"""Run optional TA dependencies outside Decky's stripped-down frozen Python."""
import asyncio
import json
import os
import sys
from pathlib import Path

MAX_MESSAGE = 4 * 1024 * 1024


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
