/**
 * Offline-first upload queue (MOB-003).
 *
 * Captures land here first and are uploaded when the network allows. The queue is pure logic
 * behind a small storage port, so it is fully testable without a device. Guarantees:
 *   - an item survives app restarts (persisted after every state change)
 *   - the same local capture is never uploaded twice (idempotency key is generated once, at capture)
 *   - failures retry with exponential backoff, and stop after a limit rather than looping forever
 */

export type QueueItemStatus = 'pending' | 'uploading' | 'uploaded' | 'failed' | 'needs_attention';

export interface QueueItem {
  /** Local id, generated at capture time. Also used as the upload idempotency key. */
  id: string;
  uri: string;
  fileName: string;
  mimeType: string;
  status: QueueItemStatus;
  attempts: number;
  lastError?: string;
  documentId?: string;
  /** Epoch ms; the item is not eligible for upload before this time. */
  nextAttemptAt: number;
  createdAt: number;
}

export interface QueueStorage {
  load(): Promise<QueueItem[]>;
  save(items: QueueItem[]): Promise<void>;
}

export interface UploadTransport {
  upload(input: {
    uri: string;
    fileName: string;
    mimeType: string;
    idempotencyKey: string;
  }): Promise<{ id: string; jobId: string; status: string; duplicate: boolean }>;
  isOnline(): boolean;
}

export interface QueueOptions {
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Injected clocks keep the tests deterministic. */
  now?: () => number;
  onItemUploaded?: (item: QueueItem, result: { id: string }) => void;
  onItemFailed?: (item: QueueItem, error: Error) => void;
}

const DEFAULT_OPTIONS: Required<
  Pick<QueueOptions, 'maxAttempts' | 'baseBackoffMs' | 'maxBackoffMs'>
> = {
  maxAttempts: 6,
  baseBackoffMs: 2_000,
  maxBackoffMs: 5 * 60_000,
};

export class UploadQueue {
  private items: QueueItem[] = [];
  private loaded = false;
  private draining = false;
  private readonly options: QueueOptions;

  constructor(
    private readonly storage: QueueStorage,
    private readonly transport: UploadTransport,
    options: QueueOptions = {},
  ) {
    this.options = options;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  async load(): Promise<QueueItem[]> {
    this.items = await this.storage.load();
    this.loaded = true;
    return this.snapshot();
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async persist(): Promise<void> {
    await this.storage.save(this.items);
  }

  snapshot(): QueueItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  /** Number of captures still to deliver (anything not uploaded). */
  pendingCount(): number {
    return this.items.filter((item) => item.status !== 'uploaded').length;
  }

  async enqueue(input: {
    id: string;
    uri: string;
    fileName: string;
    mimeType: string;
  }): Promise<QueueItem> {
    await this.ensureLoaded();

    const existing = this.items.find((item) => item.id === input.id);
    if (existing) return { ...existing };

    const item: QueueItem = {
      id: input.id,
      uri: input.uri,
      fileName: input.fileName,
      mimeType: input.mimeType,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.now(),
    };
    this.items.push(item);
    await this.persist();
    return { ...item };
  }

  async remove(id: string): Promise<void> {
    await this.ensureLoaded();
    this.items = this.items.filter((item) => item.id !== id);
    await this.persist();
  }

  /** Retry a capture that gave up, resetting its attempt counter (user-initiated). */
  async retry(id: string): Promise<void> {
    await this.ensureLoaded();
    this.items = this.items.map((item) =>
      item.id === id
        ? { ...item, status: 'pending', attempts: 0, nextAttemptAt: 0, lastError: undefined }
        : item,
    );
    await this.persist();
  }

  /**
   * Uploads every eligible item, sequentially. Safe to call repeatedly (e.g. on reconnect or
   * on app foreground). Returns the items processed in this pass.
   */
  async drain(): Promise<QueueItem[]> {
    await this.ensureLoaded();
    if (this.draining) return [];
    if (!this.transport.isOnline()) return [];

    this.draining = true;
    const processed: QueueItem[] = [];

    try {
      for (const item of [...this.items]) {
        const current = this.items.find((entry) => entry.id === item.id);
        if (!current) continue;
        if (current.status === 'uploaded') continue;
        if (current.status === 'needs_attention') continue;
        if (current.nextAttemptAt > this.now()) continue;
        if (!this.transport.isOnline()) break;

        const uploading: QueueItem = {
          ...current,
          status: 'uploading',
          attempts: current.attempts + 1,
        };
        this.update(uploading);
        await this.persist();

        try {
          const result = await this.transport.upload({
            uri: uploading.uri,
            fileName: uploading.fileName,
            mimeType: uploading.mimeType,
            idempotencyKey: uploading.id,
          });
          const done: QueueItem = {
            ...uploading,
            status: 'uploaded',
            documentId: result.id,
            lastError: undefined,
          };
          this.update(done);
          processed.push({ ...done });
          this.options.onItemUploaded?.(done, { id: result.id });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Upload failed.';
          const exhausted =
            uploading.attempts >= (this.options.maxAttempts ?? DEFAULT_OPTIONS.maxAttempts);
          const failed: QueueItem = {
            ...uploading,
            status: exhausted ? 'needs_attention' : 'failed',
            lastError: message,
            nextAttemptAt: exhausted
              ? uploading.nextAttemptAt
              : this.now() + this.backoff(uploading.attempts),
          };
          this.update(failed);
          processed.push({ ...failed });
          this.options.onItemFailed?.(failed, error instanceof Error ? error : new Error(message));
        }
        await this.persist();
      }
    } finally {
      this.draining = false;
      await this.persist();
    }

    return processed;
  }

  private update(item: QueueItem): void {
    this.items = this.items.map((entry) => (entry.id === item.id ? item : entry));
  }

  /** Exponential backoff: 2s, 4s, 8s, … capped. */
  private backoff(attempts: number): number {
    const base = this.options.baseBackoffMs ?? DEFAULT_OPTIONS.baseBackoffMs;
    const max = this.options.maxBackoffMs ?? DEFAULT_OPTIONS.maxBackoffMs;
    return Math.min(base * 2 ** Math.max(attempts - 1, 0), max);
  }
}
