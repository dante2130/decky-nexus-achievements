import asyncio
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main


class InstalledGamesTests(unittest.TestCase):
    def test_installed_filter_uses_ready_existing_manifests_and_hex_title_ids(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(main, 'user_home', return_value=Path(folder)):
            home = Path(folder)
            games = []
            for name, state, xml in [('valid', 'ready', '<Game><TitleId>2A</TitleId></Game>'),
                                      ('incomplete', 'incomplete', '<Game><TitleId>2B</TitleId></Game>'),
                                      ('invalid', 'ready', '<Game><TitleId>invalid</TitleId></Game>')]:
                directory = home / name
                directory.mkdir()
                (directory / 'MicrosoftGame.Config').write_text(xml)
                games.append({'path': str(directory), 'installState': state})
            games.append({'path': str(home / 'removed'), 'installState': 'ready'})
            state = home / '.config/xodus-nexus/launcher-state.json'
            state.parent.mkdir(parents=True)
            state.write_text(json.dumps({'games': games}))
            self.assertEqual(main.installed_title_ids(), {'42'})
            ach = home / 'achievements'
            ach.mkdir()
            (ach / 'index.json').write_text(json.dumps({'titles': [{'titleId': '42'}, {'titleId': '43'}]}))
            with patch.object(main, 'resolve_achievements_dir', return_value=ach):
                rows = main.list_titles()['titles']
                self.assertEqual([row['installed'] for row in rows], [True, False])
            state.write_text('{bad')
            self.assertEqual(main.installed_title_ids(), set())

    def test_manifest_read_supports_bom_namespaces_and_ignores_comments(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            file = home / 'MicrosoftGame.Config'
            game = {'path': str(home), 'installState': 'ready'}
            file.write_bytes('<Game><!--<TitleId>FF</TitleId>--><TitleId>2A</TitleId></Game>'.encode('utf-16'))
            self.assertEqual(main.installed_game_title_id(game), '42')
            file.write_text('<Game xmlns:x="urn:x"><x:TitleId>2B</x:TitleId></Game>')
            self.assertEqual(main.installed_game_title_id(game), '43')
            file.write_text('<Game><TitleId>2A</TitleId><TitleId>2B</TitleId></Game>')
            self.assertEqual(main.installed_game_title_id(game), '')

    def test_toggle_survives_restart_and_other_settings_updates(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'settings.json'
            plugin = main.Plugin()
            plugin.settings = dict(main.DEFAULT_SETTINGS)
            plugin._settings_file = lambda: file
            asyncio.run(plugin.set_installed_games_only(True))
            asyncio.run(plugin.set_settings(True, 8000))
            restored = main.Plugin()
            restored._settings_file = lambda: file
            restored._load()
            self.assertTrue(restored.settings['installed_games_only'])
            with patch.object(restored, '_save', side_effect=OSError('read only')):
                with self.assertRaises(OSError):
                    asyncio.run(restored.set_installed_games_only(False))
            self.assertTrue(restored.settings['installed_games_only'])
