"""Read localized achievement text through the signed-in Nexus backend."""
import asyncio
import json
import os
import pwd
import shutil
from pathlib import Path
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


def backend_command(home: Path) -> tuple[list[str], dict[str, str]]:
    # Execute as the Deck user so the backend uses their existing sign-in.
    config = home / ".config"
    binary = home / ".local/share/nexus-launcher/achievement-backend/xodus-cli"
    if not binary.is_file():
        pointer = json.loads((config / "xodus-nexus/xodus-backends/current.json").read_text())
        binary = Path(pointer["binaryPath"])
    if not binary.is_absolute() or not binary.is_file():
        raise ValueError("Nexus achievement backend is not installed.")
    owner = pwd.getpwuid(home.stat().st_uid)
    command = [str(binary)]
    user_env = {"HOME": str(home), "USER": owner.pw_name, "LOGNAME": owner.pw_name,
                "XDG_CONFIG_HOME": str(config), "XDG_DATA_HOME": str(home / ".local/share"),
                "XDG_CACHE_HOME": str(home / ".cache"), "XDG_RUNTIME_DIR": f"/run/user/{owner.pw_uid}",
                "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{owner.pw_uid}/bus"}
    env = dict(os.environ, **user_env)
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


def localized_text(raw: bytes, title_id: str) -> dict[str, tuple[str, str]]:
    data = json.loads(raw)
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


async def translate_title(home: Path, detail: dict, language: str) -> dict:
    if language not in LANGUAGES:
        raise ValueError("Unsupported achievement language.")
    if not detail.get("ok"):
        return detail
    title_id = detail["titleId"]
    if not title_id.isascii() or not title_id.isdecimal() or not 0 < int(title_id) <= 0xffffffff:
        if language:
            raise ValueError("Language selection requires a numeric Xbox title ID.")
        return detail
    try:
        command, env = backend_command(home)
        code, help_text = await run_bounded([*command, "achievements", "--help"], env)
    except (OSError, ValueError, asyncio.TimeoutError):
        if language:
            raise
        return {**detail, "mythicUnavailable": "backend"}
    supports_mythic = not code and b"--include-mythic" in help_text
    if language and (code or b"--language" not in help_text):
        raise ValueError("Update the Nexus backend to a version supporting achievement languages, or select Original.")
    if not language and not supports_mythic:
        return {**detail, "mythicUnavailable": "backend"}
    args = [*command, "achievements", title_id, "--json"]
    if language:
        args += ["--language", language]
    if supports_mythic:
        args += ["--include-mythic"]
    try:
        code, raw = await run_bounded(args, env)
        if code:
            raise ValueError("Could not load this language from Xbox. Check your Nexus sign-in and connection.")
        data = json.loads(raw)
        text = localized_text(raw, title_id) if language else {}
        group, membership = parse_mythic(data, title_id)
    except (OSError, ValueError, asyncio.TimeoutError):
        if language:
            raise
        return {**detail, "mythicUnavailable": "data"}
    items = [{**item, **({"name": text[item["id"]][0], "description": text[item["id"]][1]}
                        if item["id"] in text else {}),
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
