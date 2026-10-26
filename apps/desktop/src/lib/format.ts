/** Presentation helpers shared by every page. Pure functions, so they are unit-tested directly. */

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function formatPercent(confidence: number | null | undefined): string {
  if (confidence === null || confidence === undefined || Number.isNaN(confidence)) return '—';
  return `${Math.round(confidence * 100)}%`;
}

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
