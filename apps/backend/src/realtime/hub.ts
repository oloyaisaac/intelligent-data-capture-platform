import type { Logger } from '../logger';

/**
 * Realtime hub (PAIR-003, DEC-006).
 *
 * Services publish through this interface. The current runtime uses InMemoryRealtimeHub and the
 * SSE route; there is no production Socket.IO adapter. Subscription is an optional capability of
 * the port, independent of the current in-memory implementation. Payloads carry identifiers,
 * not document content (API.md §9).
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
  | 'export:ready'
  | 'batch:created'
  | 'batch:updated';

export type RealtimeSubscriber = (event: RealtimeEvent, payload: Record<string, unknown>) => void;

export interface RealtimeHub {
  /** Optional subscription capability used by the SSE adapter. */
  subscribe?(
    target: { organisationId?: string; userId?: string },
    handler: RealtimeSubscriber,
  ): () => void;
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
      } catch {
        // A broken subscriber must never break the publisher or leak its exception to logs.
        this.logger?.warn('realtime subscriber failed', { event });
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

  /** Subscribe to events for an organisation or user. */
  subscribe(
    target: { organisationId?: string; userId?: string },
    handler: (event: RealtimeEvent, payload: Record<string, unknown>) => void,
  ): () => void {
    const entry = { ...target, handler };
    this.subscribers.add(entry);
    return () => this.subscribers.delete(entry);
  }
}
