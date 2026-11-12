export type AchievementSet = "all" | "original" | "addon" | `dlc:${string}`;

export function matchesAchievementSet(item: { baseGame?: boolean }, selection: AchievementSet, bundle?: string): boolean {
  if (selection === "original") return item.baseGame === true;
  if (selection === "addon") return item.baseGame === false && !bundle;
  return selection === "all" || (!!bundle && selection === `dlc:${bundle}`);
}
