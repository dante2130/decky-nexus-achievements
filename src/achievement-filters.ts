export type AchievementSet = "all" | "original" | "addon";

export function matchesAchievementSet(item: { baseGame?: boolean }, selection: AchievementSet): boolean {
  if (selection === "original") return item.baseGame === true;
  if (selection === "addon") return item.baseGame === false;
  return true;
}
