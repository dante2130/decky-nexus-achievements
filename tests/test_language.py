import asyncio
import json
import sys
import tempfile
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import achievement_language as language
import main


class LanguageTests(unittest.TestCase):
    def test_rarity_validation(self):
        for percentage in (0, 0.27, 100):
            value = {"percentage": percentage, "category": "Rare"}
            self.assertEqual(language.achievement_rarities({"items": [{"id": "a", "rarity": value}]}), {"a": value})
        for percentage in (True, -1, 101, float("nan"), float("inf"), "1"):
            self.assertEqual(language.achievement_rarities({"items": [{"id": "a", "rarity": {"percentage": percentage, "category": "Rare"}}]}), {})

    def test_missing_unknown_and_duplicate_rarity_is_omitted(self):
        valid = {"id": "a", "rarity": {"percentage": 5, "category": "Common"}}
        self.assertEqual(language.achievement_rarities({"items": [valid, valid]}), {})
        self.assertEqual(language.achievement_rarities({"items": [{"id": "a"}]}), {})
        self.assertEqual(language.achievement_rarities({"items": [{"id": "a", "rarity": {"percentage": 5, "category": "Unset"}}]}), {})
        self.assertEqual(language.achievement_rarities({"items": None}), {})

    def test_rarity_enriches_original_without_changing_unlocks(self):
        raw = json.dumps({"schema": 1, "titleId": "42", "items": [
            {"id": "scid:1", "rarity": {"percentage": 0.27, "category": "Rare"}}]}).encode()
        runner = AsyncMock(side_effect=[(0, b"--include-mythic"), (0, raw)])
        with patch.object(language, "backend_command", return_value=(["/backend"], {})), patch.object(language, "run_bounded", runner):
            result = asyncio.run(language.translate_title(Path("/tmp"), self.detail(), ""))
        first, second = result["achievements"]
        self.assertEqual(first["rarity"]["percentage"], 0.27)
        self.assertFalse(first["unlocked"])
        self.assertEqual(first["name"], "Original")
        self.assertNotIn("rarity", second)

    def test_helper_backend_uses_deck_user_and_session(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            binary = home / ".local/share/nexus-launcher/achievement-backend/xodus-cli"
            binary.parent.mkdir(parents=True)
            binary.touch()
            owner = SimpleNamespace(pw_uid=1000, pw_name="deck")
            with patch.object(language.pwd, "getpwuid", return_value=owner), patch.object(language.os, "geteuid", return_value=0), patch.object(language.shutil, "which", return_value="/usr/sbin/runuser"):
                command, env = language.backend_command(home)
            self.assertEqual(command[:5], ["/usr/sbin/runuser", "-u", "deck", "--", "env"])
            self.assertEqual(command[-1], str(binary))
            self.assertEqual(env["HOME"], str(home))
            self.assertEqual(env["DBUS_SESSION_BUS_ADDRESS"], "unix:path=/run/user/1000/bus")
            self.assertIn("XDG_RUNTIME_DIR=/run/user/1000", command)

    def detail(self):
        return {"ok": True, "titleId": "42", "achievements": [
            {"id": "scid:1", "name": "Original", "description": "Original description",
             "unlocked": False, "secret": True, "gamerscore": 10},
            {"id": "scid:2", "name": "Second", "description": "Keep this"}]}

    def test_original_keeps_saved_text_and_skips_online_reads_with_older_backend(self):
        detail = self.detail()
        runner = AsyncMock(return_value=(0, b"--language"))
        with patch.object(language, "backend_command", return_value=(["/backend"], {})), patch.object(language, "run_bounded", runner):
            result = asyncio.run(language.translate_title(Path("/tmp"), detail, ""))
        self.assertEqual(result["achievements"], detail["achievements"])
        self.assertEqual(result["mythicUnavailable"], "backend")
        self.assertEqual(runner.await_count, 1)

    def test_localized_text_preserves_progress_and_missing_translations(self):
        raw = json.dumps({"schema": 1, "titleId": "42", "items": [
            {"id": "scid:1", "name": "Українська назва", "description": "Опис", "state": "unlocked"}]}).encode()
        runner = AsyncMock(side_effect=[(0, b"--language"), (0, raw)])
        with patch.object(language, "backend_command", return_value=(["/backend"], {})), patch.object(language, "run_bounded", runner):
            result = asyncio.run(language.translate_title(Path("/tmp"), self.detail(), "uk-UA"))
        first, second = result["achievements"]
        self.assertEqual(first["name"], "Українська назва")
        self.assertEqual(first["description"], "Опис")
        self.assertFalse(first["unlocked"])
        self.assertTrue(first["secret"])
        self.assertEqual(second["name"], "Second")
        self.assertEqual(runner.call_args.args[0], ["/backend", "achievements", "42", "--json", "--language", "uk-UA"])

    def test_old_backend_has_actionable_error(self):
        with patch.object(language, "backend_command", return_value=(["/backend"], {})), patch.object(language, "run_bounded", AsyncMock(return_value=(0, b"achievements --json"))):
            with self.assertRaisesRegex(ValueError, "Update the Nexus backend"):
                asyncio.run(language.translate_title(Path("/tmp"), self.detail(), "de-DE"))

    def test_invalid_language_and_wrong_title_rejected(self):
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            asyncio.run(language.translate_title(Path("/tmp"), self.detail(), "../../en-US"))
        with self.assertRaises(ValueError):
            language.localized_text(b'{"schema":1,"titleId":"43","items":[]}', "42")

    def test_translation_failure_keeps_saved_achievements_visible(self):
        plugin = main.Plugin()
        plugin.settings = {**main.DEFAULT_SETTINGS, "achievement_language": "uk-UA"}
        with patch.object(main, "get_title", return_value=self.detail()), patch.object(main, "translate_title", AsyncMock(side_effect=ValueError("Update the Nexus backend"))):
            result = asyncio.run(plugin.get_title_achievements("42"))
        self.assertTrue(result["ok"])
        self.assertEqual(result["achievements"], self.detail()["achievements"])
        self.assertIn("Update the Nexus backend", result["languageError"])

    def test_setting_is_validated_and_survives_other_settings_updates(self):
        plugin = main.Plugin()
        plugin.settings = dict(main.DEFAULT_SETTINGS)
        plugin._save = lambda: None
        self.assertEqual(asyncio.run(plugin.set_achievement_language("uk-UA")), "uk-UA")
        asyncio.run(plugin.set_settings(True, 5000))
        self.assertEqual(plugin.settings["achievement_language"], "uk-UA")
        with self.assertRaises(ValueError):
            asyncio.run(plugin.set_achievement_language("unknown"))


if __name__ == "__main__":
    unittest.main()

class PreloadedLanguageTests(unittest.TestCase):
    def test_first_load_and_notification_use_selected_language_without_opening_game(self):
        async def check():
            plugin = main.Plugin()
            plugin.settings = {**main.DEFAULT_SETTINGS, "achievement_language": "ru-RU"}
            saved = {"ok": True, "titleId": "42", "achievements": [
                {"id": "scid:1", "name": "Original", "description": "Original text", "unlocked": False}]}
            localized = {**saved, "achievements": [
                {**saved["achievements"][0], "name": "Название", "description": "Описание"}]}
            with patch.object(main, "get_title", return_value=saved), \
                 patch.object(main, "translate_title", AsyncMock(return_value=localized)) as fetch:
                # No background scan or game click has happened yet.
                first = await plugin.get_saved_title_achievements("42")
                self.assertEqual(first["achievements"][0]["name"], "Название")
                event = {"titleId": "42", "scid": "scid", "id": "1", "name": "Original", "description": "Original text", "gamerscore": 10}
                notification = await plugin._localized_notification(event)
                self.assertEqual(notification["description"], "Описание")
                self.assertEqual(notification["gamerscore"], 10)
                self.assertEqual(event["name"], "Original")
                self.assertEqual(fetch.await_count, 1)
                # Overlay text onto fresh progress, never cache unlock state.
                saved["achievements"][0]["unlocked"] = True
                second = await plugin.get_saved_title_achievements("42")
                self.assertTrue(second["achievements"][0]["unlocked"])
                plugin.settings["achievement_language"] = ""
                self.assertEqual((await plugin._localized_notification(event))["name"], "Original")
        asyncio.run(check())

    def test_notification_fetches_translation_on_cache_miss(self):
        async def check():
            plugin = main.Plugin()
            plugin.settings = {**main.DEFAULT_SETTINGS, "achievement_language": "uk-UA"}
            saved = {"ok": True, "titleId": "42", "achievements": [
                {"id": "1", "name": "Назва", "description": "Опис"}]}
            with patch.object(main, "get_title", return_value=saved), \
                 patch.object(main, "translate_title", AsyncMock(return_value=saved)) as fetch:
                result = await plugin._localized_notification({"titleId": "42", "id": "1", "name": "Original"})
                self.assertEqual(result["name"], "Назва")
                self.assertEqual(fetch.await_count, 1)
        asyncio.run(check())
