/**
 * Money handling.
 *
 * Rule: currency amounts are stored as **numbers in major units** (e.g. 1250000.5) together
 * with an ISO-4217 currency code, and are never used for arithmetic that requires exactness
 * beyond 2 decimal places. For reporting totals we round to the currency's minor-unit scale.
 * Never use floats for accounting *ledgers* — this platform only transports extracted values.
 */

/** Currencies with zero decimal places in everyday use. */
const ZERO_DECIMAL_CURRENCIES = new Set(['UGX', 'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XOF', 'XAF']);

const SYMBOLS: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '₦': 'NGN',
  '₵': 'GHS',
  '₹': 'INR',
  '¥': 'JPY',
};

export interface ParsedMoney {
  amount: number;
  currency: string;
}

export function currencyScale(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}

export function roundMoney(amount: number, currency: string): number {
  const factor = 10 ** currencyScale(currency);
  return Math.round((amount + Number.EPSILON) * factor) / factor;
}

/**
 * Parse a currency string as printed on documents: `UGX 1,250,000`, `$1,234.56`,
 * `EUR 99,99` (comma decimal separator), `1.234,56 €`, or a bare number with a known currency.
 *
 * Returns null when the value cannot be parsed with confidence — callers must then lower the
 * field's confidence and let a human decide.
 */
export function parseMoney(
  raw: string,
  options: { defaultCurrency?: string; locale?: string } = {},
): ParsedMoney | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;

  // Currency: explicit code, or a known symbol.
  const codeMatch = text.match(/\b([A-Z]{3})\b/);
  let currency = codeMatch?.[1] ?? options.defaultCurrency ?? null;
  for (const [symbol, code] of Object.entries(SYMBOLS)) {
    if (text.includes(symbol) && !currency) currency = code;
  }
  if (!currency) return null;

  // Strip everything that is not a digit, separator, minus or plus.
  const numeric = text
    .replace(/\b[A-Z]{3}\b/g, ' ')
    .replace(/[^\d.,\-+]/g, '')
    .trim();
  if (!numeric || !/\d/.test(numeric)) return null;

  const hasDot = numeric.includes('.');
  const hasComma = numeric.includes(',');
  let normalised = numeric;

  if (hasDot && hasComma) {
    // Whichever separator appears last is the decimal separator.
    const decimalSep = numeric.lastIndexOf(',') > numeric.lastIndexOf('.') ? ',' : '.';
    const groupSep = decimalSep === ',' ? '.' : ',';
    normalised = numeric.split(groupSep).join('').replace(decimalSep, '.');
  } else if (hasComma) {
    const parts = numeric.split(',');
    const lastPart = parts[parts.length - 1] ?? '';
    // `1,250` / `1,250,000` are thousands groups; `99,99` is a decimal comma.
    normalised = lastPart.length === 3 ? parts.join('') : parts.join('.');
  } else if (hasDot) {
    const parts = numeric.split('.');
    const lastPart = parts[parts.length - 1] ?? '';
    // `1.250.000` is European grouping; `1.25` is a decimal.
    normalised = parts.length > 2 && lastPart.length === 3 ? parts.join('') : numeric;
  }

  const amount = Number(normalised);
  if (!Number.isFinite(amount)) return null;
  return { amount: roundMoney(amount, currency), currency };
}

/** Format for display: `UGX 1,250,000` / `$1,234.56`. Presentation only. */
export function formatMoney(amount: number, currency: string, locale = 'en-US'): string {
  const scale = currencyScale(currency);
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  }).format(amount);
  return `${currency} ${formatted}`;
}
