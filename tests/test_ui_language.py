import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main


class UiLanguageTests(unittest.TestCase):
    def test_ukrainian_language_survives_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            settings_file = Path(directory) / "settings.json"
            plugin = main.Plugin()
            plugin._settings_file = lambda: settings_file
            plugin.settings = dict(main.DEFAULT_SETTINGS)
            asyncio.run(plugin.set_plugin_language("uk"))
            restored = main.Plugin()
            restored._settings_file = lambda: settings_file
            restored._load()
            self.assertEqual(restored.settings["plugin_language"], "uk")

    def test_language_persists_and_does_not_change_achievement_language(self):
        with tempfile.TemporaryDirectory() as directory:
            settings_file = Path(directory) / "settings.json"
            plugin = main.Plugin()
            plugin._settings_file = lambda: settings_file
            plugin.settings = {**main.DEFAULT_SETTINGS, "achievement_language": "de-DE"}
            asyncio.run(plugin.set_plugin_language("en"))
            asyncio.run(plugin.set_settings(False, 5000))
            restored = main.Plugin()
            restored._settings_file = lambda: settings_file
            restored._load()
            self.assertEqual(restored.settings["plugin_language"], "en")
            self.assertEqual(restored.settings["achievement_language"], "de-DE")
            with self.assertRaises(ValueError):
                asyncio.run(plugin.set_plugin_language("invalid"))
            self.assertEqual(json.loads(settings_file.read_text())["plugin_language"], "en")

    def test_failed_save_keeps_previous_interface_language(self):
        plugin = main.Plugin()
        plugin.settings = dict(main.DEFAULT_SETTINGS)
        with patch.object(plugin, "_save", side_effect=OSError("read only")):
            with self.assertRaises(OSError):
                asyncio.run(plugin.set_plugin_language("en"))
        self.assertEqual(plugin.settings["plugin_language"], "system")

    def test_test_notifications_follow_interface_language(self):
        plugin = main.Plugin()
        plugin.settings = dict(main.DEFAULT_SETTINGS)
        plugin.settings["plugin_language"] = "ru"
        emit = AsyncMock()
        with patch.object(main, "decky", SimpleNamespace(emit=emit)):
            asyncio.run(plugin.test_notification())
            self.assertEqual(emit.call_args.args[1]["name"], "Тестовое достижение")
            plugin.settings["plugin_language"] = "en"
            asyncio.run(plugin.test_notification())
            self.assertEqual(emit.call_args.args[1]["name"], "Test achievement")
            plugin.settings["plugin_language"] = "uk"
            asyncio.run(plugin.test_notification())
            self.assertEqual(emit.call_args.args[1]["name"], "Тестове досягнення")
            self.assertEqual(emit.call_args.args[1]["description"], "Сповіщення Nexus працюють.")

    def test_rare_and_mythic_durations_are_separate_and_persisted(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "settings.json"
            plugin = main.Plugin()
            plugin.settings = dict(main.DEFAULT_SETTINGS)
            plugin._settings_file = lambda: file
            asyncio.run(plugin.set_notification_duration("rare", 12000))
            asyncio.run(plugin.set_notification_duration("mythic", 20000))
            asyncio.run(plugin.set_settings(True, 6000))
            restored = main.Plugin()
            restored._settings_file = lambda: file
            restored._load()
            self.assertEqual(restored.settings["duration"], 6000)
            self.assertEqual(restored.settings["notification_durations"], {"rare": 12000, "mythic": 20000})
            for kind, value in (("invalid", 8000), ("rare", 0), ("mythic", 86400001), ("rare", True)):
                with self.assertRaises(ValueError):
                    asyncio.run(plugin.set_notification_duration(kind, value))
            with patch.object(plugin, "_save", side_effect=OSError("read only")):
                with self.assertRaises(OSError):
                    asyncio.run(plugin.set_notification_duration("rare", 5000))
            self.assertEqual(plugin.settings["notification_durations"]["rare"], 12000)

    def test_notification_choice_survives_restart_and_other_setting_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            settings_file = Path(directory) / "settings.json"
            plugin = main.Plugin()
            plugin._settings_file = lambda: settings_file
            plugin.settings = dict(main.DEFAULT_SETTINGS)
            for kind in ("rare", "mythic", "normal"):
                self.assertEqual(asyncio.run(plugin.set_test_notification_type(kind)), kind)
                asyncio.run(plugin.set_settings(True, 8000))
                restored = main.Plugin()
                restored._settings_file = lambda: settings_file
                restored._load()
                self.assertEqual(asyncio.run(restored.get_settings())["test_notification_type"], kind)
            with self.assertRaises(ValueError):
                asyncio.run(plugin.set_test_notification_type("invalid"))
            with patch.object(plugin, "_save", side_effect=OSError("read only")):
                with self.assertRaises(OSError):
                    asyncio.run(plugin.set_test_notification_type("rare"))
            self.assertEqual(plugin.settings["test_notification_type"], "normal")

    def test_notification_types_emit_preview_payloads(self):
        plugin = main.Plugin()
        plugin.settings = dict(main.DEFAULT_SETTINGS)
        emit = AsyncMock()
        with patch.object(main, "decky", SimpleNamespace(emit=emit)):
            asyncio.run(plugin.test_notification("en", "normal"))
            topic, event = emit.call_args.args
            self.assertEqual(topic, "achievement")
            self.assertTrue(event["preview"])
            self.assertNotIn("rarity", event)
            asyncio.run(plugin.test_notification("uk", "rare"))
            topic, event = emit.call_args.args
            self.assertEqual(topic, "achievement")
            self.assertTrue(event["preview"])
            self.assertEqual(event["rarity"], {"percentage": 1.23, "category": "Rare"})
            self.assertEqual(event["name"], "Тестове досягнення")
            asyncio.run(plugin.test_notification("en", "mythic"))
            topic, event = emit.call_args.args
            self.assertEqual(topic, "mythic")
            self.assertTrue(event["preview"])
            self.assertTrue(event["mythic"]["unlocked"])
            self.assertEqual(event["mythic"]["unlockedCount"], event["mythic"]["totalCount"])
            previous = emit.await_count
            with self.assertRaises(ValueError):
                asyncio.run(plugin.test_notification("en", "invalid"))
            self.assertEqual(emit.await_count, previous)

    def test_system_default_and_notification_fallback(self):
        plugin = main.Plugin()
        plugin.settings = dict(main.DEFAULT_SETTINGS)
        self.assertEqual(plugin.settings["plugin_language"], "system")
        emit = AsyncMock()
        with patch.object(main, "decky", SimpleNamespace(emit=emit)):
            asyncio.run(plugin.test_notification("uk"))
            self.assertEqual(emit.call_args.args[1]["name"], "Тестове досягнення")
            asyncio.run(plugin.test_notification("de"))
            self.assertEqual(emit.call_args.args[1]["name"], "Test achievement")
            asyncio.run(plugin.test_notification())
            self.assertEqual(emit.call_args.args[1]["name"], "Test achievement")
