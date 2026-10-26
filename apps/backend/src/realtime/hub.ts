import type { Logger } from '../logger';

/**
 * Realtime hub (PAIR-003, DEC-006).
 *
 * The rest of the codebase publishes events through this interface only, so the transport
 * (Socket.IO in production, an in-process emitter in tests) can change without touching services.
 * Payloads carry identifiers, never document content or personal data (API.md §9).
 */

export type RealtimeEvent =
  | 'device:paired'
  | 'device:revoked'
  | 'document:queued'
  | 'job:progress'
  | 'document:extracted'
  | 'document:needs_review'
  | 'document:approved'
  | 'document:failed'
  | 'connector:run_updated'
  | 'export:ready';

export interface RealtimeHub {
  /** Publish to everyone in an organisation (desktop dashboards, review screens). */
  toOrganisation(
    organisationId: string,
    event: RealtimeEvent,
    payload: Record<string, unknown>,
  ): void;
  /** Publish to a single user (their own devices). */
  toUser(userId: string, event: RealtimeEvent, payload: Record<string, unknown>): void;
  /** Force-disconnect a revoked device. */
  disconnectDevice(deviceId: string): void;
  /** Register a device socket mapping (called by the Socket.IO adapter). */
  registerDevice(deviceId: string, disconnect: () => void): void;
}

/** Default hub: keeps an in-process subscriber list. Used by tests and single-process dev. */
export class InMemoryRealtimeHub implements RealtimeHub {
  private readonly subscribers = new Set<{
    organisationId?: string;
    userId?: string;
    handler: (event: RealtimeEvent, payload: Record<string, unknown>) => void;
  }>();
  private readonly deviceSockets = new Map<string, () => void>();

  constructor(private readonly logger?: Logger) {}

  toOrganisation(
    organisationId: string,
    event: RealtimeEvent,
    payload: Record<string, unknown>,
  ): void {
    this.publish({ organisationId }, event, payload);
  }

  toUser(userId: string, event: RealtimeEvent, payload: Record<string, unknown>): void {
    this.publish({ userId }, event, payload);
  }

  private publish(
    target: { organisationId?: string; userId?: string },
    event: RealtimeEvent,
    payload: Record<string, unknown>,
  ): void {
    for (const subscriber of this.subscribers) {
      const matches =
        (target.organisationId !== undefined &&
          subscriber.organisationId === target.organisationId) ||
        (target.userId !== undefined && subscriber.userId === target.userId);
      if (!matches) continue;
      try {
        subscriber.handler(event, payload);
      } catch (error) {
        // A broken subscriber must never break the request that published the event.
        this.logger?.warn('realtime subscriber failed', { event, error: (error as Error).message });
      }
    }
  }

  disconnectDevice(deviceId: string): void {
    const disconnect = this.deviceSockets.get(deviceId);
    if (disconnect) {
      disconnect();
      this.deviceSockets.delete(deviceId);
    }
  }

  registerDevice(deviceId: string, disconnect: () => void): void {
    this.deviceSockets.set(deviceId, disconnect);
  }

  /** Test helper: subscribe to events for an organisation. */
  subscribe(
    target: { organisationId?: string; userId?: string },
    handler: (event: RealtimeEvent, payload: Record<string, unknown>) => void,
  ): () => void {
    const entry = { ...target, handler };
    this.subscribers.add(entry);
    return () => this.subscribers.delete(entry);
  }
}
