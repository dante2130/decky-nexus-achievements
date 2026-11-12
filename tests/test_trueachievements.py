import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main
import trueachievements as ta
import ta_worker

# A minimal parser contract fixture, not a captured live TA response.
HTML = '''<ul class="achievements">
<li class="achievement"><a href="/a123/first-steps-achievement"><img src="icon"></a>
<a href="/a123/first-steps-achievement">First Steps</a><p>Start playing</p>
<span title="Missable"><i></i></span></li>
<li class="achievement"><a href="/a124/the-end-achievement">The End</a>
<p>This guide mentions missable items, but that is not a flag.</p></li></ul>'''


def detail():
    return {"ok": True, "titleId": "42", "achievements": [
        {"id": "scid:1", "name": "First Steps"}, {"id": "scid:2", "name": "The End"}]}


class TrueAchievementsTests(unittest.TestCase):
    def test_named_packs_are_scoped_to_their_achievement_sections(self):
        html = '''<h2>Base Game (Excludes DLC)</h2>
        <ul class="ach-panels"><li><a href="/a123/first-steps-achievement">First Steps</a></li></ul>
        <h2>Brushes with Death</h2>
        <ul class="ach-panels"><li><a href="/a124/the-end-achievement">The End</a></li></ul>
        <h2>Legacy of the Forge</h2>
        <ul class="ach-panels"><li><a href="/a125/forge-achievement">The Forge</a></li></ul>
        <h2>DLC Information</h2>
        <ul><li><a href="/a126/other-achievement">Other</a></li></ul>'''
        rows = ta.parse_page(html)
        self.assertEqual([row.get("bundle") for row in rows],
                         [None, "Brushes with Death", "Legacy of the Forge", None])
        matched = ta.match_rows(detail()["achievements"], rows)
        self.assertNotIn("bundle", matched["scid:1"])
        self.assertEqual(matched["scid:2"]["bundle"], "Brushes with Death")

    def test_live_ta_bitmask_format_decodes_every_assigned_flag(self):
        html = '''<ul class="ach-panels"><li class="w">
          <a class="title" href="/a291813/death-incarnate-achievement#123">Death Incarnate</a>
          <div class="info"><a href="/a291813/death-incarnate-achievement#oAddSolution">Add a guide</a>
          <i class="flg-5E000000"></i></div></li>
          <li><a class="title" href="/a123/first-steps-achievement">First Steps</a>
          <i class="flg-50080000"></i></li></ul>'''
        rows = ta.parse_page(html)
        self.assertEqual(rows[0]['name'], 'Death Incarnate')
        self.assertEqual(set(rows[0]['flags']), {'offline', 'single-player', 'main-storyline', 'difficulty-specific', 'stackable'})
        self.assertEqual(set(rows[1]['flags']), {'offline', 'single-player', 'missable'})
        all_flags = ta.parse_page(html.replace('flg-5E000000', 'flg-FFFFFFFF'))[0]['flags']
        self.assertEqual(set(all_flags), ta.FLAG_IDS)

    def test_rpc_matches_english_names_without_changing_display_snapshot(self):
        plugin = main.Plugin()
        original = {'ok': True, 'titleId': '42', 'achievements': [{'id': 'scid:1', 'name': 'Первые шаги'}]}
        english = {**original, 'achievements': [{'id': 'scid:1', 'name': 'First Steps'}]}
        async def run():
            with patch.object(main, 'get_title', return_value=original), \
                 patch.object(main, 'translate_title', new=AsyncMock(return_value=english)) as translate, \
                 patch.object(plugin, '_ta_call', new=AsyncMock(return_value={})) as worker:
                await plugin.get_trueachievements('42')
                self.assertEqual(translate.call_args.args[2], 'en-US')
                self.assertEqual(worker.call_args.args[1]['achievements'][0]['name'], 'First Steps')
                self.assertEqual(worker.call_args.args[1]['achievements'][0]['id'], 'scid:1')
                self.assertEqual(original['achievements'][0]['name'], 'Первые шаги')
                await plugin.get_trueachievements('42')
                self.assertEqual(translate.call_count, 1)
        asyncio.run(run())

    def test_flags_are_scoped_to_rows_and_never_inferred_from_prose(self):
        rows = ta.parse_page(HTML)
        self.assertEqual([row["missable"] for row in rows], [True, False])
        mapped = ta.match_rows(detail()["achievements"], rows)
        self.assertTrue(mapped["scid:1"]["missable"])
        self.assertFalse(mapped["scid:2"]["missable"])

    def test_matching_is_conservative_and_uses_stable_snapshot_ids(self):
        rows = ta.parse_page(HTML)
        self.assertEqual(ta.match_rows([{"id": "1", "name": "FIRST   Steps"}], rows)["1"]["missable"], True)
        self.assertEqual(ta.match_rows([{"id": "1", "name": "Translated name"}], rows), {})
        self.assertEqual(ta.match_rows([{"id": "1", "name": "First Steps"}, {"id": "2", "name": "First Steps"}], rows), {})
        self.assertEqual(ta.match_rows(detail()["achievements"], rows + rows), {})

    def test_invalid_pages_and_offsite_links(self):
        for html in ['<html>Just a moment...</html>', HTML.replace('/a123/', 'https://evil.test/a123/').replace('/a124/', 'https://evil.test/a124/')]:
            with self.assertRaises(ValueError):
                ta.parse_page(html)
        for value in ['../42', 'abc', '', 42]:
            with self.assertRaises(ValueError):
                ta.title_link(value)
        self.assertFalse(ta.safe_url('https://www.trueachievements.com.evil.test/game'))
        self.assertFalse(ta.safe_url('http://www.trueachievements.com/game'))

    def test_disk_cache_ttl_failure_backoff_and_stale_flags(self):
        with tempfile.TemporaryDirectory() as directory:
            client = ta.TrueAchievements(Path(directory))
            with patch.object(ta, 'fetch_page', return_value=HTML) as fetch, patch.object(ta.time, 'time', return_value=100000):
                first = client.get(detail())
                self.assertEqual(first['status'], 'ready')
                self.assertEqual(client.get(detail()), first)
                fresh_client = ta.TrueAchievements(Path(directory))
                self.assertEqual(fresh_client.get(detail()), first)
                self.assertEqual(fetch.call_count, 1)
            with patch.object(ta, 'fetch_page', side_effect=OSError('403')) as fetch, patch.object(ta.time, 'time', return_value=200000):
                result = fresh_client.get(detail())
                self.assertEqual(result['status'], 'stale')
                self.assertTrue(result['achievements']['scid:1']['missable'])
                fresh_client.get(detail())
                self.assertEqual(fetch.call_count, 1)

    def test_unavailable_is_not_an_empty_success_and_retries_are_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            client = ta.TrueAchievements(Path(directory))
            with patch.object(ta, 'fetch_page', side_effect=OSError('403')) as fetch:
                self.assertEqual(client.get(detail())['status'], 'unavailable')
                self.assertEqual(client.get(detail())['achievements'], {})
                self.assertEqual(fetch.call_count, 1)

    def test_unrelated_redirect_cannot_be_cached(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(ta, 'fetch_page', return_value=HTML):
            result = ta.TrueAchievements(Path(directory)).get({**detail(), 'achievements': [{'id': '1', 'name': 'Other game'}]})
            self.assertEqual(result['status'], 'unavailable')
            self.assertFalse((Path(directory) / '42.json').exists())

    def test_corrupt_cache_is_ignored(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(ta, 'fetch_page', side_effect=OSError):
            path = Path(directory) / '42.json'
            for value in [None, {'titleId': '42', 'rows': [None]},
                          {'titleId': '42', 'updatedAt': 100000, 'rows': [{'name': 'First Steps', 'url': 'https://evil.test', 'missable': True}]}]:
                path.write_text(json.dumps(value))
                self.assertEqual(ta.TrueAchievements(Path(directory)).get(detail())['status'], 'unavailable')

    def test_rpc_uses_original_snapshot_independent_of_language(self):
        plugin = main.Plugin()
        plugin.settings = {**main.DEFAULT_SETTINGS, 'achievement_language': 'uk'}
        with tempfile.TemporaryDirectory() as directory, patch.object(main, 'get_title', return_value=detail()), \
             patch.object(plugin, '_settings_file', return_value=Path(directory) / 'settings.json'), \
             patch.object(plugin, '_ta_call', new=AsyncMock(side_effect=lambda action, snapshot: ta.TrueAchievements(Path(directory)).get(snapshot))), \
             patch.object(ta, 'fetch_page', return_value=HTML):
            result = asyncio.run(plugin.get_trueachievements('42'))
            self.assertTrue(result['achievements']['scid:1']['missable'])


if __name__ == '__main__':
    unittest.main()
