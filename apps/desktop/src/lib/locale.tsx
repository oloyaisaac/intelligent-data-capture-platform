import React, { createContext, useContext, useMemo } from 'react';
import {
  createTranslator,
  directionFor,
  type Direction,
  type Locale,
  type Translate,
} from '@idcp/shared';

/**
 * I18N-001 — the locale, the translator and the text direction, available to every component.
 *
 * The default is English, so a component rendered on its own (a test, a story) still works and does
 * not need a provider. The provider is what makes the choice switchable at runtime: changing the
 * locale re-renders every consumer with fresh strings, and the same render sets `dir` on the root
 * element so one layout serves both directions.
 */

export interface LocaleContextValue {
  locale: Locale;
  t: Translate;
  direction: Direction;
}

const fallback: LocaleContextValue = {
  locale: 'en',
  t: createTranslator('en'),
  direction: 'ltr',
};

const LocaleContext = createContext<LocaleContextValue>(fallback);

export function LocaleProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}): React.JSX.Element {
  const value = useMemo<LocaleContextValue>(
    () => ({ locale, t: createTranslator(locale), direction: directionFor(locale) }),
    [locale],
  );
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}

/** Shorthand for the common case. */
export function useTranslator(): Translate {
  return useContext(LocaleContext).t;
}

/**
 * Applies the direction and language to the document root.
 *
 * A deskless reviewer on a shared workstation should not have to reload after a language change, so
 * this runs on every locale change. `dir` also flips the direction of form controls the browser
 * draws itself (scrollbars, carets, date pickers).
 */
export function applyDocumentLocale(
  locale: Locale,
  direction: Direction = directionFor(locale),
): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.lang = locale;
  root.dir = direction;
}

/** Logical alignment for a table cell or flex child: never `left`/`right`. */
export function alignEnd(): { textAlign: 'end' } {
  return { textAlign: 'end' };
}
