export type AchievementSort = "name" | "gamerscore" | "date" | "rarity";
export type SortDirection = "asc" | "desc";
interface SortableAchievement {
  id: string; name: string; gamerscore: number; unlockedAt: number | null;
  rarity?: { percentage: number };
}
export function compareAchievements(a: SortableAchievement, b: SortableAchievement,
  sort: AchievementSort, direction: SortDirection): number {
  const sign = direction === "asc" ? 1 : -1;
  const tie = () => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  if (sort === "name") return sign * a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const value = (item: SortableAchievement): number | null => {
    if (sort === "gamerscore") return item.gamerscore;
    if (sort === "date") return item.unlockedAt;
    const percentage = item.rarity?.percentage;
    return typeof percentage === "number" && Number.isFinite(percentage) && percentage >= 0 && percentage <= 100 ? percentage : null;
  };
  const x = value(a), y = value(b);
  // Missing rarity and unlock dates always remain at the end.
  if (x === null) return y === null ? tie() : 1;
  if (y === null) return -1;
  return sign * (x - y) || tie();
}
