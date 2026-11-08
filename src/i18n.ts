import english from "./locales/en.json" with { type: "json" };
import russian from "./locales/ru.json" with { type: "json" };
import ukrainian from "./locales/uk.json" with { type: "json" };

export { english, russian, ukrainian };

export type PluginLanguage = "en" | "ru" | "uk";
export type PluginLanguagePreference = PluginLanguage | "system";
export type Message = keyof typeof english;
const catalogs: Record<PluginLanguage, Record<Message, string>> = { en: english, ru: russian, uk: ukrainian };
export const pluginLanguages = [{ data: "system", label: "SteamOS language" }, { data: "ru", label: "Русский" }, { data: "uk", label: "Українська" }, { data: "en", label: "English" }];
export const pluginLocales: Record<PluginLanguage, string> = { en: "en-US", ru: "ru-RU", uk: "uk-UA" };
let language: PluginLanguagePreference = "system";
export function resolveSystemLanguage(value?: string): PluginLanguage {
  const normalized = (value || "").trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "russian" || /^ru(?:-|$)/.test(normalized)) return "ru";
  if (normalized === "ukrainian" || /^uk(?:-|$)/.test(normalized)) return "uk";
  return "en";
}
const browserLanguage = () => typeof navigator === "undefined" ? undefined : navigator.language;
let systemLanguage = resolveSystemLanguage(browserLanguage());
const listeners = new Set<() => void>();

export const getPluginLanguage = (): PluginLanguage => language === "system" ? systemLanguage : language;
export const getPluginLanguagePreference = () => language;
export async function initializeSystemLanguage(readSteamLanguage?: () => Promise<string>, fallback = browserLanguage()): Promise<void> {
  let detected = fallback;
  try { if (readSteamLanguage) detected = await readSteamLanguage(); } catch { /* Browser locale is the fallback when Steam's API is unavailable. */ }
  systemLanguage = resolveSystemLanguage(detected);
  for (const listener of listeners) listener();
}
export function setPluginLanguage(value: string): void {
  const next = value === "en" || value === "uk" || value === "ru" ? value : "system";
  if (next === language) return;
  language = next;
  for (const listener of listeners) listener();
}
export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function translate(locale: PluginLanguage, message: Message, values: Record<string, string | number> = {}): string {
  const text = catalogs[locale]?.[message] ?? english[message];
  return text.replace(/\{(\w+)\}/g, (placeholder, key: string) => String(values[key] ?? placeholder));
}
export function translateError(locale: PluginLanguage, error?: string): string {
  if (error && Object.prototype.hasOwnProperty.call(english, error)) return translate(locale, error as Message);
  return locale === "en" && error ? error : translate(locale, "Unexpected error");
}
