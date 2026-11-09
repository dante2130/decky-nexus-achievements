"""Explicitly connect the user's Steam browser TA session; never collect passwords."""
import asyncio
import json
import math
import os
import re
import tempfile
import time
from http.cookiejar import Cookie, CookieJar
from urllib.parse import urlsplit

import trueachievements
from trueachievements import ORIGIN, safe_url


class SessionError(Exception):
    pass


def cookie_jar(cookies):
    jar = CookieJar()
    if not isinstance(cookies, list) or len(cookies) > 300:
        raise SessionError("login_required")
    for item in cookies:
        if not isinstance(item, dict):
            continue
        domain = item.get("domain", "")
        if domain not in {"trueachievements.com", ".trueachievements.com", "www.trueachievements.com", ".www.trueachievements.com"}:
            continue
        name, value, path = item.get("name"), item.get("value"), item.get("path", "/")
        if (not isinstance(name, str) or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name)
                or not isinstance(value, str) or len(value) > 16384
                or re.search(r"[\x00-\x20\x7f;]", value)
                or not isinstance(path, str) or not path.startswith("/") or re.search(r"[\r\n]", path)):
            continue
        expires = item.get("expires", -1)
        if isinstance(expires, bool) or not isinstance(expires, (float, int)) or not math.isfinite(expires):
            continue
        expires = int(expires) if expires > 0 else None
        if expires is not None and expires <= time.time():
            continue
        jar.set_cookie(Cookie(0, name, value, None, False, domain, domain.startswith("."), domain.startswith("."),
                              path, True, True, expires, expires is None, None, None,
                              {"HttpOnly": None} if item.get("httpOnly") else {}, False))
    return jar


async def browser_session():
    # aiohttp ships with Decky Loader. Import lazily for standalone backend tests.
    from aiohttp import ClientSession, ClientTimeout

    async def command(ws, command_id, method, params):
        await ws.send_json({"id": command_id, "method": method, "params": params})
        while True:
            response = await ws.receive_json()
            if response.get("id") == command_id:
                if "error" in response:
                    raise SessionError("browser_unavailable")
                return response.get("result", {})

    async def read():
        async with ClientSession(timeout=ClientTimeout(total=5)) as client:
            async with client.get("http://127.0.0.1:8080/json", allow_redirects=False) as response:
                targets = await response.json()
            if not isinstance(targets, list):
                raise SessionError("browser_unavailable")
            saw_ta = False
            for target in targets:
                if not isinstance(target, dict) or not safe_url(target.get("url", "")):
                    continue
                saw_ta = True
                websocket = target.get("webSocketDebuggerUrl", "")
                parsed = urlsplit(websocket)
                if (parsed.scheme != "ws" or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}
                        or parsed.port != 8080 or parsed.username or parsed.password):
                    continue
                try:
                    async with client.ws_connect(websocket, max_msg_size=1024 * 1024) as ws:
                        expression = """JSON.stringify({origin:location.origin,userAgent:navigator.userAgent,
                          authenticated:Array.from(document.querySelectorAll('a')).some(a =>
                            [a.textContent,a.getAttribute('title'),a.getAttribute('aria-label')].some(label =>
                              ['sign out','log out','logout','sign off'].includes((label || '').trim().toLowerCase().replace(/\\s+/g,' '))) ||
                            /(?:^|\\/)(?:logout|logoff|signout)(?:[.?/#]|$)/i.test(a.getAttribute('href') || ''))})"""
                        result = await command(ws, 1, "Runtime.evaluate", {"expression": expression, "returnByValue": True})
                        info = json.loads(result.get("result", {}).get("value", "{}"))
                        # Recheck after connecting: login redirects can change a target.
                        if info.get("origin") != ORIGIN:
                            continue
                        if info.get("authenticated") is not True:
                            continue
                        result = await command(ws, 2, "Network.getCookies", {"urls": [ORIGIN + "/"]})
                        return {"cookies": result.get("cookies", []), "userAgent": info.get("userAgent", ""), "authenticated": True}
                except SessionError:
                    continue
            raise SessionError("login_required" if saw_ta else "browser_unavailable")
    try:
        return await asyncio.wait_for(read(), timeout=12)
    except SessionError:
        raise
    except Exception:
        raise SessionError("browser_unavailable") from None


class TASession:
    def __init__(self, path, load=True):
        self.path = path
        self.cookies = []
        self.user_agent = ""
        self.state = "disconnected"
        self.jar = CookieJar()
        if not load:
            return
        try:
            data = json.loads(path.read_text())
            self._assign(data)
            self.state = "saved" if list(self.jar) else "disconnected"
        except (OSError, ValueError, TypeError, AttributeError, SessionError):
            self.jar = CookieJar()

    def _assign(self, data):
        ua = data.get("userAgent", "")
        if not isinstance(ua, str) or not ua or len(ua) > 1024 or re.search(r"[\r\n\x00]", ua):
            raise SessionError("login_required")
        self.jar = cookie_jar(data.get("cookies"))
        self.cookies = data["cookies"]
        self.user_agent = ua

    def fetch(self, url):
        return trueachievements.fetch_page(url, self.jar, self.user_agent)

    def status(self):
        # Deliberately return no cookies, tokens, file paths, or raw exceptions.
        if self.state != "disconnected" and not any(not c.is_expired() for c in self.jar):
            self.state = "expired"
        return {"status": self.state}

    def connect(self, data):
        candidate = TASession(self.path, load=False)
        candidate._assign(data)
        if not list(candidate.jar) or data.get("authenticated") is not True:
            raise SessionError("login_required")
        # Store only the accepted TA cookies, not unrelated browser data.
        accepted = {(c.name, c.domain, c.path) for c in candidate.jar}
        cookies = [c for c in data["cookies"] if isinstance(c, dict) and (c.get("name"), c.get("domain"), c.get("path", "/")) in accepted]
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".ta-session-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w") as handle:
                os.fchmod(handle.fileno(), 0o600)
                json.dump({"cookies": cookies, "userAgent": candidate.user_agent}, handle)
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        self._assign({"cookies": cookies, "userAgent": candidate.user_agent})
        self.state = "connected"
        return self.status()

    def disconnect(self):
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass
        self.cookies = []
        self.jar = CookieJar()
        self.user_agent = ""
        self.state = "disconnected"
        return self.status()
