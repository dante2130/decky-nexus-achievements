# Nexus Achievements (Decky plugin)

Xbox-style achievement toasts in Game Mode on Steam Deck for games running on the Nexus runtime.

## How it works

```
game -> nexus-xgameruntime (guest) -> xodus-nexus bridge (host)
     -> ~/.local/share/nexus-launcher/achievement-events.jsonl
     -> this plugin (tails file) -> decky.emit("achievement") -> toaster.toast
```

- `nexus-xgameruntime` advertises the `achievement-notify-v1` capability when it can report unlocks. The runtime passes `NEXUS_INVITE_PORT`/`NEXUS_INVITE_KEY` and `XODUS_BRIDGE_*` to the game process, so the guest can reach the host bridge.
- `xodus-nexus` (the host side) appends one JSON line per unlock to the event file.
- This plugin only reads that file; it never talks to the game.

Event line format:

```json
{"type":"achievement","ts":"2026-01-01T00:00:00Z","titleId":"...","scid":"...","id":"1","name":"First Steps","description":"Finish the tutorial","gamerscore":10,"iconUrl":"https://..."}
```

Malformed lines and other `type` values are ignored. The plugin starts at the end of the file (old unlocks are not replayed) and handles truncation and rotation.

## Install

1. Install [Decky Loader](https://decky.xyz) on the Deck.
2. Build: `npm install && npm run build`.
3. Copy this folder (with `dist/`, `main.py`, `plugin.json`, `package.json`, `LICENSE`) to `~/homebrew/plugins/decky-nexus-achievements/` (needs root to write), then restart Decky: `sudo systemctl restart plugin_loader`.
4. Open the Quick Access menu (`...`), then Nexus Achievements, then "Send test notification".

## Achievements viewer

Open the quick-access panel and press **View all achievements** to browse
titles and per-title achievements (filter All/Unlocked/Locked, sort, search;
secret achievements stay hidden until unlocked; a global "Show secret achievements" toggle is persisted, and each locked secret row has its own eye-icon button (below the gamerscore) that overrides it for the current view only and resets when the global toggle changes). Data comes from snapshot files
in `~/.local/share/nexus-launcher/achievements/` (`index.json` plus
`<titleId>.json`), overridable with `NEXUS_ACHIEVEMENTS_DIR`. The page refreshes
when a new achievement event arrives.

## Configuration

Event file, in order of precedence:

1. The path saved in the plugin settings.
2. `NEXUS_ACHIEVEMENT_EVENTS`.
3. `$DECKY_USER_HOME/.local/share/nexus-launcher/achievement-events.jsonl` (the Deck user's home, even when Decky runs as root).

Panel options: enable, toast duration, test notification.

## Tests

`python3 -m unittest discover -s tests`

## Limitations

- Toasts appear when the plugin sees the line (about 0.5 s polling).
- Remote icons need network access; otherwise a trophy icon is shown.
