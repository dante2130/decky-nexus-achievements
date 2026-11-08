"""Nexus Achievements Decky backend.

Tails a JSONL file written by the Nexus guest bridge and forwards each
achievement event to the frontend, which shows a toast.
"""
import asyncio
import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

try:
    import decky
except ImportError:  # unit tests run outside Decky Loader
    decky = None

DEFAULT_RELATIVE = ".local/share/nexus-launcher/achievement-events.jsonl"
POLL_SECONDS = 0.5
MAX_LINE = 64 * 1024
DEFAULT_SETTINGS = {"enabled": True, "duration": 8000, "events_path": ""}


def user_home() -> Path:
    # Decky may run as root; prefer the Deck user's home.
    for value in (os.environ.get("DECKY_USER_HOME"), getattr(decky, "DECKY_USER_HOME", None)):
        if value:
            return Path(value)
    return Path.home()


def resolve_events_path(setting: str = "") -> Path:
    for value in (setting, os.environ.get("NEXUS_ACHIEVEMENT_EVENTS")):
        value = (value or "").strip()
        if not value:
            continue
        if value == "~" or value.startswith("~/"):
            return user_home() / value[1:].lstrip("/")
        return Path(value)
    return user_home() / DEFAULT_RELATIVE


def parse_event(line: bytes) -> Optional[Dict[str, Any]]:
    if len(line) > MAX_LINE:
        return None
    try:
        value = json.loads(line.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(value, dict) or value.get("type") != "achievement":
        return None
    if not isinstance(value.get("name"), str) or not value["name"]:
        return None
    return value


class Tailer:
    """Incremental JSONL reader that starts at EOF and survives rotation."""

    def __init__(self, path: Path):
        self.path = path
        self.inode: Optional[int] = None
        self.offset = 0
        self.buffer = b""
        self.started = False

    def poll(self):
        events = []
        try:
            st = os.stat(self.path)
        except OSError:
            self.inode = None
            self.started = True
            return events
        if self.inode is None:
            # Skip history present at startup; read a later-created file from the start.
            self.inode = st.st_ino
            self.offset = st.st_size if not self.started else 0
            self.buffer = b""
            self.started = True
        elif st.st_ino != self.inode or st.st_size < self.offset:
            self.inode = st.st_ino
            self.offset = 0
            self.buffer = b""
        if st.st_size <= self.offset:
            return events
        with open(self.path, "rb") as handle:
            handle.seek(self.offset)
            data = handle.read(min(st.st_size - self.offset, 1024 * 1024))
        self.offset += len(data)
        self.buffer += data
        *lines, self.buffer = self.buffer.split(b"\n")
        if len(self.buffer) > MAX_LINE:
            self.buffer = b""
        for line in lines:
            event = parse_event(line.strip())
            if event:
                events.append(event)
        return events


class Plugin:
    settings: Dict[str, Any] = dict(DEFAULT_SETTINGS)
    task: Optional["asyncio.Task[None]"] = None

    def _settings_file(self) -> Path:
        return Path(decky.DECKY_PLUGIN_SETTINGS_DIR) / "settings.json"

    def _load(self):
        try:
            data = json.loads(self._settings_file().read_text())
            if isinstance(data, dict):
                self.settings = {**DEFAULT_SETTINGS, **{k: data[k] for k in DEFAULT_SETTINGS if k in data}}
        except (OSError, ValueError):
            self.settings = dict(DEFAULT_SETTINGS)

    def _save(self):
        path = self._settings_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.settings))

    async def get_settings(self) -> Dict[str, Any]:
        return {**self.settings, "resolved_path": str(resolve_events_path(self.settings["events_path"]))}

    async def set_settings(self, enabled: bool, duration: int, events_path: str = "") -> Dict[str, Any]:
        duration = max(1000, min(60000, int(duration)))
        changed = events_path != self.settings["events_path"]
        self.settings = {"enabled": bool(enabled), "duration": duration, "events_path": str(events_path)}
        self._save()
        if changed:
            await self._restart()
        return await self.get_settings()

    async def test_notification(self) -> None:
        await decky.emit("achievement", {
            "type": "achievement", "ts": "", "titleId": "test", "scid": "", "id": "0",
            "name": "Test achievement", "description": "Nexus notifications work.",
            "gamerscore": 10, "iconUrl": "",
        })

    async def _watch(self):
        tailer = Tailer(resolve_events_path(self.settings["events_path"]))
        while True:
            try:
                for event in tailer.poll():
                    if self.settings["enabled"]:
                        await decky.emit("achievement", event)
            except asyncio.CancelledError:
                raise
            except Exception as error:  # keep tailing on transient errors
                decky.logger.error(f"achievement tail error: {error}")
            await asyncio.sleep(POLL_SECONDS)

    async def _restart(self):
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
        self.task = asyncio.get_event_loop().create_task(self._watch())

    async def _main(self):
        self._load()
        await self._restart()

    async def _unload(self):
        if self.task:
            self.task.cancel()
