import { parsePairingQrPayload } from '@idcp/shared';

/**
 * Pairing helpers (PAIR-002).
 *
 * The QR payload is parsed with the shared validator, so a phone refuses foreign, malformed or
 * plain-HTTP codes before it sends anything over the network.
 */

export interface PairingTarget {
  endpoint: string;
  token: string;
}

export type PairingScanResult =
  | { ok: true; target: PairingTarget }
  | { ok: false; reason: 'not_our_code' | 'insecure' | 'malformed' };

export function readPairingCode(raw: string): PairingScanResult {
  if (!raw || !raw.trim().startsWith('idcp://')) {
    return { ok: false, reason: 'not_our_code' };
  }
  const parsed = parsePairingQrPayload(raw);
  if (!parsed) {
    // Distinguish an insecure endpoint so the UI can say something more useful than "invalid".
    // The endpoint is URL-encoded inside the payload, so it must be decoded before inspecting it.
    const encodedEndpoint = /[?&]e=([^&]*)/.exec(raw)?.[1];
    if (encodedEndpoint) {
      try {
        const endpoint = decodeURIComponent(encodedEndpoint);
        if (
          /^http:\/\//i.test(endpoint) &&
          !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(endpoint)
        ) {
          return { ok: false, reason: 'insecure' };
        }
      } catch {
        // Malformed percent-encoding falls through to the generic reason below.
      }
    }
    return { ok: false, reason: 'malformed' };
  }
  return { ok: true, target: parsed };
}

/** Device name shown on the desktop so a person can recognise which phone paired. */
export function describeDevice(platform: 'android' | 'ios', model?: string): string {
  const fallback = platform === 'ios' ? 'iPhone' : 'Android device';
  const name = (model ?? '').trim();
  return name.length > 0 ? name.slice(0, 80) : fallback;
}

/** Human-readable countdown for the pairing dialog. */
export function formatExpiry(secondsRemaining: number): string {
  if (secondsRemaining <= 0) return 'Expired';
  const minutes = Math.floor(secondsRemaining / 60);
  const seconds = secondsRemaining % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
