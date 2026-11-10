import { addEventListener, removeEventListener, callable, routerHook } from "@decky/api";
import { afterPatch, appDetailsClasses, appDetailsHeaderClasses, createReactTreePatcher, findInReactTree,
  findModule, Focusable, GamepadButton, injectFCTrampoline, mainMenuAppRunningClasses, type Patch } from "@decky/ui";
import { createElement, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { appendGameHeaderEntries } from "./game-header-entries";
import { SessionCache } from "./cache";
import { headerNavigationProviders } from "./profile-gamerscore";
import { getPluginLanguage, subscribeLanguage, translate } from "./i18n";

export interface MenuTarget { titleId: string; titleName: string; coverUrl?: string; gamerscore?: number; gamerscoreTotal?: number; unlocked?: number; total?: number; updatedAt?: number; }
const getTarget = callable<[number], MenuTarget | null>("get_game_menu_target");
export const saveGameMenuButton = callable<[boolean], boolean>("set_game_menu_button");
let enabled = false;
const listeners = new Set<() => void>();
export function setGameMenuEnabled(value: boolean) { enabled = value; listeners.forEach(fn => fn()); }
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const snapshot = () => enabled;

const targetCache = new SessionCache<MenuTarget | null>();
export function invalidateGameMenuCache() { targetCache.clear(); }
function useMenuTarget(appId: number) {
  const active = useSyncExternalStore(subscribe, snapshot);
  const [result, setResult] = useState(() => ({ appId, target: targetCache.peek(String(appId)) ?? null }));
  useEffect(() => {
    let alive = true;
    const load = () => {
      if (active && Number.isInteger(appId) && appId > 0) targetCache.load(String(appId), () => getTarget(appId), 5000)
        .then(value => { if (alive) setResult({ appId, target: value }); }).catch(() => {});
    };
    load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listener = addEventListener("achievement", () => {
      clearTimeout(timer);
      timer = setTimeout(load, 1500);
    });
    return () => { alive = false; clearTimeout(timer); removeEventListener("achievement", listener); };
  }, [appId, active]);
  return active && result.appId === appId ? result.target : null;
}

function GameMenuButton({ appId, onOpen }: { appId: number; onOpen: (target: MenuTarget) => void }) {
  const target = useMenuTarget(appId);
  const locale = useSyncExternalStore(subscribeLanguage, getPluginLanguage);
  if (!target) return null;
  return <Focusable role="button" className={mainMenuAppRunningClasses.NavigationMenuItem}
    onActivate={() => onOpen(target)} onClick={() => onOpen(target)}>{translate(locale, "Nexus Achievements")}</Focusable>;
}

function GameViewAchievements({ appId, icon, onOpen }: { appId: number; icon: ReactNode; onOpen: (target: MenuTarget) => void }) {
  const target = useMenuTarget(appId);
  const locale = useSyncExternalStore(subscribeLanguage, getPluginLanguage);
  const anchor = useRef<HTMLSpanElement>(null);
  const scoreButton = useRef<HTMLDivElement>(null);
  const [hero, setHero] = useState<HTMLElement | null>(null);
  const [providers, setProviders] = useState<ReturnType<typeof headerNavigationProviders>>([]);
  useEffect(() => {
    const parent = anchor.current?.parentElement;
    if (!parent) return;
    const findHero = () => {
      const header = [...parent.children].find(child => child.classList.contains(appDetailsClasses.Header));
      const capsule = header?.querySelector<HTMLElement>(`.${appDetailsHeaderClasses.TopCapsule}`);
      setHero(capsule ?? null);
      const next = capsule ? headerNavigationProviders(capsule) : [];
      setProviders(previous => previous.length === next.length && previous.every((provider, index) =>
        provider.type === next[index].type && provider.value === next[index].value) ? previous : next);
    };
    findHero();
    const observer = new MutationObserver(findHero);
    observer.observe(parent, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [appId, !!target]);
  useEffect(() => {
    const container = anchor.current?.parentElement;
    const button = scoreButton.current;
    if (!container || !hero || !button) return;

    let leftNeighbor: HTMLElement | null = null;
    let belowNeighbor: HTMLElement | null = null;
    const moveFocus = (event: Event, destination: HTMLElement) => {
      const ownerWindow = destination.ownerDocument.defaultView;
      if (!ownerWindow) return;
      const request = new ownerWindow.CustomEvent("vgp_requestfocus", {
        bubbles: true, cancelable: true, detail: (event as CustomEvent).detail,
      });
      if (destination.dispatchEvent(request)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onHeroDirection = (event: Event) => {
      const { button: direction, is_repeat } = (event as CustomEvent<{ button: GamepadButton; is_repeat?: boolean }>).detail;
      if (event.defaultPrevented || is_repeat) return;
      const source = event.target as HTMLElement;
      const tile = button.getBoundingClientRect();
      const origin = source.getBoundingClientRect();
      if (direction === GamepadButton.DIR_RIGHT && origin.right <= tile.left &&
          origin.top < tile.bottom && origin.bottom > tile.top) {
        leftNeighbor = source;
        moveFocus(event, button);
      }
    };
    const onTileDirection = (event: Event) => {
      const { button: direction, is_repeat } = (event as CustomEvent<{ button: GamepadButton; is_repeat?: boolean }>).detail;
      if (event.defaultPrevented || is_repeat) return;
      const source = event.target as HTMLElement;
      if (source === button) {
        const neighbor = direction === GamepadButton.DIR_LEFT ? leftNeighbor
          : direction === GamepadButton.DIR_DOWN ? belowNeighbor : null;
        if (neighbor && container.contains(neighbor)) moveFocus(event, neighbor);
        return;
      }
      if (direction !== GamepadButton.DIR_UP) return;
      const tile = button.getBoundingClientRect();
      const origin = source.getBoundingClientRect();
      const heroBottom = hero.getBoundingClientRect().bottom;
      if (origin.top >= heroBottom && origin.top < heroBottom + 64 && origin.right > tile.left) {
        belowNeighbor = source;
        moveFocus(event, button);
      }
    };
    // Let the horizontal hero row handle Right first. Its unhandled edge event
    // can cross into the tile, which Steam registers in a separate vertical group.
    container.addEventListener("vgp_ondirection", onHeroDirection);
    container.addEventListener("vgp_ondirection", onTileDirection, true);
    return () => {
      container.removeEventListener("vgp_ondirection", onHeroDirection);
      container.removeEventListener("vgp_ondirection", onTileDirection, true);
    };
  }, [hero, !!target]);
  if (!target || typeof target.gamerscore !== "number" || typeof target.gamerscoreTotal !== "number") return null;
  const label = translate(locale, "View all achievements");
  let badge: ReactNode = <div className="nexus-game-view-achievements" style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 5 }}>
    <style>{`
      .nexus-game-view-achievements .nexus-game-view-score:is(.gpfocus, :focus-visible) {
        background: #fff !important;
        color: #0e141b !important;
      }
      .nexus-game-view-score:is(.gpfocus, :focus-visible) .nexus-gamerscore-icon circle { fill: #0e141b !important; }
      .nexus-game-view-score:is(.gpfocus, :focus-visible) .nexus-gamerscore-icon path { stroke: #fff !important; }
    `}</style>
    <Focusable ref={scoreButton} role="button" noFocusRing className="nexus-game-view-score"
      aria-label={label} onOKActionDescription={label} onActivate={() => onOpen(target)}
      style={{ position: "absolute", right: 16, top: 46, width: "auto", minWidth: 0, height: "auto", cursor: "pointer", padding: "6px 10px", borderRadius: 6,
        pointerEvents: "auto", background: "rgba(20,27,36,0.94)", color: "#fff", boxShadow: "0 2px 8px rgba(0,0,0,0.3)", opacity: 1 }}
      onClick={() => onOpen(target)}>
      <span style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 5, fontSize: 13, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
        {icon}{target.gamerscore}/{target.gamerscoreTotal}
      </span>
      <span style={{ display: "block", fontSize: 11, opacity: 0.9 }}>{translate(locale, "{unlocked}/{total} unlocked", { unlocked: target.unlocked ?? 0, total: target.total ?? 0 })}</span>
    </Focusable>
  </div>;
  for (const provider of providers) badge = createElement(provider.type, { value: provider.value }, badge);
  return <><span ref={anchor} hidden data-nexus-score-anchor="true" />
    {hero && (window as any).SP_REACTDOM.createPortal(badge, hero)}
  </>;
}

// Steam's React structures are private, so confine their dynamic shapes to this boundary.
export function installGameMenuButtons(onOpen: (target: MenuTarget) => void, icon: ReactNode): () => void {
  const patches: Patch[] = [];
  const routeObjects = new WeakSet<object>();
  const libraryPatch = routerHook.addPatch("/library/app/:appid", (route: any) => {
    const props = findInReactTree(route, (node: any) => typeof node?.renderFunc === "function");
    if (!props || routeObjects.has(props)) return route;
    routeObjects.add(props);
    patches.push(afterPatch(props, "renderFunc", createReactTreePatcher([
      (tree: any) => findInReactTree(tree, (node: any) => node?.props?.children?.props?.overview)?.props?.children,
    ], (_: any[], tree: any) => {
      const overview = findInReactTree(tree, (node: any) => node?.props?.overview)?.props?.overview;
      const container = findInReactTree(tree, (node: any) => Array.isArray(node?.props?.children)
        && typeof node?.props?.className === "string" && node.props.className.split(" ").includes(appDetailsClasses.InnerContainer));
      if (overview?.appid && container) {
        appendGameHeaderEntries(container.props.children, [
          <GameViewAchievements key="nexus-game-view-score" appId={overview.appid} icon={icon} onOpen={onOpen} />,
        ]);
      }
      return tree;
    }, "NexusLibraryButton")));
    return route;
  });

  const module = findModule((value: any) => typeof value === "object" && Object.values(value).some((entry: any) =>
    typeof entry === "function" && entry.toString().includes("#AppOverlay_GameDetails") && entry.toString().includes("#AppOverlay_Resume")));
  if (module) {
    for (const component of Object.values(module) as any[]) {
      if (typeof component !== "function" || !(/collapsible:!0/.test(component.toString()) && /focusedColumn/.test(component.toString())
          || component.toString().includes('"StandaloneAppRunningControls"'))) continue;
      const trampoline = injectFCTrampoline(component);
      patches.push(afterPatch(trampoline, "component", createReactTreePatcher([
        (tree: any) => findInReactTree(tree, (node: any) => node?.props?.app && typeof node?.type === "function"),
        (tree: any) => findInReactTree(tree, (node: any) => node?.props?.app && node?.props?.navRef),
      ], (args: any[], tree: any) => {
        const appId = args[0]?.app?.appid;
        const box = findInReactTree(tree, (node: any) => Array.isArray(node?.props?.children)
          && Array.isArray(node.props.children[0]) && node.props.children[0].some((entry: any) => entry?.props?.text && entry?.props?.onActivate));
        if (appId && box && !box.props.children[0].some((entry: any) => entry?.key === "nexus-game-achievements")) {
          const items = [...box.props.children[0]];
          const details = items.findIndex((entry: any) => entry?.key === "details");
          items.splice(details >= 0 ? details + 1 : Math.max(0, items.length - 1), 0,
            <GameMenuButton key="nexus-game-achievements" appId={appId} onOpen={onOpen} />);
          box.props.children = [items, ...box.props.children.slice(1)];
        }
        return tree;
      }, "NexusRunningGameButton")));
    }
  } else console.warn("Nexus: Steam running-game menu integration is unavailable on this Steam build.");
  return () => {
    setGameMenuEnabled(false);
    targetCache.clear();
    routerHook.removePatch("/library/app/:appid", libraryPatch);
    patches.reverse().forEach(patch => patch.unpatch());
  };
}
