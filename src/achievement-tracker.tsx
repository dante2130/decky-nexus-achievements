import { ButtonItem, DropdownItem, SliderField, ToggleField } from "@decky/ui";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getPluginLanguage, pluginLocales, subscribeLanguage, translate, translateError, type Message } from "./i18n";
import { createTrackerPopup, type TrackerPopupHandle } from "./tracker-popup";
import { reportTrackerOverlayError, updateTrackerOptions, useTrackerOverlayError, useTrackerState, type TrackerState } from "./achievement-tracking";

const positions = [
  ["upper-left", "Top left"], ["center-top", "Top center"], ["upper-right", "Top right"],
  ["center-left", "Middle left"], ["center-right", "Middle right"],
  ["lower-left", "Bottom left"], ["center-bottom", "Bottom center"], ["lower-right", "Bottom right"],
];
let retry = 0;
const retries = new Set<() => void>();

export function HideTrackerButton() {
  const { options } = useTrackerState();
  const locale = useSyncExternalStore(subscribeLanguage, getPluginLanguage);
  const [error, setError] = useState(false);
  if (!options.enabled && !error) return null;
  return <div>
    {options.enabled && <ButtonItem layout="below" onClick={() => {
      setError(false);
      void updateTrackerOptions({ enabled: false }).catch(() => setError(true));
    }}>{translate(locale, "Hide achievement tracker")}</ButtonItem>}
    {error && <div role="alert">{translate(locale, "Tracker hidden. Could not save this preference.")}</div>}
  </div>;
}

export function TrackerControls({ compact = false }: { compact?: boolean }) {
  const { options } = useTrackerState();
  const unavailable = useTrackerOverlayError();
  const locale = useSyncExternalStore(subscribeLanguage, getPluginLanguage);
  const t = (message: Message) => translate(locale, message);
  const [error, setError] = useState(false);
  const save = (patch: Partial<typeof options>) => {
    setError(false);
    void updateTrackerOptions(patch).catch(() => setError(true));
  };
  return <div className="nexus-tracker-controls" style={{ display: "flex", flexDirection: "column", width: "100%", gap: compact ? 8 : 0 }}>
    {!compact && <HideTrackerButton />}
    <div className="nexus-tracker-option" style={{ width: "100%" }}><ToggleField label={t("Achievement tracker")} description={t("Keep up to five selected achievements visible while playing.")}
      checked={options.enabled} onChange={enabled => save({ enabled })} /></div>
    <>
      <div className="nexus-tracker-option" style={{ width: "100%" }}><DropdownItem label={t("Tracker position")} selectedOption={options.position}
        rgOptions={positions.map(([data, label]) => ({ data, label: t(label as Message) }))}
        onChange={option => save({ position: option.data })} /></div>
      <div className="nexus-tracker-option" style={{ width: "100%" }}><DropdownItem label={t("Achievements shown")} selectedOption={options.count}
        rgOptions={[1, 2, 3, 4, 5].map(count => ({ data: count, label: String(count) }))}
        onChange={option => save({ count: option.data })} /></div>
      <div className="nexus-tracker-option" style={{ width: "100%" }}><SliderField label={t("Tracker opacity")} min={20} max={100} step={5} value={options.opacity} showValue
        onChange={opacity => save({ opacity: Math.round(opacity) })} /></div>
    </>
    {error && <div role="alert">{t("Could not save tracker settings.")}</div>}
    {unavailable && <div role="alert">
      {t("Tracker overlay is unavailable. Your tracked achievements are still saved.")}
      <ButtonItem layout="below" onClick={() => { retry++; retries.forEach(listener => listener()); }}>{t("Retry tracker overlay")}</ButtonItem>
    </div>}
  </div>;
}

export function AchievementTrackerOverlay() {
  const state = useTrackerState();
  const locale = useSyncExternalStore(subscribeLanguage, getPluginLanguage);
  const attempt = useSyncExternalStore(listener => { retries.add(listener); return () => { retries.delete(listener); }; }, () => retry);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const popup = useRef<TrackerPopupHandle | null>(null);
  const items = state.achievements.filter(item => !item.unlocked).slice(0, state.options.count);
  const active = state.options.enabled && !!state.running && items.length > 0;
  useEffect(() => {
    if (!active) { reportTrackerOverlayError(false); return; }
    try {
      popup.current = createTrackerPopup(setHost, () => reportTrackerOverlayError(true));
      reportTrackerOverlayError(false);
    } catch { reportTrackerOverlayError(true); }
    return () => { popup.current?.close(); popup.current = null; };
  }, [active, attempt]);
  useEffect(() => { popup.current?.update(state.options.position, items.length); }, [state.options.position, items.length, active, attempt]);
  if (!host || !active) return null;
  const dom = (window as any).SP_REACTDOM;
  return dom.createPortal(<TrackerPanel state={state} locale={locale} />, host);
}

export function TrackerPanel({ state, locale }: { state: TrackerState; locale: ReturnType<typeof getPluginLanguage> }) {
  const items = state.achievements.filter(item => !item.unlocked).slice(0, state.options.count);
  const t = (message: Message) => translate(locale, message);
  return <section aria-label={t("Achievement tracker")} className="nexus-achievement-tracker"
    style={{ boxSizing: "border-box", width: "100%", fontFamily: "Arial, sans-serif", color: "#fff", opacity: state.options.opacity / 100, background: "rgb(14,20,27)",
      borderLeft: "2px solid #8fdb8f", borderRadius: 6, padding: 8, pointerEvents: "none" }}>
    {items.map(item => {
      const progress = item.progress !== null && Number.isFinite(item.progress) ? Math.max(0, Math.min(100, item.progress)) : null;
      return <div key={item.id} style={{ marginTop: 6, minHeight: 30 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ flex: 1, fontSize: 11, fontWeight: "bold", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{item.name || t(item.secret ? "Secret achievement" : "Unnamed achievement")}</span>
          {progress !== null && <span style={{ fontSize: 10 }}>{new Intl.NumberFormat(pluginLocales[locale], { style: "percent", maximumFractionDigits: 0 }).format(progress / 100)}</span>}
        </div>
        {progress === null && <div style={{ fontSize: 9, opacity: 0.8, marginTop: 2 }}>{t("Progress unavailable")}</div>}
        {progress !== null && <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}
          style={{ width: 160, maxWidth: "100%", overflow: "hidden", height: 4, background: "rgba(255,255,255,.22)", borderRadius: 2, marginTop: 4 }}>
          <div style={{ width: `${progress}%`, height: "100%", background: "#8fdb8f", borderRadius: 2 }} />
        </div>}
      </div>;
    })}
  </section>;
}

export const trackingError = (error: unknown) => translateError(getPluginLanguage(), error instanceof Error ? error.message : undefined);
