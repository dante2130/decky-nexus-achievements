import { findInReactTree, getReactRoot, Menu, MenuItem, showContextMenu } from "@decky/ui";
import { createElement, type ReactNode } from "react";
import { getPluginLanguage, translate } from "./i18n";

const entryKey = "nexus-achievements";
const positionKey = "NEXUS_ACHIEVEMENTS_STEAM_MENU_POSITION";
const nativeRouteKeys = new Set(["home", "library", "store", "chat", "media", "downloads", "console", "settings", "account"]);

function getPosition() {
  try {
    const position = Number(localStorage.getItem(positionKey) ?? 3);
    if (Number.isInteger(position) && position >= 1 && position <= 9) return position;
  } catch { /* Storage can be unavailable while the Steam UI starts. */ }
  return 3;
}

function choosePosition(event?: Event) {
  const position = getPosition();
  const label = translate(getPluginLanguage(), "Change menu position");
  showContextMenu(createElement(Menu, { label },
    Array.from({ length: 9 }, (_, index) => {
      const slot = index + 1;
      return createElement(MenuItem, {
        key: slot,
        selected: slot === position,
        onSelected: () => localStorage.setItem(positionKey, String(slot)),
      }, String(slot));
    }),
  ), event?.currentTarget ?? undefined);
}

function patchMountedMenu(route: string, icon: ReactNode, isVisible: () => boolean): (() => void) | undefined {
  const root = document.getElementById("root");
  if (!root) return;
  const menu = findInReactTree(getReactRoot(root), fiber => fiber?.memoizedProps?.navID === "MainNavMenuContainer");
  const parent = menu?.return;
  if (typeof parent?.type !== "function") return;

  const render = parent.type;
  const rowsSeen = new Set<any[]>();
  const wrappedTypes = new WeakMap<Function, Function>();
  let active = true;
  const removeEntry = (rows: any[]) => {
    const index = rows.findIndex(row => row?.key === entryKey);
    if (index !== -1) rows.splice(index, 1);
  };

  function renderMenu(this: unknown, ...args: unknown[]) {
    const tree = render.apply(this, args);
    const list = tree?.props?.children?.props?.children?.[0];
    if (typeof list?.type !== "function") return tree;
    const renderList = list.type;
    let wrapped = wrappedTypes.get(renderList);
    if (!wrapped) {
      wrapped = function (this: unknown, ...listArgs: unknown[]) {
        const output = renderList.apply(this, listArgs);
        if (!active) return output;
        const rows = findInReactTree(output, node => Array.isArray(node) && node.some(row => row?.key === "library"));
        if (!Array.isArray(rows) || Object.isFrozen(rows)) return output;
        const template = rows.find(row => row?.key === "library" && row.props?.route);
        if (!template) return output;
        removeEntry(rows);
        if (!isVisible()) return output;
        rowsSeen.add(rows);
        if (rowsSeen.size > 32) rowsSeen.delete(rowsSeen.values().next().value!);

        // Count Steam's routes so another plugin's shortcut cannot shift our slot.
        const nativeRoutes = rows.flatMap((row, index) => nativeRouteKeys.has(row?.key) && row.props?.route ? [index] : []);
        const position = getPosition();
        const insertAt = (position === 9 ? undefined : nativeRoutes[position - 1]) ?? nativeRoutes[nativeRoutes.length - 1] + 1;
        const locale = getPluginLanguage();
        rows.splice(insertAt, 0, createElement(template.type, {
          key: entryKey, route, icon,
          label: translate(locale, "Nexus Achievements"),
          onGamepadFocus: template.props.onGamepadFocus,
          onFocus: template.props.onFocus,
          onSecondaryActionDescription: translate(locale, "Change menu position"),
          onSecondaryButton: choosePosition,
        }));
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
    rowsSeen.forEach(removeEntry);
    rowsSeen.clear();
  };
}

export function installSteamMainMenuEntry(route: string, icon: ReactNode, isVisible: () => boolean): () => void {
  let dispose: (() => void) | undefined;
  let attempts = 0;
  const timer = setInterval(tryMount, 2000);
  function tryMount() {
    try {
      dispose = patchMountedMenu(route, icon, isVisible);
    } catch (error) {
      console.debug("Nexus: unable to patch the mounted Steam menu.", error);
    }
    if (dispose || ++attempts >= 30) clearInterval(timer);
  }
  tryMount();
  return () => {
    clearInterval(timer);
    dispose?.();
  };
}
