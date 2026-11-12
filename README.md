# Nexus Achievements (Decky plugin)

Standalone plugin repository, extracted from [nexus-runtime](https://github.com/dante2130/nexus-runtime) with its plugin Git history.

Clone: `git clone https://github.com/dante2130/decky-nexus-achievements.git`.
Use Node.js 24 and Python 3.9 or newer. Run `npm ci`, `npm run typecheck`, `npm run build`, `npm test`, and `python3 -m unittest discover -s tests`.

Xbox-style achievement toasts in Game Mode on Steam Deck for games running on the Nexus runtime.

## How it works

```
game -> nexus-xgameruntime (guest) -> xodus-nexus bridge (host)
     -> ~/.local/share/nexus-launcher/achievement-events.jsonl
     -> this plugin (tails file) -> decky.emit("achievement") -> toaster.toast
```

- `nexus-xgameruntime` advertises the `achievement-notify-v1` capability when it can report unlocks. The runtime passes `NEXUS_INVITE_PORT`/`NEXUS_INVITE_KEY` and `XODUS_BRIDGE_*` to the game process, so the guest can reach the host bridge.
- `xodus-nexus` (the host side) appends one JSON line per unlock to the event file.
- The plugin reads that file and snapshots; optional Xbox metadata is read through
  the signed-in Nexus backend. It never writes achievement progress or talks to the game.

Event line format:

```json
{"type":"achievement","ts":"2026-01-01T00:00:00Z","titleId":"...","scid":"...","id":"1","name":"First Steps","description":"Finish the tutorial","gamerscore":10,"iconUrl":"https://..."}
```

Malformed lines and other `type` values are ignored. The plugin starts at the end of the file (old unlocks are not replayed) and handles truncation and rotation.

## Install

1. Install [Decky Loader](https://decky.xyz) on the Deck.
2. Build: `npm install && npm run build`.
3. Copy this folder (with `dist/`, `main.py`, `achievement_language.py`, `mythic.py`, `steam_menu.py`, `trueachievements.py`, `ta_session.py`, `ta_bridge.py`, `ta_worker.py`, `ta_flags.json`, `plugin.json`, `package.json`, `LICENSE`) to `~/homebrew/plugins/decky-nexus-achievements/` (needs root to write). When extracting an archive, use `sudo tar --no-same-owner` and then `sudo chown -R root:root ~/homebrew/plugins/decky-nexus-achievements` to avoid importing a macOS UID. Keep backups outside `~/homebrew/plugins/`. Restart Decky: `sudo systemctl restart plugin_loader`.
4. Open the Quick Access menu (`...`), then Nexus Achievements, then "Send test notification".

## Achievements viewer

Open the quick-access panel and press **View all achievements** to browse
titles and per-title achievements (filter All/Unlocked/Locked, sort, search;
secret achievements stay hidden until unlocked; a global "Show secret achievements" toggle is persisted, and each locked secret row has its own eye-icon button (below the gamerscore) that overrides it for the current view only and resets when the global toggle changes). Data comes from snapshot files
in `~/.local/share/nexus-launcher/achievements/` (`index.json` plus
`<titleId>.json`), overridable with `NEXUS_ACHIEVEMENTS_DIR`. The page refreshes
when a new achievement event arrives.

Enable **Group achievements**, above the secret-achievement toggle, to separate
the list into **Unlocked** and **Locked** sections with counts. Search and filters
apply before grouping, and the selected sort order is preserved inside each
section. Empty sections are hidden. Grouping is off by default and saved across
restarts.

Filter and sort selections are saved separately for each game in
`settings.json`, under `game_view_settings` keyed by title ID. Reopening a game
restores its own choices, including after restarting Decky. Games without saved
preferences start with **All** and **Unlock date** (newest first).
Use **Remember game filters and sorting** immediately before **Plugin language**
in the main panel to turn this behavior on or off. It is enabled by default.
When disabled, each reopened game starts with the defaults and filter/sort changes
are not saved. Existing saved choices are retained for when the toggle is enabled again.
The **Achievement set** filter offers **All**, **Original**, and **Add-on**,
independently of the unlocked/locked filter. It shares its saved state with the
Mythic-only toggle: enabled selects Original, disabled selects All. Selecting
Add-on switches Mythic-only off. These choices also obey the remember-settings
toggle and restore per game after a restart. Achievements with unknown membership
are shown in All but are not guessed to belong to either set.

The viewer keeps game and achievement lists in memory for the plugin session.
Reopening a list displays cached rows immediately. Achievement responses are
reused for up to one minute; stale lists stay visible during background refreshes.
Snapshot changes, unlock notifications, and language changes refresh the relevant
data. Failed refreshes retain the previous rows. The cache holds at most 32
achievement snapshots and is cleared when the plugin unloads.

Game rows share a cover, left-aligned title, and achievement progress underneath.
The launcher exports Store display names and cover URLs, falling back to the
installed title when Store metadata is unavailable. Restart an updated launcher
to refresh existing snapshots.

While a game is running, the main panel shows a play icon beside its title.
The all-games page shows “Now playing” beside the title. Select either row to
open that game’s achievements. The launcher publishes `running.json` alongside
the snapshots; the plugin polls it every three seconds and ignores records whose
launcher process has exited. Older launchers still support the ordinary list.

### Plugin interface language

Use **Plugin language** at the bottom of the main plugin panel to choose a
supported interface language or **SteamOS language** (the default).
Automatic mode reads Steam's interface language, using English when it is unsupported.
If Steam's language API is unavailable, it uses the browser locale with the same
English fallback. An explicitly saved language takes precedence. The selection is
saved across restarts and updates menus, buttons, messages, dates, and notification
headings immediately. It does not change achievement names and descriptions;
those use the separate achievement-language selector below.

### Achievement language

Choose **Achievement language** in the plugin panel or a title's achievement
page. This changes achievement names and descriptions in the viewer and unlock
notifications; interface headings use the separate plugin language setting. The choice is saved across restarts. **Original
(saved by Nexus)** preserves the snapshot's names and descriptions. The plugin
may still fetch Mythic completion metadata when a compatible backend is installed.
Other languages fetch localized text from Xbox through the signed-in Nexus
backend. Xbox may fall back to another language when a game has no translation.
Unlock state, score, and secret visibility continue to use the original snapshot.

Localized reads require a Nexus backend supporting
`xodus-cli achievements TITLE_ID --json --language LANGUAGE_TAG`. Backend 0.2.14 does
not support this option. The corresponding backend source change is included in
`backend-patches/achievement-language.patch`; apply it in the `nexus-backend`
source checkout at commit `a80cfa0b822d777b6344971079cdea99e5ebfdf9` with
`git apply` and build/install that backend using its own
build instructions. The plugin reports an update requirement for older backends;
select **Original** to keep viewing saved achievements. The managed backend is
resolved from `~/.config/xodus-nexus/xodus-backends/current.json` and runs as the
Deck user, using their existing Nexus sign-in. You can also install the language-enabled
backend from [dante2130/nexus-backend](https://github.com/dante2130/nexus-backend)
under `~/.local/share/nexus-launcher/achievement-backend/` (containing `xodus-cli`
and `xodus-service`). The plugin prefers that copy, so language support can be
installed without changing the launcher's managed backend. Failed localized reads
show a warning while preserving the saved achievement list.

### Mythic achievements

The viewer shows progress toward the original game's Mythic achievement below
the search field and above the achievement groups, with an earned badge and cover frame.
The **Mythic achievements only** toggle inside that card switches between original
achievements required for Mythic and the full list. Search, filters, sorting, and
grouping continue to apply. The toggle is disabled when membership data is unavailable.
Achievements outside the original set are marked **Add-on**. Game-list badges
appear after the game's Mythic metadata has been loaded during the plugin session.

Mythic status comes from Xbox's authoritative `BaseGame` completion group, using
achievement contract version 6 through `xodus-cli achievements TITLE_ID --json
--include-mythic`. Missing group data is shown as unavailable; total gamerscore
or completing every visible achievement never substitutes for Xbox's status.
DLC and title-update achievements are excluded according to Xbox's membership list.

The first observation of an already-earned Mythic seeds history silently. A later
server-reported transition to earned triggers a special notification, once per
account, game, and group during the session. Normal unlock events schedule a
background metadata refresh without delaying achievement notifications. The global
notification switch applies to Mythic notifications too. Offline and older-backend
fallbacks preserve saved achievement rows.

The required backend is built in [dante2130/nexus-backend](https://github.com/dante2130/nexus-backend).
Install the compatible helper under the separate achievement-backend directory
described above. This feature never awards or writes achievements on Xbox.

## Unifideck Xbox PC

Use this plugin alongside a Unifideck build that exports the Xbox PC
achievement feed. Complete the Xbox PC sign-in in Unifideck, then launch an
installed Xbox PC game. The game's first successful achievements read populates the
library, and later reads update the list and send unlocks to this plugin.
Unifideck checks Xbox during play (about every 90 seconds) and after the
game closes. Unifideck also shows its own notifications for these unlocks.

When both launchers have saved the same Xbox title, each launcher has its
own entry and tracker preferences. The Unifideck feed includes Microsoft
Store cover art when available. For achievement languages, rarity, and Mythic,
the plugin can use a compatible Nexus helper when the Unifideck backend lacks
those features and both backends report the same Xbox account. Profile Gamerscore
prefers the Nexus helper and uses Unifideck when no Nexus helper is installed.

## Configuration

Event file, in order of precedence:

1. The path saved in the plugin settings.
2. `NEXUS_ACHIEVEMENT_EVENTS`.
3. `$DECKY_USER_HOME/.local/share/nexus-launcher/achievement-events.jsonl` (the Deck user's home, even when Decky runs as root).

Panel options: enable, toast duration, test notification.

## Tests

`python3 -m unittest discover -s tests`

Frontend cache tests (Node.js 24): `npm run test:cache`.

Interface localization tests: `npm run test:i18n`.

## Limitations

- Toasts appear when the plugin sees the line (about 0.5 s polling).
- Remote icons need network access; otherwise a trophy icon is shown.

Achievement rows show Xbox-reported unlock percentages and a diamond badge for Rare achievements when metadata is available. Missing rarity is left blank.

Use the main panel’s test notification type selector to preview normal, Rare, or Mythic notifications. Previews use sample data and do not change game progress or cached Mythic badges.

To use custom notification audio, place a WAV, MP3, OGG, or FLAC file (up to 5 MB) in your Deck home folder. Select a notification type on the main panel, then choose its custom sound. Preview playback or send a test notification to check the selected file. Each notification type has its own saved file; remove the custom sound to make that notification type silent. Files remain at their selected paths and must stay accessible. Codec playback depends on Steam’s browser audio support.

Steam’s built-in notification sound is disabled. Only selected custom audio files play; notification types without a file are silent.

Normal, Rare, and Mythic notifications have separate display durations. Existing installations use the original duration until a per-type duration is chosen. Notification audio starts once when the popup becomes visible, not when queued or viewed in notification history; pending audio is cancelled if the popup disappears before loading finishes.

When a custom sound is selected, its length (rounded up to a whole second) becomes the minimum display timeout for that notification type. The slider minimum and saved timeout follow this limit, and the slider range expands for longer sounds. Removing the file restores the two-second minimum without shortening your saved timeout.



Enable “Show profile Gamerscore in status bar” to display the signed-in Xbox player profile’s reported total beside the SteamOS status indicators. The setting defaults to off. Profile reads are cached for five minutes and refreshed after achievement events; disabling the setting stops polling and hides the score. Missing profile data is not shown as zero. This feature requires an achievement backend exposing the optional numeric `gamerscore` field in `profile --json` (backend PR: https://github.com/dante2130/nexus-backend/pull/1).



The profile Gamerscore is a clickable status-bar control on the home screen and game pages, not limited to running games. Select it to open the plugin’s all-games list. The same control is reused in Steam header variants without duplicating it.

Game-header integration appends only Nexus entries without replacing Steam’s child array or shifting existing entries. The score badge is anchored separately to the cover, preserving other plugins’ header anchors, including PlayCount and ProtonDB Badges.

Enable “Show Nexus Achievements in game menus” to show the running-game Steam menu entry and a compact clickable badge on the library game view. The badge opens that specific game in Nexus Achievements; no extra game-view panel or tab is added. The profile status-bar score opens the all-games list.

Notification text wraps onto multiple lines. Nexus resizes the managed popup placeholder to fit the content and restores it after the notification closes. Gamerscore stays together before the description. Corner badges have no extra circular background, and Rare uses the original simple blue diamond.

The persistent status-bar fallback uses a regular click control and does not register a controller-navigation node across Steam windows. Native controller focus is added only within the Gamepad header; Frame and VR headers are left untouched.

Mythic progress loads in the background at plugin startup for all saved games, then refreshes every ten minutes. The games list updates as results arrive without opening individual games. The initial scan does not announce historical completions. Xbox sign-in and a connection are required to fetch progress.

The initial local game view includes preloaded Mythic progress, Original/Add-on membership, and selected-language text. The startup scan also warms localized notification text; changing achievement language requests a new background scan.

Achievement sorting supports name, Gamerscore, unlock date, and Xbox unlock percentage (rarity). Use the up/down arrows beside Sort by for ascending/descending order. Ascending rarity puts the rarest achievements first; unavailable rarity stays last in both directions. Sort direction is saved per game when preference saving is enabled.

### TrueAchievements

Achievement rows show localized TA flag badges and an emblem button linking to
achievement guides. The plugin decodes TA's flag bitmasks, requests English names
from Xbox, and matches them to displayed rows by stable achievement ID. Changing
the display language does not change the flags. Ambiguous or unmatched names receive
no inferred flags; absence of a badge does not confirm an achievement is unmissable.

A separate **TrueAchievements filter** lists only flag types present in the game
and combines with unlock-state and achievement-set filters. Clicking a badge applies
its flag filter. Selections persist per game; previous TA filter preferences migrate
to the separate field. Filter rows share a flat group with no internal gaps or
separators. Sorting and direction arrows share a row, with language and tracker options on separate rows.

Left/right moves between badges and between the horizontal achievement action buttons. X toggles a locked secret achievement, and RB opens the focused row's guide.
Holding either shortcut does not repeat its action. Secret text, badges, and guide
buttons stay hidden until revealed; RB explicitly opens a guide even on a hidden row.
Missable badges are red, and all row buttons share readable focus colors. The
status-bar Gamerscore also supports native header D-pad navigation; A opens achievements.

Successful TA metadata is cached in the plugin settings directory for 24 hours.
Failed requests back off for 15 minutes and preserve cached flags with a notice.
TA may block automated requests (HTTP 403); a saved session does not guarantee access,
and browser links remain available when flags cannot be loaded.

#### Signing in to TA

Choose **Sign in to TrueAchievements** in plugin settings or the game view, then
use TA's sign-in control in the Steam browser. Complete sign-in and leave the TA page
open. Return to the plugin and choose **Connect browser session**. The plugin checks
for a signed-in TA page through Steam's local browser debugging interface and copies
only cookies scoped to TrueAchievements. If the Steam build does not expose the page,
it reports that the session cannot be connected. No TA login is required for public
metadata, but a session can be connected for authenticated requests.

The plugin never receives your password or Microsoft cookies. TA session credentials
stay in `trueachievements/session.json` under the plugin settings directory with
owner-only permissions (0600); frontend settings and logs never contain those cookies.
**Disconnect TA session** deletes the plugin's copy and leaves the browser signed in.
TA controls cookie expiry; reconnect after expiry.

TA processing runs in an isolated worker using `/usr/bin/python3` on Steam Deck,
avoiding standard-library modules absent from Decky's frozen Python. Browser session
connection requires `aiohttp` in the system Python environment. Optional TA failures
cannot prevent the core plugin from loading.

### Favorites and achievement tracker

Press **Y** on an achievement row, or use its star button, to add or remove a favorite.
Favorites appear in their own group above the remaining achievements, without duplicate
rows. They follow the current search, sorting, and filters and persist per game.
Favoriting does not start tracking.

Use the pin button on a locked achievement to track it. Tracking is a separate selection
limited to **five achievements per game**. Pinning does not enable the overlay; use the
**Achievement tracker** toggle when you want it visible. Unlocked achievements cannot
be favorited, unfavorited, or tracked and no longer appear in the Favorites group. Unpinning or
unlocking an achievement removes it from the overlay and frees a tracking slot.

The tracker requests Steam notification composition without replacing the running game's
composition queue. It displays only the running Nexus game's selected achievements in a persistent,
non-focusable child browser view on Steam’s notification layer. Its compact layout shows names and
reported progress bars; games that do not report progress display no invented percentage.
Locked secret details remain hidden unless the global reveal preference is enabled.
It reads local snapshots every 1.5 seconds and refreshes Xbox progress in the background
at most once every 15 seconds while tracked achievements are active. Offline refresh
failures retain the last available snapshot.

The **Achievement tracker** toggle is available in the game view and plugin settings.
Both views provide eight screen positions, a displayed count from one to five, and
whole-widget opacity from 20% to 100%. **Hide achievement tracker** appears at the top of the plugin panel
and in plugin-panel tracker controls; hiding is immediate, even if saving fails. The overlay hides
automatically while Steam menus or the main UI are open. Disabling the tracker preserves its selections. The overlay closes
when the game stops or no selected locked achievements remain; it never takes gamepad
focus. If Steam's browser-view API is unavailable, selections remain saved and the settings show
a retry button. Plugin unload closes the popup and stops its timers and background jobs.

Achievement rows display progress bars spanning 65% of the row, with the percentage
beside them. Unknown progress is labeled unavailable; locked secret progress remains hidden.
Normal, rare, and Mythic notifications use Steam’s default sound when their category
has no custom audio file. Custom audio suppresses native playback to avoid duplication.
