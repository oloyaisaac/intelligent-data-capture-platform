import type { Translate, TranslationKey } from '@idcp/shared';

/**
 * I18N-001 — catalogue lookups for values that arrive from the API as enums.
 *
 * Statuses and document types are data, so the catalogue cannot type them as literal keys. These
 * helpers build the key, and fall back to the raw value with underscores removed when a new enum
 * member ships before its translation does — a visible English word beats `needs_review`.
 */
function lookup(t: Translate, key: string, fallback: string): string {
  const translated = t(key as TranslationKey);
  return translated === key ? fallback.replace(/_/g, ' ') : translated;
}

export function statusLabel(t: Translate, status: string): string {
  return lookup(t, `document.status.${status}`, status);
}

export function documentTypeLabel(t: Translate, type: string): string {
  return lookup(t, `document.type.${type}`, type);
}

export function roleLabel(t: Translate, role: string): string {
  return lookup(t, `role.${role}`, role);
}

export function keyStatusLabel(t: Translate, revoked: boolean): string {
  return t(revoked ? 'status.revoked' : 'status.active');
}

/** Free-text classification values ("Invoice 2026") are shown as they are. */
export function classifyLabel(t: Translate, value: string | null | undefined): string {
  if (!value) return '—';
  return documentTypeLabel(t, value);
}
