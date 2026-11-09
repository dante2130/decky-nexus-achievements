import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main


class GameViewSettingsTests(unittest.TestCase):
    def test_original_mythic_and_addon_choices_persist_separately(self):
        with tempfile.TemporaryDirectory() as directory:
            settings_file = Path(directory) / "settings.json"
            plugin = self.plugin()
            plugin._settings_file = lambda: settings_file
            asyncio.run(plugin.set_game_view_settings("42", "locked", "date", "original"))
            asyncio.run(plugin.set_game_view_settings("43", "all", "gamerscore", "addon"))
            restored = self.plugin()
            restored._settings_file = lambda: settings_file
            restored._load()
            self.assertEqual(asyncio.run(restored.get_game_view_settings("42"))["contentFilter"], "original")
            self.assertEqual(asyncio.run(restored.get_game_view_settings("43"))["contentFilter"], "addon")
            asyncio.run(restored.set_remember_game_view_settings(False))
            asyncio.run(restored.set_game_view_settings("42", "all", "name", "all"))
            self.assertEqual(asyncio.run(restored.get_game_view_settings("42"))["contentFilter"], "all")
            asyncio.run(restored.set_remember_game_view_settings(True))
            self.assertEqual(asyncio.run(restored.get_game_view_settings("42"))["contentFilter"], "original")
            asyncio.run(restored.set_game_view_settings("42", "locked", "date", "all"))
            self.assertEqual(asyncio.run(restored.get_game_view_settings("42"))["contentFilter"], "all")

    def test_legacy_records_default_to_all_and_invalid_sets_are_rejected(self):
        plugin = self.plugin()
        plugin.settings["game_view_settings"] = {"42": {"filter": "locked", "sort": "gamerscore"}}
        self.assertEqual(asyncio.run(plugin.get_game_view_settings("42")), {"filter": "locked", "sort": "gamerscore", "contentFilter": "all", "sortDirection": "desc"})
        with patch.object(plugin, "_save") as save:
            with self.assertRaises(ValueError):
                asyncio.run(plugin.set_game_view_settings("42", "all", "date", "invalid"))
            save.assert_not_called()

    def test_disabling_persistence_ignores_saved_choices_without_erasing_them(self):
        with tempfile.TemporaryDirectory() as directory:
            settings_file = Path(directory) / "settings.json"
            plugin = self.plugin()
            plugin._settings_file = lambda: settings_file
            asyncio.run(plugin.set_game_view_settings("42", "locked", "name"))
            asyncio.run(plugin.set_remember_game_view_settings(False))
            self.assertEqual(asyncio.run(plugin.get_game_view_settings("42")), {"filter": "all", "sort": "date", "contentFilter": "all", "sortDirection": "desc"})
            with patch.object(plugin, "_save") as save:
                asyncio.run(plugin.set_game_view_settings("42", "unlocked", "gamerscore"))
                save.assert_not_called()
            restored = self.plugin()
            restored._settings_file = lambda: settings_file
            restored._load()
            self.assertFalse(restored.settings["remember_game_view_settings"])
            asyncio.run(restored.set_remember_game_view_settings(True))
            self.assertEqual(asyncio.run(restored.get_game_view_settings("42")), {"filter": "locked", "sort": "name", "contentFilter": "all", "sortDirection": "asc"})

    def test_failed_toggle_save_preserves_enabled_state(self):
        plugin = self.plugin()
        with patch.object(plugin, "_save", side_effect=OSError("read only")):
            with self.assertRaises(OSError):
                asyncio.run(plugin.set_remember_game_view_settings(False))
        self.assertTrue(plugin.settings["remember_game_view_settings"])

    def plugin(self):
        plugin = main.Plugin()
        plugin.settings = dict(main.DEFAULT_SETTINGS)
        return plugin

    def test_defaults_and_separate_games_survive_restart_and_global_updates(self):
        with tempfile.TemporaryDirectory() as directory:
            settings_file = Path(directory) / "settings.json"
            plugin = self.plugin()
            plugin._settings_file = lambda: settings_file
            self.assertEqual(asyncio.run(plugin.get_game_view_settings("42")), {"filter": "all", "sort": "date", "contentFilter": "all", "sortDirection": "desc"})
            asyncio.run(plugin.set_game_view_settings("42", "unlocked", "gamerscore"))
            asyncio.run(plugin.set_game_view_settings("43", "locked", "name"))
            asyncio.run(plugin.set_settings(False, 5000))
            restored = self.plugin()
            restored._settings_file = lambda: settings_file
            restored._load()
            self.assertEqual(asyncio.run(restored.get_game_view_settings("42")), {"filter": "unlocked", "sort": "gamerscore", "contentFilter": "all", "sortDirection": "desc"})
            self.assertEqual(asyncio.run(restored.get_game_view_settings("43")), {"filter": "locked", "sort": "name", "contentFilter": "all", "sortDirection": "asc"})
            self.assertEqual(asyncio.run(restored.get_game_view_settings("44")), {"filter": "all", "sort": "date", "contentFilter": "all", "sortDirection": "desc"})

    def test_invalid_ids_and_choices_are_rejected_without_writing(self):
        plugin = self.plugin()
        with patch.object(plugin, "_save") as save:
            for args in [("../42", "all", "date"), ("42", "invalid", "date"), ("42", "all", "invalid")]:
                with self.assertRaises(ValueError):
                    asyncio.run(plugin.set_game_view_settings(*args))
            with self.assertRaises(ValueError):
                asyncio.run(plugin.get_game_view_settings("../42"))
            save.assert_not_called()

    def test_malformed_stored_preferences_use_defaults(self):
        plugin = self.plugin()
        for value in [None, [], {"42": None}, {"42": {"filter": "bad", "sort": "bad"}}]:
            plugin.settings["game_view_settings"] = value
            self.assertEqual(asyncio.run(plugin.get_game_view_settings("42")), {"filter": "all", "sort": "date", "contentFilter": "all", "sortDirection": "desc"})

    def test_failed_save_retains_previous_settings(self):
        plugin = self.plugin()
        plugin.settings["game_view_settings"] = {"42": {"filter": "locked", "sort": "name", "contentFilter": "all", "sortDirection": "asc"}}
        with patch.object(plugin, "_save", side_effect=OSError("read only")):
            with self.assertRaises(OSError):
                asyncio.run(plugin.set_game_view_settings("42", "all", "date"))
        self.assertEqual(asyncio.run(plugin.get_game_view_settings("42")), {"filter": "locked", "sort": "name", "contentFilter": "all", "sortDirection": "asc"})

    def test_rarity_direction_persists_and_invalid_direction_is_rejected(self):
        plugin = self.plugin()
        with patch.object(plugin, "_save"):
            asyncio.run(plugin.set_game_view_settings("42", "all", "rarity", "original", "asc"))
            self.assertEqual(asyncio.run(plugin.get_game_view_settings("42"))["sortDirection"], "asc")
            self.assertEqual(asyncio.run(plugin.get_game_view_settings("42"))["sort"], "rarity")
            with self.assertRaises(ValueError):
                asyncio.run(plugin.set_game_view_settings("42", "all", "rarity", "all", "invalid"))
