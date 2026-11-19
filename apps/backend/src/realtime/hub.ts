import type { Logger } from '../logger';

/**
 * Realtime hub (PAIR-003, DEC-006).
 *
 * Services publish through this interface. The current runtime uses InMemoryRealtimeHub and the
 * SSE route; there is no production Socket.IO adapter. The route depends on the concrete hub's
 * subscribe method, so a different transport would require route changes. Payloads carry identifiers,
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
