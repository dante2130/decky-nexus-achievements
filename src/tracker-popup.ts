export interface TrackerPopupHandle { update(position: string, count: number): void; close(): void; }

// Use the same child browser-view surface as Steam's notification toasts.
// A standalone native popup is not reliably composited over games on Deck.
export function createTrackerPopup(onHost: (element: HTMLElement | null) => void, onError: () => void): TrackerPopupHandle {
  const main = (window as any).SteamUIStore?.WindowStore?.GamepadUIMainWindowInstance;
  const client = (window as any).SteamClient;
  const owner = main?.BrowserWindow;
  if (!owner || !client?.BrowserView?.CreatePopup) throw new Error("Tracker overlay is unavailable.");
  const name = "NexusAchievementTrackerView";
  const { strCreateURL, browserView } = client.BrowserView.CreatePopup({
    parentPopupBrowserID: owner.SteamClient.Browser.GetBrowserID(), strName: name,
  });
  let view: Window | null = null;
  let closed = false;
  let ready = false;
  let position = "upper-right";
  let count = 1;
  let visible: boolean | undefined;
  let compositionRequest: any;
  let poll: ReturnType<typeof setInterval> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const compositionKey = "NexusAchievementTracker";
  const releaseComposition = () => {
    if (!compositionRequest) return;
    const store = compositionRequest;
    compositionRequest = undefined;
    store.RemoveMinimumCompositionStateRequest(1, compositionKey);
  };
  const configure = () => {
    // BrowserView bounds are CSS pixels, not the physical display resolution.
    const width = 200, height = 16 + Math.max(1, count) * 40;
    const viewportWidth = owner.innerWidth, viewportHeight = owner.innerHeight;
    const x = position.endsWith("left") ? 12 : (position === "center-top" || position === "center-bottom") ? (viewportWidth - width) / 2 : viewportWidth - width - 12;
    const y = position === "center-left" || position === "center-right" ? (viewportHeight - height) / 2 : position.startsWith("lower") || position === "center-bottom" ? viewportHeight - height - 12 : 12;
    browserView.SetBounds(Math.max(0, x), Math.max(0, y), width, height);
  };
  const updateVisibility = () => {
    const composition = main.m_CompositionStateStore?.GetCompositionState?.() ?? main.m_CompositionStateStore?.m_eLatestCompositionState;
    const shouldShow = !(main.MenuStore?.IsAnySideMenuVisible?.() ?? false) && !(typeof composition === "number" && composition >= 2);
    if (visible === shouldShow) return;
    if (shouldShow && !compositionRequest) {
      const store = main.m_CompositionStateStore;
      if (!store?.AddMinimumCompositionStateRequest || !store?.RemoveMinimumCompositionStateRequest) throw new Error("Tracker composition is unavailable.");
      compositionRequest = store;
      store.AddMinimumCompositionStateRequest(1, compositionKey);
    } else if (!shouldShow) releaseComposition();
    visible = shouldShow;
    browserView.SetVisible(shouldShow);
  };
  const handle: TrackerPopupHandle = {
    update(nextPosition, nextCount) {
      position = nextPosition; count = nextCount;
      if (ready) { try { configure(); } catch { fail(); } }
    },
    close() {
      if (closed) return;
      closed = true;
      if (poll !== undefined) clearInterval(poll);
      if (timeout !== undefined) clearTimeout(timeout);
      onHost(null);
      try { releaseComposition(); } finally {
        try { browserView.SetVisible(false); } finally { client.BrowserView.Destroy(browserView); }
      }
    },
  };
  const fail = () => { if (!closed) { handle.close(); onError(); } };
  try {
    browserView.SetVisible(false);
    view = window.open(`${strCreateURL}&createflags=512`, name, "top=0,left=0,width=200,height=234,resizable=yes,status=0,toolbar=0,menubar=0,location=0");
    if (!view) throw new Error("Tracker browser view could not open.");
    view.document.write('<!DOCTYPE html><html><head><title>Achievement Tracker</title></head><body style="margin:0;background:transparent;overflow:hidden;pointer-events:none"><div id="nexus-tracker-target"></div></body></html>');
    view.document.close();
    view.document.documentElement.style.background = "transparent";
    browserView.SetWindowStackingOrder(1);
    poll = setInterval(() => {
      if (closed) return;
      try {
        if (view?.closed) { fail(); return; }
        configure();
        updateVisibility();
        if (!ready) {
          const host = view?.document.getElementById("nexus-tracker-target");
          if (!host) return;
          ready = true;
          if (timeout !== undefined) clearTimeout(timeout);
          onHost(host);
        }
      } catch { fail(); }
    }, 100);
    timeout = setTimeout(() => { if (!ready) fail(); }, 8000);
  } catch (error) { handle.close(); throw error; }
  return handle;
}
