import { en } from "./resources/en";
import { zhCN } from "./resources/zh-CN";
import {
  DEFAULT_LOCALE,
  type InterpolationValues,
  type SupportedLocale,
  type TranslationDictionary,
} from "./types";

export * from "./types";

export type Translator = (
  key: string,
  values?: InterpolationValues,
  fallbackText?: string,
) => string;

const RESOURCES: Record<SupportedLocale, TranslationDictionary> = {
  en,
  "zh-CN": zhCN,
};

/**
 * Resolves system locale safely across Node / React Native / Electron / Web
 * without DOM APIs or localStorage.
 */
export function detectSystemLocales(): string[] {
  const detected: string[] = [];

  // Intl API (available in modern JS, Node, RN hermes)
  try {
    if (
      typeof Intl !== "undefined" &&
      typeof Intl.DateTimeFormat === "function"
    ) {
      const resolved = Intl.DateTimeFormat().resolvedOptions().locale;
      if (resolved) detected.push(resolved);
    }
  } catch {
    // Ignore error
  }

  // Environment variables (Node/desktop host environments)
  try {
    if (typeof process !== "undefined" && process.env) {
      const envLocale =
        process.env.LC_ALL ||
        process.env.LC_MESSAGES ||
        process.env.LANG ||
        process.env.LANGUAGE;
      if (envLocale) {
        const cleaned = envLocale.split(".")[0]?.replace(/_/g, "-");
        if (cleaned) detected.push(cleaned);
      }
    }
  } catch {
    // Ignore error
  }

  return detected;
}

export function resolveSupportedLocale(
  preference: string | null | undefined,
  systemLocales: readonly string[] = detectSystemLocales(),
): SupportedLocale {
  if (preference) {
    const normalizedPref = preference.toLowerCase();
    if (
      normalizedPref === "zh" ||
      normalizedPref.startsWith("zh-") ||
      normalizedPref.startsWith("zh_")
    ) {
      return "zh-CN";
    }
    if (
      normalizedPref === "en" ||
      normalizedPref.startsWith("en-") ||
      normalizedPref.startsWith("en_")
    ) {
      return "en";
    }
  }

  for (const locale of systemLocales) {
    const normalized = locale.toLowerCase();
    if (
      normalized === "zh" ||
      normalized.startsWith("zh-") ||
      normalized.startsWith("zh_")
    ) {
      return "zh-CN";
    }
    if (
      normalized === "en" ||
      normalized.startsWith("en-") ||
      normalized.startsWith("en_")
    ) {
      return "en";
    }
  }

  return DEFAULT_LOCALE;
}

function getNestedValue(obj: unknown, path: string): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === "object" && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === "string" ? current : undefined;
}

export function interpolate(
  template: string,
  values?: InterpolationValues,
): string {
  if (!values) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
    const value = values[key];
    return value !== undefined && value !== null ? String(value) : match;
  });
}

export function createTranslator(locale: SupportedLocale): Translator {
  const dictionary = RESOURCES[locale] ?? RESOURCES[DEFAULT_LOCALE];
  const fallbackDict = RESOURCES[DEFAULT_LOCALE];

  return (
    key: string,
    values?: InterpolationValues,
    fallbackText?: string,
  ): string => {
    const template =
      getNestedValue(dictionary, key) ??
      getNestedValue(fallbackDict, key) ??
      fallbackText ??
      key;
    return interpolate(template, values);
  };
}

let activeLocale: SupportedLocale = DEFAULT_LOCALE;

export function setGlobalLocale(locale: SupportedLocale): void {
  activeLocale = locale;
}

export function getGlobalLocale(): SupportedLocale {
  return activeLocale;
}

export function t(
  key: string,
  values?: InterpolationValues,
  fallback?: string,
): string {
  return createTranslator(activeLocale)(key, values, fallback);
}
