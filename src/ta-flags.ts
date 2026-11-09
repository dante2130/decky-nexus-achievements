import flags from "./ta_flags.json" with { type: "json" };
export const taFlags = flags;
export function matchesTAFlag(metadata: { flags?: string[] } | undefined, filter: string): boolean {
  return !filter.startsWith("ta:") || !!metadata?.flags?.includes(filter.slice(3));
}

export function flagsForGame(achievements: readonly { id: string }[], metadata: Record<string, { flags?: string[] }>) {
  const present = new Set(achievements.flatMap(item => metadata[item.id]?.flags ?? []));
  return taFlags.filter(flag => present.has(flag.id));
}
