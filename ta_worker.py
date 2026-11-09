"""Private JSONL worker launched only with the system Python interpreter."""
import asyncio
import json
import sys
import time
from pathlib import Path

from ta_session import TASession, SessionError, browser_session
from trueachievements import TrueAchievements


async def dispatch(client, session, request):
    action = request.get("action")
    if action == "metadata":
        try:
            return client.get(request.get("detail") or {})
        except Exception:
            return {"status": "unavailable", "achievements": {}}
    if action == "status":
        return session.status()
    if action == "disconnect":
        result = session.disconnect()
        client.attempts.clear()
        return result
    if action == "connect":
        try:
            data = await browser_session()
            result = session.connect(data)
            client.attempts.clear()
            client.refresh_after = time.time()
            return result
        except SessionError as error:
            return {**session.status(), "error": str(error)}
        except Exception:
            return {**session.status(), "error": "verification_failed"}
    return {"error": "invalid_action"}


def serve(directory):
    session = TASession(directory / "session.json")
    client = TrueAchievements(directory, session)
    # One event loop, one ordered request at a time; no credential output/logging.
    loop = asyncio.new_event_loop()
    try:
        while True:
            raw = sys.stdin.buffer.readline(4 * 1024 * 1024 + 1)
            if not raw:
                return
            if len(raw) > 4 * 1024 * 1024:
                return
            try:
                request = json.loads(raw)
                result = loop.run_until_complete(dispatch(client, session, request))
            except Exception:
                result = {"error": "verification_failed"}
            print(json.dumps(result), flush=True)
    finally:
        loop.close()


if __name__ == "__main__":
    serve(Path(sys.argv[1]))
