import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import AsyncMock, patch

import achievement_language
import main


class UnifideckTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        for override in (patch.object(main, "user_home", return_value=self.home),
                         patch.dict(os.environ, {"XDG_DATA_HOME": "", "NEXUS_ACHIEVEMENTS_DIR": ""})):
            override.start()
            self.addCleanup(override.stop)
        self.root = achievement_language.unifideck_root(self.home)

    def write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data))

    def test_title_snapshot_running_title_and_shortcut(self):
        product_id = "9PK087LNGJC5"
        title_id = "unifideck.42"
        self.write(self.root / "installed" / f"{product_id}.json",
                   {"productId": product_id, "storeGameId": "merged-game", "state": "installed", "titleId": "2A"})
        self.write(self.root.parent / "shortcuts_registry.json",
                   {"microsoft:merged-game": {"appid_unsigned": 123, "title": "Test Game"}})
        self.write(self.root / "achievements" / f"{title_id}.json",
                   {"titleId": title_id, "titleName": "Test Game", "total": 1,
                    "achievements": [{"id": "scid:1", "name": "First"}]})
        self.write(self.root / "achievements/running.json",
                   {"titleId": title_id, "launcherPid": os.getpid()})

        summary, = main.list_titles()["titles"]
        self.assertTrue(summary["installed"])
        self.assertEqual(main.game_menu_target(123), summary)
        self.assertEqual(main.get_running_title(), summary)
        self.assertEqual(main.get_title(title_id)["achievements"][0]["id"], "scid:1")

    async def test_unifideck_localization_uses_its_backend_even_with_nexus(self):
        binary = self.root / "backend/release/xodus-cli"
        binary.parent.mkdir(parents=True)
        binary.touch()
        self.write(self.root / "active.json", {"schema": 1, "backend": {"dir": "backend/release"}})
        nexus = self.home / ".local/share/nexus-launcher/achievement-backend/xodus-cli"
        nexus.parent.mkdir(parents=True)
        nexus.touch()
        self.assertEqual(achievement_language.backend_command(self.home)[0][-1], str(nexus))
        response = {"schema": 1, "titleId": "42",
                    "items": [{"id": "scid:1", "name": "Erste", "description": ""}]}
        run = AsyncMock(side_effect=[(0, b"--language --include-mythic"), (0, json.dumps(response).encode())])
        detail = {"ok": True, "titleId": "unifideck.42", "achievements": [{"id": "scid:1", "name": "First"}]}
        with patch.object(achievement_language, "run_bounded", run):
            result = await achievement_language.translate_title(self.home, detail, "de-DE")
        argv, env = run.await_args.args
        self.assertEqual(argv[-7:], [str(binary), "achievements", "42", "--json", "--language", "de-DE", "--include-mythic"])
        self.assertEqual(env["XODUS_CREDENTIAL_DIR"], str(self.root / "credentials"))
        self.assertEqual(result["achievements"][0]["name"], "Erste")

    async def test_enrichment_fallback_requires_the_same_xbox_account(self):
        detail = {"ok": True, "titleId": "unifideck.42",
                  "achievements": [{"id": "scid:1", "name": "First"}]}
        response = {"schema": 1, "titleId": "42", "account": "same@example.invalid",
                    "items": [{"id": "scid:1", "name": "Erste", "description": ""}]}

        def backend(home, *, unifideck=False):
            return (["unifideck" if unifideck else "nexus"], {})

        for helper_account in ("SAME@example.invalid", "different@example.invalid"):
            run = AsyncMock(side_effect=[
                (0, b"--json"), (0, b"--language --include-mythic"),
                (0, b'{"username":"same@example.invalid"}'),
                (0, json.dumps({"player": {"username": helper_account}}).encode()),
                (0, json.dumps(response).encode()),
            ])
            with patch.object(achievement_language, "backend_command", backend), \
                 patch.object(achievement_language, "run_bounded", run):
                if helper_account.startswith("SAME"):
                    result = await achievement_language.translate_title(self.home, detail, "de-DE")
                    self.assertEqual(result["achievements"][0]["name"], "Erste")
                else:
                    with self.assertRaisesRegex(ValueError, "supporting achievement languages"):
                        await achievement_language.translate_title(self.home, detail, "de-DE")
                    self.assertEqual(run.await_count, 4)
