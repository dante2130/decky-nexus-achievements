import { findInReactTree, getReactRoot } from "@decky/ui";
import { createElement, type ReactNode } from "react";
import { getPluginLanguage, translate } from "./i18n";

interface MenuEntry {
  id: string;
  route: string;
  label: string;
  icon: ReactNode;
  order: number;
  onSecondary?: () => void;
}

// Steamcord's shared registry lets either plugin load first and own the patch.
interface SteamMenuRegistry {
  revision?: number;
  entries: Map<string, MenuEntry>;
  dispose?: () => void;
  timer?: ReturnType<typeof setInterval>;
}

const registryKey = "__necroSteamMenuV1";
const entryPrefix = "necro-menu:";

function patchMountedMenu(registry: SteamMenuRegistry): (() => void) | undefined {
  const root = document.getElementById("root");
  if (!root) return;
  const menu = findInReactTree(getReactRoot(root), fiber => fiber?.memoizedProps?.navID === "MainNavMenuContainer");
  const parent = menu?.return;
  if (typeof parent?.type !== "function") return;

  const render = parent.type;
  const rowsSeen = new Set<any[]>();
  const wrappedTypes = new WeakMap<Function, Function>();
  let active = true;
  const isSharedEntry = (row: any) => typeof row?.key === "string" && row.key.startsWith(entryPrefix);
  const removeSharedEntries = (rows: any[]) => {
    for (let index = rows.length - 1; index >= 0; index--) {
      if (isSharedEntry(rows[index])) rows.splice(index, 1);
    }
  };
  function renderMenu(this: unknown, ...args: unknown[]) {
    const tree = render.apply(this, args);
    if (!active) return tree;
    const list = tree?.props?.children?.props?.children?.[0];
    if (typeof list?.type !== "function") return tree;
    const renderList = list.type;
    let wrapped = wrappedTypes.get(renderList);
    if (!wrapped) {
      wrapped = function (this: unknown, ...listArgs: unknown[]) {
        const output = renderList.apply(this, listArgs);
        if (!active) return output;
        const isNativeRoute = (row: any) => !isSharedEntry(row) && row?.props?.route &&
          row.props.label && (row.props.onGamepadFocus || row.props.onFocus);
        const rows = findInReactTree(output, node => Array.isArray(node) && node.some(isNativeRoute));
        if (!Array.isArray(rows) || Object.isFrozen(rows)) return output;
        removeSharedEntries(rows);
        const template = rows.find(isNativeRoute);
        if (!template) return output;
        rowsSeen.add(rows);
        if (rowsSeen.size > 32) rowsSeen.delete(rowsSeen.values().next().value!);

        const routes = rows.flatMap((row, index) => isNativeRoute(row) ? [index] : []);
        let position = 3;
        try {
          const saved = Number(localStorage.getItem("STEAMCORD_MENU_POSITION") ?? 3);
          if (Number.isInteger(saved) && saved >= 1 && saved <= 9) position = saved;
        } catch { /* Use the default menu position when storage is unavailable. */ }
        const insertAt = (position === 9 ? undefined : routes[position - 1]) ?? routes[routes.length - 1] + 1;
        const entries = [...registry.entries.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        rows.splice(insertAt, 0, ...entries.map(entry => createElement(template.type, {
          key: entryPrefix + entry.id,
          route: entry.route,
          label: entry.label,
          ...(template.props.onGamepadFocus ? { onGamepadFocus: template.props.onGamepadFocus } : { onFocus: template.props.onFocus }),
          ...(template.props.icon ? { icon: entry.icon } : { children: entry.icon }),
          ...(entry.onSecondary ? { onSecondaryActionDescription: "Change Position", onSecondaryButton: entry.onSecondary } : {}),
        })));
        return output;
      };
      wrappedTypes.set(renderList, wrapped);
      wrappedTypes.set(wrapped, wrapped);
    }
    if (wrapped !== renderList && !Object.isFrozen(list)) list.type = wrapped;
    return tree;
  }

  parent.type = renderMenu;
  if (parent.alternate) parent.alternate.type = renderMenu;
  return () => {
    active = false;
    if (parent.type === renderMenu) parent.type = render;
    if (parent.alternate?.type === renderMenu) parent.alternate.type = render;
    rowsSeen.forEach(removeSharedEntries);
    rowsSeen.clear();
  };
}

export function installSteamMainMenuEntry(route: string, icon: ReactNode): () => void {
  const host = window as Window & { [registryKey]?: SteamMenuRegistry };
  const registry: SteamMenuRegistry = host[registryKey] ??= { entries: new Map() };
  const entry: MenuEntry = {
    id: "nexus-achievements", route, icon, order: 20,
    get label() { return translate(getPluginLanguage(), "Nexus Achievements"); },
  };
  registry.revision ??= 3;
  registry.entries.set(entry.id, entry);
  const stopRetrying = () => {
    clearInterval(registry.timer);
    registry.timer = undefined;
  };
  if (!registry.dispose && registry.timer === undefined) {
    let attempts = 0;
    const tryMount = () => {
      try {
        registry.dispose = patchMountedMenu(registry);
      } catch (error) {
        console.debug("Nexus: unable to patch the mounted Steam menu.", error);
      }
      if (registry.dispose || ++attempts >= 30) stopRetrying();
    };
    registry.timer = setInterval(tryMount, 2000);
    tryMount();
  }
  return () => {
    if (registry.entries.get(entry.id) !== entry) return;
    registry.entries.delete(entry.id);
    if (registry.entries.size) return;
    stopRetrying();
    registry.dispose?.();
    registry.dispose = undefined;
  };
}
