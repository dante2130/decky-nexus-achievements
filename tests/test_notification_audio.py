import asyncio
import base64
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main


class NotificationAudioTests(unittest.TestCase):
    def test_select_read_restore_and_persist_separate_sounds(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(main, 'user_home', return_value=Path(folder)):
            home = Path(folder)
            file = home / 'custom.wav'
            file.write_bytes(b'RIFFtestWAVE')
            plugin = main.Plugin()
            plugin.settings = dict(main.DEFAULT_SETTINGS)
            plugin._settings_file = lambda: home / 'settings.json'
            asyncio.run(plugin.set_notification_sound('rare', str(file)))
            restored = main.Plugin()
            restored._settings_file = plugin._settings_file
            restored._load()
            value = asyncio.run(restored.get_notification_audio('rare'))
            self.assertEqual(base64.b64decode(value['data']), file.read_bytes())
            self.assertEqual(value['mime'], 'audio/wav')
            self.assertEqual(asyncio.run(restored.get_notification_audio('normal')), {})
            asyncio.run(restored.set_notification_sound('mythic', str(file)))
            sounds = asyncio.run(restored.set_notification_sound('rare', ''))
            self.assertEqual(sounds, {'mythic': str(file.resolve())})
            with patch.object(restored, '_save', side_effect=OSError('read only')):
                with self.assertRaises(OSError):
                    asyncio.run(restored.set_notification_sound('normal', str(file)))
            self.assertNotIn('normal', restored.settings['notification_sounds'])

    def test_sound_length_sets_and_enforces_timeout_minimum(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(main, 'user_home', return_value=Path(folder)):
            home = Path(folder)
            file = home / 'long.wav'
            file.write_bytes(b'RIFFtestWAVE')
            plugin = main.Plugin()
            plugin.settings = dict(main.DEFAULT_SETTINGS)
            plugin._settings_file = lambda: home / 'settings.json'
            for kind in ('normal', 'rare', 'mythic'):
                asyncio.run(plugin.set_notification_sound(kind, str(file)))
                saved = asyncio.run(plugin.set_notification_sound_duration(kind, str(file.resolve()), 40400))
                self.assertEqual(saved['notification_sound_durations'][kind], 41000)
                if kind == 'normal':
                    self.assertEqual(saved['duration'], 41000)
                    saved = asyncio.run(plugin.set_settings(True, 8000))
                    self.assertEqual(saved['duration'], 41000)
                else:
                    self.assertEqual(saved['notification_durations'][kind], 41000)
                    durations = asyncio.run(plugin.set_notification_duration(kind, 8000))
                    self.assertEqual(durations[kind], 41000)
            with self.assertRaises(ValueError):
                asyncio.run(plugin.set_notification_sound_duration('rare', '/old.wav', 5000))
            asyncio.run(plugin.set_notification_sound('rare', ''))
            self.assertNotIn('rare', plugin.settings['notification_sound_durations'])
            self.assertEqual(asyncio.run(plugin.set_notification_duration('rare', 8000))['rare'], 8000)
            restored = main.Plugin()
            restored._settings_file = plugin._settings_file
            restored._load()
            self.assertEqual(restored.settings['notification_sound_durations']['mythic'], 41000)

    def test_invalid_audio_and_paths_do_not_change_configuration(self):
        with tempfile.TemporaryDirectory() as folder, tempfile.TemporaryDirectory() as outside, patch.object(main, 'user_home', return_value=Path(folder)):
            home = Path(folder)
            plugin = main.Plugin()
            plugin.settings = dict(main.DEFAULT_SETTINGS)
            plugin._save = lambda: None
            invalid = [home / 'empty.wav', home / 'bad.txt', home / 'large.mp3', Path(outside) / 'outside.wav']
            for file in invalid:
                file.write_bytes(b'x')
            invalid[0].write_bytes(b'')
            with invalid[2].open('wb') as stream:
                stream.truncate(main.MAX_AUDIO_BYTES + 1)
            link = home / 'link.wav'
            link.symlink_to(invalid[3])
            for file in [*invalid, link, home / 'missing.wav']:
                with self.assertRaises(ValueError):
                    asyncio.run(plugin.set_notification_sound('rare', str(file)))
            with self.assertRaises(ValueError):
                asyncio.run(plugin.set_notification_sound('unknown', ''))
            self.assertEqual(plugin.settings['notification_sounds'], {})
