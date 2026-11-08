interface Entry<T> {
  value?: T;
  freshUntil: number;
  pending?: Promise<T>;
}

// Session-only cache: stale values remain visible during background refreshes.
export class SessionCache<T> {
  private entries = new Map<string, Entry<T>>();

  peek(key: string): T | undefined {
    return this.entries.get(key)?.value;
  }

  load(key: string, read: () => Promise<T>, maxAge = 60_000,
    cacheable: (value: T) => boolean = () => true): Promise<T> {
    let entry = this.entries.get(key);
    if (entry?.pending) return entry.pending;
    if (entry?.value !== undefined && entry.freshUntil > Date.now()) return Promise.resolve(entry.value);
    if (!entry) {
      entry = { freshUntil: 0 };
      this.entries.set(key, entry);
      if (this.entries.size > 32) this.entries.delete(this.entries.keys().next().value!);
    }
    const current = entry;
    current.pending = Promise.resolve().then(read).then(value => {
      // An invalidated request may finish, but must not repopulate the cache.
      if (this.entries.get(key) === current && cacheable(value)) {
        current.value = value;
        current.freshUntil = Date.now() + maxAge;
      }
      return value;
    }).finally(() => { current.pending = undefined; });
    return current.pending;
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
