import { createContext, type ReactNode, useContext, useMemo } from "react";
import {
  createTranslator,
  DEFAULT_LOCALE,
  resolveSupportedLocale,
  type SupportedLocale,
  type Translator,
} from "./index";

export interface I18nContextValue {
  locale: SupportedLocale;
  t: Translator;
}

const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  t: createTranslator(DEFAULT_LOCALE),
});

export interface I18nProviderProps {
  locale?: string | null;
  children: ReactNode;
}

export function I18nProvider({ locale, children }: I18nProviderProps) {
  const resolvedLocale = useMemo(
    () => resolveSupportedLocale(locale),
    [locale],
  );

  const translator = useMemo(
    () => createTranslator(resolvedLocale),
    [resolvedLocale],
  );

  const contextValue = useMemo<I18nContextValue>(
    () => ({
      locale: resolvedLocale,
      t: translator,
    }),
    [resolvedLocale, translator],
  );

  return (
    <I18nContext.Provider value={contextValue}>{children}</I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export function useTranslation() {
  const { t, locale } = useI18n();
  return {
    t,
    locale,
  };
}
