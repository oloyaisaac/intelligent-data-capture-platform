/**
 * Date parsing for values printed on documents.
 *
 * Documents use wildly different formats. We only accept unambiguous, well-understood forms and
 * return an ISO date (YYYY-MM-DD). When a value is ambiguous (`03/04/2026`) we pick the
 * documented default (day-first, as used in most of the target markets) but flag it so a human
 * confirms — ambiguity is never resolved silently.
 */

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

export interface ParsedDate {
  /** ISO date, YYYY-MM-DD. */
  iso: string;
  /** True when the input could be read two ways and needs human confirmation. */
  ambiguous: boolean;
}

function toIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null; // e.g. 31 February
  }
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
    .toString()
    .padStart(2, '0')}`;
}

/** Expand a 2-digit year: 00–49 → 2000s, 50–99 → 1900s. */
function expandYear(raw: number): number {
  if (raw > 99) return raw;
  return raw < 50 ? 2000 + raw : 1900 + raw;
}

export function parseDocumentDate(raw: string): ParsedDate | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
  if (!text) return null;

  // 2026-10-26 (ISO)
  const iso = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const value = toIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return value ? { iso: value, ambiguous: false } : null;
  }

  // 26 Oct 2026 / 26 October, 2026
  const dmyText = text.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{2,4})\b/);
  if (dmyText) {
    const month = MONTHS[dmyText[2]!.toLowerCase()];
    const value = month ? toIso(expandYear(Number(dmyText[3])), month, Number(dmyText[1])) : null;
    return value ? { iso: value, ambiguous: false } : null;
  }

  // Oct 26, 2026
  const mdyText = text.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2,4})\b/);
  if (mdyText) {
    const month = MONTHS[mdyText[1]!.toLowerCase()];
    const value = month ? toIso(expandYear(Number(mdyText[3])), month, Number(mdyText[2])) : null;
    return value ? { iso: value, ambiguous: false } : null;
  }

  // Numeric: 26/10/2026, 26.10.2026, 26-10-2026, 10/26/2026
  const numeric = text.match(/\b(\d{1,4})[/.-](\d{1,2})[/.-](\d{2,4})\b/);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const third = Number(numeric[3]);

    // Year-first: 2026/10/26
    if (numeric[1]!.length === 4) {
      const value = toIso(first, second, expandYear(third));
      return value ? { iso: value, ambiguous: false } : null;
    }

    const year = expandYear(third);
    const dayFirst = toIso(year, second, first);
    const monthFirst = toIso(year, first, second);

    if (dayFirst && monthFirst && dayFirst !== monthFirst) {
      // Ambiguous: default to day-first, but ask a human.
      return { iso: dayFirst, ambiguous: true };
    }
    if (dayFirst) return { iso: dayFirst, ambiguous: false };
    if (monthFirst) return { iso: monthFirst, ambiguous: false };
    return null;
  }

  return null;
}

/** Today's date in UTC as YYYY-MM-DD. Injecting the clock keeps tests deterministic. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && parseDocumentDate(value)?.iso === value;
}
