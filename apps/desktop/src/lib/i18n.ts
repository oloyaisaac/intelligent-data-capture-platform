import { SUPPORTED_LOCALES, createTranslator, type Locale, type Translate } from '@idcp/shared';

/**
 * I18N-001 — interface language for the desktop renderer.
 *
 * The catalogues belong to `@idcp/shared`, so the phone and the desktop cannot drift apart on
 * wording. The choice is remembered locally because it is a device preference, not an account
 * setting: a shared review workstation should not flip language for everyone at the office.
 */

const STORAGE_KEY = 'idcp.locale';

export interface LocaleOption {
  locale: Locale;
  label: string;
}

/** Endonyms, because "Swahili" is not what a Swahili speaker is looking for. */
export const LOCALE_OPTIONS: LocaleOption[] = [
  { locale: 'en', label: 'English' },
  { locale: 'sw', label: 'Kiswahili' },
  { locale: 'fr', label: 'Français' },
];

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as string[]).includes(value);
}

/**
 * The stored locale, else the browser's, else English.
 *
 * A browser set to `sw-KE` should get Swahili, so only the primary subtag is matched.
 */
export function resolveLocale(stored: string | null, preferred: string | null): Locale {
  if (isLocale(stored)) return stored;
  const primary = (preferred ?? '').toLowerCase().split('-')[0];
  return isLocale(primary) ? primary : 'en';
}

export function loadLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // A locked-down profile can throw on access; the browser language still applies.
    stored = null;
  }
  return resolveLocale(stored, typeof navigator === 'undefined' ? null : navigator.language);
}

export function saveLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Not fatal: the choice simply will not survive a restart.
  }
}

export function translator(locale: Locale): Translate {
  return createTranslator(locale);
}
