import {
  ButtonItem,
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
import { useCallback, useEffect, useMemo, useState } from "react";
import { FaTrophy } from "react-icons/fa";

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
  resolved_path?: string;
}

const getSettings = callable<[], Settings>("get_settings");
const setSettings = callable<[boolean, number, string], Settings>("set_settings");
const testNotification = callable<[], void>("test_notification");

interface TitleSummary {
  titleId: string;
  titleName: string;
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
  titleId?: string;
  titleName?: string;
  achievements: Achievement[];
}

const listTitles = callable<[], { ok: boolean; error?: string; titles: TitleSummary[] }>("list_titles");
const getTitleAchievements = callable<[string], TitleDetail>("get_title_achievements");

const ROUTE = "/nexus-achievements";

// The toast runs in the Steam UI, so keep the duration locally.
let currentDuration = 8000;

function showAchievement(event: AchievementEvent) {
  const score = typeof event.gamerscore === "number" ? `${event.gamerscore} G` : "";
  const body = [event.description, score].filter(Boolean).join(" • ");
  const logo = event.iconUrl && /^https?:\/\//.test(event.iconUrl)
    ? <img src={event.iconUrl} style={{ width: 48, height: 48, borderRadius: 4 }} />
    : <FaTrophy />;
  toaster.toast({
    title: `Achievement unlocked: ${event.name}`,
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
const fmtDate = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : "");

function Icon({ url }: { url: string }) {
  const src = safeIcon(url);
  return src
    ? <img src={src} style={{ width: 56, height: 56, borderRadius: 4, objectFit: "cover", flexShrink: 0 }} />
    : <div style={{ width: 56, height: 56, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><FaTrophy size={28} /></div>;
}

function AchievementRow({ a }: { a: Achievement }) {
  const hidden = a.secret && !a.unlocked;
  return (
    <Focusable style={{ display: "flex", gap: 12, padding: "8px 0", opacity: a.unlocked ? 1 : 0.65 }}>
      <Icon url={hidden ? "" : a.iconUrl} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: "bold" }}>{hidden ? "Secret achievement" : a.name}</div>
        <div style={{ fontSize: 13, opacity: 0.8 }}>{hidden ? "Keep playing to reveal this achievement." : a.description}</div>
        {!a.unlocked && a.progress !== null && !hidden && (
          <div style={{ marginTop: 4, height: 6, background: "rgba(255,255,255,0.15)", borderRadius: 3 }}>
            <div style={{ width: `${a.progress}%`, height: "100%", background: "#1a9fff", borderRadius: 3 }} />
          </div>
        )}
        {a.unlocked && a.unlockedAt && <div style={{ fontSize: 12, opacity: 0.7 }}>Unlocked {fmtDate(a.unlockedAt)}</div>}
        {!a.unlocked && a.progress !== null && !hidden && <div style={{ fontSize: 12, opacity: 0.7 }}>{a.progress}%</div>}
      </div>
      <div style={{ fontWeight: "bold", whiteSpace: "nowrap" }}>{hidden ? "? G" : `${a.gamerscore} G`}</div>
    </Focusable>
  );
}

function TitleView({ title, onBack, tick }: { title: TitleSummary; onBack: () => void; tick: number }) {
  const [detail, setDetail] = useState<TitleDetail | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("name");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    getTitleAchievements(title.titleId)
      .then(d => { if (live) setDetail(d); })
      .catch(() => { if (live) setDetail({ ok: false, error: "Failed to load", achievements: [] }); });
    return () => { live = false; };
  }, [title.titleId, tick]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (detail?.achievements ?? []).filter(a => {
      if (filter === "unlocked" && !a.unlocked) return false;
      if (filter === "locked" && a.unlocked) return false;
      if (!q) return true;
      const hidden = a.secret && !a.unlocked;
      return !hidden && (a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q));
    });
    return list.sort((x, y) => {
      if (sort === "gamerscore") return y.gamerscore - x.gamerscore || x.name.localeCompare(y.name);
      if (sort === "date") return (y.unlockedAt ?? 0) - (x.unlockedAt ?? 0) || x.name.localeCompare(y.name);
      return x.name.localeCompare(y.name);
    });
  }, [detail, filter, sort, query]);

  return (
    <div>
      <ButtonItem layout="below" onClick={onBack}>← All titles</ButtonItem>
      <h2 style={{ margin: "8px 0" }}>{title.titleName}</h2>
      <div style={{ opacity: 0.8, marginBottom: 8 }}>
        {title.unlocked}/{title.total} unlocked • {title.gamerscore}/{title.gamerscoreTotal} G
      </div>
      <DropdownItem label="Filter" rgOptions={FILTERS} selectedOption={filter}
        onChange={o => setFilter(o.data as Filter)} />
      <DropdownItem label="Sort by" rgOptions={SORTS} selectedOption={sort}
        onChange={o => setSort(o.data as Sort)} />
      <TextField label="Search" value={query} onChange={e => setQuery(e.target.value)} />
      {!detail && <div style={{ padding: 16 }}>Loading…</div>}
      {detail && !detail.ok && <div style={{ padding: 16 }}>Could not load achievements ({detail.error}).</div>}
      {detail?.ok && rows.length === 0 && <div style={{ padding: 16, opacity: 0.7 }}>No achievements match.</div>}
      {rows.map(a => <AchievementRow key={a.id || a.name} a={a} />)}
    </div>
  );
}

function AchievementsPage() {
  const [titles, setTitles] = useState<TitleSummary[] | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => {
    listTitles()
      .then(r => { setTitles(r.titles); setError(r.ok ? "" : r.error ?? "error"); })
      .catch(() => { setTitles([]); setError("Failed to load"); });
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

  return (
    <div style={{ padding: "40px 24px 24px", marginTop: 40, height: "100%", overflowY: "auto", boxSizing: "border-box" }}>
      {title ? (
        <TitleView title={title} tick={tick} onBack={() => setSelected(null)} />
      ) : (
        <div>
          <h1 style={{ margin: "0 0 12px" }}>Nexus Achievements</h1>
          {titles === null && <div>Loading…</div>}
          {error && <div style={{ padding: 8 }}>Error: {error}</div>}
          {titles && titles.length === 0 && !error && (
            <div style={{ opacity: 0.7 }}>No achievements yet. Play a Nexus game to start unlocking.</div>
          )}
          {titles?.map(t => (
            <ButtonItem key={t.titleId} layout="below" onClick={() => setSelected(t.titleId)}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                <span>{t.titleName}</span>
                <span style={{ opacity: 0.8 }}>{t.unlocked}/{t.total} • {t.gamerscore}/{t.gamerscoreTotal} G</span>
              </div>
            </ButtonItem>
          ))}
          <ButtonItem layout="below" onClick={reload}>Refresh</ButtonItem>
        </div>
      )}
    </div>
  );
}

function Content() {
  const [settings, setLocal] = useState<Settings | null>(null);

  useEffect(() => {
    getSettings().then(s => { currentDuration = s.duration; setLocal(s); });
  }, []);

  if (!settings) return null;

  const update = async (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setLocal(next);
    currentDuration = next.duration;
    setLocal(await setSettings(next.enabled, next.duration, next.events_path));
  };

  return (
    <PanelSection title="Nexus Achievements">
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => { Navigation.CloseSideMenus(); Navigation.Navigate(ROUTE); }}>
          View all achievements
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField label="Enable notifications" checked={settings.enabled}
          onChange={enabled => update({ enabled })} />
      </PanelSectionRow>
      <PanelSectionRow>
        <SliderField label="Duration (seconds)" min={2} max={30} step={1}
          value={Math.round(settings.duration / 1000)} showValue
          onChange={seconds => update({ duration: seconds * 1000 })} />
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => testNotification()}>
          Send test notification
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <div style={{ fontSize: 11, opacity: 0.7, wordBreak: "break-all" }}>
          Watching: {settings.resolved_path}
        </div>
      </PanelSectionRow>
    </PanelSection>
  );
}

export default definePlugin(() => {
  getSettings().then(s => { currentDuration = s.duration; }).catch(() => {});
  routerHook.addRoute(ROUTE, AchievementsPage, { exact: true });
  const listener = addEventListener<[AchievementEvent]>("achievement", showAchievement);

  return {
    name: "Nexus Achievements",
    titleView: <div className={staticClasses.Title}>Nexus Achievements</div>,
    content: <Content />,
    icon: <FaTrophy />,
    onDismount() {
      removeEventListener("achievement", listener);
      routerHook.removeRoute(ROUTE);
    },
  };
});
