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
3. Copy this folder (with `dist/`, `main.py`, `achievement_language.py`, `plugin.json`, `package.json`, `LICENSE`) to `~/homebrew/plugins/decky-nexus-achievements/` (needs root to write). When extracting an archive, use `sudo tar --no-same-owner` and then `sudo chown -R root:root ~/homebrew/plugins/decky-nexus-achievements` to avoid importing a macOS UID. Keep backups outside `~/homebrew/plugins/`. Restart Decky: `sudo systemctl restart plugin_loader`.
4. Open the Quick Access menu (`...`), then Nexus Achievements, then "Send test notification".

## Achievements viewer

Open the quick-access panel and press **View all achievements** to browse
titles and per-title achievements (filter All/Unlocked/Locked, sort, search;
secret achievements stay hidden until unlocked; a global "Show secret achievements" toggle is persisted, and each locked secret row has its own eye-icon button (below the gamerscore) that overrides it for the current view only and resets when the global toggle changes). Data comes from snapshot files
in `~/.local/share/nexus-launcher/achievements/` (`index.json` plus
`<titleId>.json`), overridable with `NEXUS_ACHIEVEMENTS_DIR`. The page refreshes
when a new achievement event arrives.

Game rows share a cover, left-aligned title, and achievement progress underneath.
The launcher exports Store display names and cover URLs, falling back to the
installed title when Store metadata is unavailable. Restart an updated launcher
to refresh existing snapshots.

While a game is running, the main panel shows a play icon beside its title.
The all-games page shows “Now playing” beside the title. Select either row to
open that game’s achievements. The launcher publishes `running.json` alongside
the snapshots; the plugin polls it every three seconds and ignores records whose
launcher process has exited. Older launchers still support the ordinary list.

### Achievement language

Choose **Achievement language** in the plugin panel or a title's achievement
page. This changes achievement names and descriptions in the viewer; menus and
notification text are unchanged. The choice is saved across restarts. **Original
(saved by Nexus)** reads the existing snapshot without an online request.
Other languages fetch localized text from Xbox through the signed-in Nexus
backend. Xbox may fall back to another language when a game has no translation.
Unlock state, score, and secret visibility continue to use the original snapshot.

Localized reads require a managed Nexus backend supporting
`xodus-cli achievements TITLE_ID --json --language uk-UA`. Backend 0.2.14 does
not support this option. The corresponding backend source change is included in
`backend-patches/achievement-language.patch`; apply it in the `nexus-backend`
source checkout at commit `a80cfa0b822d777b6344971079cdea99e5ebfdf9` with
`git apply` and build/install that backend using its own
build instructions. The plugin reports an update requirement for older backends;
select **Original** to keep viewing saved achievements. The managed backend is
resolved from `~/.config/xodus-nexus/xodus-backends/current.json` and runs as the
Deck user, using their existing Nexus sign-in.

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
