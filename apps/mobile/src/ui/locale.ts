import {
  SUPPORTED_LOCALES,
  createTranslator,
  directionFor,
  type Direction,
  type Locale,
  type Translate,
} from '@idcp/shared';

/**
 * I18N-001 — the phone follows the device's language.
 *
 * A capture operator should not have to find a setting on a phone that is already set to their
 * language, so the phone reads the device locale and falls back to English. The choice is a device
 * preference, exactly as on the desktop, and the desktop's explicit switcher covers the case where
 * two people share one workstation.
 */
export function resolveDeviceLocale(preferred: string | null | undefined): Locale {
  const primary = (preferred ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
  return (SUPPORTED_LOCALES as string[]).includes(primary) ? (primary as Locale) : 'en';
}

/** The device locale as the platform reports it, if anything does. */
export function deviceLocale(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale ?? null;
  } catch {
    return null;
  }
}

export function mobileTranslator(locale: Locale): Translate {
  return createTranslator(locale);
}

/**
 * The text direction the UI should mirror for.
 *
 * React Native flips its own layout from `I18nManager` (set before the bundle loads), but the
 * screens still mirror the few things flexbox does not: chevron glyphs and the confidence columns.
 * Deriving the direction from the same helper the desktop uses keeps both surfaces in step, and this
 * module stays free of native imports so the phone's logic can be tested in Node.
 */
export function deviceDirection(locale: string | null | undefined = deviceLocale()): Direction {
  return directionFor(locale);
}

export function deviceIsRtl(locale: string | null | undefined = deviceLocale()): boolean {
  return deviceDirection(locale) === 'rtl';
}
