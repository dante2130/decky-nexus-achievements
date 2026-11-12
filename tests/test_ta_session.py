import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.request import Request

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main
import ta_session as auth
import ta_bridge
import trueachievements as ta
import ta_worker


def session_data():
    return {"authenticated": True, "userAgent": "Steam Browser Test", "cookies": [
        {"name": "GamerToken", "value": "fixture-secret", "domain": ".trueachievements.com", "path": "/", "expires": -1, "httpOnly": True},
        {"name": "Microsoft", "value": "must-not-store", "domain": ".live.com", "path": "/", "expires": -1},
        {"name": "bad", "value": "header\r\ninjection", "domain": ".trueachievements.com", "expires": -1}]}


class SessionTests(unittest.TestCase):
    def test_verified_session_persists_privately_and_status_never_exposes_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'ta' / 'session.json'
            session = auth.TASession(path)
            self.assertEqual(session.status(), {"status": "disconnected"})
            self.assertEqual(session.connect(session_data()), {"status": "connected"})
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            saved = json.loads(path.read_text())
            self.assertEqual([c['name'] for c in saved['cookies']], ['GamerToken'])
            self.assertNotIn('fixture-secret', json.dumps(session.status()))
            self.assertNotIn('must-not-store', path.read_text())
            restored = auth.TASession(path)
            self.assertEqual(restored.status(), {"status": "saved"})
            with patch.object(ta, 'fetch_page', return_value='html') as fetch:
                self.assertEqual(restored.fetch(ta.ORIGIN + '/deeplink/42'), 'html')
                self.assertEqual(fetch.call_args.args[2], 'Steam Browser Test')
                request = Request(ta.ORIGIN + '/')
                fetch.call_args.args[1].add_cookie_header(request)
                self.assertEqual(request.get_header('Cookie'), 'GamerToken=fixture-secret')
                other = Request('https://login.live.com/')
                fetch.call_args.args[1].add_cookie_header(other)
                self.assertIsNone(other.get_header('Cookie'))
            self.assertEqual(restored.disconnect(), {"status": "disconnected"})
            self.assertFalse(path.exists())
            self.assertEqual(list(restored.jar), [])

    def test_anonymous_expired_and_invalid_sessions_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            session = auth.TASession(Path(directory) / 'session.json')
            for changes in [{'authenticated': False}, {'cookies': []}, {'userAgent': 'bad\r\nheader'},
                            {'cookies': [{**session_data()['cookies'][0], 'expires': 1}]}]:
                with self.assertRaises(auth.SessionError):
                    session.connect({**session_data(), **changes})
            self.assertFalse(session.path.exists())
            session.path.write_text('{broken')
            self.assertEqual(auth.TASession(session.path).status(), {'status': 'disconnected'})

    def test_expiry_is_reported_and_failed_reconnect_preserves_existing_session(self):
        with tempfile.TemporaryDirectory() as directory:
            session = auth.TASession(Path(directory) / 'session.json')
            session.connect(session_data())
            with self.assertRaises(auth.SessionError):
                session.connect({**session_data(), 'authenticated': False})
            self.assertEqual(session.status()['status'], 'connected')
            for cookie in session.jar:
                cookie.expires = 1
            self.assertEqual(session.status()['status'], 'expired')

    def test_worker_connect_invalidates_backoff_and_disconnect_removes_session(self):
        async def run(directory):
            session = auth.TASession(Path(directory) / 'session.json')
            client = ta.TrueAchievements(Path(directory), session)
            client.attempts['42'] = 100
            with patch.object(main, "browser_session", new=AsyncMock(return_value=session_data())):
                plugin = main.Plugin()
                plugin._ta_worker = ta_bridge.TAWorker(Path(directory))
                try:
                    self.assertEqual(await plugin.connect_ta_session(), {"status": "connected"})
                finally:
                    await plugin._ta_worker.close()
            session = auth.TASession(Path(directory) / "session.json")
            self.assertEqual(await ta_worker.dispatch(client, session, {
                "action": "connect", "detail": session_data(),
            }), {"status": "connected"})
            self.assertEqual(client.attempts, {})
            self.assertGreater(client.refresh_after, 0)
            self.assertEqual(await ta_worker.dispatch(client, session, {"action": "status"}), {"status": "connected"})
            self.assertEqual(await ta_worker.dispatch(client, session, {"action": "disconnect"}), {"status": "disconnected"})
            self.assertFalse(session.path.exists())
        with tempfile.TemporaryDirectory() as directory:
            asyncio.run(run(directory))

    def test_worker_errors_are_sanitized(self):
        async def run(directory):
            session = auth.TASession(Path(directory) / 'session.json')
            client = ta.TrueAchievements(Path(directory), session)
            with patch.object(session, 'connect', side_effect=RuntimeError('fixture-secret')):
                result = await ta_worker.dispatch(client, session, {'action': 'connect'})
                self.assertEqual(result['error'], 'verification_failed')
                self.assertNotIn('fixture-secret', json.dumps(result))
        with tempfile.TemporaryDirectory() as directory:
            asyncio.run(run(directory))


class Context:
    def __init__(self, value): self.value = value
    async def __aenter__(self): return self.value
    async def __aexit__(self, *args): pass


class BrowserSessionTests(unittest.TestCase):
    def test_scoped_cookie_query_checks_origin_and_authentication(self):
        calls = []
        class WS:
            async def send_json(self, command):
                calls.append(command)
                self.command = command
            async def receive_json(self):
                command = self.command
                result = {'result': {'value': json.dumps({'origin': ta.ORIGIN, 'authenticated': True, 'userAgent': 'Steam'})}} if command['id'] == 1 else {'cookies': session_data()['cookies']}
                return {'id': command['id'], 'result': result}
        class Client:
            def get(self, url, **kwargs):
                self.url = url
                async def response():
                    return [{'url': 'https://login.live.com', 'webSocketDebuggerUrl': 'ws://127.0.0.1:8080/devtools/page/other'},
                            {'url': ta.ORIGIN, 'webSocketDebuggerUrl': 'ws://127.0.0.1:8080/devtools/page/ta'}]
                return Context(SimpleNamespace(json=response))
            def ws_connect(self, url, **kwargs):
                self.websocket = url
                return Context(WS())
        client = Client()
        with patch.dict(sys.modules, {'aiohttp': SimpleNamespace(ClientSession=lambda **kwargs: Context(client), ClientTimeout=lambda **kwargs: None)}):
            result = asyncio.run(ta_bridge.browser_session())
        self.assertTrue(result['authenticated'])
        self.assertEqual(client.url, 'http://127.0.0.1:8080/json')
        self.assertTrue(client.websocket.endswith('/ta'))
        self.assertEqual(calls[1]['method'], 'Network.getCookies')
        self.assertEqual(calls[1]['params'], {'urls': [ta.ORIGIN + '/']})
        self.assertNotIn('document.cookie', calls[0]['params']['expression'])

    def test_unavailable_browser_has_actionable_error(self):
        class Client:
            def get(self, *args, **kwargs):
                async def response(): return []
                return Context(SimpleNamespace(json=response))
        with patch.dict(sys.modules, {'aiohttp': SimpleNamespace(ClientSession=lambda **kwargs: Context(Client()), ClientTimeout=lambda **kwargs: None)}):
            with self.assertRaisesRegex(auth.SessionError, 'browser_unavailable'):
                asyncio.run(ta_bridge.browser_session())

    def test_remote_debugger_addresses_are_never_contacted(self):
        class Client:
            def get(self, *args, **kwargs):
                async def response():
                    return [{'url': ta.ORIGIN, 'webSocketDebuggerUrl': 'ws://evil.test:8080/devtools/page/ta'}]
                return Context(SimpleNamespace(json=response))
            def ws_connect(self, *args, **kwargs):
                raise AssertionError('Must not contact a remote debugger')
        with patch.dict(sys.modules, {'aiohttp': SimpleNamespace(ClientSession=lambda **kwargs: Context(Client()), ClientTimeout=lambda **kwargs: None)}):
            with self.assertRaises(auth.SessionError):
                asyncio.run(ta_bridge.browser_session())
