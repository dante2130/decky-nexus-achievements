import { callable, routerHook } from "@decky/api";
import { afterPatch, findModule, findClassModule, Focusable } from "@decky/ui";
import { cloneElement, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { getPluginLanguage, pluginLocales, subscribeLanguage, translate } from "./i18n";

interface ScoreState { enabled: boolean; score: number | null; unavailable: boolean; }
let state: ScoreState = { enabled: false, score: null, unavailable: false };
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const snapshot = () => state;
export const useProfileGamerscore = () => useSyncExternalStore(subscribe, snapshot);
const publish = (value: ScoreState) => { state = value; listeners.forEach(fn => fn()); };
const readScore = callable<[boolean], { ok: boolean; gamerscore?: number }>("get_profile_gamerscore");
export const saveProfileGamerscore = callable<[boolean], boolean>("set_profile_gamerscore");
let generation = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let pending: Promise<void> | undefined;
let unlockTimer: ReturnType<typeof setTimeout> | undefined;

async function refresh(force = false) {
  if (!state.enabled) return;
  if (pending) return pending;
  const version = generation;
  const request = readScore(force).then(value => {
    if (version !== generation || !state.enabled) return;
    const valid = value.ok && Number.isInteger(value.gamerscore) && value.gamerscore! >= 0 && value.gamerscore! <= 0xffffffff;
    publish({ ...state, score: valid ? value.gamerscore! : null, unavailable: !valid });
  }).catch(() => { if (version === generation && state.enabled) publish({ ...state, score: null, unavailable: true }); });
  pending = request;
  try { await request; } finally { if (pending === request) pending = undefined; }
}

export function setProfileGamerscoreEnabled(enabled: boolean) {
  if (state.enabled === enabled) return;
  generation++;
  pending = undefined;
  clearInterval(timer); clearTimeout(unlockTimer);
  timer = undefined; unlockTimer = undefined;
  publish({ enabled, score: null, unavailable: false });
  if (enabled) {
    void refresh();
    timer = setInterval(() => { void refresh(); }, 300000);
  }
}
export function refreshProfileGamerscore() {
  if (!state.enabled) return;
  clearTimeout(unlockTimer);
  unlockTimer = setTimeout(() => { void refresh(true); }, 2000);
}

const headerButtonClasses = findClassModule((value: any) => value.HeaderItem && value.Clickable && value.Clock) as { HeaderItem?: string; Clickable?: string; InQuickAccess?: string } | undefined;

function ProfileScore({ icon, onOpen, iconOnly = false, nativeNavigation = true }: { icon: ReactNode; onOpen: () => void; iconOnly?: boolean; nativeNavigation?: boolean }) {
  const [controllerFocus, setControllerFocus] = useState(false);
  const value = useProfileGamerscore();
  const locale = useSyncExternalStore(subscribeLanguage, getPluginLanguage);
  if (!value.enabled || value.score === null) return null;
  const score = new Intl.NumberFormat(pluginLocales[locale]).format(value.score);
  const className = [headerButtonClasses?.HeaderItem, headerButtonClasses?.Clickable, "nexus-profile-gamerscore",
    controllerFocus && "nexus-profile-controller-focus"].filter(Boolean).join(" ");
  const style = { display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, whiteSpace: "nowrap" as const,
    fontVariantNumeric: "tabular-nums", fontSize: 14, cursor: "pointer", padding: "0 8px", width: "auto", minWidth: 0,
    height: "100%", alignSelf: "stretch", boxSizing: "border-box" as const, borderRadius: 0, color: "inherit" };
  const content = <>
    <style>{`
      .${headerButtonClasses?.InQuickAccess} .nexus-profile-score-value { display: none !important; }
      .nexus-profile-controller-focus,
      .nexus-profile-gamerscore:is(.gpfocus, :focus, :focus-visible):not(:hover) {
        background: transparent !important;
        color: inherit !important;
        box-shadow: none !important;
        outline: none !important;
      }
      .nexus-profile-controller-focus::before,
      .nexus-profile-controller-focus::after,
      .nexus-profile-gamerscore:is(.gpfocus, :focus, :focus-visible):not(:hover)::before,
      .nexus-profile-gamerscore:is(.gpfocus, :focus, :focus-visible):not(:hover)::after {
        background: transparent !important;
        box-shadow: none !important;
        opacity: 0 !important;
      }
    `}</style>
    {icon}{!iconOnly && <span className="nexus-profile-score-value">{score}</span>}
  </>;
  if (!nativeNavigation) return <button type="button" tabIndex={-1}
    className={`${className} nexus-profile-dom-button`} data-nexus-profile-score="true"
    aria-label={translate(locale, "Profile Gamerscore: {score}", { score })} style={style}
    onMouseDown={event => event.preventDefault()} onClick={onOpen}>
    <style>{`.nexus-profile-dom-button { appearance: none; border: 0; background: transparent; font-family: inherit; }`}</style>
    {content}
  </button>;
  return <Focusable noFocusRing className={className} role="button" data-nexus-profile-score="true"
    onGamepadFocus={() => setControllerFocus(true)} onGamepadBlur={() => setControllerFocus(false)}
    onMouseEnter={() => setControllerFocus(false)} onMouseMove={() => setControllerFocus(false)}
    onActivate={onOpen} onClick={onOpen} aria-label={translate(locale, "Profile Gamerscore: {score}", { score })} style={style}>
    {content}
  </Focusable>;
}

function ExistingHeaderScore({ icon, onOpen }: { icon: ReactNode; onOpen: () => void }) {
  const value = useProfileGamerscore();
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!value.enabled) return;
    let node: HTMLElement | null = null;
    let observer: MutationObserver | undefined;
    let observed: Document | undefined;
    const attach = () => {
      const store = (window as any).SteamUIStore;
      const win = store?.WindowStore?.GamepadUIMainWindowInstance?.BrowserWindow?.window as Window | undefined;
      const doc = win?.document;
      if (!doc) return;
      if (observed !== doc) {
        observer?.disconnect();
        observed = doc;
        observer = new MutationObserver(attach);
        observer.observe(doc.documentElement, { childList: true, subtree: true });
      }
      const header = doc.getElementById("header");
      if (!header) return;
      const native = [...header.querySelectorAll("[data-nexus-profile-score]")].find(item => !node?.contains(item));
      if (native) {
        if (node) { node.remove(); node = null; setHost(null); }
        return;
      }
      if (node?.parentElement === header) return;
      node?.remove();
      node = doc.createElement("div");
      node.className = "nexus-profile-status-host";
      Object.assign(node.style, { display: "flex", alignItems: "stretch", alignSelf: "stretch", height: "100%", flexShrink: "0", pointerEvents: "auto" });
      const clock = [...header.children].find(child => /[0-9]{1,2}:[0-9]{2}/.test(child.textContent || ""));
      header.insertBefore(node, clock || header.lastElementChild);
      setHost(node);
    };
    attach();
    const timer = setInterval(attach, 1000);
    return () => { clearInterval(timer); observer?.disconnect(); node?.remove(); setHost(null); };
  }, [value.enabled]);
  if (!host || !value.enabled) return null;
  const dom = (window as any).SP_REACTDOM;
  return dom.createPortal(<ProfileScore icon={icon} onOpen={onOpen} nativeNavigation={false} />, host);
}

export function installProfileGamerscore(icon: ReactNode, onOpen: () => void): () => void {
  routerHook.addGlobalComponent("NexusProfileGamerscore", () => <ExistingHeaderScore icon={icon} onOpen={onOpen} />);
  const module = findModule((value: any) => typeof value === "object" && Object.values(value).some((item: any) =>
    typeof item?.type === "function" && item.type.toString().includes("quickAccessHeader") && item.type.toString().includes("BShowHeader")));
  const headers = module ? Object.values(module).filter((item: any) => typeof item?.type === "function"
    && item.type.toString().includes("quickAccessHeader") && item.type.toString().includes("BShowHeader")) as any[] : [];
  const patches = headers.map(header => afterPatch(header, "type", (args: any[], tree: any) => {
    const iconOnly = args[0]?.quickAccessHeader === true || tree?.props?.value?.region === 1;
    if (Array.isArray(tree?.props?.children)) {
      return cloneElement(tree, {}, <ProfileScore key="nexus-profile-gamerscore" icon={icon} onOpen={onOpen} iconOnly={iconOnly} />, ...tree.props.children);
    }
    const row = tree?.props?.children;
    const groups = row?.props?.children;
    if (!Array.isArray(groups)) return tree;
    let index = groups.length - 1;
    while (index >= 0 && !Array.isArray(groups[index]?.props?.children)) index--;
    if (index < 0) return tree;
    const group = groups[index];
    const items = group.props.children;
    if (items.some((item: any) => item?.key === "nexus-profile-gamerscore")) return tree;
    const updated = [...groups];
    updated[index] = cloneElement(group, {}, <ProfileScore key="nexus-profile-gamerscore" icon={icon} onOpen={onOpen} iconOnly={iconOnly} />, ...items);
    return cloneElement(tree, {}, cloneElement(row, {}, ...updated));
  }));
  return () => { setProfileGamerscoreEnabled(false); routerHook.removeGlobalComponent("NexusProfileGamerscore"); patches.reverse().forEach(patch => patch.unpatch()); };
}
