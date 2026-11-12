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
  GamepadButton,
  gamepadDialogClasses,
  gamepadSliderClasses,
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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { FaEye, FaEyeSlash, FaPlay, FaTrophy, FaSignInAlt, FaLink, FaUnlink, FaExternalLinkAlt, FaSpinner, FaStar, FaRegStar, FaThumbtack } from "react-icons/fa";
import { fitNotificationPopup } from "./notification-popup";
import { NotificationAudio, observePopupSound, shouldSuppressNexusSound, type PopupPlayback, type SoundFiles } from "./notification-audio";
import { installProfileGamerscore, setProfileGamerscoreEnabled, saveProfileGamerscore, useProfileGamerscore, refreshProfileGamerscore } from "./profile-gamerscore";
import { installGameMenuButtons, invalidateGameMenuCache, setGameMenuEnabled, saveGameMenuButton, type MenuTarget } from "./game-menu";
import { RareIcon, MythicIcon, TAIcon } from "./achievement-icons";
import { compareAchievements, type AchievementSort, type SortDirection } from "./achievement-sorting";
import { SessionCache } from "./cache";
import { taFlags, matchesTAFlag, flagsForGame } from "./ta-flags";
import { matchesAchievementSet, type AchievementSet } from "./achievement-filters";
import { getPluginLanguage, getPluginLanguagePreference, initializeSystemLanguage, setPluginLanguage, subscribeLanguage, translate, translateError, pluginLanguages, pluginLocales, type Message } from "./i18n";

import { useAchievementPreferences, toggleAchievementFavorite, toggleAchievementTracked, splitFavoriteAchievements, startAchievementTracking, refreshTrackerState } from "./achievement-tracking";
import { AchievementTrackerOverlay, TrackerControls, HideTrackerButton, trackingError as formatTrackingError } from "./achievement-tracker";

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

interface TAAchievement { url: string; flags: string[]; missable?: boolean; }
interface TAMetadata { url?: string; status: "ready" | "stale" | "unavailable"; achievements: Record<string, TAAchievement>; }
const getTrueAchievements = callable<[string], TAMetadata>("get_trueachievements");

interface TASessionStatus { status: "disconnected" | "connected" | "saved" | "expired"; error?: string; }
const getTASession = callable<[], TASessionStatus>("get_ta_session");
const connectTASession = callable<[], TASessionStatus>("connect_ta_session");
const disconnectTASession = callable<[], TASessionStatus>("disconnect_ta_session");
let taSessionRevision = 0;
const taSessionListeners = new Set<() => void>();
function notifyTASessionChanged() {
  taSessionRevision++;
  for (const listener of taSessionListeners) listener();
}
function useTASessionRevision() {
  return useSyncExternalStore(listener => {
    taSessionListeners.add(listener);
    return () => { taSessionListeners.delete(listener); };
  }, () => taSessionRevision);
}
function TAAccount({ gameTitleId }: { gameTitleId?: string } = {}) {
  const { t } = usePluginTranslation();
  const [session, setSession] = useState<TASessionStatus>({ status: "disconnected" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const revision = useTASessionRevision();
  const requestRevision = useRef(0);
  useEffect(() => {
    let live = true;
    const request = ++requestRevision.current;
    getTASession().then(value => {
      if (!live || request !== requestRevision.current) return;
      if (value.error) setError("Could not check TA session.");
      else setSession(value);
    }).catch(() => { if (live && request === requestRevision.current) setError("Could not check TA session."); });
    return () => { live = false; };
  }, [revision]);
  const changeSession = async (disconnect: boolean) => {
    ++requestRevision.current;
    setBusy(true); setError(null);
    try {
      const result = await (disconnect ? disconnectTASession() : connectTASession());
      setSession(result);
      if (result.error) setError(result.error === "browser_unavailable"
        ? "Keep TrueAchievements open in the Steam browser, then try connecting again."
        : result.error === "login_required" ? "Finish signing in on TrueAchievements, then connect again."
        : "Could not connect TA session.");
      else notifyTASessionChanged();
    } catch { setError("Could not connect TA session."); }
    finally { setBusy(false); }
  };
  const connected = session.status === "connected" || session.status === "saved";
  const description = t(busy ? "Connecting…" : connected ? "TA session saved on this device." : session.status === "expired" ? "TA session expired. Sign in again." : "Sign in in the Steam browser, then connect your session here.");
  if (gameTitleId) {
    const iconStyle = { width: 36, minWidth: 36, height: 36, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" };
    return <div className="nexus-ta-row">
      <Field label="TrueAchievements" description={description} childrenContainerWidth="min" verticalAlignment="center">
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <DialogButton style={iconStyle} disabled={busy} onOKActionDescription={t("Sign in to TrueAchievements")} aria-label={t("Sign in to TrueAchievements")}
            onClick={() => Navigation.NavigateToExternalWeb("https://www.trueachievements.com")}><FaSignInAlt /></DialogButton>
          <DialogButton style={iconStyle} disabled={busy} onOKActionDescription={t("Connect browser session")} aria-label={t("Connect browser session")}
            onClick={() => changeSession(false)}>{busy ? <FaSpinner /> : <FaLink />}</DialogButton>
          {connected && <DialogButton style={iconStyle} disabled={busy} onOKActionDescription={t("Disconnect TA session")} aria-label={t("Disconnect TA session")}
            onClick={() => changeSession(true)}><FaUnlink /></DialogButton>}
          <DialogButton style={iconStyle} onOKActionDescription={t("View on TrueAchievements")} aria-label={t("View on TrueAchievements")}
            onClick={() => Navigation.NavigateToExternalWeb(`https://www.trueachievements.com/deeplink/${encodeURIComponent(gameTitleId)}`)}><FaExternalLinkAlt /></DialogButton>
        </div>
      </Field>
      <div role={error ? "alert" : "status"} aria-live="polite" style={{ fontSize: 12, color: error ? "#ffcf70" : undefined }}>{error ? t(error) : busy ? t("Connecting…") : ""}</div>
    </div>;
  }
  return <div>
    <Field label="TrueAchievements" description={description} />
    <ButtonItem layout="below" disabled={busy} onClick={() => Navigation.NavigateToExternalWeb("https://www.trueachievements.com")}>
      {t("Sign in to TrueAchievements")}
    </ButtonItem>
    <ButtonItem layout="below" disabled={busy} onClick={() => changeSession(false)}>
      {t(busy ? "Connecting…" : "Connect browser session")}
    </ButtonItem>
    {(connected || session.status === "expired") && <ButtonItem layout="below" disabled={busy} onClick={() => changeSession(true)}>
      {t("Disconnect TA session")}
    </ButtonItem>}
    {error && <div role="alert">{t(error)}</div>}
  </div>;
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
    playSound: !notificationAudio.has(kind),
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
    logo: <NotificationIcon url={event.iconUrl} mythic playback={{ kind: "mythic", played: false }} />, duration: Math.max(notificationDurations.mythic ?? currentDuration, soundLength), playSound: !notificationAudio.has("mythic"), showToast: true,
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
    <div style={{ width: 80, height: 80, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}><MythicIcon size={80} locked={!group.unlocked} /></div>
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
interface GameViewSettings { taFilter?: string; filter: Filter; sort: Sort; sortDirection: SortDirection; contentFilter: AchievementSet; }
const DEFAULT_GAME_VIEW: GameViewSettings = { filter: "all", sort: "date", sortDirection: "desc", contentFilter: "all" };
const getGameViewSettings = callable<[string], GameViewSettings>("get_game_view_settings");
const setGameViewSettings = callable<[string, Filter, Sort, AchievementSet, SortDirection, string], GameViewSettings>("set_game_view_settings");
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
    ? setGameViewSettings(titleId, value.filter, value.sort, value.contentFilter, value.sortDirection, value.taFilter ?? "all") : value);
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

function AchievementRow({ a, ta, reveal, onToggle, onFlag, favorite = false, tracked = false, onFavorite = () => {}, onTrack = () => {} }: { a: Achievement; ta?: TAAchievement; reveal: boolean; onToggle: () => void; onFlag: (flag: string) => void; favorite?: boolean; tracked?: boolean; onFavorite?: () => void; onTrack?: () => void }) {
  const { locale, t } = usePluginTranslation();
  const rowRef = useRef<HTMLDivElement>(null);
  const hasRevealButton = a.secret && !a.unlocked;
  const hidden = a.secret && !a.unlocked && !reveal;
  const progress = a.unlocked ? 100 : a.progress !== null && Number.isFinite(a.progress) ? Math.max(0, Math.min(100, a.progress)) : null;
  const rarity = a.rarity;
  const rare = rarity?.category === "Rare";
  const rarityText = rarity && Number.isFinite(rarity.percentage) && rarity.percentage >= 0 && rarity.percentage <= 100
    ? t("{percentage} of players unlocked", { percentage: new Intl.NumberFormat(pluginLocales[locale], { style: "percent", maximumFractionDigits: 2 }).format(rarity.percentage / 100) })
    : "";
  const revealed = a.secret && !a.unlocked && reveal;
  const name = a.name || t("Unnamed achievement");
  const description = a.description || (revealed ? t("Details unavailable for this secret achievement.") : "");
  const content = <>
      <Icon url={hidden ? "" : a.iconUrl} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: "bold" }}>{hidden ? t("Secret achievement") : name}</div>
        <div style={{ fontSize: 13, opacity: 0.8 }}>{hidden ? t("Keep playing to reveal this achievement.") : description}</div>
        {(rarityText || (a.unlocked && a.unlockedAt)) && (
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "2px 6px", marginTop: 4, fontSize: 12, opacity: 0.8 }}>
            {rare && rarityText && <>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><RareIcon />{t("Rare")}</span>
              <span aria-hidden="true">·</span>
            </>}
            {rarityText && <span>{rarityText}</span>}
            {a.unlocked && a.unlockedAt && <>
              {rarityText && <span aria-hidden="true">·</span>}
              <span>{t("Unlocked {date}", { date: fmtDate(a.unlockedAt) })}</span>
            </>}
          </div>
        )}
        {!hidden && ta?.flags && ta.flags.length > 0 && <Focusable flow-children="row" className="nexus-ta-flags" style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
          {taFlags.filter(flag => ta.flags.includes(flag.id)).map(flag => <DialogButton key={flag.id} noFocusRing
            className={`nexus-row-action nexus-ta-action nexus-ta-flag nexus-ta-${flag.id}`} aria-label={t("Filter by {flag}", { flag: t(flag.label as Message) })}
            onOKActionDescription={t("Filter by {flag}", { flag: t(flag.label as Message) })}
            onClick={() => onFlag(flag.id)} onGamepadFocus={() => rowRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" })}
            style={{ width: "auto", minWidth: 0, height: "auto", fontSize: 11, border: "1px solid currentColor", borderRadius: 4, padding: "3px 5px", display: "flex", alignItems: "center", gap: 4 }}>
            <TAIcon size={14} />{t(flag.label as Message)}
          </DialogButton>)}
        </Focusable>}
        {a.baseGame === false && <div style={{ fontSize: 11, opacity: 0.7 }}>{t("Add-on")}</div>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
        <div style={{ fontWeight: "bold", whiteSpace: "nowrap" }}><GamerscoreIcon /> {hidden ? "?" : a.gamerscore}</div>
        <Focusable flow-children="row" className="nexus-achievement-actions" style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {!a.unlocked && <DialogButton className={`nexus-row-action nexus-favorite-button${favorite ? " nexus-favorite-active" : ""}`} noFocusRing disabled={!a.id || a.unlocked}
          aria-label={t(favorite ? "Remove from favorites" : "Add to favorites")} aria-pressed={favorite}
          onOKActionDescription={t(favorite ? "Remove from favorites" : "Add to favorites")}
          style={{ width: "auto", minWidth: 0, height: 32, padding: "0 12px" }} onClick={() => { if (!a.unlocked) onFavorite(); }}>
          {favorite ? <FaStar /> : <FaRegStar />}
        </DialogButton>}
        {!a.unlocked && <DialogButton className={`nexus-row-action nexus-track-button${tracked ? " nexus-track-active" : ""}`} noFocusRing disabled={!a.id}
          aria-label={t(tracked ? "Stop tracking achievement" : "Track achievement")} aria-pressed={tracked}
          onOKActionDescription={t(tracked ? "Stop tracking achievement" : "Track achievement")}
          style={{ width: "auto", minWidth: 0, height: 32, padding: "0 12px" }} onClick={onTrack}><FaThumbtack /></DialogButton>}
        {!hidden && ta && <DialogButton className="nexus-row-action nexus-ta-action nexus-ta-guide" noFocusRing style={{ width: "auto", minWidth: 0, height: 32, padding: "0 12px" }}
          aria-label={t("View on TrueAchievements")} onClick={() => Navigation.NavigateToExternalWeb(ta.url)}><TAIcon size={22} /></DialogButton>}
        {hasRevealButton && (
          <DialogButton
            className="nexus-row-action nexus-secret-reveal"
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
        </Focusable>
      </div>
      {!hidden && <div style={{ flexBasis: "100%", display: "flex", alignItems: "center", gap: 8 }}>
        <div role="progressbar" aria-label={name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined}
          aria-valuetext={progress === null ? t("Progress unavailable") : undefined}
          style={{ width: "65%", flexShrink: 0, height: 6, background: "rgba(255,255,255,.22)", borderRadius: 3, overflow: "hidden" }}>
          <div style={{ width: `${progress ?? 0}%`, height: "100%", background: "#8fdb8f", borderRadius: 3 }} />
        </div>
        <span style={{ fontSize: 12, opacity: 0.7 }}>{progress === null ? t("Progress unavailable") : new Intl.NumberFormat(pluginLocales[locale], { style: "percent", maximumFractionDigits: 0 }).format(progress / 100)}</span>
      </div>}
  </>;
  const style = { display: "flex", flexWrap: "wrap" as const, gap: 12, padding: "8px", borderRadius: 10, opacity: a.unlocked ? 1 : 0.65 };
  return <Focusable ref={rowRef} {...(a.unlocked && !ta ? { tabIndex: 0, onActivate: () => {} } : {})} noFocusRing
    flow-children="row" className="nexus-achievement-row" focusWithinClassName="nexus-achievement-row-focused"
    aria-label={hidden ? t("Secret achievement") : name}
    onOptionsActionDescription={!a.unlocked ? t(favorite ? "Remove from favorites" : "Add to favorites") : undefined}
    onOptionsButton={event => {
      if (a.unlocked) return;
      event.preventDefault(); event.stopPropagation();
      if (!event.detail.is_repeat) onFavorite();
    }}
    onSecondaryActionDescription={hasRevealButton ? t(reveal ? "Hide secret achievement" : "Show secret achievement") : undefined}
    actionDescriptionMap={ta ? { [GamepadButton.BUMPER_RIGHT]: t("View on TrueAchievements") } : undefined}
    onSecondaryButton={event => {
      if (!hasRevealButton) return;
      event.preventDefault(); event.stopPropagation();
      if (!event.detail.is_repeat) onToggle();
    }}
    onButtonDown={event => {
      if (event.detail.button !== GamepadButton.BUMPER_RIGHT || !ta) return;
      event.preventDefault(); event.stopPropagation();
      if (!event.detail.is_repeat) Navigation.NavigateToExternalWeb(ta.url);
    }}
    onGamepadFocus={() => rowRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" })}
    focusClassName="nexus-achievement-row-focused" style={style}>{content}</Focusable>;
}

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return <section className="nexus-settings-group" aria-label={title}>
    <h3>{title}</h3>
    <div className="nexus-settings-rows">{children}</div>
  </section>;
}

function SettingsGroupStyles() {
  const field = gamepadDialogClasses?.Field ?? "nexus-native-field";
  const control = gamepadDialogClasses?.FieldChildrenWithIcon;
  const slider = gamepadSliderClasses?.SliderControl;
  return <style>{`
    .nexus-settings-group { margin: 28px 0 0; }
    .nexus-settings-group > h3 { margin: 0 0 8px; font-size: 16px; font-weight: 500; color: #dcdedf; }
    .nexus-settings-rows { display: flex; flex-direction: column; gap: 6px; }
    .nexus-settings-rows > * { margin-block: 0; min-width: 0; }
    .nexus-settings-rows .${field} {
      box-sizing: border-box;
      width: 100%;
      margin: 0 !important;
      padding: 12px;
      border: 0 !important;
      border-radius: 2px;
      background-color: #23262e;
    }
    .nexus-settings-rows .${field}:is(.gpfocus, .gpfocuswithin, :focus-within) {
      background-color: #35383f;
    }
    .nexus-settings-rows .nexus-tracker-controls { gap: 6px !important; }
    ${control && slider ? `
      /* Steam's Quick Access minimum can exceed the padded settings row. */
      .nexus-settings-rows .${field}:has(.${slider}) .${control} {
        min-width: 0 !important;
        max-width: 100%;
        box-sizing: border-box;
      }
    ` : ""}
  `}</style>;
}

function TitleView({ title, tick }: { title: TitleSummary; tick: number }) {
  const preferences = useAchievementPreferences(title.titleId);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const toggleFavorite = (id: string) => {
    setSelectionError(null);
    void toggleAchievementFavorite(title.titleId, id).catch(error => setSelectionError(formatTrackingError(error)));
  };
  const toggleTracked = (id: string) => {
    setSelectionError(null);
    void toggleAchievementTracked(title.titleId, id).catch(error => setSelectionError(formatTrackingError(error)));
  };
  const { locale, t } = usePluginTranslation();
  const [ta, setTA] = useState<TAMetadata | null>(null);
  const taRevision = useTASessionRevision();
  useEffect(() => {
    let live = true;
    setTA(null);
    getTrueAchievements(title.titleId).then(value => { if (live) setTA(value); })
      .catch(() => { if (live) setTA({ status: "unavailable", achievements: {} }); });
    return () => { live = false; };
  }, [title.titleId, taRevision]);
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
  const { filter, sort, sortDirection, contentFilter, taFilter = "all" } = view;
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

  const availableFlags = useMemo(() => flagsForGame(detail?.achievements ?? [], ta?.achievements ?? {}), [detail, ta]);
  const selectedTAFilter = availableFlags.some(flag => `ta:${flag.id}` === taFilter) ? taFilter : "all";
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (detail?.achievements ?? []).filter(a => {
      if (!matchesAchievementSet(a, contentFilter)) return false;
      if (filter === "unlocked" && !a.unlocked) return false;
      if (filter === "locked" && a.unlocked) return false;
      if (!matchesTAFlag(ta?.achievements[a.id], selectedTAFilter)) return false;
      if (!q) return true;
      const hidden = a.secret && !a.unlocked && !isRevealed(a);
      return !hidden && (a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q));
    });
    return list.sort((x, y) => compareAchievements(x, y, sort, sortDirection));
  }, [detail, filter, sort, sortDirection, query, reveal, overrides, contentFilter, ta, selectedTAFilter]);
  const membershipPending = contentFilter !== "all" && detail?.ok && !detail.mythic && !detail.mythicUnavailable;

  const pinnedIds = new Set(preferences.tracked);
  const pinned = rows.filter(item => !item.unlocked && pinnedIds.has(item.id));
  const visiblePinnedIds = new Set(pinned.map(item => item.id));
  const separated = splitFavoriteAchievements(rows.filter(item => !visiblePinnedIds.has(item.id)), preferences.favorites);
  const groups: { label: Message | null; items: Achievement[] }[] = [
    ...(pinned.length ? [{ label: "Pinned achievements" as Message, items: pinned }] : []),
    ...(separated.favorites.length ? [{ label: "Favorites" as Message, items: separated.favorites }] : []),
    ...(grouped ? [{ label: "Unlocked" as Message, items: separated.others.filter(a => a.unlocked) },
      { label: "Locked" as Message, items: separated.others.filter(a => !a.unlocked) }]
      : [{ label: pinned.length || separated.favorites.length ? "Other achievements" as Message : null, items: separated.others }]),
  ];

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
          .nexus-achievement-row:has(:is(.nexus-secret-reveal, .nexus-ta-action):is(.gpfocus, :focus, :active))) {
          background: #fff;
          color: #0e141b;
          opacity: 1 !important;
          border-radius: 10px;
        }
        :is(.nexus-achievement-row-focused, .nexus-achievement-row:focus-within,
          .nexus-achievement-row:has(:is(.nexus-secret-reveal, .nexus-ta-action):is(.gpfocus, :focus, :active))) .nexus-gamerscore-icon circle {
          fill: #0e141b !important;
        }
        :is(.nexus-achievement-row-focused, .nexus-achievement-row:focus-within,
          .nexus-achievement-row:has(:is(.nexus-secret-reveal, .nexus-ta-action):is(.gpfocus, :focus, :active))) .nexus-gamerscore-icon path {
          stroke: #fff !important;
        }
        .nexus-row-action {
          background: #3d4450 !important;
          color: #fff !important;
          border-radius: 4px;
          transition: none !important;
        }
        .nexus-ta-missable { color: #ff6b6b !important; }
        .nexus-favorite-active { color: #ffd36b !important; }
        .nexus-track-active { color: #8fdb8f !important; }
        :where(.nexus-achievement-row-focused, .nexus-achievement-row:focus-within,
          .nexus-achievement-row:has(.nexus-row-action:is(.gpfocus, :focus, :active))) .nexus-row-action {
          background: #e5e8eb !important;
          color: #0e141b !important;
        }
        :where(.nexus-achievement-row-focused, .nexus-achievement-row:focus-within) .nexus-ta-missable {
          color: #b42318 !important;
        }
        :where(.nexus-achievement-row-focused, .nexus-achievement-row:focus-within) .nexus-favorite-active { color: #875f00 !important; }
        :where(.nexus-achievement-row-focused, .nexus-achievement-row:focus-within) .nexus-track-active { color: #1f6829 !important; }
        .nexus-achievement-row .nexus-row-action:is(.gpfocus, :focus, :hover, :active) {
          background: #0e141b !important;
          color: #fff !important;
        }
        .nexus-row-action svg { fill: currentColor; color: inherit; }
      `}</style>

      <div style={{ display: "flex", alignItems: "center", gap: 16, margin: "8px 0" }}><GameCover url={title.coverUrl} mythic={detail?.mythic?.unlocked} /><h2>{title.titleName}</h2></div>
      <div style={{ opacity: 0.8, marginBottom: 8 }}>
        {t("{unlocked}/{total} unlocked", { unlocked: title.unlocked, total: title.total })} • <GamerscoreIcon /> {title.gamerscore}/{title.gamerscoreTotal}
      </div>
      <SettingsGroupStyles />
      <SettingsGroup title={t("TrueAchievements")}>
        <TAAccount gameTitleId={title.titleId} />
        {ta?.status === "unavailable" && <div role="status" style={{ fontSize: 12, opacity: 0.7 }}>{t("TA flags unavailable. You can still open TrueAchievements.")}</div>}
        {ta?.status === "stale" && <div role="status" style={{ fontSize: 12, opacity: 0.7 }}>{t("Showing cached TA flags.")}</div>}
      </SettingsGroup>
      <SettingsGroup title={t("Filters and sorting")}>
        <TextField label={t("Search")} value={query} onChange={e => setQuery(e.target.value)} />
        <Field bottomSeparator="none" label={t("Filter")} childrenContainerWidth="min" verticalAlignment="center">
          <Dropdown rgOptions={FILTERS.map(option => ({ ...option, label: t(option.label as Message) }))} selectedOption={filter}
            onChange={option => updateView({ filter: option.data as Filter })} />
        </Field>
        {availableFlags.length > 0 && <Field bottomSeparator="none" label={t("TrueAchievements filter")} childrenContainerWidth="min" verticalAlignment="center">
          <Dropdown rgOptions={[{ data: "all", label: t("All") }, ...availableFlags.map(flag => ({ data: `ta:${flag.id}`, label: t(flag.label as Message) }))]}
            selectedOption={selectedTAFilter} onChange={option => updateView({ taFilter: option.data })} />
        </Field>}
        <Field bottomSeparator="none" label={t("Achievement set")} childrenContainerWidth="min" verticalAlignment="center">
          <Dropdown rgOptions={ACHIEVEMENT_SETS.map(option => ({ ...option, label: t(option.label as Message) }))}
            selectedOption={contentFilter} onChange={option => updateView({ contentFilter: option.data as AchievementSet })} />
        </Field>
        <Field bottomSeparator="none" label={t("Sort by")} childrenContainerWidth="min" verticalAlignment="center">
          <Focusable flow-children="row" className="nexus-sort-controls" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {(["asc", "desc"] as const).map(direction => <DialogButton key={direction}
            aria-label={t(direction === "asc" ? "Ascending" : "Descending")}
            aria-pressed={sortDirection === direction}
            style={{ width: 44, minWidth: 44, padding: 0, height: 40,
              background: sortDirection === direction ? "#fff" : undefined,
              color: sortDirection === direction ? "#0e141b" : undefined }}
            onClick={() => updateView({ sortDirection: direction })}>{direction === "asc" ? "↑" : "↓"}</DialogButton>)}
            <Dropdown rgOptions={SORTS.map(option => ({ ...option, label: t(option.label as Message) }))}
              selectedOption={sort} onChange={option => updateView({ sort: option.data as Sort })} />
          </Focusable>
        </Field>
        {viewError && <div role="alert">{t(viewError)}</div>}
      </SettingsGroup>
      <SettingsGroup title={t("Achievement display")}>
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
      </SettingsGroup>
      <SettingsGroup title={t("Achievement tracker")}>
        <TrackerControls compact />
      </SettingsGroup>
      {selectionError && <div role="alert">{selectionError}</div>}
      {preferences.error && <div role="alert">{t("Could not load favorite and tracked achievements.")}</div>}
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
            {group.items.map(a => <AchievementRow key={a.id || a.name} a={a} ta={ta?.achievements[a.id]} reveal={isRevealed(a)}
              favorite={preferences.favorites.includes(a.id)} tracked={preferences.tracked.includes(a.id)}
              onFavorite={() => toggleFavorite(a.id)} onTrack={() => toggleTracked(a.id)}
              onFlag={flag => updateView({ taFilter: `ta:${flag}` })}
              onToggle={() => setOverrides(o => ({ ...o, [a.id]: !isRevealed(a) }))} />)}
          </div>
        </div>)}
      </div>
    </div>
  );
}

function useRunningTitle() {
  const [title, setTitle] = useState<TitleSummary | null>(null);
  useEffect(() => {
    let live = true;
    const refresh = () => getRunningTitle().then(value => { if (live) setTitle(value); })
      .catch(() => { if (live) setTitle(null); });
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  return title;
}

function RunningGame({ onSelect }: { onSelect: (titleId: string) => void }) {
  const title = useRunningTitle();
  return title && <TitleRow title={title} onSelect={onSelect} playing flushCover />;
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
  const runningTitle = useRunningTitle();
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

  const title = titles?.find(t => t.titleId === selected)
    ?? (runningTitle?.titleId === selected ? runningTitle : undefined)
    ?? (requestedGame?.titleId === selected ? requestedGame : undefined);
  const matchingTitles = useMemo(() => {
    const query = gameQuery.trim().toLocaleLowerCase();
    return titles?.filter(item => item.titleId !== runningTitle?.titleId
      && (!installedOnly || item.installed === true)
      && item.titleName.toLocaleLowerCase().includes(query)) ?? [];
  }, [titles, gameQuery, installedOnly, runningTitle?.titleId]);

  return (
    <Focusable ref={pageRef} tabIndex={0} noFocusRing flow-children="column" navEntryPreferPosition={NavEntryPositionPreferences.FIRST} preferredFocus
      onCancelActionDescription={t(title && !hideAllTitles ? "All titles" : "Back")}
      onCancelButton={event => {
        event.preventDefault();
        event.stopPropagation();
        if (title && !hideAllTitles) setSelected(null);
        else Navigation.NavigateBack();
      }}
      onGamepadFocus={event => {
        // Forward entry from Steam's header to a control, without redirecting descendant focus.
        if (event.target !== pageRef.current) return;
        pageRef.current?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]')?.focus({ preventScroll: true });
      }}
      style={{ padding: "40px 24px 60px", marginTop: 40, height: "100%", overflowY: "auto", scrollPaddingBottom: 60, boxSizing: "border-box" }}>
      {title ? (
        <TitleView key={title.titleId} title={title} tick={tick} />
      ) : (
        <div>
          <h1 style={{ margin: "0 0 12px" }}>{t("Nexus Achievements")}</h1>
          {runningTitle && <div style={{ marginBottom: 8 }}>
            <TitleRow title={runningTitle} onSelect={selectTitle} playing showPlayingText flushCover />
          </div>}
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
          {titles && titles.length === 0 && !runningTitle && !error && (
            <div style={{ opacity: 0.7 }}>{t("No achievements yet. Play a Nexus game to start unlocking.")}</div>
          )}
          {titles?.some(item => item.titleId !== runningTitle?.titleId) && matchingTitles.length === 0 && !error && (
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
      <SettingsGroupStyles />
      <PanelSectionRow><HideTrackerButton /></PanelSectionRow>
      <SettingsGroup title={t("Achievements")}>
        <PanelSectionRow>
          <RunningGame onSelect={titleId => { requestedHideAllTitles = false; requestedTitle = titleId; Navigation.CloseSideMenus(); Navigation.Navigate(ROUTE); }} />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => { Navigation.CloseSideMenus(); Navigation.Navigate(ROUTE); }}>
            {t("View all achievements")}
          </ButtonItem>
        </PanelSectionRow>
      </SettingsGroup>
      <SettingsGroup title={t("TrueAchievements")}>
        <PanelSectionRow><TAAccount /></PanelSectionRow>
      </SettingsGroup>
      <SettingsGroup title={t("Achievement tracker")}>
        <PanelSectionRow><TrackerControls /></PanelSectionRow>
      </SettingsGroup>
      <SettingsGroup title={t("Steam integration")}>
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
      </SettingsGroup>
      <SettingsGroup title={t("Achievement display")}>
        <PanelSectionRow>
          <AchievementLanguageSelector />
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
      </SettingsGroup>
      <SettingsGroup title={t("Notifications")}>
        <PanelSectionRow>
          <ToggleField label={t("Enable notifications")} checked={settings.enabled}
            onChange={enabled => update({ enabled })} />
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
      </SettingsGroup>
      <SettingsGroup title={t("Notification sounds and testing")}>
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
      </SettingsGroup>
      <PanelSectionRow>
        <div style={{ fontSize: 11, opacity: 0.7, wordBreak: "break-all" }}>
          {t("Watching: {path}", { path: settings.resolved_path || "" })}
        </div>
      </PanelSectionRow>
    </PanelSection>
  );
}

export default definePlugin(() => {
  const stopTracking = startAchievementTracking();
  routerHook.addGlobalComponent("NexusAchievementTracker", () => <AchievementTrackerOverlay />);
  const removeGameMenuButtons = installGameMenuButtons(openGameAchievements, <GamerscoreIcon />);
  const removeProfileGamerscore = installProfileGamerscore(<GamerscoreIcon />, openAllGamesAchievements);
  // Current Steam builds reselect their built-in sound at popup dispatch.
  const store = (window as unknown as { NotificationStore?: { PlayNotificationSound: (toast: unknown) => unknown } }).NotificationStore;
  const soundPatch = store?.PlayNotificationSound ? replacePatch(store, "PlayNotificationSound", args =>
    shouldSuppressNexusSound(args[0]) ? undefined : callOriginal) : undefined;
  void initializeSystemLanguage(() => window.SteamClient.Settings.GetCurrentLanguage());
  getSettings().then(s => { setGameMenuEnabled(s.game_menu_button ?? true); setProfileGamerscoreEnabled(s.profile_gamerscore ?? false); currentDuration = s.duration; notificationDurations = s.notification_durations || {}; notificationAudio.configure(s.notification_sounds, s.notification_sound_durations); setPluginLanguage(s.plugin_language || "system"); applyRememberGameView(s.remember_game_view_settings ?? true); }).catch(() => {});
  routerHook.addRoute(ROUTE, AchievementsPage, { exact: true });
  const listener = addEventListener<[AchievementEvent]>("achievement", event => { void refreshTrackerState(true); void showAchievement(event); });
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
      routerHook.removeGlobalComponent("NexusAchievementTracker");
      stopTracking();
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
