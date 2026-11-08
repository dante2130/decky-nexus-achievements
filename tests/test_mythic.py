import asyncio
import copy
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main
import achievement_language as language
from mythic import MythicTracker, parse_mythic


def response(earned=False):
    return {"schema": 1, "account": "fixture-account", "titleId": "42",
            "mythic": {"groupId": "base", "unlocked": earned, "totalCount": 2,
                       "unlockedCount": 2 if earned else 1, "completedTime": "2026-10-01T12:00:00Z" if earned else None},
            "items": [{"id": "scid:1", "name": "Localized", "description": "Localized text", "baseGame": True},
                      {"id": "scid:3", "name": "DLC", "description": "DLC text", "baseGame": False}]}


class MythicTests(unittest.TestCase):
    def test_saved_title_read_never_waits_for_xbox_metadata(self):
        plugin = main.Plugin()
        saved = {"ok": True, "achievements": [{"id": "1", "name": "Saved"}]}
        with patch.object(main, "get_title", return_value=saved), patch.object(main, "translate_title") as enrich:
            self.assertEqual(asyncio.run(plugin.get_saved_title_achievements("42")), saved)
            enrich.assert_not_called()

    def test_valid_metadata_and_original_membership(self):
        group, members = parse_mythic(response(), "42")
        self.assertFalse(group["unlocked"])
        self.assertEqual((group["unlockedCount"], group["totalCount"]), (1, 2))
        self.assertEqual(members, {"scid:1": True, "scid:3": False})
        earned, _ = parse_mythic(response(True), "42")
        self.assertIsInstance(earned["completedAt"], int)

    def test_never_infers_award_from_count(self):
        data = response()
        data["mythic"]["unlockedCount"] = 2
        group, _ = parse_mythic(data, "42")
        self.assertFalse(group["unlocked"])

    def test_missing_invalid_and_cross_title_metadata(self):
        for key, value in [("totalCount", 0), ("totalCount", True), ("unlockedCount", 3), ("unlocked", "true"), ("groupId", "")]:
            data = response()
            data["mythic"][key] = value
            self.assertEqual(parse_mythic(data, "42"), (None, {}))
        self.assertEqual(parse_mythic({"schema": 1, "titleId": "42"}, "42"), (None, {}))
        with self.assertRaises(ValueError):
            parse_mythic(response(), "43")

    def test_tracker_seeds_history_and_notifies_only_once_per_account(self):
        tracker = MythicTracker()
        locked, _ = parse_mythic(response(), "42")
        earned, _ = parse_mythic(response(True), "42")
        self.assertFalse(tracker.observe("history", "42", earned))
        self.assertFalse(tracker.observe("player", "42", locked))
        self.assertTrue(tracker.observe("player", "42", earned))
        self.assertFalse(tracker.observe("player", "42", earned))
        self.assertFalse(tracker.observe("player", "42", locked))
        self.assertFalse(tracker.observe("player", "42", earned))
        self.assertFalse(tracker.observe("other-player", "42", earned))
        self.assertFalse(tracker.observe("", "42", earned))

    def test_original_text_preserved_while_mythic_is_fetched(self):
        detail = {"ok": True, "titleId": "42", "achievements": [
            {"id": "scid:1", "name": "Saved", "description": "Saved text", "unlocked": False, "secret": True}]}
        runner = AsyncMock(side_effect=[(0, b"--language --include-mythic"), (0, json.dumps(response()).encode())])
        with patch.object(language, "backend_command", return_value=(["/backend"], {})), patch.object(language, "run_bounded", runner):
            result = asyncio.run(language.translate_title(Path("/tmp"), detail, ""))
        self.assertEqual(result["achievements"][0]["name"], "Saved")
        self.assertFalse(result["achievements"][0]["unlocked"])
        self.assertTrue(result["achievements"][0]["baseGame"])
        self.assertEqual(result["mythic"]["totalCount"], 2)
        self.assertEqual(runner.call_args.args[0], ["/backend", "achievements", "42", "--json", "--include-mythic"])

    def test_offline_mythic_fetch_keeps_snapshot(self):
        detail = {"ok": True, "titleId": "42", "achievements": []}
        runner = AsyncMock(side_effect=[(0, b"--include-mythic"), (1, b"")])
        with patch.object(language, "backend_command", return_value=(["/backend"], {})), patch.object(language, "run_bounded", runner):
            result = asyncio.run(language.translate_title(Path("/tmp"), detail, ""))
        self.assertTrue(result["ok"])
        self.assertEqual(result["achievements"], [])
        self.assertEqual(result["mythicUnavailable"], "data")

    def test_plugin_hides_internal_account_and_obeys_notification_toggle(self):
        async def check():
            plugin = main.Plugin()
            plugin.settings = dict(main.DEFAULT_SETTINGS)
            locked, _ = parse_mythic(response(), "42")
            earned, _ = parse_mythic(response(True), "42")
            detail = {"ok": True, "titleId": "42", "titleName": "Fixture", "achievements": [], "_mythic_account": "fixture-account", "mythic": locked}
            emit = AsyncMock()
            with patch.object(main, "get_title", return_value={"ok": True}), patch.object(main, "decky", SimpleNamespace(emit=emit)), patch.object(main, "translate_title", AsyncMock(side_effect=lambda *args: copy.deepcopy(detail))):
                result = await plugin.get_title_achievements("42")
                self.assertNotIn("_mythic_account", result)
                emit.assert_not_called()
                detail["mythic"] = earned
                await plugin.get_title_achievements("42")
                self.assertEqual(emit.await_count, 1)
                self.assertEqual(emit.call_args.args[0], "mythic")
                await plugin.get_title_achievements("42")
                self.assertEqual(emit.await_count, 1)
                plugin.settings["enabled"] = False
                detail["_mythic_account"] = "other-player"
                detail["mythic"] = locked
                await plugin.get_title_achievements("42")
                detail["mythic"] = earned
                await plugin.get_title_achievements("42")
                self.assertEqual(emit.await_count, 1)
        asyncio.run(check())
