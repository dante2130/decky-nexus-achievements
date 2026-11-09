import asyncio
import json
from pathlib import Path
import sys
import tempfile
from unittest.mock import AsyncMock, patch
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main


def profile(score):
    return json.dumps({'schema': 1, 'account': 'fixture', 'gamerscore': score}).encode()


class ProfileGamerscoreTests(unittest.TestCase):
    def test_missing_is_not_zero_and_profile_range_is_validated(self):
        for score in (0, 12345, 0xffffffff):
            self.assertEqual(main.parse_profile_gamerscore(profile(score)), score)
        for score in (None, True, -1, 1.5, '123', 0x100000000):
            with self.assertRaises(ValueError):
                main.parse_profile_gamerscore(profile(score))
        with self.assertRaises(ValueError):
            main.parse_profile_gamerscore(b'{"schema":1,"gamerscore":100}')

    def test_disabled_feature_never_reads_profile(self):
        plugin = main.Plugin()
        plugin.settings = dict(main.DEFAULT_SETTINGS)
        with patch.object(main, 'run_bounded', AsyncMock()) as runner:
            self.assertFalse(asyncio.run(plugin.get_profile_gamerscore())['ok'])
            runner.assert_not_called()

    def test_requests_are_deduplicated_cached_and_fail_without_a_stale_total(self):
        async def scenario():
            plugin = main.Plugin()
            plugin.settings = {**main.DEFAULT_SETTINGS, 'profile_gamerscore': True}
            async def read(*args):
                await asyncio.sleep(0)
                return (0, profile(12345))
            runner = AsyncMock(side_effect=read)
            with patch.object(main, 'backend_command', return_value=(['/helper'], {})), patch.object(main, 'run_bounded', runner):
                results = await asyncio.gather(plugin.get_profile_gamerscore(), plugin.get_profile_gamerscore())
                self.assertEqual([r['gamerscore'] for r in results], [12345, 12345])
                self.assertEqual(runner.await_count, 1)
                self.assertEqual(runner.call_args.args[0], ['/helper', 'profile', '--json'])
                plugin._profile_score_cache = (asyncio.get_running_loop().time() - 301, 12345)
                runner.side_effect = None
                runner.return_value = (0, profile(None))
                self.assertFalse((await plugin.get_profile_gamerscore())['ok'])
                self.assertIsNone(plugin._profile_score_cache)
        asyncio.run(scenario())

    def test_toggle_persists_and_rolls_back_when_save_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'settings.json'
            plugin = main.Plugin()
            plugin.settings = dict(main.DEFAULT_SETTINGS)
            plugin._settings_file = lambda: file
            asyncio.run(plugin.set_profile_gamerscore(True))
            asyncio.run(plugin.set_settings(True, 8000))
            restored = main.Plugin()
            restored._settings_file = lambda: file
            restored._load()
            self.assertTrue(restored.settings['profile_gamerscore'])
            with patch.object(restored, '_save', side_effect=OSError('read only')):
                with self.assertRaises(OSError):
                    asyncio.run(restored.set_profile_gamerscore(False))
            self.assertTrue(restored.settings['profile_gamerscore'])
            asyncio.run(restored.set_profile_gamerscore(False))
            self.assertIsNone(restored._profile_score_cache)
