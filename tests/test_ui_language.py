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
