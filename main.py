"""Nexus Achievements Decky backend.

Tails a JSONL file written by the Nexus guest bridge and forwards each
achievement event to the frontend, which shows a toast.
"""
import asyncio
import base64
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional
# Decky loads main.py by filename without adding the plugin directory to sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from achievement_language import (
    LANGUAGES, UNIFIDECK_TITLE_PREFIX, backend_command, run_bounded, translate_title, unifideck_root,
)
from ta_bridge import SessionError, TAWorker, browser_session
from mythic import MythicTracker
from steam_menu import shortcut_game

try:
    import decky
except ImportError:  # unit tests run outside Decky Loader
    decky = None

DEFAULT_RELATIVE = ".local/share/nexus-launcher/achievement-events.jsonl"
POLL_SECONDS = 0.5
MAX_LINE = 64 * 1024
DEFAULT_SETTINGS = {"enabled": True, "duration": 8000, "events_path": "", "show_secrets": False, "achievement_language": "", "plugin_language": "system", "group_achievements": False, "game_view_settings": {}, "remember_game_view_settings": True, "test_notification_type": "normal", "notification_sounds": {}, "notification_durations": {}, "notification_sound_durations": {}, "installed_games_only": False, "game_menu_button": True, "profile_gamerscore": False, "favorite_achievements": {}, "tracked_achievements": {}, "tracker_options": {"enabled": False, "position": "upper-right", "opacity": 75, "count": 5}}


AUDIO_MIMES = {".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".flac": "audio/flac"}
MAX_AUDIO_BYTES = 5 * 1024 * 1024


def read_notification_audio(path: str) -> tuple[Path, bytes, str]:
    if not isinstance(path, str) or len(path) > 4096:
        raise ValueError("Invalid audio path.")
    file = Path(path).expanduser().resolve()
    try:
        file.relative_to(user_home().resolve())
    except ValueError:
        raise ValueError("Choose an audio file in your home folder.")
    mime = AUDIO_MIMES.get(file.suffix.lower())
    if not mime or not file.is_file() or not 0 < file.stat().st_size <= MAX_AUDIO_BYTES:
        raise ValueError("Choose a WAV, MP3, OGG, or FLAC file up to 5 MB.")
    with file.open("rb") as stream:
        data = stream.read(MAX_AUDIO_BYTES + 1)
    if not data or len(data) > MAX_AUDIO_BYTES:
        raise ValueError("Audio file is empty or too large.")
    return file, data, mime


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


ACH_RELATIVE = ".local/share/nexus-launcher/achievements"
MAX_SNAPSHOT = 4 * 1024 * 1024
MAX_TITLES = 500
MAX_ACHIEVEMENTS = 2000
TITLE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def resolve_achievements_dir() -> Path:
    value = (os.environ.get("NEXUS_ACHIEVEMENTS_DIR") or "").strip()
    if value:
        if value == "~" or value.startswith("~/"):
            return user_home() / value[1:].lstrip("/")
        return Path(value)
    return user_home() / ACH_RELATIVE


def _read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        if path.stat().st_size > MAX_SNAPSHOT:
            return None
        value = json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _num(value: Any, default: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return int(value)


def _str(value: Any) -> str:
    return value if isinstance(value, str) else ""


def valid_achievement_filter(value):
    if value in ("all", "unlocked", "locked"):
        return True
    if not isinstance(value, str) or not value.startswith("ta:"):
        return False
    try:
        catalog = Path(__file__).with_name("ta_flags.json")
        if not catalog.exists():
            catalog = Path(__file__).parent / "src/ta_flags.json"
        flags = json.loads(catalog.read_text())
        return value[3:] in {flag["id"] for flag in flags}
    except (OSError, ValueError, KeyError, TypeError):
        return False


def valid_title_id(title_id: Any) -> bool:
    return isinstance(title_id, str) and bool(TITLE_ID_RE.match(title_id)) and ".." not in title_id


def mythic_notification_icon(detail: dict) -> str:
    originals = [item for item in detail.get("achievements", [])
                 if item.get("baseGame") is True and item.get("unlocked") is True
                 and isinstance(item.get("iconUrl"), str) and item["iconUrl"]]
    latest = max(originals, key=lambda item: _num(item.get("unlockedAt")), default=None)
    return latest["iconUrl"] if latest else ""


def parse_profile_gamerscore(raw: bytes) -> int:
    data = json.loads(raw)
    if (not isinstance(data, dict) or data.get("schema") != 1
            or not isinstance(data.get("account"), str) or not data["account"]
            or len(data["account"]) > 256
            or type(data.get("gamerscore")) is not int or not 0 <= data["gamerscore"] <= 0xffffffff):
        raise ValueError("Profile Gamerscore unavailable.")
    return data["gamerscore"]


def launcher_games() -> list[dict]:
    state = _read_json(user_home() / ".config/xodus-nexus/launcher-state.json")
    games = state.get("games") if state else None
    return [game for game in games[:MAX_TITLES] if isinstance(game, dict)] if isinstance(games, list) else []


def installed_game_title_id(game: dict) -> str:
    if game.get("installState") != "ready" or not isinstance(game.get("path"), str):
        return ""
    try:
        directory = Path(game["path"])
        config = next((entry for entry in directory.iterdir() if entry.name.lower() == "microsoftgame.config"), None)
        if config is None or not config.is_file() or config.stat().st_size > 1_000_000:
            return ""
        raw = config.read_bytes()
        if len(raw) > 1_000_000 or b"<!DOCTYPE" in raw.upper():
            return ""
        # Decky's embedded Python omits xml.etree. Only read this bounded,
        # literal hexadecimal field; do not interpret entities or declarations.
        xml = raw.decode("utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig")
        if "<!DOCTYPE" in xml.upper() or "<!ENTITY" in xml.upper():
            return ""
        xml = re.sub(r"<!--.*?-->", "", xml, flags=re.DOTALL)
        titles = re.findall(r"<((?:[A-Za-z_][\w.-]*:)?TitleId)\s*>\s*([a-fA-F0-9]{1,8})\s*</\1\s*>", xml)
        if len(titles) == 1 and int(titles[0][1], 16) > 0:
            return str(int(titles[0][1], 16))
    except (OSError, ValueError, UnicodeError):
        pass
    return ""


def installed_title_ids() -> set[str]:
    return {title for game in launcher_games() if (title := installed_game_title_id(game))}


def unifideck_games() -> list[dict]:
    root = unifideck_root(user_home())
    registry = _read_json(root.parent / "shortcuts_registry.json") or {}
    games = []
    for path in (root / "installed").glob("*.json"):
        record = _read_json(path)
        if not record or record.get("state") != "installed" or record.get("productId") != path.stem:
            continue
        title = record.get("titleId")
        if not isinstance(title, str) or not re.fullmatch(r"[0-9a-fA-F]{1,8}", title) or int(title, 16) == 0:
            continue
        game_id = _str(record.get("storeGameId")) or path.stem
        shortcut = registry.get(f"microsoft:{game_id}")
        shortcut = shortcut if isinstance(shortcut, dict) else {}
        games.append({"titleId": f"{UNIFIDECK_TITLE_PREFIX}{int(title, 16)}",
                      "titleName": _str(shortcut.get("title")) or path.stem,
                      "appId": shortcut.get("appid_unsigned")})
    return games


def game_menu_target(app_id: int) -> Optional[Dict[str, Any]]:
    if type(app_id) is not int or not 0 < app_id <= 0xffffffff:
        return None
    game = shortcut_game(user_home(), app_id, launcher_games())
    title_id = installed_game_title_id(game) if game else ""
    if not title_id:
        target = next((entry for entry in unifideck_games() if entry["appId"] == app_id), None)
        if target is None:
            return None
        return next((title for title in list_titles()["titles"] if title["titleId"] == target["titleId"]), target)
    summary = next((title for title in list_titles()["titles"] if title["titleId"] == title_id), None)
    return summary or {"titleId": title_id, "titleName": _str(game.get("title")) or title_id,
                       "coverUrl": _str(game.get("coverUrl"))}


def list_titles() -> Dict[str, Any]:
    data = _read_json(resolve_achievements_dir() / "index.json")
    snapshots = data["titles"][:MAX_TITLES] if data and isinstance(data.get("titles"), list) else []
    titles = []
    installed = installed_title_ids() | {game["titleId"] for game in unifideck_games()}
    directory = unifideck_root(user_home()) / "achievements"
    for path in list(directory.glob(f"{UNIFIDECK_TITLE_PREFIX}*.json"))[:MAX_TITLES]:
        snapshot = _read_json(path)
        if snapshot and snapshot.get("titleId") == path.stem:
            snapshots.append(snapshot)
    for t in snapshots:
        if not isinstance(t, dict) or not valid_title_id(t.get("titleId")):
            continue
        titles.append({
            "titleId": t["titleId"],
            "installed": t["titleId"] in installed,
            "titleName": _str(t.get("titleName")) or t["titleId"],
            "coverUrl": _str(t.get("coverUrl")),
            "unlocked": _num(t.get("unlocked")),
            "total": _num(t.get("total")),
            "gamerscore": _num(t.get("gamerscore")),
            "gamerscoreTotal": _num(t.get("gamerscoreTotal")),
            "updatedAt": _num(t.get("updatedAt")),
        })
    return {"ok": True, "titles": titles}


def get_running_title() -> Optional[Dict[str, Any]]:
    for directory in (resolve_achievements_dir(), unifideck_root(user_home()) / "achievements"):
        data = _read_json(directory / "running.json")
        if not data or not valid_title_id(data.get("titleId")):
            continue
        pid = data.get("launcherPid")
        if type(pid) is not int or pid <= 0:
            continue
        try:
            os.kill(pid, 0)
        except OSError:
            continue
        title = next((title for title in list_titles()["titles"] if title["titleId"] == data["titleId"]), None)
        if title:
            return title
    return None


def get_title(title_id: Any) -> Dict[str, Any]:
    if not valid_title_id(title_id):
        return {"ok": False, "error": "invalid titleId", "achievements": []}
    base = (unifideck_root(user_home()) / "achievements"
            if title_id.startswith(UNIFIDECK_TITLE_PREFIX) else resolve_achievements_dir())
    path = base / f"{title_id}.json"
    try:
        if path.resolve().parent != base.resolve():
            return {"ok": False, "error": "invalid titleId", "achievements": []}
    except OSError:
        return {"ok": False, "error": "unreadable", "achievements": []}
    data = _read_json(path)
    if data is None or not isinstance(data.get("achievements"), list):
        return {"ok": False, "error": "not found", "achievements": []}
    items = []
    for a in data["achievements"][:MAX_ACHIEVEMENTS]:
        if not isinstance(a, dict) or not _str(a.get("name")) and not _str(a.get("id")):
            continue
        progress = a.get("progress")
        unlocked_at = a.get("unlockedAt")
        items.append({
            "id": _str(a.get("id")) or str(a.get("id", "")),
            "name": _str(a.get("name")),
            "description": _str(a.get("description")),
            "gamerscore": _num(a.get("gamerscore")),
            "iconUrl": _str(a.get("iconUrl")),
            "unlocked": a.get("unlocked") is True,
            "unlockedAt": _num(unlocked_at) if isinstance(unlocked_at, (int, float)) and not isinstance(unlocked_at, bool) else None,
            "progress": max(0, min(100, _num(progress))) if isinstance(progress, (int, float)) and not isinstance(progress, bool) else None,
            "secret": a.get("secret") is True,
        })
    return {
        "ok": True,
        "titleId": title_id,
        "titleName": _str(data.get("titleName")) or title_id,
        "coverUrl": _str(data.get("coverUrl")),
        "updatedAt": _num(data.get("updatedAt")),
        "achievements": items,
    }


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
        return {**self.settings, "resolved_path": str(resolve_events_path(self.settings["events_path"])), "sound_picker_path": str(user_home())}

    async def set_settings(self, enabled: bool, duration: int, events_path: str = "") -> Dict[str, Any]:
        duration = max(1000, min(86400000, int(duration)))
        duration = max(duration, self.settings.get("notification_sound_durations", {}).get("normal", 0))
        changed = events_path != self.settings["events_path"]
        self.settings = {**self.settings, "enabled": bool(enabled), "duration": duration, "events_path": str(events_path)}
        self._save()
        if changed:
            await self._restart()
        return await self.get_settings()

    async def set_show_secrets(self, show: bool) -> bool:
        self.settings["show_secrets"] = bool(show)
        try:
            self._save()
        except OSError as error:
            decky.logger.error(f"settings save error: {error}")
        return self.settings["show_secrets"]

    async def get_running_title(self) -> Optional[Dict[str, Any]]:
        return get_running_title()

    def _tracker_detail(self, detail: dict) -> dict:
        cached = getattr(self, "_tracker_progress", {}).get(detail.get("titleId"), {})
        if time.monotonic() - cached.get("time", 0) > 90:
            return detail
        updates = cached.get("items", {})
        return {**detail, "achievements": [{**item, **updates.get(item["id"], {}),
            "unlocked": item.get("unlocked", False) or updates.get(item["id"], {}).get("unlocked", False),
            "progress": None if item.get("unlocked") or updates.get(item["id"], {}).get("unlocked")
            else updates.get(item["id"], {}).get("progress", item.get("progress"))}
            for item in detail.get("achievements", [])]}

    async def _read_tracker_progress(self, title_id: str, detail: dict):
        xbox_title_id = title_id.removeprefix(UNIFIDECK_TITLE_PREFIX)
        command, env = (backend_command(user_home(), unifideck=True)
                        if xbox_title_id != title_id else backend_command(user_home()))
        code, raw = await run_bounded([*command, "achievements", xbox_title_id, "--json"], env)
        if code:
            return
        data = json.loads(raw)
        if not isinstance(data, dict) or data.get("schema") != 1 or str(data.get("titleId")) != xbox_title_id or not isinstance(data.get("items"), list):
            return
        known = {item["id"] for item in detail.get("achievements", [])}
        updates = {}
        for item in data["items"][:MAX_ACHIEVEMENTS]:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or item["id"] not in known:
                continue
            state = item.get("state")
            if state not in ("unlocked", "locked", "in-progress"):
                continue
            progress = item.get("progress")
            updates[item["id"]] = {"unlocked": state == "unlocked", "progress": progress
                if state != "unlocked" and type(progress) in (int, float) and 0 <= progress <= 100 else None}
        if not hasattr(self, "_tracker_progress"):
            self._tracker_progress = {}
        if len(self._tracker_progress) >= MAX_TITLES:
            self._tracker_progress.pop(next(iter(self._tracker_progress)))
        self._tracker_progress[title_id] = {"time": time.monotonic(), "items": updates}
        completed = {key for key, value in updates.items() if value["unlocked"]}
        games = self.settings.get("tracked_achievements", {})
        stored = games.get(title_id, []) if isinstance(games, dict) else []
        if isinstance(stored, list) and any(isinstance(key, str) and key in completed for key in stored):
            previous = self.settings
            self.settings = {**previous, "tracked_achievements": {**games,
                title_id: [key for key in stored if not isinstance(key, str) or key not in completed]}}
            try:
                self._save()
            except OSError:
                self.settings = previous

    def _schedule_tracker_refresh(self, title_id: str, detail: dict):
        if not hasattr(self, "_tracker_refresh_times"):
            self._tracker_refresh_times = {}
            self._tracker_jobs = {}
        if self._tracker_jobs or time.monotonic() - self._tracker_refresh_times.get(title_id, 0) < 15:
            return
        if len(self._tracker_refresh_times) >= MAX_TITLES:
            self._tracker_refresh_times.pop(next(iter(self._tracker_refresh_times)))
        self._tracker_refresh_times[title_id] = time.monotonic()
        async def refresh():
            try:
                await self._read_tracker_progress(title_id, detail)
            except Exception:
                pass  # Keep the last snapshot when Xbox is unavailable.
            finally:
                self._tracker_jobs.pop(title_id, None)
        self._tracker_jobs[title_id] = asyncio.create_task(refresh())

    def _achievement_preferences(self, title_id: str) -> Dict[str, Any]:
        detail = get_title(title_id)
        if not detail.get("ok"):
            raise ValueError("Could not load achievements.")
        detail = self._tracker_detail(detail)
        known = {item["id"]: item for item in detail.get("achievements", [])}
        def saved(key, locked=False):
            games = self.settings.get(key, {})
            ids = games.get(title_id, []) if isinstance(games, dict) else []
            if not isinstance(ids, list):
                return []
            return list(dict.fromkeys(item for item in ids if isinstance(item, str) and item in known
                                      and (not locked or not known[item].get("unlocked"))))
        return {"favorites": saved("favorite_achievements", True), "tracked": saved("tracked_achievements", True)[:5]}

    async def get_achievement_preferences(self, title_id: str) -> Dict[str, Any]:
        return self._achievement_preferences(title_id)

    def _set_achievement_selection(self, title_id: str, achievement_id: str, enabled: bool, tracked: bool) -> Dict[str, Any]:
        preferences = self._achievement_preferences(title_id)
        detail = get_title(title_id)
        item = next((item for item in self._tracker_detail(detail).get("achievements", []) if item["id"] == achievement_id), None)
        if item is None or not isinstance(achievement_id, str) or not achievement_id or not isinstance(enabled, bool):
            raise ValueError("Invalid achievement selection.")
        if item.get("unlocked") and (enabled or not tracked):
            raise ValueError("Unlocked achievements cannot be tracked." if tracked else "Unlocked achievements cannot be favorited.")
        selection = preferences["tracked" if tracked else "favorites"]
        selection = [key for key in selection if key != achievement_id]
        if enabled:
            if tracked and len(selection) >= 5:
                raise ValueError("You can track up to five achievements per game.")
            selection.append(achievement_id)
        key = "tracked_achievements" if tracked else "favorite_achievements"
        previous = self.settings
        games = previous.get(key, {})
        self.settings = {**previous, key: {**(games if isinstance(games, dict) else {}), title_id: selection}}
        try:
            self._save()
        except OSError:
            self.settings = previous
            raise
        return self._achievement_preferences(title_id)

    async def set_achievement_favorite(self, title_id: str, achievement_id: str, enabled: bool) -> Dict[str, Any]:
        return self._set_achievement_selection(title_id, achievement_id, enabled, False)

    async def set_achievement_tracked(self, title_id: str, achievement_id: str, enabled: bool) -> Dict[str, Any]:
        return self._set_achievement_selection(title_id, achievement_id, enabled, True)

    async def get_tracker_options(self) -> Dict[str, Any]:
        raw = self.settings.get("tracker_options", {})
        if not isinstance(raw, dict):
            raw = {}
        position = raw.get("position")
        count, opacity = raw.get("count"), raw.get("opacity")
        return {"enabled": raw.get("enabled") is True,
                "position": position if position in ("upper-left", "center-top", "upper-right", "center-left", "center-right", "lower-left", "center-bottom", "lower-right") else "upper-right",
                "count": count if type(count) is int and 1 <= count <= 5 else 5,
                "opacity": opacity if type(opacity) is int and 20 <= opacity <= 100 else 75}

    async def set_tracker_options(self, enabled: bool, position: str, opacity: int, count: int) -> Dict[str, Any]:
        if (not isinstance(enabled, bool) or position not in ("upper-left", "center-top", "upper-right", "center-left", "center-right", "lower-left", "center-bottom", "lower-right")
                or type(opacity) is not int or not 20 <= opacity <= 100 or type(count) is not int or not 1 <= count <= 5):
            raise ValueError("Invalid tracker settings.")
        previous = self.settings
        self.settings = {**previous, "tracker_options": {"enabled": enabled, "position": position, "opacity": opacity, "count": count}}
        try:
            self._save()
        except OSError:
            self.settings = previous
            raise
        return await self.get_tracker_options()

    async def get_tracker_state(self) -> Dict[str, Any]:
        options = await self.get_tracker_options()
        result = {"options": options, "running": None, "achievements": []}
        if not options["enabled"]:
            return result
        running = get_running_title()
        if not running:
            return result
        title_id = running["titleId"]
        detail = get_title(title_id)
        if not detail.get("ok"):
            return result
        preferences = self._achievement_preferences(title_id)
        language = self.settings.get("achievement_language", "")
        detail = self._tracker_detail(detail)
        if preferences["tracked"]:
            self._schedule_tracker_refresh(title_id, detail)
        localized = self._localized_snapshot(detail, language) if language else detail
        by_id = {item["id"]: item for item in localized.get("achievements", [])}
        items = [by_id[key] for key in preferences["tracked"][:options["count"]] if key in by_id]
        # An overlay never exposes a locked secret without the explicit reveal preference.
        if not self.settings.get("show_secrets"):
            items = [{**item, "name": "", "description": "", "iconUrl": "", "gamerscore": 0, "progress": None}
                     if item.get("secret") else item for item in items]
        return {**result, "running": {"titleId": title_id, "titleName": running["titleName"]}, "achievements": items, "tracked": preferences["tracked"]}

    async def get_game_view_settings(self, title_id: str) -> Dict[str, str]:
        if not valid_title_id(title_id):
            raise ValueError("Invalid title ID.")
        if not self.settings.get("remember_game_view_settings", True):
            return {"filter": "all", "sort": "date", "contentFilter": "all", "sortDirection": "desc"}
        games = self.settings.get("game_view_settings", {})
        value = games.get(title_id, {}) if isinstance(games, dict) else {}
        if not isinstance(value, dict):
            value = {}
        legacy = value.get("filter")
        ta_filter = value.get("taFilter", legacy if isinstance(legacy, str) and legacy.startswith("ta:") else "all")
        return {
            **({"taFilter": ta_filter} if ta_filter != "all" and valid_achievement_filter(ta_filter) else {}),
            "filter": legacy if legacy in ("all", "unlocked", "locked") else "all",
            "sort": value.get("sort") if value.get("sort") in ("name", "gamerscore", "date", "rarity") else "date",
            "sortDirection": value.get("sortDirection") if value.get("sortDirection") in ("asc", "desc") else ("asc" if value.get("sort") == "name" else "desc"),
            "contentFilter": value.get("contentFilter") if value.get("contentFilter") in ("all", "original", "addon") else "all",
        }

    async def set_game_view_settings(self, title_id: str, filter_value: str, sort_value: str, content_filter: str = "all", sort_direction: str = "", ta_filter: str = "all") -> Dict[str, str]:
        if not valid_title_id(title_id):
            raise ValueError("Invalid title ID.")
        if not sort_direction:
            sort_direction = "asc" if sort_value == "name" else "desc"
        if isinstance(filter_value, str) and filter_value.startswith("ta:"):
            if ta_filter == "all":
                ta_filter = filter_value
            filter_value = "all"
        if (not valid_achievement_filter(ta_filter) or ta_filter in ("locked", "unlocked")
                or filter_value not in ("all", "locked", "unlocked") or sort_value not in ("name", "gamerscore", "date", "rarity")
                or content_filter not in ("all", "original", "addon") or sort_direction not in ("asc", "desc")):
            raise ValueError("Invalid game view settings.")
        value = {"filter": filter_value, "sort": sort_value, "contentFilter": content_filter, "sortDirection": sort_direction,
                 **({"taFilter": ta_filter} if ta_filter != "all" else {})}
        if not self.settings.get("remember_game_view_settings", True):
            return value
        previous = self.settings
        games = previous.get("game_view_settings", {})
        self.settings = {**previous, "game_view_settings": {**(games if isinstance(games, dict) else {}), title_id: value}}
        try:
            self._save()
        except OSError:
            self.settings = previous
            raise
        return value

    async def set_remember_game_view_settings(self, enabled: bool) -> bool:
        previous = self.settings
        self.settings = {**previous, "remember_game_view_settings": bool(enabled)}
        try:
            self._save()
        except OSError:
            self.settings = previous
            raise
        return self.settings["remember_game_view_settings"]

    async def list_titles(self) -> Dict[str, Any]:
        try:
            return await asyncio.to_thread(list_titles)
        except Exception as error:
            return {"ok": False, "error": str(error), "titles": []}

    async def get_achievement_languages(self) -> list:
        return [{"data": tag, "label": name} for tag, name in LANGUAGES.items()]

    async def set_achievement_language(self, language: str) -> str:
        if language not in LANGUAGES:
            raise ValueError("Unsupported achievement language.")
        self.settings["achievement_language"] = language
        self._save()
        if hasattr(self, "_library_refresh_requested"):
            self._library_refresh_requested.set()
        return language

    async def set_plugin_language(self, language: str) -> str:
        if language not in ("system", "en", "ru", "uk"):
            raise ValueError("Unsupported plugin language.")
        previous = self.settings
        self.settings = {**previous, "plugin_language": language}
        try:
            self._save()
        except OSError:
            self.settings = previous
            raise
        return language

    async def set_group_achievements(self, enabled: bool) -> bool:
        previous = self.settings
        self.settings = {**previous, "group_achievements": bool(enabled)}
        try:
            self._save()
        except OSError:
            self.settings = previous
            raise
        return self.settings["group_achievements"]

    def _localized_snapshot(self, detail: dict, language: str) -> dict:
        text = getattr(self, "_localized_titles", {}).get((language, detail.get("titleId")))
        if not text:
            return detail
        return {**detail, "achievements": [
            {**item, **text.get(item["id"], {})} for item in detail.get("achievements", [])]}

    def _preloaded_snapshot(self, detail: dict) -> dict:
        title_id = detail.get("titleId")
        group = getattr(self, "_mythic_progress", {}).get(title_id)
        metadata = getattr(self, "_achievement_metadata", {}).get(title_id, {})
        return {**detail, **({"mythic": group} if group else {}), "achievements": [
            {**item, **metadata.get(item["id"], {})} for item in detail.get("achievements", [])]}

    async def _ta_call(self, action: str, detail=None) -> Dict[str, Any]:
        if not hasattr(self, "_ta_worker"):
            self._ta_worker = TAWorker(self._settings_file().parent / "trueachievements")
        try:
            return await self._ta_worker.call(action, detail)
        except Exception:
            if action == "metadata":
                return {"status": "unavailable", "achievements": {}}
            return {"status": "disconnected", "error": "verification_failed"}

    async def get_ta_session(self) -> Dict[str, Any]:
        return await self._ta_call("status")

    async def connect_ta_session(self) -> Dict[str, Any]:
        try:
            data = await browser_session()
        except SessionError as error:
            return {**await self.get_ta_session(), "error": str(error)}
        return await self._ta_call("connect", data)

    async def disconnect_ta_session(self) -> Dict[str, Any]:
        return await self._ta_call("disconnect")

    async def get_trueachievements(self, title_id: str) -> Dict[str, Any]:
        detail = get_title(title_id)
        if not detail.get("ok"):
            return {"status": "unavailable", "achievements": {}}
        # TA uses English names. Keep these separate from the displayed language.
        if not hasattr(self, "_ta_english"):
            self._ta_english = {}
        names = self._ta_english.get(title_id, {})
        if any(item["id"] not in names for item in detail.get("achievements", [])):
            try:
                english = await translate_title(user_home(), detail, "en-US")
                names = {item["id"]: item["name"] for item in english.get("achievements", [])}
                if len(self._ta_english) >= MAX_TITLES:
                    self._ta_english.pop(next(iter(self._ta_english)))
                self._ta_english[title_id] = names
            except Exception:
                # Exact matching can still use an English original snapshot.
                pass
        matching = {**detail, "achievements": [
            {**item, "name": names.get(item["id"], item["name"])} for item in detail.get("achievements", [])]}
        return await self._ta_call("metadata", matching)

    async def get_saved_title_achievements(self, title_id: str) -> Dict[str, Any]:
        language = self.settings.get("achievement_language", "")
        detail = get_title(title_id)
        if language and (language, title_id) not in getattr(self, "_localized_titles", {}):
            # Do not briefly render original text while the first translation loads.
            return await self.get_title_achievements(title_id)
        return self._preloaded_snapshot(self._localized_snapshot(detail, language) if language else detail)

    async def get_title_achievements(self, title_id: str) -> Dict[str, Any]:
        detail = get_title(title_id)
        language = self.settings.get("achievement_language", "")
        try:
            result = await translate_title(user_home(), detail, language)
            if language and result.get("ok") and not result.get("languageError"):
                if not hasattr(self, "_localized_titles"):
                    self._localized_titles = {}
                if len(self._localized_titles) >= MAX_TITLES:
                    self._localized_titles.pop(next(iter(self._localized_titles)))
                self._localized_titles[(language, title_id)] = {
                    item["id"]: {"name": item["name"], "description": item["description"]}
                    for item in result.get("achievements", [])}
            if result.get("ok"):
                if not hasattr(self, "_achievement_metadata"):
                    self._achievement_metadata = {}
                if len(self._achievement_metadata) >= MAX_TITLES:
                    self._achievement_metadata.pop(next(iter(self._achievement_metadata)))
                self._achievement_metadata[title_id] = {
                    item["id"]: {key: item[key] for key in ("baseGame", "rarity") if key in item}
                    for item in result.get("achievements", [])}
            account = result.pop("_mythic_account", "")
            if result.get("mythic"):
                if not hasattr(self, "_mythic_progress"):
                    self._mythic_progress = {}
                self._mythic_progress[title_id] = result["mythic"]
                if not hasattr(self, "_mythic_tracker"):
                    self._mythic_tracker = MythicTracker()
                newly_earned = self._mythic_tracker.observe(account, title_id, result["mythic"])
                if newly_earned and self.settings["enabled"]:
                    await decky.emit("mythic", {"titleId": title_id, "titleName": result.get("titleName", title_id),
                                                "mythic": result["mythic"], "iconUrl": mythic_notification_icon(result)})
            return result
        except Exception as error:
            return {**self._localized_snapshot(detail, language), "languageError": str(error) or "Could not load the selected language."}

    async def get_mythic_progress(self) -> Dict[str, Any]:
        return dict(getattr(self, "_mythic_progress", {}))

    async def _refresh_mythic_library(self):
        # Sequential requests keep startup responsive and avoid flooding Xbox.
        titles = await asyncio.to_thread(list_titles)
        language = self.settings.get("achievement_language", "")
        for title in titles["titles"]:
            if language != self.settings.get("achievement_language", ""):
                return
            await self.get_title_achievements(title["titleId"])
            await asyncio.sleep(0.25)

    async def _watch_mythic_library(self):
        self._library_refresh_requested = asyncio.Event()
        while True:
            self._library_refresh_requested.clear()
            try:
                await self._refresh_mythic_library()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                decky.logger.error(f"Mythic library refresh error: {error}")
            try:
                await asyncio.wait_for(self._library_refresh_requested.wait(), timeout=600)
            except asyncio.TimeoutError:
                pass

    def _schedule_mythic_refresh(self, title_id: str):
        if not valid_title_id(title_id):
            return
        if not hasattr(self, "_mythic_jobs"):
            self._mythic_jobs = {}
        if title_id in self._mythic_jobs or len(self._mythic_jobs) >= 2:
            return

        async def refresh():
            try:
                await asyncio.sleep(1.5)
                await self.get_title_achievements(title_id)
            finally:
                self._mythic_jobs.pop(title_id, None)
        self._mythic_jobs[title_id] = asyncio.create_task(refresh())

    async def set_profile_gamerscore(self, enabled: bool) -> bool:
        previous = self.settings
        self.settings = {**previous, "profile_gamerscore": bool(enabled)}
        try:
            self._save()
        except OSError:
            self.settings = previous
            raise
        if not enabled:
            self._profile_score_cache = None
        return self.settings["profile_gamerscore"]

    async def get_profile_gamerscore(self, force: bool = False) -> Dict[str, Any]:
        if not self.settings.get("profile_gamerscore", False):
            return {"ok": False, "error": "disabled"}
        if not hasattr(self, "_profile_score_lock"):
            self._profile_score_lock = asyncio.Lock()
        async with self._profile_score_lock:
            if not self.settings.get("profile_gamerscore", False):
                return {"ok": False, "error": "disabled"}
            now = asyncio.get_running_loop().time()
            cache = getattr(self, "_profile_score_cache", None)
            if cache and now - cache[0] < (10 if force is True else 300):
                return {"ok": True, "gamerscore": cache[1]}
            try:
                command, env = backend_command(user_home())
                code, raw = await run_bounded([*command, "profile", "--json"], env)
                if code:
                    raise ValueError("Profile unavailable.")
                score = parse_profile_gamerscore(raw)
                if not self.settings.get("profile_gamerscore", False):
                    return {"ok": False, "error": "disabled"}
                self._profile_score_cache = (asyncio.get_running_loop().time(), score)
                return {"ok": True, "gamerscore": score}
            except (OSError, ValueError, asyncio.TimeoutError):
                self._profile_score_cache = None
                return {"ok": False, "error": "profile-unavailable"}

    async def get_game_menu_target(self, app_id: int) -> Optional[Dict[str, Any]]:
        return await asyncio.to_thread(game_menu_target, app_id)

    async def set_game_menu_button(self, enabled: bool) -> bool:
        previous = self.settings
        self.settings = {**previous, "game_menu_button": bool(enabled)}
        try:
            self._save()
        except OSError:
            self.settings = previous
            raise
        return self.settings["game_menu_button"]

    async def set_installed_games_only(self, enabled: bool) -> bool:
        previous = self.settings
        self.settings = {**previous, "installed_games_only": bool(enabled)}
        try:
            self._save()
        except OSError:
            self.settings = previous
            raise
        return self.settings["installed_games_only"]

    async def set_notification_duration(self, kind: str, duration: int) -> Dict[str, int]:
        if kind not in ("rare", "mythic") or type(duration) is not int or not 2000 <= duration <= 86400000:
            raise ValueError("Invalid notification duration.")
        previous = self.settings
        duration = max(duration, previous.get("notification_sound_durations", {}).get(kind, 0))
        durations = {**previous.get("notification_durations", {}), kind: duration}
        self.settings = {**previous, "notification_durations": durations}
        try:
            self._save()
        except OSError:
            self.settings = previous
            raise
        return durations

    async def set_notification_sound_duration(self, kind: str, path: str, duration: int) -> Dict[str, Any]:
        if (kind not in ("normal", "rare", "mythic") or type(duration) is not int
                or not 1000 <= duration <= 86400000
                or self.settings.get("notification_sounds", {}).get(kind) != path):
            raise ValueError("Invalid sound duration.")
        previous = self.settings
        minimum = ((duration + 999) // 1000) * 1000
        lengths = {**previous.get("notification_sound_durations", {}), kind: minimum}
        durations = dict(previous.get("notification_durations", {}))
        normal = previous["duration"]
        if kind == "normal":
            normal = max(normal, minimum)
        else:
            durations[kind] = max(durations.get(kind, normal), minimum)
        self.settings = {**previous, "notification_sound_durations": lengths,
                         "notification_durations": durations, "duration": normal}
        try:
            self._save()
        except OSError:
            self.settings = previous
            raise
        return await self.get_settings()

    async def set_notification_sound(self, kind: str, path: str = "") -> Dict[str, str]:
        if kind not in ("normal", "rare", "mythic"):
            raise ValueError("Unsupported notification type.")
        if path:
            file, _, _ = await asyncio.to_thread(read_notification_audio, path)
            path = str(file)
        previous = self.settings
        sounds = dict(previous.get("notification_sounds", {}))
        if path:
            sounds[kind] = path
        else:
            sounds.pop(kind, None)
        lengths = dict(previous.get("notification_sound_durations", {}))
        lengths.pop(kind, None)
        self.settings = {**previous, "notification_sounds": sounds, "notification_sound_durations": lengths}
        try:
            self._save()
        except OSError:
            self.settings = previous
            raise
        return sounds

    async def get_notification_audio(self, kind: str) -> Dict[str, str]:
        if kind not in ("normal", "rare", "mythic"):
            raise ValueError("Unsupported notification type.")
        path = self.settings.get("notification_sounds", {}).get(kind)
        if not path:
            return {}
        _, data, mime = await asyncio.to_thread(read_notification_audio, path)
        return {"data": base64.b64encode(data).decode("ascii"), "mime": mime}

    async def set_test_notification_type(self, kind: str) -> str:
        if kind not in ("normal", "rare", "mythic"):
            raise ValueError("Unsupported notification type.")
        previous = self.settings
        self.settings = {**previous, "test_notification_type": kind}
        try:
            self._save()
        except OSError:
            self.settings = previous
            raise
        return kind

    async def test_notification(self, locale: str = "", kind: str = "normal") -> None:
        if kind not in ("normal", "rare", "mythic"):
            raise ValueError("Unsupported notification type.")
        texts = {
            "ru": ("Тестовое достижение", "Уведомления Nexus работают."),
            "uk": ("Тестове досягнення", "Сповіщення Nexus працюють."),
            "en": ("Test achievement", "Nexus notifications work."),
        }
        language = self.settings.get("plugin_language", "system")
        name, description = texts.get(locale if language == "system" else language, texts["en"])
        if kind == "mythic":
            await decky.emit("mythic", {
                "preview": True, "titleId": "test", "titleName": "Nexus",
                "mythic": {"groupId": "test", "unlocked": True, "totalCount": 50,
                           "unlockedCount": 50, "completedAt": None},
            })
            return
        await decky.emit("achievement", {
            "preview": True,
            **({"rarity": {"percentage": 1.23, "category": "Rare"}} if kind == "rare" else {}),
            "type": "achievement", "ts": "", "titleId": "test", "scid": "", "id": "0",
            "name": name, "description": description,
            "gamerscore": 10, "iconUrl": "",
        })

    async def _localized_notification(self, event: dict) -> dict:
        language = self.settings.get("achievement_language", "")
        title_id = event.get("titleId", "")
        if not valid_title_id(title_id):
            return event
        unifideck = title_id.startswith(UNIFIDECK_TITLE_PREFIX)
        if not language and not unifideck:
            return event
        keys = [event.get("id"), f"{event.get('scid', '')}:{event.get('id', '')}"]
        text = getattr(self, "_localized_titles", {}).get((language, title_id), {}) if language else {}
        metadata = getattr(self, "_achievement_metadata", {}).get(title_id, {}) if unifideck else {}
        if (language and not any(key in text for key in keys)) or (unifideck and not metadata):
            await self.get_title_achievements(title_id)
            text = getattr(self, "_localized_titles", {}).get((language, title_id), {}) if language else {}
            metadata = getattr(self, "_achievement_metadata", {}).get(title_id, {}) if unifideck else {}
        translation = next((text[key] for key in keys if key in text), {})
        rarity = next((metadata[key]["rarity"] for key in keys if "rarity" in metadata.get(key, {})), None)
        return {**event, **translation, **({"rarity": rarity} if rarity else {})}

    async def _watch(self):
        paths = (resolve_events_path(self.settings["events_path"]),
                 unifideck_root(user_home()) / "achievements/achievement-events.jsonl")
        tailers = [Tailer(path) for path in dict.fromkeys(paths)]
        while True:
            try:
                for event in (event for tailer in tailers for event in tailer.poll()):
                    if self.settings["enabled"]:
                        await decky.emit("achievement", await self._localized_notification(event))
                        self._schedule_mythic_refresh(event.get("titleId", ""))
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
        self._mythic_library_task = asyncio.create_task(self._watch_mythic_library())

    async def _unload(self):
        if getattr(self, "_ta_worker", None):
            await self._ta_worker.close()
        if self.task:
            self.task.cancel()
        jobs = list(getattr(self, "_mythic_jobs", {}).values()) + list(getattr(self, "_tracker_jobs", {}).values())
        if getattr(self, "_mythic_library_task", None):
            jobs.append(self._mythic_library_task)
        for job in jobs:
            job.cancel()
        if jobs:
            await asyncio.gather(*jobs, return_exceptions=True)
