import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionCache } from "../src/cache.ts";

test("fresh lists are reused and overlapping reads share one request", async () => {
  const cache = new SessionCache();
  const pending = Promise.withResolvers();
  let reads = 0;
  const read = () => { reads++; return pending.promise; };
  const first = cache.load("game", read);
  assert.equal(cache.load("game", read), first);
  pending.resolve(["achievement"]);
  await first;
  assert.deepEqual(await cache.load("game", read), ["achievement"]);
  assert.equal(reads, 1);
});

test("expired lists remain available while a background refresh runs", async t => {
  let now = 100;
  t.mock.method(Date, "now", () => now);
  const cache = new SessionCache();
  await cache.load("game", async () => "old", 10);
  now = 111;
  const pending = Promise.withResolvers();
  const refresh = cache.load("game", () => pending.promise);
  assert.equal(cache.peek("game"), "old");
  pending.resolve("new");
  await refresh;
  assert.equal(cache.peek("game"), "new");
});

test("failed refreshes preserve cached data and can be retried", async () => {
  const cache = new SessionCache();
  await cache.load("game", async () => "saved", 0);
  await assert.rejects(cache.load("game", async () => { throw Error("offline"); }));
  assert.equal(cache.peek("game"), "saved");
  assert.equal(await cache.load("game", async () => "updated"), "updated");
});

test("a request invalidated by a language change cannot overwrite newer data", async () => {
  const cache = new SessionCache();
  const pending = Promise.withResolvers();
  const old = cache.load("game", () => pending.promise);
  cache.clear();
  await cache.load("game", async () => "German");
  pending.resolve("English");
  await old;
  assert.equal(cache.peek("game"), "German");
});

test("snapshot versions have separate entries and unlock invalidation forces a read", async () => {
  const cache = new SessionCache();
  await cache.load("game:1", async () => "locked");
  assert.equal(cache.peek("game:2"), undefined);
  await cache.load("game:2", async () => "unlocked");
  cache.invalidate("game:2");
  assert.equal(await cache.load("game:2", async () => "refreshed"), "refreshed");
});

test("translation fallback responses are not cached and the cache stays bounded", async () => {
  const cache = new SessionCache();
  await cache.load("fallback", async () => ({ languageError: "offline" }), 60_000, value => !value.languageError);
  assert.equal(cache.peek("fallback"), undefined);
  for (let i = 0; i < 33; i++) await cache.load(String(i), async () => i);
  assert.equal(cache.peek("0"), undefined);
  assert.equal(cache.peek("32"), 32);
});
