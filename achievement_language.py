"""Read localized achievement text through the signed-in Nexus backend."""
import asyncio
import json
import math
import os
import pwd
import shutil
from pathlib import Path
from typing import Union
from mythic import parse_mythic

LANGUAGES = {
    "": "Original (saved by Nexus)",
    "en-US": "English", "uk-UA": "Українська", "ru-RU": "Русский",
    "de-DE": "Deutsch", "fr-FR": "Français", "es-ES": "Español",
    "it-IT": "Italiano", "pt-BR": "Português (Brasil)", "pl-PL": "Polski",
    "cs-CZ": "Čeština", "ja-JP": "日本語", "ko-KR": "한국어",
    "zh-CN": "简体中文", "zh-TW": "繁體中文",
}
MAX_OUTPUT = 4 * 1024 * 1024


UNIFIDECK_TITLE_PREFIX = "unifideck."


def unifideck_root(home: Path) -> Path:
    data_home = Path(os.environ.get("XDG_DATA_HOME", ""))
    return (data_home if data_home.is_absolute() else home / ".local/share") / "unifideck/xbox_pc"


def _unifideck_binary(root: Path) -> Path:
    try:
        active = json.loads((root / "active.json").read_text())
        directory = Path(active["backend"]["dir"])
        if active["schema"] != 1 or directory.is_absolute() or directory.parent != Path("backend"):
            raise ValueError
    except FileNotFoundError:
        try:
            backend = json.loads((root / "backend_only.json").read_text())
            name = Path(backend["dir"])
            if name.parent != Path("."):
                raise ValueError
            directory = Path("backend") / name
        except (OSError, ValueError, KeyError, TypeError):
            raise ValueError("Unifideck Xbox PC backend is not installed.") from None
    except (OSError, ValueError, KeyError, TypeError):
        raise ValueError("Unifideck Xbox PC backend is not installed.") from None
    binary = root / directory / "xodus-cli"
    if directory.name in ("", "backend", "..") or not binary.is_file():
        raise ValueError("Unifideck Xbox PC backend is not installed.")
    return binary


def backend_command(home: Path, *, unifideck: bool = False,
                    use_unifideck_session: bool = False) -> tuple[list[str], dict[str, str]]:
    # Execute as the Deck user so the backend uses their existing sign-in.
    config = home / ".config"
    root = unifideck_root(home)
    binary = home / ".local/share/nexus-launcher/achievement-backend/xodus-cli"
    if not unifideck and not binary.is_file():
        try:
            pointer = json.loads((config / "xodus-nexus/xodus-backends/current.json").read_text())
            binary = Path(pointer["binaryPath"])
        except (OSError, ValueError, KeyError, TypeError):
            unifideck = True
        else:
            unifideck = not binary.is_absolute() or not binary.is_file()
    if unifideck:
        binary = _unifideck_binary(root)
    owner = pwd.getpwuid(home.stat().st_uid)
    command = [str(binary)]
    user_env = {"HOME": str(home), "USER": owner.pw_name, "LOGNAME": owner.pw_name,
                "XDG_CONFIG_HOME": str(config), "XDG_DATA_HOME": str(home / ".local/share"),
                "XDG_CACHE_HOME": str(home / ".cache"), "XDG_RUNTIME_DIR": f"/run/user/{owner.pw_uid}",
                "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{owner.pw_uid}/bus"}
    if unifideck or use_unifideck_session:
        user_env["XODUS_CREDENTIAL_DIR"] = str(root / "credentials")
        user_env["XDG_DATA_HOME"] = str(root.parent.parent)
    # Decky's frozen host and Steam's runtime load their own libraries.
    env = {key: value for key, value in os.environ.items() if key not in {
        "LD_LIBRARY_PATH", "LD_LIBRARY_PATH_ORIG", "LD_PRELOAD", "LD_PRELOAD_ORIG",
        "PYTHONHOME", "PYTHONPATH", "XODUS_CREDENTIAL_DIR",
    }}
    env.update(user_env)
    if os.geteuid() != owner.pw_uid:
        runuser = shutil.which("runuser") or "/usr/sbin/runuser"
        command = [runuser, "-u", owner.pw_name, "--", "env",
                   *(f"{key}={value}" for key, value in user_env.items()), *command]
    return command, env


async def run_bounded(command: list[str], env: dict[str, str]) -> tuple[int, bytes]:
    process = await asyncio.create_subprocess_exec(
        *command, env=env, stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        async def read():
            output = bytearray()
            while chunk := await process.stdout.read(65536):
                output.extend(chunk)
                if len(output) > MAX_OUTPUT:
                    raise ValueError("Achievement response is too large.")
            return await process.wait(), bytes(output)
        return await asyncio.wait_for(read(), 40)
    finally:
        if process.returncode is None:
            process.kill()
        await process.wait()


def localized_text(raw: Union[bytes, dict], title_id: str) -> dict[str, tuple[str, str]]:
    data = json.loads(raw) if isinstance(raw, bytes) else raw
    if (not isinstance(data, dict) or data.get("schema") != 1
            or data.get("titleId") != title_id or not isinstance(data.get("items"), list)
            or len(data["items"]) > 500):
        raise ValueError("Invalid localized achievement response.")
    result = {}
    for item in data["items"]:
        if not isinstance(item, dict):
            raise ValueError("Invalid localized achievement.")
        key, name, description = item.get("id"), item.get("name"), item.get("description")
        if (not isinstance(key, str) or not key or key in result
                or not isinstance(name, str) or not name or len(name) > 256
                or not isinstance(description, str) or len(description) > 1500):
            raise ValueError("Invalid localized achievement text.")
        result[key] = (name, description)
    return result


def achievement_rarities(data: dict) -> dict:
    result = {}
    seen = set()
    items = data.get("items")
    if not isinstance(items, list) or len(items) > 500:
        return result
    for item in items:
        if not isinstance(item, dict):
            continue
        key = item.get("id")
        if not isinstance(key, str) or not key:
            continue
        if key in seen:
            result.pop(key, None)
            continue
        seen.add(key)
        value = item.get("rarity")
        if not isinstance(value, dict):
            continue
        percentage = value.get("percentage")
        category = value.get("category")
        if (type(percentage) in (int, float) and 0 <= percentage <= 100
                and math.isfinite(percentage) and category in ("Rare", "Common")):
            result[key] = {"percentage": percentage, "category": category}
    return result


async def backend_account(command: list[str], env: dict[str, str]) -> str:
    code, raw = await run_bounded([*command, "account", "--json"], env)
    data = json.loads(raw) if not code else None
    if not isinstance(data, dict):
        return ""
    player = data.get("player")
    username = player.get("username") if isinstance(player, dict) else data.get("username")
    return username.strip().casefold() if isinstance(username, str) else ""


async def _read_achievements(command: list[str], env: dict[str, str], args: list[str]) -> dict:
    code, raw = await run_bounded([*command, *args], env)
    if code:
        raise ValueError("Could not load this language from Xbox. Check your Nexus sign-in and connection.")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("Invalid achievement response.")
    return data


async def translate_title(home: Path, detail: dict, language: str) -> dict:
    if language not in LANGUAGES:
        raise ValueError("Unsupported achievement language.")
    if not detail.get("ok"):
        return detail
    unifideck = detail["titleId"].startswith(UNIFIDECK_TITLE_PREFIX)
    title_id = detail["titleId"].removeprefix(UNIFIDECK_TITLE_PREFIX)
    if not title_id.isascii() or not title_id.isdecimal() or not 0 < int(title_id) <= 0xffffffff:
        if language:
            raise ValueError("Language selection requires a numeric Xbox title ID.")
        return detail
    command, env, code, help_text = [], {}, 1, b""
    try:
        command, env = (backend_command(home, unifideck=True)
                        if unifideck else backend_command(home))
        code, help_text = await run_bounded([*command, "achievements", "--help"], env)
    except (OSError, ValueError, asyncio.TimeoutError):
        if language and not unifideck:
            raise
    source_command, source_env = command, env
    using_helper = False
    if unifideck and (code or b"--include-mythic" not in help_text or
                      (language and b"--language" not in help_text)):
        try:
            helper, helper_env = backend_command(home, use_unifideck_session=True)
            if helper != command:
                helper_code, helper_help = await run_bounded([*helper, "achievements", "--help"], helper_env)
                if (not helper_code and b"--include-mythic" in helper_help
                        and (not language or b"--language" in helper_help)):
                    command, env, code, help_text = helper, helper_env, helper_code, helper_help
                    using_helper = True
        except (OSError, ValueError, asyncio.TimeoutError):
            pass
    supports_mythic = not code and b"--include-mythic" in help_text
    if language and (code or b"--language" not in help_text):
        raise ValueError("Update the Nexus backend to a version supporting achievement languages, or select Original.")
    if not language and not supports_mythic:
        return {**detail, "mythicUnavailable": "backend"}
    args = ["achievements", title_id, "--json"]
    if language:
        args += ["--language", language]
    if supports_mythic:
        args += ["--include-mythic"]
    try:
        try:
            data = await _read_achievements(command, env, args)
        except (OSError, ValueError, asyncio.TimeoutError):
            if not using_helper or not source_command:
                raise
            # Unifideck can renew its session during gameplay. Retry with the
            # separate Nexus session only when it belongs to the same player.
            nexus, nexus_env = backend_command(home)
            if nexus == command and nexus_env == env:
                raise
            account = await backend_account(source_command, source_env)
            if not account or account != await backend_account(nexus, nexus_env):
                raise
            data = await _read_achievements(nexus, nexus_env, args)
            returned_account = data.get("account")
            if not isinstance(returned_account, str) or returned_account.strip().casefold() != account:
                raise ValueError("Xbox account changed while loading achievements.")
        text = localized_text(data, title_id) if language else {}
        group, membership = parse_mythic(data, title_id)
        rarities = achievement_rarities(data)
    except (OSError, ValueError, asyncio.TimeoutError):
        if language:
            raise
        return {**detail, "mythicUnavailable": "data"}
    items = [{**item, **({"name": text[item["id"]][0], "description": text[item["id"]][1]}
                        if item["id"] in text else {}),
              **({"rarity": rarities[item["id"]]} if item["id"] in rarities else {}),
              **({"baseGame": membership[item["id"]]} if item["id"] in membership else {})}
             for item in detail["achievements"]]
    result = {**detail, "achievements": items}
    if group:
        result["mythic"] = group
        account = data.get("account")
        result["_mythic_account"] = account if isinstance(account, str) and len(account) <= 256 else ""
    else:
        result["mythicUnavailable"] = "data" if supports_mythic else "backend"
    return result
