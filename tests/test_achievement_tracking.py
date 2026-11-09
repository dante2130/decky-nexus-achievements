import asyncio
import copy
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main


def detail(title='42'):
    return {'ok': True, 'titleId': title, 'titleName': 'Game', 'achievements': [
        {'id': str(i), 'name': f'Achievement {i}', 'description': 'Details', 'progress': 25,
         'unlocked': False, 'secret': i == 2, 'iconUrl': 'https://example.com/icon', 'gamerscore': 10}
        for i in range(1, 8)]}


class AchievementTrackingTests(unittest.TestCase):
    def plugin(self):
        plugin = main.Plugin()
        plugin.settings = copy.deepcopy(main.DEFAULT_SETTINGS)
        plugin._schedule_tracker_refresh = lambda *args: None
        return plugin

    def test_favorites_persist_per_game_and_are_independent_of_tracking(self):
        with tempfile.TemporaryDirectory() as directory:
            plugin = self.plugin()
            plugin._settings_file = lambda: Path(directory) / 'settings.json'
            with patch.object(main, 'get_title', side_effect=detail):
                self.assertEqual(asyncio.run(plugin.set_achievement_favorite('42', '1', True)), {'favorites': ['1'], 'tracked': []})
                self.assertEqual(asyncio.run(plugin.set_achievement_tracked('42', '3', True)), {'favorites': ['1'], 'tracked': ['3']})
                restored = self.plugin()
                restored._settings_file = plugin._settings_file
                restored._load()
                self.assertEqual(asyncio.run(restored.get_achievement_preferences('42')), {'favorites': ['1'], 'tracked': ['3']})
                self.assertEqual(asyncio.run(restored.get_achievement_preferences('43')), {'favorites': [], 'tracked': []})
                self.assertEqual(asyncio.run(restored.set_achievement_favorite('42', '1', False)), {'favorites': [], 'tracked': ['3']})

    def test_tracking_limit_prunes_completed_and_missing_ids(self):
        plugin = self.plugin()
        snapshot = detail()
        with patch.object(main, 'get_title', return_value=snapshot), patch.object(plugin, '_save'):
            for key in ['1', '2', '3', '4', '5']:
                asyncio.run(plugin.set_achievement_tracked('42', key, True))
            self.assertFalse(asyncio.run(plugin.get_tracker_options())['enabled'])
            with self.assertRaisesRegex(ValueError, 'five'):
                asyncio.run(plugin.set_achievement_tracked('42', '6', True))
            snapshot['achievements'][0]['unlocked'] = True
            result = asyncio.run(plugin.set_achievement_tracked('42', '6', True))
            self.assertEqual(result['tracked'], ['2', '3', '4', '5', '6'])
            with self.assertRaisesRegex(ValueError, 'Unlocked'):
                asyncio.run(plugin.set_achievement_tracked('42', '1', True))

    def test_unknown_or_missing_title_cannot_be_saved(self):
        plugin = self.plugin()
        with patch.object(main, 'get_title', return_value=detail()), patch.object(plugin, '_save') as save:
            with self.assertRaises(ValueError):
                asyncio.run(plugin.set_achievement_favorite('42', 'invented', True))
            save.assert_not_called()
        with patch.object(main, 'get_title', return_value={'ok': False}), patch.object(plugin, '_save') as save:
            with self.assertRaises(ValueError):
                asyncio.run(plugin.set_achievement_favorite('../42', '1', True))
            save.assert_not_called()

    def test_failed_save_rolls_back_favorites_tracking_and_overlay_enable(self):
        plugin = self.plugin()
        before = copy.deepcopy(plugin.settings)
        with patch.object(main, 'get_title', return_value=detail()), patch.object(plugin, '_save', side_effect=OSError):
            with self.assertRaises(OSError):
                asyncio.run(plugin.set_achievement_tracked('42', '1', True))
            self.assertEqual(plugin.settings, before)
            with self.assertRaises(OSError):
                asyncio.run(plugin.set_achievement_favorite('42', '1', True))
            self.assertEqual(plugin.settings, before)

    def test_tracker_follows_running_title_masks_secrets_and_hides_unlocks(self):
        plugin = self.plugin()
        plugin.settings.update({'tracked_achievements': {'42': ['1', '2', '3'], '43': ['4']},
                                'tracker_options': {'enabled': True, 'count': 5, 'opacity': 60, 'position': 'lower-left'}})
        snapshot = detail()
        snapshot['achievements'][0]['unlocked'] = True
        plugin._localized_titles = {('uk-UA', '42'): {'3': {'name': 'Переклад', 'description': 'Опис'}}}
        plugin.settings['achievement_language'] = 'uk-UA'
        with patch.object(main, 'get_title', return_value=snapshot), patch.object(main, 'get_running_title', return_value={'titleId': '42', 'titleName': 'Game'}):
            result = asyncio.run(plugin.get_tracker_state())
            self.assertEqual([item['id'] for item in result['achievements']], ['2', '3'])
            self.assertEqual(result['achievements'][0]['name'], '')
            self.assertIsNone(result['achievements'][0]['progress'])
            self.assertEqual(result['achievements'][0]['iconUrl'], '')
            self.assertEqual(result['achievements'][1]['name'], 'Переклад')
            self.assertEqual(result['achievements'][1]['progress'], 25)
            self.assertEqual(result['tracked'], ['2', '3'])
            plugin.settings['show_secrets'] = True
            self.assertEqual(asyncio.run(plugin.get_tracker_state())['achievements'][0]['name'], 'Achievement 2')
        with patch.object(main, 'get_running_title', return_value=None):
            self.assertEqual(asyncio.run(plugin.get_tracker_state())['achievements'], [])

    def test_disabled_tracker_does_not_read_running_game(self):
        plugin = self.plugin()
        with patch.object(main, 'get_running_title') as read:
            self.assertIsNone(asyncio.run(plugin.get_tracker_state())['running'])
            read.assert_not_called()

    def test_options_validate_persist_and_limit_visible_count(self):
        plugin = self.plugin()
        with patch.object(plugin, '_save'):
            saved = asyncio.run(plugin.set_tracker_options(True, 'lower-right', 50, 2))
            self.assertEqual(saved, {'enabled': True, 'position': 'lower-right', 'opacity': 50, 'count': 2})
            for position in ['upper-left', 'center-top', 'upper-right', 'center-left', 'center-right', 'lower-left', 'center-bottom', 'lower-right']:
                self.assertEqual(asyncio.run(plugin.set_tracker_options(True, position, 50, 2))['position'], position)
            for args in [(True, 'bad', 50, 2), (True, 'upper-left', 0, 2), (True, 'upper-left', 50, 6), (True, 'upper-left', True, 2)]:
                with self.assertRaises(ValueError):
                    asyncio.run(plugin.set_tracker_options(*args))
        plugin.settings['tracked_achievements'] = {'42': ['1', '2', '3']}
        with patch.object(main, 'get_title', return_value=detail()), patch.object(main, 'get_running_title', return_value={'titleId': '42', 'titleName': 'Game'}):
            self.assertEqual(len(asyncio.run(plugin.get_tracker_state())['achievements']), 2)

    def test_live_progress_matches_ids_without_overwriting_local_unlocks(self):
        import json
        plugin = self.plugin()
        snapshot = detail()
        snapshot['achievements'][0]['unlocked'] = True
        payload = {'schema': 1, 'titleId': '42', 'items': [
            {'id': '1', 'state': 'locked', 'progress': 20},
            {'id': '2', 'state': 'in-progress', 'progress': 65},
            {'id': '3', 'state': 'unlocked', 'progress': 100},
            {'id': 'unknown', 'state': 'unlocked'},
        ]}
        plugin.settings['tracked_achievements'] = {'42': ['1', '2', '3']}
        with patch.object(plugin, '_save'), patch.object(main, 'backend_command', return_value=(['backend'], {})), \
             patch.object(main, 'run_bounded', new=AsyncMock(return_value=(0, json.dumps(payload).encode()))):
            asyncio.run(plugin._read_tracker_progress('42', snapshot))
        self.assertEqual(plugin.settings['tracked_achievements']['42'], ['1', '2'])
        merged = plugin._tracker_detail(snapshot)
        self.assertTrue(merged['achievements'][0]['unlocked'])
        self.assertEqual(merged['achievements'][1]['progress'], 65)
        self.assertTrue(merged['achievements'][2]['unlocked'])
        self.assertIsNone(merged['achievements'][2]['progress'])
        plugin.settings['tracked_achievements'] = {'42': ['1', '2', '3']}
        with patch.object(main, 'get_title', return_value=snapshot):
            self.assertEqual(plugin._achievement_preferences('42')['tracked'], ['2'])

    def test_live_refresh_is_throttled_and_cancelled_on_plugin_unload(self):
        plugin = self.plugin()
        del plugin._schedule_tracker_refresh
        async def run():
            wait = asyncio.Event()
            plugin._read_tracker_progress = AsyncMock()
            async def reader(*args): await wait.wait()
            plugin._read_tracker_progress.side_effect = reader
            with patch.object(main.time, 'monotonic', return_value=100):
                plugin._schedule_tracker_refresh('42', detail())
                await asyncio.sleep(0)
                plugin._schedule_tracker_refresh('42', detail())
                plugin._schedule_tracker_refresh('43', detail('43'))
                self.assertEqual(plugin._read_tracker_progress.call_count, 1)
                await plugin._unload()
                self.assertEqual(plugin._tracker_jobs, {})
        asyncio.run(run())

    def test_live_refresh_does_not_poll_again_within_fifteen_seconds(self):
        plugin = self.plugin()
        del plugin._schedule_tracker_refresh
        plugin._read_tracker_progress = AsyncMock()
        async def run():
            with patch.object(main.time, 'monotonic', return_value=100):
                plugin._schedule_tracker_refresh('42', detail())
                await asyncio.gather(*list(plugin._tracker_jobs.values()))
                plugin._schedule_tracker_refresh('42', detail())
                self.assertEqual(plugin._read_tracker_progress.call_count, 1)
            with patch.object(main.time, 'monotonic', return_value=116):
                plugin._schedule_tracker_refresh('42', detail())
                await asyncio.gather(*list(plugin._tracker_jobs.values()))
                self.assertEqual(plugin._read_tracker_progress.call_count, 2)
        asyncio.run(run())

    def test_unlocked_achievements_have_no_favorite_operations_or_group_membership(self):
        plugin = self.plugin()
        snapshot = detail()
        snapshot['achievements'][0]['unlocked'] = True
        plugin.settings['favorite_achievements'] = {'42': ['1']}
        with patch.object(main, 'get_title', return_value=snapshot), patch.object(plugin, '_save'):
            with self.assertRaisesRegex(ValueError, 'favorited'):
                asyncio.run(plugin.set_achievement_favorite('42', '1', True))
            with self.assertRaisesRegex(ValueError, 'favorited'):
                asyncio.run(plugin.set_achievement_favorite('42', '1', False))
            self.assertEqual(asyncio.run(plugin.get_achievement_preferences('42'))['favorites'], [])
