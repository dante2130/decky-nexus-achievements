"""Explicitly connect the user's Steam browser TA session; never collect passwords."""
import json
import math
import os
import re
import tempfile
import time
from http.cookiejar import Cookie, CookieJar

import trueachievements
from ta_bridge import SessionError


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
