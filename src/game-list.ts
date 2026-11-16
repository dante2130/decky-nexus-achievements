interface GameSummary {
  titleId: string;
  installed?: boolean;
  updatedAt: number;
}

function gameListKey(titleId: string): string {
  // Unifideck prefixes the same decimal Xbox title ID used by Nexus.
  return titleId.replace(/^unifideck\.(?=[1-9][0-9]*$)/, "");
}

export function uniqueGames<T extends GameSummary>(titles: readonly T[], runningTitleId?: string): T[] {
  const runningKey = runningTitleId && gameListKey(runningTitleId);
  const games = new Map<string, T>();
  for (const title of titles) {
    const key = gameListKey(title.titleId);
    if (key === runningKey) continue;
    const previous = games.get(key);
    if (!previous || (title.installed && !previous.installed)
      || (Boolean(title.installed) === Boolean(previous.installed) && title.updatedAt > previous.updatedAt)) {
      games.set(key, title);
    }
  }
  return [...games.values()];
}
