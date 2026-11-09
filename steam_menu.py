"""Read-only mapping from Steam shortcuts to Nexus launcher game records."""
from pathlib import Path
import shlex
import struct


def parse_shortcuts(data: bytes) -> list[dict]:
    if len(data) > 32 * 1024 * 1024:
        raise ValueError("Steam shortcuts too large")
    offset = count = 0

    def text():
        nonlocal offset
        end = data.find(b"\0", offset)
        if end < 0 or end - offset > 65536:
            raise ValueError("Invalid shortcut string")
        value = data[offset:end].decode("utf-8")
        offset = end + 1
        return value

    def obj(depth=0):
        nonlocal offset, count
        if depth > 8:
            raise ValueError("Invalid shortcut nesting")
        fields = {}
        while offset < len(data):
            kind = data[offset]
            offset += 1
            if kind == 8:
                return fields
            count += 1
            if count > 500000:
                raise ValueError("Too many shortcut fields")
            key = text().lower()
            if key in fields:
                raise ValueError("Duplicate shortcut field")
            if kind == 0:
                fields[key] = obj(depth + 1)
            elif kind == 1:
                fields[key] = text()
            elif kind in (2, 3, 4, 6, 7, 10):
                size = 8 if kind in (7, 10) else 4
                if offset + size > len(data):
                    raise ValueError("Truncated shortcut")
                fields[key] = struct.unpack_from("<I", data, offset)[0]
                offset += size
            else:
                raise ValueError("Unsupported shortcut field")
        raise ValueError("Truncated shortcut object")

    root = obj()
    if offset != len(data) or set(root) != {"shortcuts"} or not isinstance(root["shortcuts"], dict):
        raise ValueError("Invalid shortcuts root")
    return [value for value in root["shortcuts"].values() if isinstance(value, dict)]


def shortcut_game(home: Path, app_id: int, games: list[dict]):
    seen = set()
    for base in (home / ".local/share/Steam", home / ".steam/steam"):
        for file in list((base / "userdata").glob("*/config/shortcuts.vdf"))[:50]:
            try:
                file = file.resolve()
                if file in seen:
                    continue
                seen.add(file)
                with file.open("rb") as stream:
                    entries = parse_shortcuts(stream.read(32 * 1024 * 1024 + 1))
            except (OSError, ValueError):
                continue
            for entry in entries:
                if entry.get("appid") != app_id:
                    continue
                options = entry.get("launchoptions", "")
                if not isinstance(options, str):
                    continue
                try:
                    words = shlex.split(options)
                except ValueError:
                    continue
                if "--nexus-profile" in words:
                    at = words.index("--nexus-profile") + 1
                    if at >= len(words) or Path(words[at]).resolve() != (home / ".config/xodus-nexus").resolve():
                        continue
                if "--launch-game" in words:
                    at = words.index("--launch-game") + 1
                    if at < len(words):
                        matches = [game for game in games if game.get("id") == words[at]]
                        if len(matches) == 1:
                            return matches[0]
                # Legacy shortcuts used the game's name and a Nexus executable.
                command = str(entry.get("exe", "")) + " " + options
                if "nexus" in command.lower():
                    matches = [game for game in games if game.get("title") == entry.get("appname")]
                    if len(matches) == 1:
                        return matches[0]
    return None
