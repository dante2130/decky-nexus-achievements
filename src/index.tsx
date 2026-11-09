import {
  findClassModule,
  replacePatch,
  callOriginal,
  ButtonItem,
  DialogButton,
  DropdownItem,
  Dropdown,
  Field,
  Focusable,
  Navigation,
  NavEntryPositionPreferences,
  PanelSection,
  PanelSectionRow,
  SliderField,
  TextField,
  ToggleField,
  staticClasses,
} from "@decky/ui";
import { addEventListener, callable, definePlugin, removeEventListener, routerHook, toaster, openFilePicker, FileSelectionType } from "@decky/api";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FaEye, FaEyeSlash, FaPlay, FaTrophy } from "react-icons/fa";
import { fitNotificationPopup } from "./notification-popup";
import { NotificationAudio, observePopupSound, isNexusToast, type PopupPlayback, type SoundFiles } from "./notification-audio";
import { installProfileGamerscore, setProfileGamerscoreEnabled, saveProfileGamerscore, useProfileGamerscore, refreshProfileGamerscore } from "./profile-gamerscore";
import { installGameMenuButtons, invalidateGameMenuCache, setGameMenuEnabled, saveGameMenuButton, type MenuTarget } from "./game-menu";
import { RareIcon, MythicIcon } from "./achievement-icons";
import { compareAchievements, type AchievementSort, type SortDirection } from "./achievement-sorting";
import { SessionCache } from "./cache";
import { matchesAchievementSet, type AchievementSet } from "./achievement-filters";
import { getPluginLanguage, getPluginLanguagePreference, initializeSystemLanguage, setPluginLanguage, subscribeLanguage, translate, translateError, pluginLanguages, pluginLocales, type Message } from "./i18n";

interface AchievementEvent {
  type: "achievement";
  preview?: boolean;
  rarity?: { percentage: number; category: "Rare" | "Common" };
  ts: string;
  titleId: string;
  scid: string;
  id: string;
  name: string;
  description?: string;
  gamerscore?: number;
  iconUrl?: string;
}

interface Settings {
  enabled: boolean;
  installed_games_only?: boolean;
  game_menu_button?: boolean;
  profile_gamerscore?: boolean;
  duration: number;
  events_path: string;
  show_secrets?: boolean;
  achievement_language?: string;
  plugin_language?: string;
  group_achievements?: boolean;
  remember_game_view_settings?: boolean;
  resolved_path?: string;
  test_notification_type?: NotificationKind;
  notification_sounds?: SoundFiles;
  notification_durations?: Partial<Record<NotificationKind, number>>;
  notification_sound_durations?: Partial<Record<NotificationKind, number>>;
  sound_picker_path?: string;
}

const getSettings = callable<[], Settings>("get_settings");
const setSettings = callable<[boolean, number, string], Settings>("set_settings");
type NotificationKind = "normal" | "rare" | "mythic";
let selectedNotificationKind: NotificationKind = "normal";
let notificationKindSaveQueue = Promise.resolve();
let notificationDurationSaveQueue = Promise.resolve();
const saveTestNotificationType = callable<[NotificationKind], NotificationKind>("set_test_notification_type");
const testNotification = callable<[string, NotificationKind], void>("test_notification");
const setSoundDuration = callable<[NotificationKind, string, number], Settings>("set_notification_sound_duration");
const setNotificationDuration = callable<[NotificationKind, number], Partial<Record<NotificationKind, number>>>("set_notification_duration");
const setNotificationSound = callable<[NotificationKind, string], SoundFiles>("set_notification_sound");
const getNotificationAudio = callable<[NotificationKind], { data?: string; mime?: string }>("get_notification_audio");
const notificationAudio = new NotificationAudio(getNotificationAudio);
function customNotificationSound(kind: NotificationKind, isVisible: () => boolean) {
  if (!notificationAudio.has(kind)) return;
  void notificationAudio.play(kind, isVisible).catch(error => {
    console.error("Nexus notification audio failed", error);
    toaster.toast({ title: translate(getPluginLanguage(), "Could not play custom sound."),
      body: translate(getPluginLanguage(), "Choose an audio file again or remove the custom sound."),
      duration: 5000, playSound: false, showToast: true });
  });
}


interface TitleSummary {
  installed?: boolean;
  titleId: string;
  titleName: string;
  coverUrl?: string;
  unlocked: number;
  total: number;
  gamerscore: number;
  gamerscoreTotal: number;
  updatedAt: number;
}

interface Achievement {
  id: string;
  name: string;
  description: string;
  gamerscore: number;
  iconUrl: string;
  unlocked: boolean;
  unlockedAt: number | null;
  progress: number | null;
  secret: boolean;
  baseGame?: boolean;
  rarity?: { percentage: number; category: "Rare" | "Common" };
}

interface MythicCompletion {
  groupId: string;
  unlocked: boolean;
  totalCount: number;
  unlockedCount: number;
  completedAt: number | null;
}
interface MythicEvent { iconUrl?: string; preview?: boolean; titleId: string; titleName: string; mythic: MythicCompletion; }
const mythicByTitle = new Map<string, MythicCompletion>();
const mythicProgressListeners = new Set<() => void>();
let mythicProgressRevision = 0;
const getMythicProgress = callable<[], Record<string, MythicCompletion>>("get_mythic_progress");
function useMythicProgress() {
  useSyncExternalStore(callback => {
    mythicProgressListeners.add(callback);
    return () => { mythicProgressListeners.delete(callback); };
  }, () => mythicProgressRevision);
}

interface TitleDetail {
  ok: boolean;
  error?: string;
  languageError?: string;
  mythic?: MythicCompletion;
  mythicUnavailable?: "backend" | "data";
  titleId?: string;
  titleName?: string;
  achievements: Achievement[];
}

const listTitles = callable<[], { ok: boolean; error?: string; titles: TitleSummary[] }>("list_titles");
const getTitleAchievements = callable<[string], TitleDetail>("get_title_achievements");
const getSavedTitleAchievements = callable<[string], TitleDetail>("get_saved_title_achievements");
const achievementCache = new SessionCache<TitleDetail>();
const gamesCache = new SessionCache<TitleSummary[]>();
const achievementCacheKey = (title: TitleSummary) => `${title.titleId}:${title.updatedAt}`;

const setShowSecrets = callable<[boolean], boolean>("set_show_secrets");
const setGroupAchievements = callable<[boolean], boolean>("set_group_achievements");
const getAchievementLanguages = callable<[], { data: string; label: string }[]>("get_achievement_languages");
const setAchievementLanguage = callable<[string], string>("set_achievement_language");

const savePluginLanguage = callable<[string], string>("set_plugin_language");

function usePluginTranslation() {
  const locale = useSyncExternalStore(subscribeLanguage, getPluginLanguage);
  const preference = useSyncExternalStore(subscribeLanguage, getPluginLanguagePreference);
  return { locale, preference, t: (message: Message, values?: Record<string, string | number>) => translate(locale, message, values) };
}

function PluginTitle() {
  const { t } = usePluginTranslation();
  return <div className={staticClasses.Title}>{t("Nexus Achievements")}</div>;
}

function PluginLanguageSelector() {
  const { preference, t } = usePluginTranslation();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  return <div>
    <DropdownItem label={t("Plugin language")} description={t("Changes the plugin interface only.")}
      selectedOption={preference} rgOptions={pluginLanguages.map(option => option.data === "system" ? { ...option, label: t("SteamOS language") } : option)}
      onChange={async option => {
        if (saving) return;
        setSaving(true); setError(false);
        try { setPluginLanguage(await savePluginLanguage(option.data)); }
        catch { setError(true); }
        finally { setSaving(false); }
      }} />
    {saving && <div role="status">{t("Changing language…")}</div>}
    {error && <div role="alert">{t("Could not save plugin language.")}</div>}
  </div>;
}

function AchievementLanguageSelector({ onChange }: { onChange?: () => void }) {
  const { locale, t } = usePluginTranslation();
  const [language, setLanguage] = useState("");
  const [options, setOptions] = useState<{ data: string; label: string }[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.all([getSettings(), getAchievementLanguages()]).then(([settings, choices]) => {
      if (live) { setLanguage(settings.achievement_language || ""); setOptions(choices); }
    }).catch(() => { if (live) setError("Could not load achievement languages."); });
    return () => { live = false; };
  }, []);
  return (
    <div>
      {options.length > 0 && <DropdownItem label={t("Achievement language")}
        description={t("Names and descriptions only. Xbox may use a fallback when a translation is unavailable.")}
        rgOptions={options.map(option => option.data ? option : { ...option, label: t("Original (saved by Nexus)") })} selectedOption={language}
        onChange={async option => {
          if (saving) return;
          setSaving(true); setError("");
          try {
            setLanguage(await setAchievementLanguage(option.data));
            achievementCache.clear();
            onChange?.();
          }
          catch { setError("Could not save achievement language."); }
          finally { setSaving(false); }
        }} />}
      {saving && <div role="status">{t("Changing language…")}</div>}
      {error && <div role="alert">{translateError(locale, error)}</div>}
    </div>
  );
}

const ROUTE = "/nexus-achievements";
let requestedTitle: string | null = null;
let requestedGame: TitleSummary | null = null;
let requestedHideAllTitles = false;
const allGamesListeners = new Set<() => void>();
function openAllGamesAchievements() {
  requestedTitle = null; requestedGame = null; requestedHideAllTitles = false;
  allGamesListeners.forEach(listener => listener());
  Navigation.Navigate(ROUTE); Navigation.CloseSideMenus();
}
function openGameAchievements(target: MenuTarget) {
  requestedHideAllTitles = true;
  requestedTitle = target.titleId;
  requestedGame = { ...target, unlocked: target.unlocked ?? 0, total: target.total ?? 0, gamerscore: target.gamerscore ?? 0, gamerscoreTotal: target.gamerscoreTotal ?? 0, updatedAt: target.updatedAt ?? 0 };
  Navigation.Navigate(ROUTE);
  Navigation.CloseSideMenus();
}
const getRunningTitle = callable<[], TitleSummary | null>("get_running_title");

// The toast runs in the Steam UI, so keep the duration locally.
let currentDuration = 8000;
let notificationDurations: Partial<Record<NotificationKind, number>> = {};
type NotificationPlayback = PopupPlayback;

const toastWindowClasses = findClassModule((value: any) => value.GamepadToastPlaceholder && value.GamepadToastPopup) as { GamepadToastPlaceholder: string } | undefined;

function usePopupSound(ref: { current: HTMLDivElement | null }, playback?: NotificationPlayback) {
  useEffect(() => {
    const popup = ref.current?.closest<HTMLElement>(".DeckyGamepadUIPopupToast");
    if (!popup || !toastWindowClasses) return;
    const store = (window as any).SteamUIStore?.WindowStore;
    const instances = [store?.GamepadUIMainWindowInstance, ...(store?.SteamUIWindows || [])];
    for (const instance of instances) {
      const doc = instance?.BrowserWindow?.window?.document as Document | undefined;
      const placeholder = doc?.querySelector<HTMLElement>(`.${toastWindowClasses.GamepadToastPlaceholder}`);
      if (placeholder) return fitNotificationPopup(popup, placeholder);
    }
    return undefined;
  }, [playback]);
  useEffect(() => {
    if (!ref.current || !playback) return;
    return observePopupSound(ref.current, playback, customNotificationSound);
  }, [playback]);
}


function NotificationIcon({ url, mythic = false, rare = false, playback }: { url?: string; mythic?: boolean; rare?: boolean; playback?: NotificationPlayback }) {
  const popupRef = useRef<HTMLDivElement>(null);
  usePopupSound(popupRef, playback);
  const src = safeIcon(url || "");
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return <div ref={popupRef} className="nexus-achievement-notification-logo" style={{ width: 44, height: 40, position: "relative", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
    <style>{`
      .nexus-achievement-notification.DeckyGamepadUIPopupToast {
        height: auto !important;
        min-height: 40px !important;
        max-height: none !important;
        overflow: visible !important;
      }
      .nexus-notification-content {
        text-align: left !important;
        align-items: stretch !important;
        min-width: 0;
        height: auto !important;
        max-height: none !important;
        overflow: visible !important;
      }
      .nexus-notification-content div {
        text-align: left !important;
        white-space: normal !important;
        text-overflow: clip !important;
        overflow: visible !important;
        overflow-wrap: anywhere;
        height: auto !important;
        max-height: none !important;
        -webkit-line-clamp: unset !important;
      }
      .nexus-achievement-notification div:has(> .nexus-achievement-notification-logo) {
        display: flex !important;
        align-self: center !important;
        align-items: center !important;
        justify-content: center !important;
        width: 44px !important;
        height: 40px !important;
        min-height: 0;
        margin-top: 0 !important;
        margin-bottom: 0 !important;
      }
    `}</style>
    {src && !failed
      ? <img src={src} alt="" onError={() => setFailed(true)} style={{ width: 40, height: 40, borderRadius: 4, objectFit: "cover" }} />
      : <FaTrophy size={36} style={{ width: 36, height: 36, display: "block", flexShrink: 0 }} />}
    {(mythic || rare) && <span role="img" aria-label={translate(getPluginLanguage(), mythic ? "Mythic" : "Rare")}
      style={{ position: "absolute", right: 0, bottom: 0, width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", color: mythic ? "#8fdb8f" : "#7bd7ff" }}>
      {mythic ? <MythicIcon size={20} /> : <RareIcon size={18} />}
    </span>}
  </div>;
}

async function showAchievement(event: AchievementEvent) {
  if (!event.preview) {
    refreshProfileGamerscore();
    invalidateGameMenuCache();
    achievementCache.clear();
    gamesCache.invalidate("titles");
  }
  const locale = getPluginLanguage();
  const rarity = event.rarity;
  const rare = rarity?.category === "Rare";
  const rarityText = rarity && Number.isFinite(rarity.percentage) && rarity.percentage >= 0 && rarity.percentage <= 100
    ? translate(locale, "{percentage} of players unlocked", { percentage: new Intl.NumberFormat(pluginLocales[locale], { style: "percent", maximumFractionDigits: 2 }).format(rarity.percentage / 100) }) : "";
  const detailText = [event.description, rarityText].filter(Boolean).join(" • ");
  const hasScore = typeof event.gamerscore === "number";
  const body = <div style={{ width: "100%", minWidth: 0, textAlign: "left" }}>
    {hasScore && <span className="nexus-notification-score" style={{ display: "inline-flex", alignItems: "center", gap: 4, marginRight: 6, whiteSpace: "nowrap" }}>
      <GamerscoreIcon />{event.gamerscore}
    </span>}
    {detailText && <span style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
      {hasScore && "• "}{detailText}
    </span>}
  </div>;
  const kind = rare ? "rare" : "normal";
  const soundLength = await notificationAudio.duration(kind).catch(() => 0);
  const logo = <NotificationIcon url={event.iconUrl} rare={rare} playback={{ kind, played: false }} />;
  toaster.toast({
    className: "nexus-achievement-notification",
    contentClassName: "nexus-notification-content",
    title: translate(locale, rare ? "Rare achievement unlocked: {name}" : "Achievement unlocked: {name}", { name: event.name }),
    body,
    logo,
    duration: Math.max(notificationDurations[kind] ?? currentDuration, soundLength),
    playSound: false,
    showToast: true,
  });
}

async function showMythic(event: MythicEvent) {
  const soundLength = await notificationAudio.duration("mythic").catch(() => 0);
  if (!event.preview) {
    refreshProfileGamerscore();
    mythicByTitle.set(event.titleId, event.mythic);
    achievementCache.clear();
  }
  toaster.toast({
    className: "nexus-achievement-notification",
    contentClassName: "nexus-notification-content",
    title: translate(getPluginLanguage(), "Mythic achievement unlocked"),
    body: translate(getPluginLanguage(), "Unlocked all {total} original achievements in {game}.", { total: event.mythic.totalCount, game: event.titleName }),
    logo: <NotificationIcon url={event.iconUrl} mythic playback={{ kind: "mythic", played: false }} />, duration: Math.max(notificationDurations.mythic ?? currentDuration, soundLength), playSound: false, showToast: true,
  });
}

function MythicBadge() {
  const { t } = usePluginTranslation();
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#8fdb8f", fontSize: 12 }}>
    <MythicIcon />{t("Mythic")}
  </span>;
}

function MythicProgress({ detail, mythicOnly, onChange }: { detail: TitleDetail; mythicOnly: boolean; onChange: (enabled: boolean) => void }) {
  const { t } = usePluginTranslation();
  const group = detail.mythic;
  if (!group) return <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 12 }}>
    {t(detail.mythicUnavailable === "backend" ? "Update the Nexus achievement backend for Mythic support." : "Mythic progress is unavailable for this game.")}
  </div>;
  return <section style={{ padding: 12, marginBottom: 12, borderRadius: 10, background: "rgba(143,219,143,0.08)", display: "flex", alignItems: "center", gap: 16 }}>
    <div style={{ width: 80, height: 80, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}><MythicIcon size={80} /></div>
    <div style={{ flex: 1, minWidth: 0 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <strong>{t("Mythic achievement")}</strong>{group.unlocked && <MythicBadge />}
    </div>
    <div style={{ marginTop: 4 }}>{t("{unlocked}/{total} original achievements", { unlocked: group.unlockedCount, total: group.totalCount })}</div>
    <div role="progressbar" aria-label={t("Mythic achievement")} aria-valuemin={0} aria-valuemax={group.totalCount} aria-valuenow={group.unlockedCount}
      style={{ marginTop: 8, height: 6, borderRadius: 3, background: "rgba(255,255,255,0.15)", overflow: "hidden" }}>
      <div style={{ width: `${group.unlockedCount / group.totalCount * 100}%`, height: "100%", background: "#8fdb8f" }} />
    </div>
    <ToggleField label={t("Mythic achievements only")} description={t("Turn off to show all achievements.")}
      checked={mythicOnly} onChange={onChange} disabled={!detail.achievements.some(a => a.baseGame !== undefined)} />
    </div>
  </section>;
}

type Filter = "all" | "unlocked" | "locked";
type Sort = AchievementSort;
interface GameViewSettings { filter: Filter; sort: Sort; sortDirection: SortDirection; contentFilter: AchievementSet; }
const DEFAULT_GAME_VIEW: GameViewSettings = { filter: "all", sort: "date", sortDirection: "desc", contentFilter: "all" };
const getGameViewSettings = callable<[string], GameViewSettings>("get_game_view_settings");
const setGameViewSettings = callable<[string, Filter, Sort, AchievementSet, SortDirection], GameViewSettings>("set_game_view_settings");
const gameViewCache = new Map<string, GameViewSettings>();
let rememberGameView = true;
let gameViewPreferenceGeneration = 0;
const setRememberGameViewSettings = callable<[boolean], boolean>("set_remember_game_view_settings");
function applyRememberGameView(enabled: boolean) {
  if (rememberGameView !== enabled) gameViewPreferenceGeneration++;
  rememberGameView = enabled;
  if (!enabled) gameViewCache.clear();
}
let gameViewSaveQueue = Promise.resolve();
function saveGameView(titleId: string, value: GameViewSettings): Promise<GameViewSettings> {
  const generation = gameViewPreferenceGeneration;
  const result = gameViewSaveQueue.then(() => rememberGameView && generation === gameViewPreferenceGeneration
    ? setGameViewSettings(titleId, value.filter, value.sort, value.contentFilter, value.sortDirection) : value);
  gameViewSaveQueue = result.then(() => undefined, () => undefined);
  return result;
}

const FILTERS = [
  { data: "all", label: "All" },
  { data: "unlocked", label: "Unlocked" },
  { data: "locked", label: "Locked" },
];
const SORTS = [
  { data: "name", label: "Name" },
  { data: "gamerscore", label: "Gamerscore" },
  { data: "date", label: "Unlock date" },
  { data: "rarity", label: "Rarity" },
];
const ACHIEVEMENT_SETS = [
  { data: "all", label: "All" },
  { data: "original", label: "Original" },
  { data: "addon", label: "Add-on" },
];

const safeIcon = (url: string) => (/^https?:\/\//.test(url) ? url : "");
const fmtDate = (ms: number | null) => (ms ? new Date(ms).toLocaleString(pluginLocales[getPluginLanguage()]) : "");

function Icon({ url }: { url: string }) {
  const src = safeIcon(url);
  return src
    ? <img src={src} style={{ width: 56, height: 56, borderRadius: 4, objectFit: "cover", flexShrink: 0 }} />
    : <div style={{ width: 56, height: 56, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><FaTrophy size={28} /></div>;
}

function GameCover({ url, mythic = false }: { url?: string; mythic?: boolean }) {
  const src = safeIcon(url || "");
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return <div style={{ width: 80, height: 80, aspectRatio: "1 / 1", flexShrink: 0, borderRadius: 4, boxShadow: mythic ? "0 0 0 2px #8fdb8f" : undefined, overflow: "hidden", transform: "translateZ(0)", isolation: "isolate", background: "rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "center" }}>
    {src && !failed ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} style={{ width: "100%", height: "100%", objectFit: "cover", imageRendering: "auto", display: "block" }} /> : <FaTrophy size={24} />}
  </div>;
}

function GamerscoreIcon() {
  const { t } = usePluginTranslation();
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" role="img" className="nexus-gamerscore-icon" aria-label={t("Gamerscore")}
      style={{ display: "inline-block", verticalAlign: "-0.15em", flexShrink: 0 }}>
      <circle cx="12" cy="12" r="11" style={{ fill: "#fff" }} />
      <path d="M16 8.5a5 5 0 1 0 .5 6.5V12H12" style={{ fill: "none", stroke: "#182726", strokeWidth: 2.2 }} />
    </svg>
  );
}

function AchievementRow({ a, reveal, onToggle }: { a: Achievement; reveal: boolean; onToggle: () => void }) {
  const { locale, t } = usePluginTranslation();
  const rowRef = useRef<HTMLDivElement>(null);
  const hasRevealButton = a.secret && !a.unlocked;
  const hidden = a.secret && !a.unlocked && !reveal;
  const revealed = a.secret && !a.unlocked && reveal;
  const name = a.name || t("Unnamed achievement");
  const description = a.description || (revealed ? t("Details unavailable for this secret achievement.") : "");
  const content = <>
      <Icon url={hidden ? "" : a.iconUrl} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: "bold" }}>{hidden ? t("Secret achievement") : name}</div>
        <div style={{ fontSize: 13, opacity: 0.8 }}>{hidden ? t("Keep playing to reveal this achievement.") : description}</div>
        {a.rarity && Number.isFinite(a.rarity.percentage) && a.rarity.percentage >= 0 && a.rarity.percentage <= 100 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, opacity: 0.8, marginTop: 4 }}>
            {a.rarity.category === "Rare" && <><RareIcon /><span>{t("Rare")}</span><span>·</span></>}
            <span>{t("{percentage} of players unlocked", { percentage: new Intl.NumberFormat(pluginLocales[locale], { style: "percent", maximumFractionDigits: 2 }).format(a.rarity.percentage / 100) })}</span>
          </div>
        )}
        {a.baseGame === false && <div style={{ fontSize: 11, opacity: 0.7 }}>{t("Add-on")}</div>}
        {!a.unlocked && a.progress !== null && !hidden && (
          <div style={{ marginTop: 4, height: 6, background: "rgba(255,255,255,0.15)", borderRadius: 3 }}>
            <div style={{ width: `${a.progress}%`, height: "100%", background: "#1a9fff", borderRadius: 3 }} />
          </div>
        )}
        {a.unlocked && a.unlockedAt && <div style={{ fontSize: 12, opacity: 0.7 }}>{t("Unlocked {date}", { date: fmtDate(a.unlockedAt) })}</div>}
        {!a.unlocked && a.progress !== null && !hidden && <div style={{ fontSize: 12, opacity: 0.7 }}>{a.progress}%</div>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
        <div style={{ fontWeight: "bold", whiteSpace: "nowrap" }}><GamerscoreIcon /> {hidden ? "?" : a.gamerscore}</div>
        {hasRevealButton && (
          <DialogButton
            className="nexus-secret-reveal"
            preferredFocus
            noFocusRing
            onGamepadFocus={() => {
              rowRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
            }}
            aria-label={reveal ? t("Hide secret achievement") : t("Show secret achievement")}
            style={{ width: "auto", minWidth: 0, height: 32, padding: "0 12px", display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={onToggle}>
            {reveal ? <FaEyeSlash /> : <FaEye />}
          </DialogButton>
        )}
      </div>
  </>;
  const style = { display: "flex", gap: 12, padding: "8px", borderRadius: 10, opacity: a.unlocked ? 1 : 0.65 };
  // Secret rows expose only the native reveal button as a navigation target.
  if (hasRevealButton) return <div ref={rowRef} style={style}
    className="nexus-achievement-row">{content}</div>;
  return <Focusable ref={rowRef} tabIndex={0} noFocusRing className="nexus-achievement-row"
    aria-label={name} onActivate={() => { /* Read-only navigation target. */ }}
    onGamepadFocus={() => rowRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" })}
    focusClassName="nexus-achievement-row-focused" style={style}>{content}</Focusable>;
}

function TitleView({ title, onBack, tick, hideAllTitles = false }: { title: TitleSummary; onBack: () => void; tick: number; hideAllTitles?: boolean }) {
  const { locale, t } = usePluginTranslation();
  const [languageRevision, setLanguageRevision] = useState(0);
  const [reveal, setReveal] = useState(false);
  const [grouped, setGrouped] = useState(false);
  const [groupError, setGroupError] = useState(false);
  useEffect(() => {
    getSettings().then(s => { setReveal(!!s.show_secrets); setGrouped(!!s.group_achievements); applyRememberGameView(s.remember_game_view_settings ?? true); }).catch(() => {});
  }, []);
  // Per-row overrides are session-only; the global toggle clears them.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const toggleReveal = (v: boolean) => { setReveal(v); setOverrides({}); setShowSecrets(v).catch(() => {}); };
  const isRevealed = (a: Achievement) => overrides[a.id] ?? reveal;
  const [detail, setDetail] = useState<TitleDetail | null>(() => achievementCache.peek(achievementCacheKey(title)) ?? null);
  const [view, setView] = useState<GameViewSettings>(() => (rememberGameView ? gameViewCache.get(title.titleId) : undefined) ?? DEFAULT_GAME_VIEW);
  const { filter, sort, sortDirection, contentFilter } = view;
  const [viewError, setViewError] = useState<Message | null>(null);
  const viewRevision = useRef(0);
  const viewMounted = useRef(false);
  useEffect(() => {
    viewMounted.current = true;
    const revision = viewRevision.current;
    gameViewSaveQueue.then(() => getGameViewSettings(title.titleId)).then(value => {
      if (viewMounted.current && viewRevision.current === revision) {
        if (rememberGameView) gameViewCache.set(title.titleId, value);
        setView(value);
      }
    }).catch(() => {
      if (viewMounted.current && viewRevision.current === revision) setViewError("Could not load game view settings.");
    });
    return () => { viewMounted.current = false; };
  }, [title.titleId]);
  const updateView = (patch: Partial<GameViewSettings>) => {
    const next = { ...(rememberGameView ? gameViewCache.get(title.titleId) ?? view : view), ...patch };
    const revision = ++viewRevision.current;
    if (rememberGameView) gameViewCache.set(title.titleId, next);
    setView(next);
    setViewError(null);
    if (!rememberGameView) return;
    void saveGameView(title.titleId, next).catch(() => {
      if (gameViewCache.get(title.titleId) === next) gameViewCache.delete(title.titleId);
      if (viewMounted.current && viewRevision.current === revision) setViewError("Could not save game view settings.");
    });
  };
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    const key = achievementCacheKey(title);
    if (!achievementCache.peek(key)) {
      // Never make the first local list wait for an optional Xbox metadata read.
      getSavedTitleAchievements(title.titleId).then(saved => {
        if (live && saved.ok) setDetail(previous => previous?.ok ? previous : saved);
      }).catch(() => {});
    }
    achievementCache.load(key, async () => {
      const result = await getTitleAchievements(title.titleId);
      if (!result.ok) throw new Error(result.error || "Failed to load");
      return result;
    }, 60_000, result => !result.languageError)
      .then(d => {
        if (d.mythic) mythicByTitle.set(title.titleId, d.mythic);
        if (live) setDetail(d);
      })
      .catch(() => { if (live) setDetail(previous => previous?.ok ? previous : { ok: false, error: "Failed to load", achievements: [] }); });
    return () => { live = false; };
  }, [title.titleId, title.updatedAt, tick, languageRevision]);

  useEffect(() => {
    const listener = addEventListener<[MythicEvent]>("mythic", event => {
      if (event.titleId === title.titleId) setDetail(previous => previous ? { ...previous, mythic: event.mythic } : previous);
    });
    return () => removeEventListener("mythic", listener);
  }, [title.titleId]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (detail?.achievements ?? []).filter(a => {
      if (!matchesAchievementSet(a, contentFilter)) return false;
      if (filter === "unlocked" && !a.unlocked) return false;
      if (filter === "locked" && a.unlocked) return false;
      if (!q) return true;
      const hidden = a.secret && !a.unlocked && !isRevealed(a);
      return !hidden && (a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q));
    });
    return list.sort((x, y) => compareAchievements(x, y, sort, sortDirection));
  }, [detail, filter, sort, sortDirection, query, reveal, overrides, contentFilter]);
  const membershipPending = contentFilter !== "all" && detail?.ok && !detail.mythic && !detail.mythicUnavailable;

  const groups: { label: "Unlocked" | "Locked" | null; items: Achievement[] }[] = grouped
    ? [{ label: "Unlocked", items: rows.filter(a => a.unlocked) }, { label: "Locked", items: rows.filter(a => !a.unlocked) }]
    : [{ label: null, items: rows }];

  return (
    <div>
      <style>{`
        .nexus-achievement-row,
        .nexus-achievement-row .gpfocus {
          outline: none !important;
          box-shadow: none !important;
          animation: none !important;
        }
        :is(.nexus-achievement-row-focused, .nexus-achievement-row:focus-within,
          .nexus-achievement-row:has(.nexus-secret-reveal:is(.gpfocus, :focus, :active))) {
          background: #fff;
          color: #0e141b;
          opacity: 1 !important;
          border-radius: 10px;
        }
        :is(.nexus-achievement-row-focused, .nexus-achievement-row:focus-within,
          .nexus-achievement-row:has(.nexus-secret-reveal:is(.gpfocus, :focus, :active))) .nexus-gamerscore-icon circle {
          fill: #0e141b !important;
        }
        :is(.nexus-achievement-row-focused, .nexus-achievement-row:focus-within,
          .nexus-achievement-row:has(.nexus-secret-reveal:is(.gpfocus, :focus, :active))) .nexus-gamerscore-icon path {
          stroke: #fff !important;
        }
        .nexus-achievement-row .nexus-secret-reveal {
          background: #3d4450 !important;
          color: #fff !important;
        }
        .nexus-achievement-row .nexus-secret-reveal:is(.gpfocus, :focus, :hover, :active) {
          background: #fff !important;
          color: #0e141b !important;
        }
        .nexus-secret-reveal svg {
          color: inherit;
          fill: currentColor;
        }
      `}</style>
      {!hideAllTitles && <ButtonItem layout="below" onClick={onBack}>{t("← All titles")}</ButtonItem>}
      <div style={{ display: "flex", alignItems: "center", gap: 16, margin: "8px 0" }}><GameCover url={title.coverUrl} mythic={detail?.mythic?.unlocked} /><h2>{title.titleName}</h2></div>
      <div style={{ opacity: 0.8, marginBottom: 8 }}>
        {t("{unlocked}/{total} unlocked", { unlocked: title.unlocked, total: title.total })} • <GamerscoreIcon /> {title.gamerscore}/{title.gamerscoreTotal}
      </div>
      <DropdownItem label={t("Filter")} rgOptions={FILTERS.map(option => ({ ...option, label: t(option.label as Message) }))} selectedOption={filter}
        onChange={o => updateView({ filter: o.data as Filter })} />
      <DropdownItem label={t("Achievement set")} rgOptions={ACHIEVEMENT_SETS.map(option => ({ ...option, label: t(option.label as Message) }))}
        selectedOption={contentFilter} onChange={option => updateView({ contentFilter: option.data as AchievementSet })} />
      <Field label={t("Sort by")} childrenContainerWidth="min" verticalAlignment="center">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>

        {(["asc", "desc"] as const).map(direction => <DialogButton key={direction}
          aria-label={t(direction === "asc" ? "Ascending" : "Descending")}
          aria-pressed={sortDirection === direction}
          style={{ width: 44, minWidth: 44, padding: 0, height: 40,
            background: sortDirection === direction ? "#fff" : undefined,
            color: sortDirection === direction ? "#0e141b" : undefined }}
          onClick={() => updateView({ sortDirection: direction })}>{direction === "asc" ? "↑" : "↓"}</DialogButton>)}
          <Dropdown rgOptions={SORTS.map(option => ({ ...option, label: t(option.label as Message) }))} selectedOption={sort}
            onChange={o => updateView({ sort: o.data as Sort })} />
        </div>
      </Field>
      {viewError && <div role="alert">{t(viewError)}</div>}
      <AchievementLanguageSelector onChange={() => setLanguageRevision(value => value + 1)} />
      <ToggleField label={t("Group achievements")} description={t("Separate unlocked and locked achievements.")}
        checked={grouped} onChange={async enabled => {
          setGroupError(false);
          try { setGrouped(await setGroupAchievements(enabled)); }
          catch { setGroupError(true); }
        }} />
      {groupError && <div role="alert">{t("Could not save achievement grouping.")}</div>}
      <ToggleField label={t("Show secret achievements")} description={t("Reveal names and descriptions of locked secret achievements.")}
        checked={reveal} onChange={toggleReveal} />
      <div style={{ marginTop: 12 }}>
        <TextField label={t("Search")} value={query} onChange={e => setQuery(e.target.value)} />
      </div>
      {detail?.ok && (detail.mythic || detail.mythicUnavailable) && <div style={{ marginTop: 12 }}><MythicProgress detail={detail}
        mythicOnly={contentFilter === "original"} onChange={enabled => updateView({ contentFilter: enabled ? "original" : "all" })} /></div>}
      {!detail && <div style={{ padding: 16 }}>{t("Loading…")}</div>}
      {detail && !detail.ok && <div style={{ padding: 16 }}>{t("Could not load achievements ({error}).", { error: translateError(locale, detail.error) })}</div>}
      {detail?.languageError && <div role="alert" style={{ padding: 16 }}>{t("Showing original achievement text. {error}", { error: translateError(locale, detail.languageError) })}</div>}
      {membershipPending && <div role="status" style={{ padding: 16, opacity: 0.7 }}>{t("Loading achievement set…")}</div>}
      {detail?.ok && !membershipPending && rows.length === 0 && <div style={{ padding: 16, opacity: 0.7 }}>{t("No achievements match.")}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {groups.filter(group => group.items.length > 0).map(group => <div key={group.label || "all"}>
          {group.label && <h3 style={{ margin: "12px 0 8px" }}>{t(group.label)} ({group.items.length})</h3>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {group.items.map(a => <AchievementRow key={a.id || a.name} a={a} reveal={isRevealed(a)}
              onToggle={() => setOverrides(o => ({ ...o, [a.id]: !isRevealed(a) }))} />)}
          </div>
        </div>)}
      </div>
    </div>
  );
}

function RunningGame({ onSelect, showPlayingText = false, flushCover = false }: { onSelect: (titleId: string) => void; showPlayingText?: boolean; flushCover?: boolean }) {
  const [title, setTitle] = useState<TitleSummary | null>(null);
  useEffect(() => {
    let live = true;
    const refresh = () => getRunningTitle().then(value => { if (live) setTitle(value); })
      .catch(() => { if (live) setTitle(null); });
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  if (!title) return null;
  return <TitleRow title={title} onSelect={onSelect} playing showPlayingText={showPlayingText} flushCover={flushCover} />;
}

function TitleRow({ title, onSelect, playing = false, showPlayingText = false, flushCover = false }: {
  title: TitleSummary; onSelect: (titleId: string) => void; playing?: boolean; showPlayingText?: boolean; flushCover?: boolean;
}) {
  const { t } = usePluginTranslation();
  useMythicProgress();
  const mythic = mythicByTitle.get(title.titleId);
  const content = (
    <div style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left" }}>
      <GameCover url={title.coverUrl} mythic={mythic?.unlocked} />
      <div style={{ flex: 1, minWidth: 0, whiteSpace: "normal", paddingRight: flushCover ? 12 : 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ flex: 1, minWidth: 0 }}>{title.titleName}</span>
          {mythic?.unlocked && <MythicBadge />}
          {playing && <span aria-label={t("Now playing")} style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0, color: "#8fdb8f", fontSize: 12, whiteSpace: "nowrap" }}>
            <FaPlay aria-hidden="true" />{showPlayingText && t("Now playing")}
          </span>}
        </div>
        <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>{t("{unlocked}/{total} unlocked", { unlocked: title.unlocked, total: title.total })} • <GamerscoreIcon /> {title.gamerscore}/{title.gamerscoreTotal}</div>
      </div>
    </div>
  );
  return flushCover
    ? <DialogButton style={{ width: "100%", height: "auto", minHeight: 80, padding: 4, overflow: "hidden" }} onClick={() => onSelect(title.titleId)}>{content}</DialogButton>
    : <ButtonItem layout="below" onClick={() => onSelect(title.titleId)}>{content}</ButtonItem>;
}

const saveInstalledGamesOnly = callable<[boolean], boolean>("set_installed_games_only");
let installedGamesOnly = false;

function AchievementsPage() {
  const { locale, t } = usePluginTranslation();
  const [titles, setTitles] = useState<TitleSummary[] | null>(() => gamesCache.peek("titles") ?? null);
  const [gameQuery, setGameQuery] = useState("");
  const [installedOnly, setInstalledOnly] = useState(installedGamesOnly);
  const [installedFilterError, setInstalledFilterError] = useState(false);
  const installedFilterRevision = useRef(0);
  useEffect(() => {
    const revision = installedFilterRevision.current;
    getSettings().then(settings => {
      if (revision !== installedFilterRevision.current) return;
      installedGamesOnly = settings.installed_games_only ?? false;
      setInstalledOnly(installedGamesOnly);
    }).catch(() => {});
  }, []);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(() => { const title = requestedTitle; requestedTitle = null; return title; });
  const pageRef = useRef<HTMLDivElement>(null);
  const [hideAllTitles, setHideAllTitles] = useState(requestedHideAllTitles);
  const selectTitle = (id: string) => { setHideAllTitles(false); setSelected(id); };
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const listener = () => { setSelected(null); setHideAllTitles(false); };
    allGamesListeners.add(listener);
    return () => { allGamesListeners.delete(listener); };
  }, []);

  const reload = useCallback(() => {
    // Recheck lightweight snapshot metadata while retaining the visible list.
    gamesCache.load("titles", async () => {
      const result = await listTitles();
      if (!result.ok) throw new Error(result.error || "Failed to load");
      return result.titles;
    }, 0)
      .then(value => { setTitles(value); setError(""); })
      .catch(() => { setTitles(previous => previous ?? []); setError("Failed to refresh games"); });
  }, []);

  useEffect(() => { reload(); }, [reload, tick]);

  useEffect(() => {
    // Snapshots are written by the host around the time the event arrives.
    routerHook.addRoute(ROUTE, AchievementsPage, { exact: true });
  const listener = addEventListener<[AchievementEvent]>("achievement", () => {
      setTimeout(() => setTick(t => t + 1), 1500);
    });
    return () => removeEventListener("achievement", listener);
  }, []);

  useEffect(() => {
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const page = pageRef.current;
        const first = page?.querySelector<HTMLElement>('button:not([disabled]), [tabindex="0"]');
        first?.focus({ preventScroll: true });
      });
    });
    return () => { cancelAnimationFrame(firstFrame); cancelAnimationFrame(secondFrame); };
  }, [selected]);

  const title = titles?.find(t => t.titleId === selected) ?? (requestedGame?.titleId === selected ? requestedGame : undefined);
  const matchingTitles = useMemo(() => {
    const query = gameQuery.trim().toLocaleLowerCase();
    return titles?.filter(item => (!installedOnly || item.installed === true) && item.titleName.toLocaleLowerCase().includes(query)) ?? [];
  }, [titles, gameQuery, installedOnly]);

  return (
    <Focusable ref={pageRef} tabIndex={0} noFocusRing flow-children="column" navEntryPreferPosition={NavEntryPositionPreferences.FIRST} preferredFocus
      onGamepadFocus={event => {
        // Forward entry from Steam's header to a control, without redirecting descendant focus.
        if (event.target !== pageRef.current) return;
        pageRef.current?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]')?.focus({ preventScroll: true });
      }}
      style={{ padding: "40px 24px 60px", marginTop: 40, height: "100%", overflowY: "auto", scrollPaddingBottom: 60, boxSizing: "border-box" }}>
      {title ? (
        <TitleView key={title.titleId} title={title} tick={tick} hideAllTitles={hideAllTitles} onBack={() => setSelected(null)} />
      ) : (
        <div>
          <h1 style={{ margin: "0 0 12px" }}>{t("Nexus Achievements")}</h1>
          <div style={{ marginBottom: 8 }}><RunningGame onSelect={selectTitle} showPlayingText flushCover /></div>
          <ToggleField label={t("Installed games only")} checked={installedOnly} onChange={async enabled => {
            const revision = ++installedFilterRevision.current;
            installedGamesOnly = enabled; setInstalledOnly(enabled); setInstalledFilterError(false);
            try { await saveInstalledGamesOnly(enabled); }
            catch { if (revision === installedFilterRevision.current) setInstalledFilterError(true); }
          }} />
          {installedFilterError && <div role="alert">{t("Could not save installed games filter.")}</div>}
          <div style={{ marginTop: 12 }}>
            <TextField label={t("Search games")} value={gameQuery} onChange={event => setGameQuery(event.target.value)} />
          </div>
          {titles === null && <div>{t("Loading…")}</div>}
          {error && <div style={{ padding: 8 }}>{translateError(locale, error)}</div>}
          {titles && titles.length === 0 && !error && (
            <div style={{ opacity: 0.7 }}>{t("No achievements yet. Play a Nexus game to start unlocking.")}</div>
          )}
          {titles && titles.length > 0 && matchingTitles.length === 0 && !error && (
            <div style={{ padding: "12px 0", opacity: 0.7 }}>{t("No games match these filters.")}</div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {matchingTitles.map(t => <TitleRow key={t.titleId} title={t} onSelect={selectTitle} flushCover />)}
          </div>
          <ButtonItem layout="below" onClick={reload}>{t("Refresh")}</ButtonItem>
        </div>
      )}
    </Focusable>
  );
}

function DurationLabel({ label, seconds }: { label: string; seconds: number }) {
  const { t } = usePluginTranslation();
  return <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, width: "100%", minWidth: 0 }}>
    <span style={{ flex: 1, minWidth: 0, whiteSpace: "normal" }}>{label}</span>
    <span style={{ flexShrink: 0, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{t("{seconds} sec", { seconds })}</span>
  </div>;
}

function Content() {
  const { t } = usePluginTranslation();
  const [settings, setLocal] = useState<Settings | null>(null);
  const [rememberError, setRememberError] = useState(false);
  const [gameMenuError, setGameMenuError] = useState(false);
  const [profileScoreError, setProfileScoreError] = useState(false);
  const profileScore = useProfileGamerscore();
  const [notificationKind, setNotificationKind] = useState<NotificationKind>(() => selectedNotificationKind);
  const notificationOptions = useMemo(() => [
    { data: "normal", label: t("Normal achievement") },
    { data: "rare", label: t("Rare achievement") },
    { data: "mythic", label: t("Mythic") },
  ], [getPluginLanguage()]);
  const [notificationError, setNotificationError] = useState(false);
  const [durationError, setDurationError] = useState(false);
  const [soundError, setSoundError] = useState(false);
  const [soundBusy, setSoundBusy] = useState(false);
  const soundFiles = useSyncExternalStore(notificationAudio.subscribe, notificationAudio.getFiles);

  useEffect(() => {
    Promise.all([notificationKindSaveQueue, notificationDurationSaveQueue]).then(() => getSettings()).then(s => { setGameMenuEnabled(s.game_menu_button ?? true); setProfileGamerscoreEnabled(s.profile_gamerscore ?? false); currentDuration = s.duration; notificationDurations = s.notification_durations || {}; notificationAudio.configure(s.notification_sounds, s.notification_sound_durations); setPluginLanguage(s.plugin_language || "system"); applyRememberGameView(s.remember_game_view_settings ?? true);
      const kind = s.test_notification_type;
      selectedNotificationKind = kind === "rare" || kind === "mythic" ? kind : "normal";
      setNotificationKind(selectedNotificationKind); setLocal(s); });
  }, []);

  useEffect(() => {
    if (!settings) return;
    let active = true;
    const pending = (["normal", "rare", "mythic"] as const).filter(kind => soundFiles[kind] && !settings.notification_sound_durations?.[kind]);
    if (pending.length) {
      void Promise.all(pending.map(async kind => {
        const duration = await notificationAudio.duration(kind);
        return setSoundDuration(kind, soundFiles[kind]!, duration);
      })).then(() => getSettings()).then(saved => {
        currentDuration = saved.duration; notificationDurations = saved.notification_durations || {};
        if (active) setLocal(saved);
      }).catch(() => { if (active) setSoundError(true); });
    }
    return () => { active = false; };
  }, [soundFiles, settings?.notification_sound_durations, !!settings]);

  if (!settings) return null;
  const soundMinimum = (kind: NotificationKind) => Math.max(2, Math.ceil((settings.notification_sound_durations?.[kind] || 0) / 1000));
  const soundMaximum = (kind: NotificationKind) => Math.min(86400, Math.max(30,
    soundMinimum(kind) > 30 ? soundMinimum(kind) + 30 : 30,
    Math.ceil((kind === "normal" ? settings.duration : settings.notification_durations?.[kind] ?? settings.duration) / 1000)));
  const measuringSound = (kind: NotificationKind) => !!soundFiles[kind] && !settings.notification_sound_durations?.[kind];

  const update = async (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setLocal(next);
    currentDuration = next.duration;
    setLocal(await setSettings(next.enabled, next.duration, next.events_path));
  };

  const saveSound = async (path: string) => {
    setSoundBusy(true); setSoundError(false);
    try {
      const files = await setNotificationSound(notificationKind, path);
      notificationAudio.invalidate(notificationKind);
      notificationAudio.configure(files);
      setLocal(previous => {
        if (!previous) return previous;
        const lengths = { ...previous.notification_sound_durations };
        delete lengths[notificationKind];
        return { ...previous, notification_sounds: files, notification_sound_durations: lengths };
      });
    } catch { setSoundError(true); }
    finally { setSoundBusy(false); }
  };
  const soundPath = soundFiles[notificationKind];

  return (
    <PanelSection title={t("Nexus Achievements")}>
      <PanelSectionRow>
        <RunningGame flushCover onSelect={titleId => { requestedHideAllTitles = false; requestedTitle = titleId; Navigation.CloseSideMenus(); Navigation.Navigate(ROUTE); }} />
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => { Navigation.CloseSideMenus(); Navigation.Navigate(ROUTE); }}>
          {t("View all achievements")}
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField label={t("Enable notifications")} checked={settings.enabled}
          onChange={enabled => update({ enabled })} />
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField label={t("Show Nexus Achievements in game menus")} description={t("Add a button to the running game menu and library page.")}
          checked={settings.game_menu_button ?? true} onChange={async enabled => {
            setGameMenuError(false);
            try {
              const saved = await saveGameMenuButton(enabled);
              setGameMenuEnabled(saved);
              setLocal(previous => previous ? { ...previous, game_menu_button: saved } : previous);
            } catch { setGameMenuError(true); }
          }} />
        {gameMenuError && <div role="alert">{t("Could not save game menu preference.")}</div>}
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField label={t("Show profile Gamerscore in status bar")} description={t("Display your Xbox profile’s total Gamerscore in the SteamOS header.")}
          checked={settings.profile_gamerscore ?? false} onChange={async enabled => {
            setProfileScoreError(false);
            try {
              const saved = await saveProfileGamerscore(enabled);
              setProfileGamerscoreEnabled(saved);
              setLocal(previous => previous ? { ...previous, profile_gamerscore: saved } : previous);
            } catch { setProfileScoreError(true); }
          }} />
        {profileScoreError && <div role="alert">{t("Could not save profile Gamerscore preference.")}</div>}
        {profileScore.enabled && profileScore.unavailable && <div role="status" style={{ fontSize: 12, opacity: 0.7 }}>{t("Profile Gamerscore unavailable. Check your Nexus sign-in and update the achievement backend.")}</div>}
      </PanelSectionRow>
      <PanelSectionRow>
        <AchievementLanguageSelector />
      </PanelSectionRow>
      <PanelSectionRow>
        <SliderField layout="below" showValue={false} label={<DurationLabel label={t("Normal notification")} seconds={Math.max(soundMinimum("normal"), Math.round(settings.duration / 1000))} />} min={soundMinimum("normal")} max={soundMaximum("normal")} disabled={measuringSound("normal")} step={1}
          value={Math.max(soundMinimum("normal"), Math.round(settings.duration / 1000))}
          onChange={seconds => update({ duration: seconds * 1000 })} />
      </PanelSectionRow>
      {(["rare", "mythic"] as const).map(kind => <PanelSectionRow key={kind}>
        <SliderField layout="below" showValue={false} label={<DurationLabel label={t(kind === "rare" ? "Rare notification" : "Mythic notification")} seconds={Math.max(soundMinimum(kind), Math.round((settings.notification_durations?.[kind] ?? settings.duration) / 1000))} />}
          min={soundMinimum(kind)} max={soundMaximum(kind)} disabled={measuringSound(kind)} step={1}
          value={Math.max(soundMinimum(kind), Math.round((settings.notification_durations?.[kind] ?? settings.duration) / 1000))}
          onChange={async seconds => {
            const duration = seconds * 1000;
            notificationDurations = { ...notificationDurations, [kind]: duration };
            setLocal(previous => previous ? { ...previous, notification_durations: { ...previous.notification_durations, [kind]: duration } } : previous);
            setDurationError(false);
            const saved = notificationDurationSaveQueue.then(() => setNotificationDuration(kind, duration));
            notificationDurationSaveQueue = saved.then(() => undefined, () => undefined);
            try { await saved; }
            catch { setDurationError(true); }
          }} />
      </PanelSectionRow>)}
      {durationError && <PanelSectionRow><div role="alert">{t("Could not save notification duration.")}</div></PanelSectionRow>}
      <PanelSectionRow>
        <DropdownItem label={t("Test notification type")} selectedOption={notificationKind}
          rgOptions={notificationOptions}
          onChange={async option => {
            const kind = option.data as NotificationKind;
            selectedNotificationKind = kind;
            setNotificationKind(kind); setNotificationError(false);
            const saved = notificationKindSaveQueue.then(() => saveTestNotificationType(kind));
            notificationKindSaveQueue = saved.then(() => undefined, () => undefined);
            try { await saved; }
            catch { setNotificationError(true); }
          }} />
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={soundBusy} description={soundPath?.split("/").pop() || t("Silent")}
          onClick={async () => {
            let file;
            try { file = await openFilePicker(FileSelectionType.FILE, settings.sound_picker_path || "/home/deck", true, true, undefined, ["wav", "mp3", "ogg", "flac"]); }
            catch { return; }
            await saveSound(file.realpath || file.path);
          }}>{t("Choose custom sound")}</ButtonItem>
      </PanelSectionRow>
      {soundPath && <PanelSectionRow>
        <ButtonItem layout="below" disabled={soundBusy} onClick={async () => {
          setSoundError(false);
          try { await notificationAudio.play(notificationKind); }
          catch { setSoundError(true); }
        }}>{t("Preview custom sound")}</ButtonItem>
        <ButtonItem layout="below" disabled={soundBusy} onClick={() => saveSound("")}>{t("Remove custom sound")}</ButtonItem>
      </PanelSectionRow>}
      {soundError && <PanelSectionRow><div role="alert">{t("Could not use this audio file. Choose a WAV, MP3, OGG, or FLAC file up to 5 MB.")}</div></PanelSectionRow>}
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={async () => {
          setNotificationError(false);
          try { await testNotification(getPluginLanguage(), notificationKind); }
          catch { setNotificationError(true); }
        }}>
          {t("Send test notification")}
        </ButtonItem>
        {notificationError && <div role="alert">{t("Could not send test notification.")}</div>}
      </PanelSectionRow>
      <PanelSectionRow>
        <div style={{ fontSize: 11, opacity: 0.7, wordBreak: "break-all" }}>
          {t("Watching: {path}", { path: settings.resolved_path || "" })}
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField label={t("Remember game filters and sorting")} description={t("Save filter and sort choices separately for each game.")}
          checked={settings.remember_game_view_settings ?? true}
          onChange={async enabled => {
            setRememberError(false);
            try {
              const saved = await setRememberGameViewSettings(enabled);
              applyRememberGameView(saved);
              setLocal(previous => previous ? { ...previous, remember_game_view_settings: saved } : previous);
            } catch { setRememberError(true); }
          }} />
        {rememberError && <div role="alert">{t("Could not save the game settings preference.")}</div>}
      </PanelSectionRow>
      <PanelSectionRow>
        <PluginLanguageSelector />
      </PanelSectionRow>
    </PanelSection>
  );
}

export default definePlugin(() => {
  const removeGameMenuButtons = installGameMenuButtons(openGameAchievements, <GamerscoreIcon />);
  const removeProfileGamerscore = installProfileGamerscore(<GamerscoreIcon />, openAllGamesAchievements);
  // Current Steam builds reselect their built-in sound at popup dispatch.
  const store = (window as unknown as { NotificationStore?: { PlayNotificationSound: (toast: unknown) => unknown } }).NotificationStore;
  const soundPatch = store?.PlayNotificationSound ? replacePatch(store, "PlayNotificationSound", args =>
    isNexusToast(args[0]) ? undefined : callOriginal) : undefined;
  void initializeSystemLanguage(() => window.SteamClient.Settings.GetCurrentLanguage());
  getSettings().then(s => { setGameMenuEnabled(s.game_menu_button ?? true); setProfileGamerscoreEnabled(s.profile_gamerscore ?? false); currentDuration = s.duration; notificationDurations = s.notification_durations || {}; notificationAudio.configure(s.notification_sounds, s.notification_sound_durations); setPluginLanguage(s.plugin_language || "system"); applyRememberGameView(s.remember_game_view_settings ?? true); }).catch(() => {});
  routerHook.addRoute(ROUTE, AchievementsPage, { exact: true });
  const listener = addEventListener<[AchievementEvent]>("achievement", showAchievement);
  const mythicListener = addEventListener<[MythicEvent]>("mythic", showMythic);
  let progressDisposed = false;
  const refreshMythicProgress = async () => {
    try {
      const progress = await getMythicProgress();
      if (progressDisposed) return;
      let changed = false;
      for (const [id, mythic] of Object.entries(progress)) {
        if (JSON.stringify(mythicByTitle.get(id)) === JSON.stringify(mythic)) continue;
        mythicByTitle.set(id, mythic);
        changed = true;
      }
      if (changed) { mythicProgressRevision++; mythicProgressListeners.forEach(listener => listener()); }
    } catch { /* Retry on the next poll if the backend is starting. */ }
  };
  void refreshMythicProgress();
  const mythicProgressTimer = setInterval(() => { void refreshMythicProgress(); }, 15000);

  return {
    name: "Nexus Achievements",
    titleView: <PluginTitle />,
    content: <Content />,
    icon: <FaTrophy />,
    onDismount() {
      progressDisposed = true;
      clearInterval(mythicProgressTimer);
      removeProfileGamerscore();
      removeGameMenuButtons();
      requestedGame = null;
      soundPatch?.unpatch();
      notificationAudio.dispose();
      achievementCache.clear();
      gamesCache.clear();
      gameViewCache.clear();
      mythicByTitle.clear();
      removeEventListener("achievement", listener);
      removeEventListener("mythic", mythicListener);
      routerHook.removeRoute(ROUTE);
    },
  };
});
