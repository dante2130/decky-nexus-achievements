export function readAudioDuration(source: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    const timer = setTimeout(() => finish(new Error("Audio metadata timed out")), 10000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      const seconds = audio.duration;
      audio.onloadedmetadata = audio.onerror = null;
      audio.removeAttribute("src"); audio.load();
      if (error || !Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) reject(error || new Error("Invalid audio duration"));
      else resolve(Math.ceil(seconds) * 1000);
    };
    audio.preload = "metadata";
    audio.onloadedmetadata = () => finish();
    audio.onerror = () => finish(new Error("Audio metadata unavailable"));
    audio.src = source;
  });
}

export type SoundKind = "normal" | "rare" | "mythic";
export type SoundFiles = Partial<Record<SoundKind, string>>;
interface AudioPayload { data?: string; mime?: string; }
interface Player { play(): Promise<void>; pause(): void; onended: ((event: Event) => void) | null; }

export class NotificationAudio {
  private files: SoundFiles = {};
  private cache = new Map<SoundKind, Promise<string>>();
  private active: Player | null = null;
  private lengths = new Map<SoundKind, Promise<number>>();
  private measure: (source: string) => Promise<number>;
  private generation = 0;

  private listeners = new Set<() => void>();
  private load: (kind: SoundKind) => Promise<AudioPayload>;
  private create: (source: string) => Player;
  constructor(load: (kind: SoundKind) => Promise<AudioPayload>,
    create: (source: string) => Player = source => new Audio(source),
    measure: (source: string) => Promise<number> = readAudioDuration) { this.load = load; this.create = create; this.measure = measure; }
  getFiles = () => this.files;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  configure(files: SoundFiles = {}, durations: Partial<Record<SoundKind, number>> = {}) {
    let changed = false;
    for (const kind of ["normal", "rare", "mythic"] as const) {
      if (this.files[kind] !== files[kind]) { this.cache.delete(kind); this.lengths.delete(kind); changed = true; }
    }
    // Persisted durations avoid a cold backend read and metadata decode before
    // the first popup can be submitted to Steam.
    for (const kind of ["normal", "rare", "mythic"] as const) {
      const duration = durations[kind];
      if (files[kind] && typeof duration === "number" && Number.isFinite(duration) && duration > 0 && duration <= 86400000) {
        this.lengths.set(kind, Promise.resolve(duration));
      }
    }
    if (!changed) return;
    this.files = { ...files };
    this.stop();
    this.listeners.forEach(listener => listener());
  }

  invalidate(kind: SoundKind) { this.cache.delete(kind); this.lengths.delete(kind); }

  has(kind: SoundKind) { return !!this.files[kind]; }

  private source(kind: SoundKind): Promise<string> {
    let pending = this.cache.get(kind);
    if (!pending) {
      pending = this.load(kind).then(value => {
        if (!value.data || !["audio/wav", "audio/mpeg", "audio/ogg", "audio/flac"].includes(value.mime || "")) {
          throw new Error("Audio unavailable");
        }
        return `data:${value.mime};base64,${value.data}`;
      });
      this.cache.set(kind, pending);
      void pending.catch(() => { if (this.cache.get(kind) === pending) this.cache.delete(kind); });
    }
    return pending;
  }

  duration(kind: SoundKind): Promise<number> {
    if (!this.has(kind)) return Promise.resolve(0);
    let pending = this.lengths.get(kind);
    if (!pending) {
      pending = this.source(kind).then(this.measure);
      this.lengths.set(kind, pending);
      void pending.catch(() => { if (this.lengths.get(kind) === pending) this.lengths.delete(kind); });
    }
    return pending;
  }

  async play(kind: SoundKind, isVisible: () => boolean = () => true) {
    this.stop();
    if (!this.has(kind)) return;
    const generation = this.generation;
    const source = await this.source(kind);
    if (generation !== this.generation || !isVisible()) return;
    const player = this.create(source);
    this.active = player;
    player.onended = () => { if (this.active === player) this.active = null; };
    try { await player.play(); }
    catch (error) { if (this.active === player) this.active = null; player.pause(); throw error; }
  }

  stop() { this.generation++; this.active?.pause(); this.active = null; }
  dispose() { this.stop(); this.cache.clear(); this.lengths.clear(); }
}

export interface PopupPlayback { kind: SoundKind; played: boolean; }
export function observePopupSound(element: HTMLElement, playback: PopupPlayback,
  start: (kind: SoundKind, isVisible: () => boolean) => void,
  createObserver: (callback: IntersectionObserverCallback) => IntersectionObserver = callback => new IntersectionObserver(callback, { threshold: [0, 0.01] })) {
  const popup = element.closest('.DeckyGamepadUIPopupToast');
  if (!popup || playback.played) return () => {};
  let visible = false;
  const observer = createObserver(entries => {
    visible = entries.some(entry => entry.isIntersecting && entry.intersectionRatio > 0);
    if (visible && !playback.played) {
      playback.played = true;
      start(playback.kind, () => visible && popup.isConnected);
    }
  });
  observer.observe(popup);
  return () => { visible = false; observer.disconnect(); };
}

export function isNexusToast(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const toast = value as { decky?: boolean; data?: { className?: string }; notifications?: unknown[] };
  return (toast.decky === true && typeof toast.data?.className === "string"
    && toast.data.className.split(/\s+/).includes("nexus-achievement-notification"))
    || (Array.isArray(toast.notifications) && toast.notifications.some(item => {
      if (!item || typeof item !== "object") return false;
      const row = item as { decky?: boolean; data?: { className?: string } };
      return row.decky === true && typeof row.data?.className === "string"
        && row.data.className.split(/\s+/).includes("nexus-achievement-notification");
    }));
}
