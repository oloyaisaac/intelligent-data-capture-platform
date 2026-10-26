/** Presentation helpers shared by every page. Pure functions, so they are unit-tested directly. */
import { createTranslator, type Locale } from '@idcp/shared';

/**
 * I18N-001 — dates and numbers are formatted for the reader's language, not the server's.
 *
 * `en` maps to `en-GB` so the existing output (and every caller that does not pass a locale) is
 * unchanged: "26 Oct 2026, 14:05". A locale that `Intl` does not know falls back to the default
 * rather than throwing, because a wrong date format is better than a blank screen.
 */
const DATE_LOCALES: Record<Locale, string> = { en: 'en-GB', sw: 'sw-KE', fr: 'fr-FR' };

export function dateLocale(locale: Locale = 'en'): string {
  return DATE_LOCALES[locale] ?? DATE_LOCALES.en;
}

export function formatDateTime(iso: string | null | undefined, locale: Locale = 'en'): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(dateLocale(locale), {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function formatDate(iso: string | null | undefined, locale: Locale = 'en'): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(dateLocale(locale), {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/** Whole numbers with the reader's grouping and digits, e.g. 1 234 / 1,234 / 1 234. */
export function formatNumber(value: number | null | undefined, locale: Locale = 'en'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat(dateLocale(locale)).format(value);
}

export function formatBytes(bytes: number, locale: Locale = 'en'): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const format = (value: number, digits: number) =>
    new Intl.NumberFormat(dateLocale(locale), {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  if (bytes < 1024) return `${format(bytes, 0)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${format(value, value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** A 0–1 confidence as a percentage in the reader's number format ("85%" / "85 %"). */
export function formatPercent(
  confidence: number | null | undefined,
  locale: Locale = 'en',
): string {
  if (confidence === null || confidence === undefined || Number.isNaN(confidence)) return '—';
  return new Intl.NumberFormat(dateLocale(locale), {
    style: 'percent',
    maximumFractionDigits: 0,
  }).format(confidence);
}

/**
 * Relative time ("3 minutes ago"), used where an exact timestamp is noise.
 *
 * `Intl.RelativeTimeFormat` is used rather than a hand-rolled table, so the plural rules belong to
 * the language rather than to this file.
 */
export function formatRelative(
  iso: string | null | undefined,
  locale: Locale = 'en',
  now = Date.now(),
): string {
  if (!iso) return '—';
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return '—';
  const seconds = Math.round((at - now) / 1000);
  const formatter = new Intl.RelativeTimeFormat(dateLocale(locale), { numeric: 'auto' });
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.348],
    ['month', 12],
  ];
  let value = seconds;
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) return formatter.format(Math.round(value), unit);
    value /= size;
  }
  return formatter.format(Math.round(value), 'year');
}

/** Exported so a caller can check a phrase without importing the catalogue twice. */
export const translateFor = (locale: Locale = 'en') => createTranslator(locale);

/** Confidence band used for colour *and* for the text label, so colour is never the only cue. */
export function confidenceTone(confidence: number | null | undefined): 'ok' | 'medium' | 'low' {
  if (confidence === null || confidence === undefined) return 'low';
  if (confidence >= 0.85) return 'ok';
  if (confidence >= 0.6) return 'medium';
  return 'low';
}

export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
}

export function humanisePath(path: string): string {
  const last = path.split('.').pop() ?? path;
  return titleCase(last.replace(/([a-z0-9])([A-Z])/g, '$1 $2'));
}

/** Maps a document status to a badge tone (kept next to the label for consistency). */
export function statusTone(status: string): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'approved':
      return 'success';
    case 'needs_review':
      return 'warning';
    case 'failed':
    case 'rejected':
      return 'danger';
    case 'processing':
    case 'queued':
    case 'uploaded':
      return 'info';
    case 'extracted':
      return 'info';
    default:
      return 'neutral';
  }
}

export function isoDayStart(value: string): string | undefined {
  if (!value) return undefined;
  return new Date(`${value}T00:00:00.000Z`).toISOString();
}

export function isoDayEnd(value: string): string | undefined {
  if (!value) return undefined;
  return new Date(`${value}T23:59:59.999Z`).toISOString();
}
