import asyncio
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from ta_bridge import TAWorker


class BridgeTests(unittest.TestCase):
    def test_plugin_imports_without_optional_frozen_stdlib_modules(self):
        code = '''
import builtins, sys
sys.path.insert(0, sys.argv[1])
original = builtins.__import__
def restricted(name, *args, **kwargs):
    if name in {'html.parser', 'http.cookiejar', 'urllib.request'}:
        raise ModuleNotFoundError(name)
    return original(name, *args, **kwargs)
builtins.__import__ = restricted
import main
assert hasattr(main.Plugin, 'get_trueachievements')
'''
        result = subprocess.run([sys.executable, '-I', '-c', code, str(ROOT)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_worker_round_trip_reuses_process_and_recovers_after_exit(self):
        async def run(directory):
            worker = TAWorker(Path(directory))
            try:
                self.assertEqual(await worker.call('status'), {'status': 'disconnected'})
                process = worker.process
                self.assertEqual(await worker.call('disconnect'), {'status': 'disconnected'})
                self.assertIs(worker.process, process)
                process.kill()
                await process.wait()
                self.assertEqual(await worker.call('status'), {'status': 'disconnected'})
                self.assertIsNot(worker.process, process)
            finally:
                await worker.close()
            self.assertIsNone(worker.process)
        with tempfile.TemporaryDirectory() as directory:
            asyncio.run(run(directory))

    def test_missing_worker_is_optional_and_core_snapshot_remains_available(self):
        import main
        from unittest.mock import AsyncMock, patch
        async def run():
            plugin = main.Plugin()
            snapshot = {'ok': True, 'titleId': '42', 'achievements': []}
            with patch.object(plugin, '_settings_file', return_value=Path('/tmp/test/settings.json')), \
                 patch.object(TAWorker, 'call', new=AsyncMock(side_effect=OSError('unavailable'))), \
                 patch.object(main, 'get_title', return_value=snapshot):
                self.assertEqual((await plugin.get_trueachievements('42'))['status'], 'unavailable')
                plugin.settings = main.DEFAULT_SETTINGS.copy()
                self.assertEqual(await plugin.get_saved_title_achievements('42'), snapshot)
        asyncio.run(run())
