import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesAchievementSet } from "../src/achievement-filters.ts";

test("Original and Add-on use known membership, independently of unlock state", () => {
  const rows = [
    { id: "base-locked", baseGame: true, unlocked: false },
    { id: "addon-unlocked", baseGame: false, unlocked: true },
    { id: "unknown", unlocked: false },
    { id: "base-unlocked", baseGame: true, unlocked: true },
  ];
  const selected = set => rows.filter(row => matchesAchievementSet(row, set)).map(row => row.id);
  assert.deepEqual(selected("all"), rows.map(row => row.id));
  assert.deepEqual(selected("original"), ["base-locked", "base-unlocked"]);
  assert.deepEqual(selected("addon"), ["addon-unlocked"]);
});

test("named DLC uses TA membership and leaves unnamed Xbox add-ons under Add-on", () => {
  assert.equal(matchesAchievementSet({}, "dlc:Pack A", "Pack A"), true);
  assert.equal(matchesAchievementSet({ baseGame: false }, "dlc:Pack A", "Pack B"), false);
  assert.equal(matchesAchievementSet({ baseGame: false }, "addon", "Pack A"), false);
  assert.equal(matchesAchievementSet({ baseGame: false }, "addon"), true);
  assert.equal(matchesAchievementSet({ baseGame: true }, "original", "Pack A"), true);
});
