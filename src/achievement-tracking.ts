import { callable } from "@decky/api";
import { useEffect, useSyncExternalStore } from "react";

export interface AchievementPreferences { favorites: string[]; tracked: string[]; error?: boolean; }
export interface TrackerOptions { enabled: boolean; position: string; opacity: number; count: number; }
export interface TrackedAchievement { id: string; name: string; description: string; iconUrl: string; secret: boolean; progress: number | null; unlocked: boolean; }
export interface TrackerState { options: TrackerOptions; running: { titleId: string; titleName: string } | null; achievements: TrackedAchievement[]; tracked?: string[]; }
const getPreferences = callable<[string], AchievementPreferences>("get_achievement_preferences");
const saveFavorite = callable<[string, string, boolean], AchievementPreferences>("set_achievement_favorite");
const saveTracked = callable<[string, string, boolean], AchievementPreferences>("set_achievement_tracked");
const getOptions = callable<[], TrackerOptions>("get_tracker_options");
const saveOptions = callable<[boolean, string, number, number], TrackerOptions>("set_tracker_options");
const getTracker = callable<[], TrackerState>("get_tracker_state");
let dataVersion = 0;
let locallyHidden = false;
let visibilityIntent = 0;
const preferenceVersions = new Map<string, number>();
const preferences = new Map<string, AchievementPreferences>();
const empty: AchievementPreferences = { favorites: [], tracked: [] };
const listeners = new Set<() => void>();
let revision = 0;
let queue = Promise.resolve();
let tracker: TrackerState = { options: { enabled: false, position: "upper-right", opacity: 75, count: 5 }, running: null, achievements: [] };
let overlayError = false;
const emit = () => { revision++; listeners.forEach(listener => listener()); };
function useRevision() {
  useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => revision);
}
export function useAchievementPreferences(titleId: string): AchievementPreferences {
  useRevision();
  useEffect(() => {
    let live = true;
    const version = preferenceVersions.get(titleId) ?? 0;
    void getPreferences(titleId).then(value => { if (live && version === (preferenceVersions.get(titleId) ?? 0)) { preferences.set(titleId, value); emit(); } }).catch(() => { if (live && version === (preferenceVersions.get(titleId) ?? 0)) { preferences.set(titleId, { ...(preferences.get(titleId) ?? empty), error: true }); emit(); } });
    return () => { live = false; };
  }, [titleId]);
  return preferences.get(titleId) ?? empty;
}
export function useTrackerState() { useRevision(); return tracker; }
export function useTrackerOverlayError() { useRevision(); return overlayError; }
export function reportTrackerOverlayError(value: boolean) { if (overlayError !== value) { overlayError = value; emit(); } }
function serialize<T>(action: () => Promise<T>): Promise<T> {
  const result = queue.then(action);
  queue = result.then(() => undefined, () => undefined);
  return result;
}
export function toggleAchievementFavorite(titleId: string, achievementId: string) {
  return serialize(async () => {
    preferenceVersions.set(titleId, (preferenceVersions.get(titleId) ?? 0) + 1);
    const current = preferences.get(titleId) ?? await getPreferences(titleId);
    const next = await saveFavorite(titleId, achievementId, !current.favorites.includes(achievementId));
    preferences.set(titleId, next); dataVersion++; emit();
    return next;
  });
}
export function toggleAchievementTracked(titleId: string, achievementId: string) {
  return serialize(async () => {
    preferenceVersions.set(titleId, (preferenceVersions.get(titleId) ?? 0) + 1);
    const current = preferences.get(titleId) ?? await getPreferences(titleId);
    const adding = !current.tracked.includes(achievementId);
    if (adding && current.tracked.length >= 5) throw new Error("You can track up to five achievements per game.");
    const next = await saveTracked(titleId, achievementId, adding);
    preferences.set(titleId, next); dataVersion++; emit();
    await refreshTrackerState(true);
    return next;
  });
}
export function updateTrackerOptions(patch: Partial<TrackerOptions>) {
  const intent = typeof patch.enabled === "boolean" ? ++visibilityIntent : visibilityIntent;
  if (patch.enabled === false) {
    locallyHidden = true;
    dataVersion++;
    tracker = { ...tracker, options: { ...tracker.options, enabled: false } }; emit();
  }
  return serialize(async () => {
    const next = { ...tracker.options, ...patch };
    const saved = await saveOptions(next.enabled, next.position, next.opacity, next.count);
    if (patch.enabled === true && intent === visibilityIntent) locallyHidden = false;
    dataVersion++; tracker = { ...tracker, options: { ...saved, enabled: locallyHidden ? false : saved.enabled } }; emit();
    await refreshTrackerState(true);
    return saved;
  });
}
let refreshing: Promise<void> | undefined;
let generation = 0;
export function refreshTrackerState(force = false): Promise<void> {
  if (refreshing) return force ? refreshing.then(() => refreshTrackerState()) : refreshing;
  const version = generation;
  const data = dataVersion;
  const request = getTracker().then(value => {
    if (version !== generation || data !== dataVersion) return;
    tracker = locallyHidden ? { ...value, options: { ...value.options, enabled: false } } : value;
    if (value.running) {
      const saved = preferences.get(value.running.titleId);
      if (saved) preferences.set(value.running.titleId, { ...saved,
        tracked: value.tracked ?? saved.tracked });
    }
    emit();
  }).catch(() => { if (version === generation && data === dataVersion) { tracker = { ...tracker, running: null, achievements: [] }; emit(); } });
  refreshing = request;
  void request.finally(() => { if (refreshing === request) refreshing = undefined; });
  return request;
}
export function startAchievementTracking() {
  const version = ++generation;
  const optionsVersion = dataVersion;
  void getOptions().then(options => { if (version === generation && optionsVersion === dataVersion) { tracker = { ...tracker, options: locallyHidden ? { ...options, enabled: false } : options }; emit(); } }).catch(() => {});
  void refreshTrackerState();
  const timer = setInterval(() => { void refreshTrackerState(); }, 1500);
  return () => {
    generation++;
    clearInterval(timer);
    refreshing = undefined;
    preferences.clear();
    tracker = { ...tracker, running: null, achievements: [] };
    emit();
  };
}

export function splitFavoriteAchievements<T extends { id: string }>(items: T[], favorites: readonly string[]) {
  const ids = new Set(favorites);
  return { favorites: items.filter(item => ids.has(item.id)), others: items.filter(item => !ids.has(item.id)) };
}
