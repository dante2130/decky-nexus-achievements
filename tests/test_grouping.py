import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main


class GroupingTests(unittest.TestCase):
    def test_grouping_persists_across_settings_updates_and_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            settings_file = Path(directory) / "settings.json"
            plugin = main.Plugin()
            plugin._settings_file = lambda: settings_file
            plugin.settings = dict(main.DEFAULT_SETTINGS)
            self.assertFalse(plugin.settings["group_achievements"])
            self.assertTrue(asyncio.run(plugin.set_group_achievements(True)))
            asyncio.run(plugin.set_settings(True, 5000))
            restored = main.Plugin()
            restored._settings_file = lambda: settings_file
            restored._load()
            self.assertTrue(restored.settings["group_achievements"])
            self.assertFalse(asyncio.run(restored.set_group_achievements(False)))

    def test_failed_save_keeps_previous_grouping_preference(self):
        plugin = main.Plugin()
        plugin.settings = dict(main.DEFAULT_SETTINGS)
        with patch.object(plugin, "_save", side_effect=OSError("read only")):
            with self.assertRaises(OSError):
                asyncio.run(plugin.set_group_achievements(True))
        self.assertFalse(plugin.settings["group_achievements"])
