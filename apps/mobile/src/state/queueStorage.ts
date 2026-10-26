import type { TokenStore } from '../api/client';
import type { QueueItem, QueueStorage, UploadQueue } from './uploadQueue';
import { UploadQueue as UploadQueueImpl } from './uploadQueue';

/**
 * Persistence for the offline upload queue.
 *
 * The queue itself is small (capture metadata only), so it is serialised as JSON in the same
 * keychain-backed store as the credentials. Capture files stay in the app's document directory,
 * which the OS protects; `uri` is all we need to find them again after a restart.
 */

const QUEUE_KEY = 'upload_queue';

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export class PersistedQueueStorage implements QueueStorage {
  constructor(private readonly store: KeyValueStore) {}

  async load(): Promise<QueueItem[]> {
    const raw = await this.store.getItem(QUEUE_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isQueueItem);
    } catch {
      // A corrupt payload must not brick the app: start clean.
      return [];
    }
  }

  async save(items: QueueItem[]): Promise<void> {
    await this.store.setItem(QUEUE_KEY, JSON.stringify(items));
  }
}

function isQueueItem(value: unknown): value is QueueItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    typeof item.uri === 'string' &&
    typeof item.fileName === 'string' &&
    typeof item.mimeType === 'string' &&
    typeof item.attempts === 'number' &&
    typeof item.createdAt === 'number' &&
    typeof item.nextAttemptAt === 'number' &&
    ['pending', 'uploading', 'uploaded', 'failed', 'needs_attention'].includes(String(item.status))
  );
}

export interface UploadTransportPort {
  upload(input: {
    uri: string;
    fileName: string;
    mimeType: string;
    idempotencyKey: string;
  }): Promise<{ id: string; jobId: string; status: string; duplicate: boolean }>;
  isOnline(): boolean;
}

/** Minimal slice of the API client the queue needs, so tests can supply a stub. */
export interface UploadApi {
  uploadDocument(input: {
    uri: string;
    fileName: string;
    mimeType: string;
    idempotencyKey: string;
  }): Promise<{ id: string; jobId: string; status: string; duplicate: boolean }>;
}

/**
 * Reachability is optimistic: in React Native there is no reliable `navigator.onLine`, and a
 * fetch failure is treated as a per-item failure with backoff rather than a silent stall.
 */
class ClientTransport implements UploadTransportPort {
  constructor(private readonly client: UploadApi) {}

  upload(input: {
    uri: string;
    fileName: string;
    mimeType: string;
    idempotencyKey: string;
  }): Promise<{ id: string; jobId: string; status: string; duplicate: boolean }> {
    return this.client.uploadDocument(input);
  }

  isOnline(): boolean {
    return true;
  }
}

export function createPersistentQueue(
  store: KeyValueStore & TokenStore,
  client: UploadApi,
): UploadQueue {
  return new UploadQueueImpl(new PersistedQueueStorage(store), new ClientTransport(client));
}
