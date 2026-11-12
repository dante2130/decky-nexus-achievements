"""Run optional TA dependencies outside Decky's stripped-down frozen Python."""
import asyncio
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

MAX_MESSAGE = 4 * 1024 * 1024
ORIGIN = "https://www.trueachievements.com"


class SessionError(Exception):
    pass


def safe_url(url):
    parsed = urlsplit(url)
    return parsed.scheme == "https" and parsed.netloc == "www.trueachievements.com"


async def browser_session():
    async def command(ws, command_id, method, params):
        await ws.send_json({"id": command_id, "method": method, "params": params})
        while True:
            response = await ws.receive_json()
            if response.get("id") == command_id:
                if "error" in response:
                    raise SessionError("browser_unavailable")
                return response.get("result", {})

    async def read():
        from aiohttp import ClientSession, ClientTimeout

        async with ClientSession(timeout=ClientTimeout(total=5)) as client:
            async with client.get("http://127.0.0.1:8080/json", allow_redirects=False) as response:
                targets = await response.json()
            if not isinstance(targets, list):
                raise SessionError("browser_unavailable")
            saw_ta = False
            for target in targets:
                if (not isinstance(target, dict) or target.get("type", "page") != "page"
                        or not safe_url(target.get("url", ""))):
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
                except (SessionError, OSError, ValueError):
                    continue
            raise SessionError("login_required" if saw_ta else "browser_unavailable")
    try:
        return await asyncio.wait_for(read(), timeout=12)
    except SessionError:
        raise
    except Exception:
        raise SessionError("browser_unavailable") from None


class TAWorker:
    def __init__(self, directory):
        self.directory = directory
        self.process = None
        self.lock = asyncio.Lock()

    async def close(self):
        process, self.process = self.process, None
        if process is not None:
            if process.returncode is None:
                process.kill()
            await process.wait()

    async def call(self, action, detail=None):
        async with self.lock:
            try:
                if self.process is None or self.process.returncode is not None:
                    env = dict(os.environ)
                    # The system interpreter must not inherit PyInstaller's libraries.
                    for key in ("PYTHONHOME", "PYTHONPATH", "LD_LIBRARY_PATH"):
                        env.pop(key, None)
                    if os.environ.get("LD_LIBRARY_PATH_ORIG"):
                        env["LD_LIBRARY_PATH"] = os.environ["LD_LIBRARY_PATH_ORIG"]
                    python = "/usr/bin/python3" if getattr(sys, "frozen", False) else sys.executable
                    self.process = await asyncio.create_subprocess_exec(
                        python, str(Path(__file__).with_name("ta_worker.py")), str(self.directory),
                        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.DEVNULL, env=env, limit=MAX_MESSAGE)
                payload = json.dumps({"action": action, "detail": detail}).encode() + b"\n"
                if len(payload) > MAX_MESSAGE:
                    raise ValueError("TA request too large")

                async def exchange():
                    self.process.stdin.write(payload)
                    await self.process.stdin.drain()
                    response = await self.process.stdout.readline()
                    if not response or len(response) > MAX_MESSAGE:
                        raise ValueError("Invalid TA worker response")
                    result = json.loads(response)
                    if not isinstance(result, dict):
                        raise ValueError("Invalid TA worker response")
                    return result
                return await asyncio.wait_for(exchange(), timeout=40)
            except BaseException:
                await self.close()
                raise
