import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main  # noqa: E402


class ViewerTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name) / "ach"
        self.root.mkdir()
        os.environ["NEXUS_ACHIEVEMENTS_DIR"] = str(self.root)

    def tearDown(self):
        os.environ.pop("NEXUS_ACHIEVEMENTS_DIR", None)
        self.dir.cleanup()

    def test_missing_index(self):
        self.assertEqual(main.list_titles(), {"ok": True, "titles": []})

    def test_malformed_index(self):
        (self.root / "index.json").write_text("{nope")
        self.assertEqual(main.list_titles()["titles"], [])

    def test_list_titles_filters_bad(self):
        (self.root / "index.json").write_text(json.dumps({"version": 1, "titles": [
            {"titleId": "a1", "titleName": "DRAGON QUEST XI S", "coverUrl": "https://store-images.s-microsoft.com/cover", "unlocked": 1, "total": 2, "gamerscore": 5, "gamerscoreTotal": 10},
            {"titleId": "../x"}, "junk", {"titleId": 5}]}))
        titles = main.list_titles()["titles"]
        self.assertEqual([t["titleId"] for t in titles], ["a1"])
        self.assertEqual(titles[0]["total"], 2)
        self.assertEqual(titles[0]["titleName"], "DRAGON QUEST XI S")
        self.assertEqual(titles[0]["coverUrl"], "https://store-images.s-microsoft.com/cover")

    def test_running_title_requires_live_launcher_and_known_title(self):
        (self.root / "index.json").write_text(json.dumps({"titles": [{"titleId": "123", "titleName": "Game", "coverUrl": "https://example.com/cover"}]}))
        running = self.root / "running.json"
        self.assertIsNone(main.get_running_title())
        running.write_text(json.dumps({"titleId": "123", "launcherPid": os.getpid()}))
        self.assertEqual(main.get_running_title()["titleName"], "Game")
        from unittest.mock import patch
        with patch.object(main.os, "kill", side_effect=ProcessLookupError):
            self.assertIsNone(main.get_running_title())
        running.write_text(json.dumps({"titleId": "unknown", "launcherPid": os.getpid()}))
        self.assertIsNone(main.get_running_title())
        running.write_text(json.dumps({"titleId": "123", "launcherPid": -1}))
        self.assertIsNone(main.get_running_title())

    def test_traversal_rejected(self):
        (Path(self.dir.name) / "secret.json").write_text(json.dumps({"achievements": []}))
        for bad in ["../secret", "a/b", "..", "", None, 5, "a\\b", "x..y"]:
            self.assertFalse(main.get_title(bad)["ok"], bad)

    def test_get_title(self):
        (self.root / "t1.json").write_text(json.dumps({"titleName": "T", "achievements": [
            {"id": "1", "name": "N", "gamerscore": 10, "unlocked": True, "unlockedAt": 5, "progress": 150, "secret": False},
            {"id": 2, "name": "M", "unlocked": "yes"}, 7]}))
        r = main.get_title("t1")
        self.assertTrue(r["ok"])
        self.assertEqual(len(r["achievements"]), 2)
        self.assertEqual(r["achievements"][0]["progress"], 100)
        self.assertFalse(r["achievements"][1]["unlocked"])
        self.assertEqual(r["achievements"][1]["id"], "2")

    def test_missing_and_malformed_title(self):
        self.assertFalse(main.get_title("nope")["ok"])
        (self.root / "bad.json").write_text("[1]")
        self.assertFalse(main.get_title("bad")["ok"])

    def test_settings_default_and_toggle_persist(self):
        self.assertFalse(main.DEFAULT_SETTINGS["show_secrets"])
        import asyncio
        plugin = main.Plugin()
        plugin.settings = dict(main.DEFAULT_SETTINGS)
        plugin._save = lambda: None
        self.assertTrue(asyncio.run(plugin.set_show_secrets(True)))
        asyncio.run(plugin.set_settings(True, 5000, ""))
        self.assertTrue(plugin.settings["show_secrets"])

    def test_secret_fields_pass_through(self):
        (self.root / "s.json").write_text(json.dumps({"achievements": [
            {"id": "1", "name": "Hid", "description": "", "secret": True}]}))
        a = main.get_title("s")["achievements"][0]
        self.assertTrue(a["secret"])
        self.assertEqual(a["description"], "")

    def test_oversize(self):
        (self.root / "big.json").write_bytes(b" " * (main.MAX_SNAPSHOT + 1))
        self.assertFalse(main.get_title("big")["ok"])


if __name__ == "__main__":
    unittest.main()
