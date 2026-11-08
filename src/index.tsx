import {
  ButtonItem,
  DialogButton,
  DropdownItem,
  Focusable,
  Navigation,
  PanelSection,
  PanelSectionRow,
  SliderField,
  TextField,
  ToggleField,
  staticClasses,
} from "@decky/ui";
import { addEventListener, callable, definePlugin, removeEventListener, routerHook, toaster } from "@decky/api";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { FaEye, FaEyeSlash, FaPlay, FaTrophy } from "react-icons/fa";
import { SessionCache } from "./cache";
import { getPluginLanguage, getPluginLanguagePreference, initializeSystemLanguage, setPluginLanguage, subscribeLanguage, translate, translateError, pluginLanguages, pluginLocales, type Message } from "./i18n";

interface AchievementEvent {
  type: "achievement";
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
  duration: number;
  events_path: string;
  show_secrets?: boolean;
  achievement_language?: string;
  plugin_language?: string;
  resolved_path?: string;
}

const getSettings = callable<[], Settings>("get_settings");
const setSettings = callable<[boolean, number, string], Settings>("set_settings");
const testNotification = callable<[string], void>("test_notification");

interface TitleSummary {
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
}

interface TitleDetail {
  ok: boolean;
  error?: string;
  languageError?: string;
  titleId?: string;
  titleName?: string;
  achievements: Achievement[];
}

const listTitles = callable<[], { ok: boolean; error?: string; titles: TitleSummary[] }>("list_titles");
const getTitleAchievements = callable<[string], TitleDetail>("get_title_achievements");
const achievementCache = new SessionCache<TitleDetail>();
const gamesCache = new SessionCache<TitleSummary[]>();
const achievementCacheKey = (title: TitleSummary) => `${title.titleId}:${title.updatedAt}`;

const setShowSecrets = callable<[boolean], boolean>("set_show_secrets");
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
const getRunningTitle = callable<[], TitleSummary | null>("get_running_title");

// The toast runs in the Steam UI, so keep the duration locally.
let currentDuration = 8000;

function showAchievement(event: AchievementEvent) {
  achievementCache.clear();
  gamesCache.invalidate("titles");
  const score = typeof event.gamerscore === "number" ? `${event.gamerscore} G` : "";
  const body = [event.description, score].filter(Boolean).join(" • ");
  const logo = event.iconUrl && /^https?:\/\//.test(event.iconUrl)
    ? <img src={event.iconUrl} style={{ width: 48, height: 48, borderRadius: 4 }} />
    : <FaTrophy />;
  toaster.toast({
    title: translate(getPluginLanguage(), "Achievement unlocked: {name}", { name: event.name }),
    body,
    logo,
    duration: currentDuration,
    playSound: true,
    sound: 6,
    showToast: true,
  });
}

type Filter = "all" | "unlocked" | "locked";
type Sort = "name" | "gamerscore" | "date";

const FILTERS = [
  { data: "all", label: "All" },
  { data: "unlocked", label: "Unlocked" },
  { data: "locked", label: "Locked" },
];
const SORTS = [
  { data: "name", label: "Name" },
  { data: "gamerscore", label: "Gamerscore" },
  { data: "date", label: "Unlock date" },
];

const safeIcon = (url: string) => (/^https?:\/\//.test(url) ? url : "");
const fmtDate = (ms: number | null) => (ms ? new Date(ms).toLocaleString(pluginLocales[getPluginLanguage()]) : "");

function Icon({ url }: { url: string }) {
  const src = safeIcon(url);
  return src
    ? <img src={src} style={{ width: 56, height: 56, borderRadius: 4, objectFit: "cover", flexShrink: 0 }} />
    : <div style={{ width: 56, height: 56, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><FaTrophy size={28} /></div>;
}

function GameCover({ url }: { url?: string }) {
  const src = safeIcon(url || "");
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return <div style={{ width: 60, height: 80, flexShrink: 0, borderRadius: 4, overflow: "hidden", transform: "translateZ(0)", isolation: "isolate", background: "rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "center" }}>
    {src && !failed ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} style={{ width: "100%", height: "100%", objectFit: "cover", imageRendering: "auto", display: "block" }} /> : <FaTrophy size={24} />}
  </div>;
}

function GamerscoreIcon() {
  const { t } = usePluginTranslation();
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" role="img" aria-label={t("Gamerscore")}
      style={{ display: "inline-block", verticalAlign: "-0.15em", flexShrink: 0 }}>
      <circle cx="12" cy="12" r="11" style={{ fill: "#fff" }} />
      <path d="M16 8.5a5 5 0 1 0 .5 6.5V12H12" style={{ fill: "none", stroke: "#182726", strokeWidth: 2.2 }} />
    </svg>
  );
}

function AchievementRow({ a, reveal, onToggle }: { a: Achievement; reveal: boolean; onToggle: () => void }) {
  const { t } = usePluginTranslation();
  const hidden = a.secret && !a.unlocked && !reveal;
  const revealed = a.secret && !a.unlocked && reveal;
  const name = a.name || t("Unnamed achievement");
  const description = a.description || (revealed ? t("Details unavailable for this secret achievement.") : "");
  return (
    <Focusable style={{ display: "flex", gap: 12, padding: "8px 0", opacity: a.unlocked ? 1 : 0.65 }}>
      <Icon url={hidden ? "" : a.iconUrl} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: "bold" }}>{hidden ? t("Secret achievement") : name}</div>
        <div style={{ fontSize: 13, opacity: 0.8 }}>{hidden ? t("Keep playing to reveal this achievement.") : description}</div>
        {!a.unlocked && a.progress !== null && !hidden && (
          <div style={{ marginTop: 4, height: 6, background: "rgba(255,255,255,0.15)", borderRadius: 3 }}>
            <div style={{ width: `${a.progress}%`, height: "100%", background: "#1a9fff", borderRadius: 3 }} />
          </div>
        )}
        {a.unlocked && a.unlockedAt && <div style={{ fontSize: 12, opacity: 0.7 }}>{t("Unlocked {date}", { date: fmtDate(a.unlockedAt) })}</div>}
        {!a.unlocked && a.progress !== null && !hidden && <div style={{ fontSize: 12, opacity: 0.7 }}>{a.progress}%</div>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
        <div style={{ fontWeight: "bold", whiteSpace: "nowrap" }}>{hidden ? "?" : a.gamerscore} <GamerscoreIcon /></div>
        {a.secret && !a.unlocked && (
          <DialogButton
            aria-label={reveal ? t("Hide secret achievement") : t("Show secret achievement")}
            style={{ width: "auto", minWidth: 0, height: 32, padding: "0 12px", display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={onToggle}>
            {reveal ? <FaEyeSlash /> : <FaEye />}
          </DialogButton>
        )}
      </div>
    </Focusable>
  );
}

function TitleView({ title, onBack, tick }: { title: TitleSummary; onBack: () => void; tick: number }) {
  const { locale, t } = usePluginTranslation();
  const [languageRevision, setLanguageRevision] = useState(0);
  const [reveal, setReveal] = useState(false);
  useEffect(() => {
    getSettings().then(s => setReveal(!!s.show_secrets)).catch(() => {});
  }, []);
  // Per-row overrides are session-only; the global toggle clears them.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const toggleReveal = (v: boolean) => { setReveal(v); setOverrides({}); setShowSecrets(v).catch(() => {}); };
  const isRevealed = (a: Achievement) => overrides[a.id] ?? reveal;
  const [detail, setDetail] = useState<TitleDetail | null>(() => achievementCache.peek(achievementCacheKey(title)) ?? null);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("name");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    const key = achievementCacheKey(title);
    achievementCache.load(key, async () => {
      const result = await getTitleAchievements(title.titleId);
      if (!result.ok) throw new Error(result.error || "Failed to load");
      return result;
    }, 60_000, result => !result.languageError)
      .then(d => { if (live) setDetail(d); })
      .catch(() => { if (live) setDetail(previous => previous?.ok ? previous : { ok: false, error: "Failed to load", achievements: [] }); });
    return () => { live = false; };
  }, [title.titleId, title.updatedAt, tick, languageRevision]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (detail?.achievements ?? []).filter(a => {
      if (filter === "unlocked" && !a.unlocked) return false;
      if (filter === "locked" && a.unlocked) return false;
      if (!q) return true;
      const hidden = a.secret && !a.unlocked && !isRevealed(a);
      return !hidden && (a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q));
    });
    return list.sort((x, y) => {
      if (sort === "gamerscore") return y.gamerscore - x.gamerscore || x.name.localeCompare(y.name);
      if (sort === "date") return (y.unlockedAt ?? 0) - (x.unlockedAt ?? 0) || x.name.localeCompare(y.name);
      return x.name.localeCompare(y.name);
    });
  }, [detail, filter, sort, query, reveal, overrides]);

  return (
    <div>
      <ButtonItem layout="below" onClick={onBack}>{t("← All titles")}</ButtonItem>
      <div style={{ display: "flex", alignItems: "center", gap: 16, margin: "8px 0" }}><GameCover url={title.coverUrl} /><h2>{title.titleName}</h2></div>
      <div style={{ opacity: 0.8, marginBottom: 8 }}>
        {t("{unlocked}/{total} unlocked", { unlocked: title.unlocked, total: title.total })} • {title.gamerscore}/{title.gamerscoreTotal} <GamerscoreIcon />
      </div>
      <DropdownItem label={t("Filter")} rgOptions={FILTERS.map(option => ({ ...option, label: t(option.label as Message) }))} selectedOption={filter}
        onChange={o => setFilter(o.data as Filter)} />
      <DropdownItem label={t("Sort by")} rgOptions={SORTS.map(option => ({ ...option, label: t(option.label as Message) }))} selectedOption={sort}
        onChange={o => setSort(o.data as Sort)} />
      <AchievementLanguageSelector onChange={() => setLanguageRevision(value => value + 1)} />
      <ToggleField label={t("Show secret achievements")} description={t("Reveal names and descriptions of locked secret achievements.")}
        checked={reveal} onChange={toggleReveal} />
      <TextField label={t("Search")} value={query} onChange={e => setQuery(e.target.value)} />
      {!detail && <div style={{ padding: 16 }}>{t("Loading…")}</div>}
      {detail && !detail.ok && <div style={{ padding: 16 }}>{t("Could not load achievements ({error}).", { error: translateError(locale, detail.error) })}</div>}
      {detail?.languageError && <div role="alert" style={{ padding: 16 }}>{t("Showing original achievement text. {error}", { error: translateError(locale, detail.languageError) })}</div>}
      {detail?.ok && rows.length === 0 && <div style={{ padding: 16, opacity: 0.7 }}>{t("No achievements match.")}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map(a => <AchievementRow key={a.id || a.name} a={a} reveal={isRevealed(a)}
          onToggle={() => setOverrides(o => ({ ...o, [a.id]: !isRevealed(a) }))} />)}
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
  const content = (
    <div style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left" }}>
      <GameCover url={title.coverUrl} />
      <div style={{ flex: 1, minWidth: 0, whiteSpace: "normal", paddingRight: flushCover ? 12 : 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ flex: 1, minWidth: 0 }}>{title.titleName}</span>
          {playing && <span aria-label={t("Now playing")} style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0, color: "#8fdb8f", fontSize: 12, whiteSpace: "nowrap" }}>
            <FaPlay aria-hidden="true" />{showPlayingText && t("Now playing")}
          </span>}
        </div>
        <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>{t("{unlocked}/{total} unlocked", { unlocked: title.unlocked, total: title.total })} • {title.gamerscore}/{title.gamerscoreTotal} <GamerscoreIcon /></div>
      </div>
    </div>
  );
  return flushCover
    ? <DialogButton style={{ width: "100%", height: "auto", minHeight: 80, padding: 4, overflow: "hidden" }} onClick={() => onSelect(title.titleId)}>{content}</DialogButton>
    : <ButtonItem layout="below" onClick={() => onSelect(title.titleId)}>{content}</ButtonItem>;
}

function AchievementsPage() {
  const { locale, t } = usePluginTranslation();
  const [titles, setTitles] = useState<TitleSummary[] | null>(() => gamesCache.peek("titles") ?? null);
  const [gameQuery, setGameQuery] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(() => { const title = requestedTitle; requestedTitle = null; return title; });
  const [tick, setTick] = useState(0);

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

  const title = titles?.find(t => t.titleId === selected);
  const matchingTitles = useMemo(() => {
    const query = gameQuery.trim().toLocaleLowerCase();
    return titles?.filter(item => item.titleName.toLocaleLowerCase().includes(query)) ?? [];
  }, [titles, gameQuery]);

  return (
    <div style={{ padding: "40px 24px 60px", marginTop: 40, height: "100%", overflowY: "auto", scrollPaddingBottom: 60, boxSizing: "border-box" }}>
      {title ? (
        <TitleView key={title.titleId} title={title} tick={tick} onBack={() => setSelected(null)} />
      ) : (
        <div>
          <h1 style={{ margin: "0 0 12px" }}>{t("Nexus Achievements")}</h1>
          <div style={{ marginBottom: 8 }}><RunningGame onSelect={setSelected} showPlayingText flushCover /></div>
          <TextField label={t("Search games")} value={gameQuery} onChange={event => setGameQuery(event.target.value)} />
          {titles === null && <div>{t("Loading…")}</div>}
          {error && <div style={{ padding: 8 }}>{translateError(locale, error)}</div>}
          {titles && titles.length === 0 && !error && (
            <div style={{ opacity: 0.7 }}>{t("No achievements yet. Play a Nexus game to start unlocking.")}</div>
          )}
          {titles && titles.length > 0 && matchingTitles.length === 0 && !error && (
            <div style={{ padding: "12px 0", opacity: 0.7 }}>{t("No games match your search.")}</div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {matchingTitles.map(t => <TitleRow key={t.titleId} title={t} onSelect={setSelected} flushCover />)}
          </div>
          <ButtonItem layout="below" onClick={reload}>{t("Refresh")}</ButtonItem>
        </div>
      )}
    </div>
  );
}

function Content() {
  const { t } = usePluginTranslation();
  const [settings, setLocal] = useState<Settings | null>(null);

  useEffect(() => {
    getSettings().then(s => { currentDuration = s.duration; setPluginLanguage(s.plugin_language || "system"); setLocal(s); });
  }, []);

  if (!settings) return null;

  const update = async (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setLocal(next);
    currentDuration = next.duration;
    setLocal(await setSettings(next.enabled, next.duration, next.events_path));
  };

  return (
    <PanelSection title={t("Nexus Achievements")}>
      <PanelSectionRow>
        <RunningGame flushCover onSelect={titleId => { requestedTitle = titleId; Navigation.CloseSideMenus(); Navigation.Navigate(ROUTE); }} />
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
        <AchievementLanguageSelector />
      </PanelSectionRow>
      <PanelSectionRow>
        <SliderField label={t("Duration (seconds)")} min={2} max={30} step={1}
          value={Math.round(settings.duration / 1000)} showValue
          onChange={seconds => update({ duration: seconds * 1000 })} />
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => testNotification(getPluginLanguage())}>
          {t("Send test notification")}
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <div style={{ fontSize: 11, opacity: 0.7, wordBreak: "break-all" }}>
          {t("Watching: {path}", { path: settings.resolved_path || "" })}
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <PluginLanguageSelector />
      </PanelSectionRow>
    </PanelSection>
  );
}

export default definePlugin(() => {
  void initializeSystemLanguage(() => window.SteamClient.Settings.GetCurrentLanguage());
  getSettings().then(s => { currentDuration = s.duration; setPluginLanguage(s.plugin_language || "system"); }).catch(() => {});
  routerHook.addRoute(ROUTE, AchievementsPage, { exact: true });
  const listener = addEventListener<[AchievementEvent]>("achievement", showAchievement);

  return {
    name: "Nexus Achievements",
    titleView: <PluginTitle />,
    content: <Content />,
    icon: <FaTrophy />,
    onDismount() {
      achievementCache.clear();
      gamesCache.clear();
      removeEventListener("achievement", listener);
      routerHook.removeRoute(ROUTE);
    },
  };
});
