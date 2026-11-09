import asyncio
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main
from steam_menu import parse_shortcuts, shortcut_game


def vdf(fields):
    data = b''
    for key, value in fields.items():
        kind = 0 if isinstance(value, dict) else 1 if isinstance(value, str) else 2
        data += bytes([kind]) + key.encode() + b'\0'
        data += vdf(value) if kind == 0 else value.encode() + b'\0' if kind == 1 else struct.pack('<I', value)
    return data + b'\x08'


class SteamMenuTests(unittest.TestCase):
    def test_shortcut_mapping_and_target_use_installed_manifest_not_steam_id(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(main, 'user_home', return_value=Path(directory)):
            home = Path(directory)
            game = {'id': '0123456789abcdef', 'title': 'A game', 'path': str(home / 'game'), 'installState': 'ready'}
            Path(game['path']).mkdir()
            (Path(game['path']) / 'MicrosoftGame.Config').write_text('<Game><TitleId>2A</TitleId></Game>')
            state = home / '.config/xodus-nexus/launcher-state.json'
            state.parent.mkdir(parents=True)
            state.write_text(json.dumps({'games': [game]}))
            file = home / '.local/share/Steam/userdata/123/config/shortcuts.vdf'
            file.parent.mkdir(parents=True)
            entry = {'appid': 0x80000042, 'AppName': 'Renamed in Steam', 'Exe': 'nexus', 'LaunchOptions': '--launch-game 0123456789abcdef'}
            file.write_bytes(vdf({'shortcuts': {'0': entry}}))
            self.assertEqual(main.game_menu_target(entry['appid'])['titleId'], '42')
            summary = {"titleId": "42", "titleName": "A game", "gamerscore": 150, "gamerscoreTotal": 1000,
                       "unlocked": 15, "total": 62, "updatedAt": 123}
            with patch.object(main, 'list_titles', return_value={"ok": True, "titles": [summary]}):
                self.assertEqual(main.game_menu_target(entry['appid']), summary)

            self.assertIsNone(main.game_menu_target(42))
            self.assertIsNone(main.game_menu_target(True))
            entry['LaunchOptions'] += ' --nexus-profile /another/profile'
            file.write_bytes(vdf({'shortcuts': {'0': entry}}))
            self.assertIsNone(main.game_menu_target(entry['appid']))
            entry.update(AppName='A game', LaunchOptions='')
            file.write_bytes(vdf({'shortcuts': {'0': entry}}))
            self.assertEqual(shortcut_game(home, entry['appid'], [game]), game)
            self.assertIsNone(shortcut_game(home, entry['appid'], [game, game]))
            file.write_bytes(b'broken')
            self.assertIsNone(shortcut_game(home, entry['appid'], [game]))

    def test_invalid_binary_shortcuts_are_rejected(self):
        self.assertEqual(parse_shortcuts(vdf({'shortcuts': {}})), [])
        for data in (b'', b'broken', vdf({'wrong': {}}), vdf({'shortcuts': {}}) + b'x'):
            with self.assertRaises(ValueError):
                parse_shortcuts(data)

    def test_menu_toggle_persists_and_save_failure_rolls_back(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'settings.json'
            plugin = main.Plugin()
            plugin.settings = dict(main.DEFAULT_SETTINGS)
            plugin._settings_file = lambda: file
            asyncio.run(plugin.set_game_menu_button(False))
            asyncio.run(plugin.set_settings(True, 8000))
            restored = main.Plugin()
            restored._settings_file = lambda: file
            restored._load()
            self.assertFalse(restored.settings['game_menu_button'])
            with patch.object(restored, '_save', side_effect=OSError('read only')):
                with self.assertRaises(OSError):
                    asyncio.run(restored.set_game_menu_button(True))
            self.assertFalse(restored.settings['game_menu_button'])
