import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main

class TAFilterSettingsTests(unittest.TestCase):
    def test_all_catalog_flags_can_be_saved_and_restored(self):
        import json
        flags = json.loads((Path(main.__file__).parent / 'src/ta_flags.json').read_text())
        plugin = main.Plugin()
        plugin.settings = {**main.DEFAULT_SETTINGS, 'game_view_settings': {}}
        async def run():
            with patch.object(plugin, '_save'):
                for flag in flags:
                    selected = 'ta:' + flag['id']
                    saved = await plugin.set_game_view_settings('42', selected, 'name')
                    self.assertEqual(saved['filter'], 'all')
                    self.assertEqual(saved['taFilter'], selected)
                    self.assertEqual((await plugin.get_game_view_settings('42'))['taFilter'], selected)
                with self.assertRaises(ValueError):
                    await plugin.set_game_view_settings('42', 'ta:invented', 'name')
        asyncio.run(run())

    def test_ta_filter_combines_with_unlock_filter_and_migrates_previous_selection(self):
        plugin = main.Plugin()
        plugin.settings = {**main.DEFAULT_SETTINGS, 'game_view_settings': {'42': {'filter': 'ta:missable'}}}
        async def run():
            migrated = await plugin.get_game_view_settings('42')
            self.assertEqual(migrated['filter'], 'all')
            self.assertEqual(migrated['taFilter'], 'ta:missable')
            with patch.object(plugin, '_save'):
                saved = await plugin.set_game_view_settings('42', 'locked', 'name', 'all', 'asc', 'ta:missable')
                self.assertEqual(saved['filter'], 'locked')
                self.assertEqual(saved['taFilter'], 'ta:missable')
                self.assertEqual(await plugin.get_game_view_settings('42'), saved)
        asyncio.run(run())
