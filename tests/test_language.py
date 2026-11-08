import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import achievement_language as language
import main


class LanguageTests(unittest.TestCase):
    def detail(self):
        return {"ok": True, "titleId": "42", "achievements": [
            {"id": "scid:1", "name": "Original", "description": "Original description",
             "unlocked": False, "secret": True, "gamerscore": 10},
            {"id": "scid:2", "name": "Second", "description": "Keep this"}]}

    def test_original_does_not_run_backend(self):
        detail = self.detail()
        with patch.object(language, "backend_command") as command:
            self.assertEqual(asyncio.run(language.translate_title(Path("/tmp"), detail, "")), detail)
            command.assert_not_called()

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
