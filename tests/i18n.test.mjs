import assert from "node:assert/strict";
import { test } from "node:test";
import { english, russian, ukrainian, translate, translateError, getPluginLanguage, getPluginLanguagePreference, initializeSystemLanguage, resolveSystemLanguage, setPluginLanguage, subscribeLanguage, pluginLanguages, pluginLocales } from "../src/i18n.ts";

test("each language catalog covers the English messages and preserves placeholders", () => {
  const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const catalog of [english, russian, ukrainian]) {
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(english).sort());
    for (const [english, translated] of Object.entries(catalog)) {
      assert.ok(translated.trim(), english);
      assert.deepEqual(placeholders(translated), placeholders(english), english);
    }
  }
});

test("notifications and counts interpolate values without altering achievement text", () => {
  assert.equal(translate("ru", "Achievement unlocked: {name}", { name: "First Steps" }), "Получено достижение: First Steps");
  assert.equal(translate("ru", "{unlocked}/{total} unlocked", { unlocked: 3, total: 29 }), "Получено: 3/29");
  assert.equal(translate("en", "{unlocked}/{total} unlocked", { unlocked: 3, total: 29 }), "3/29 unlocked");
  assert.equal(translate("uk", "Achievement unlocked: {name}", { name: "First Steps" }), "Здобуто досягнення: First Steps");
  assert.equal(translate("uk", "{unlocked}/{total} unlocked", { unlocked: 3, total: 29 }), "Здобуто: 3/29");
  assert.equal(pluginLocales.uk, "uk-UA");
});

test("language subscribers update immediately and can unsubscribe", async () => {
  await initializeSystemLanguage(async () => "english");
  setPluginLanguage("ru");
  const updates = [];
  const unsubscribe = subscribeLanguage(() => updates.push(getPluginLanguage()));
  setPluginLanguage("en");
  setPluginLanguage("en");
  setPluginLanguage("uk");
  setPluginLanguage("ru");
  unsubscribe();
  setPluginLanguage("en");
  assert.deepEqual(updates, ["en", "uk", "ru"]);
  setPluginLanguage("invalid");
  assert.equal(getPluginLanguage(), "en");
  assert.equal(getPluginLanguagePreference(), "system");
  assert.deepEqual(pluginLanguages.map(option => option.data).sort(), ["en", "ru", "system", "uk"]);
});

test("Steam language names and browser locale tags resolve with English fallback", () => {
  for (const value of ["russian", "ru-RU", "ru", "RU_ru"]) assert.equal(resolveSystemLanguage(value), "ru");
  for (const value of ["ukrainian", "uk-UA", "uk", "UK_ua"]) assert.equal(resolveSystemLanguage(value), "uk");
  for (const value of ["english", "en-GB", "german", "de-DE", "", undefined]) assert.equal(resolveSystemLanguage(value), "en");
});

test("system mode follows Steam and manual choices override it", async () => {
  setPluginLanguage("system");
  await initializeSystemLanguage(async () => "ukrainian", "ru-RU");
  assert.equal(getPluginLanguage(), "uk");
  assert.equal(getPluginLanguagePreference(), "system");
  setPluginLanguage("ru");
  await initializeSystemLanguage(async () => "german", "uk-UA");
  assert.equal(getPluginLanguage(), "ru");
  setPluginLanguage("system");
  assert.equal(getPluginLanguage(), "en");
  await initializeSystemLanguage(async () => { throw Error("Steam unavailable"); }, "uk-UA");
  assert.equal(getPluginLanguage(), "uk");
  await initializeSystemLanguage(undefined, "fr-FR");
  assert.equal(getPluginLanguage(), "en");
});

test("backend errors are localized, with a safe Russian fallback", () => {
  assert.equal(translateError("ru", "Failed to refresh games"), "Не удалось обновить список игр");
  assert.equal(translateError("ru", "Unknown backend detail"), "Неизвестная ошибка");
  assert.equal(translateError("en", "Unknown backend detail"), "Unknown backend detail");
  assert.equal(translateError("uk", "Failed to refresh games"), "Не вдалося оновити список ігор");
  assert.equal(translateError("uk", "Unknown backend detail"), "Невідома помилка");
});
