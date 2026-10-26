import { buildPairingQrPayload } from '@idcp/shared';
import { describeDevice, formatExpiry, readPairingCode } from '../src/pairing/pairing';
import {
  UploadQueue,
  type QueueItem,
  type QueueStorage,
  type UploadTransport,
} from '../src/state/uploadQueue';
import { PersistedQueueStorage } from '../src/state/queueStorage';
import { ApiClient, ApiError, assertSecureEndpoint } from '../src/api/client';
import { MemorySecureStore } from '../src/auth/memoryStore';
import {
  chooseJpegQuality,
  cropRectForQuad,
  planProcessing,
  processCapture,
  resizeFor,
  type ImageTransformer,
} from '../src/capture/imagePipeline';
import {
  detectDocumentQuad,
  isPlausibleQuad,
  scaleQuad,
  smoothQuad,
} from '../src/capture/edgeDetection';
import { createFrameBridge } from '../src/capture/useDocumentDetector';
import { orientationFix } from '../src/capture/imagePipeline';
import type { Detection } from '../src/capture/edgeDetection';
import { createGuidanceTracker, cueFor } from '../src/assist/guidance';
import { gate, parseCommand } from '../src/assist/commands';
import { initialVoiceSession, reduceVoice } from '../src/assist/reviewVoice';
import {
  AUDIO_POLICY,
  canListen,
  createVoiceAssistant,
  defaultVoiceSettings,
  describeAudioPolicy,
  listenBlocker,
  transcriptOnly,
  type VoiceAssistantPlatform,
} from '../src/assist/consent';

class MemoryStorage implements QueueStorage {
  items: QueueItem[] = [];
  saves = 0;
  async load(): Promise<QueueItem[]> {
    return this.items.map((item) => ({ ...item }));
  }
  async save(items: QueueItem[]): Promise<void> {
    this.items = items.map((item) => ({ ...item }));
    this.saves += 1;
  }
}

class FakeTransport implements UploadTransport {
  uploads: Array<{ idempotencyKey: string; fileName: string }> = [];
  online = true;
  failuresRemaining = 0;

  async upload(input: { uri: string; fileName: string; mimeType: string; idempotencyKey: string }) {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('Network request failed');
    }
    this.uploads.push({ idempotencyKey: input.idempotencyKey, fileName: input.fileName });
    return { id: `doc-${this.uploads.length}`, jobId: 'job-1', status: 'queued', duplicate: false };
  }

  isOnline(): boolean {
    return this.online;
  }
}

function capture(id: string) {
  return { id, uri: `file:///captures/${id}.jpg`, fileName: `${id}.jpg`, mimeType: 'image/jpeg' };
}

describe('upload queue (MOB-003)', () => {
  it('persists a capture before any upload is attempted', async () => {
    const storage = new MemoryStorage();
    const transport = new FakeTransport();
    const queue = new UploadQueue(storage, transport);

    await queue.enqueue(capture('cap_1'));

    expect(storage.items).toHaveLength(1);
    expect(storage.items[0].status).toBe('pending');
    expect(transport.uploads).toHaveLength(0);
    expect(queue.pendingCount()).toBe(1);
  });

  it('uploads each capture once, using the local id as the idempotency key', async () => {
    const storage = new MemoryStorage();
    const transport = new FakeTransport();
    const queue = new UploadQueue(storage, transport);

    await queue.enqueue(capture('cap_a'));
    await queue.drain();
    await queue.drain(); // a second drain must not upload again

    expect(transport.uploads).toEqual([{ idempotencyKey: 'cap_a', fileName: 'cap_a.jpg' }]);
    expect(storage.items[0].status).toBe('uploaded');
    expect(storage.items[0].documentId).toBe('doc-1');
    expect(queue.pendingCount()).toBe(0);
  });

  it('ignores a duplicate enqueue of the same capture', async () => {
    const storage = new MemoryStorage();
    const queue = new UploadQueue(storage, new FakeTransport());

    await queue.enqueue(capture('cap_dup'));
    await queue.enqueue(capture('cap_dup'));

    expect(queue.snapshot()).toHaveLength(1);
  });

  it('schedules a retry with exponential backoff after a failure', async () => {
    const storage = new MemoryStorage();
    const transport = new FakeTransport();
    transport.failuresRemaining = 1;
    let now = 1_000;
    const queue = new UploadQueue(storage, transport, { now: () => now, baseBackoffMs: 2_000 });

    await queue.enqueue(capture('cap_fail'));
    await queue.drain();

    const failed = storage.items[0];
    expect(failed.status).toBe('failed');
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toContain('Network');
    expect(failed.nextAttemptAt).toBe(3_000);

    // Not eligible yet: a drain before the backoff elapses must not touch the network.
    await queue.drain();
    expect(storage.items[0].attempts).toBe(1);

    now = 3_000;
    await queue.drain();
    expect(storage.items[0].status).toBe('uploaded');
  });

  it('stops retrying after the attempt limit and flags the capture for a person', async () => {
    const storage = new MemoryStorage();
    const transport = new FakeTransport();
    transport.failuresRemaining = 99;
    let now = 0;
    const queue = new UploadQueue(storage, transport, {
      now: () => now,
      maxAttempts: 2,
      baseBackoffMs: 10,
    });

    await queue.enqueue(capture('cap_poison'));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await queue.drain();
      now += 60_000;
    }

    const item = storage.items[0];
    expect(item.status).toBe('needs_attention');
    expect(item.attempts).toBe(2);
    expect(queue.pendingCount()).toBe(1);

    // A manual retry clears the attempt count and succeeds once the network is back.
    transport.failuresRemaining = 0;
    await queue.retry('cap_poison');
    await queue.drain();
    expect(storage.items[0].status).toBe('uploaded');
  });

  it('does nothing while offline but keeps the captures', async () => {
    const storage = new MemoryStorage();
    const transport = new FakeTransport();
    transport.online = false;
    const queue = new UploadQueue(storage, transport, { now: () => 0 });

    await queue.enqueue(capture('cap_offline'));
    const processed = await queue.drain();

    expect(processed).toHaveLength(0);
    expect(storage.items[0].status).toBe('pending');
    expect(queue.pendingCount()).toBe(1);
  });

  it('never reports a capture as uploaded before the server acknowledged it', async () => {
    const storage = new MemoryStorage();
    const transport = new FakeTransport();
    transport.failuresRemaining = 1;
    const queue = new UploadQueue(storage, transport, { now: () => 0 });
    let uploadedEvents = 0;

    const instrumented = new UploadQueue(storage, new FakeTransport(), {
      onItemUploaded: () => {
        uploadedEvents += 1;
      },
    });
    await instrumented.enqueue(capture('cap_x'));
    await instrumented.drain();
    expect(uploadedEvents).toBe(1);
    expect(uploadedEvents).toBeLessThanOrEqual(queue.snapshot().length + 1);
  });
});

describe('queue persistence', () => {
  it('round-trips items and survives a corrupt payload', async () => {
    const store = new MemorySecureStore();
    const storage = new PersistedQueueStorage(store);
    const queue = new UploadQueue(storage, new FakeTransport());
    await queue.enqueue(capture('cap_persist'));

    const reloaded = new UploadQueue(storage, new FakeTransport());
    expect(await reloaded.load()).toHaveLength(1);

    await store.setItem('upload_queue', '{not json');
    expect(await storage.load()).toEqual([]);

    await store.setItem('upload_queue', JSON.stringify([{ id: 'broken' }]));
    expect(await storage.load()).toEqual([]);
  });
});

describe('pairing code handling (PAIR-002)', () => {
  const token = 'a'.repeat(43);

  it('accepts a code generated by the desktop app', () => {
    const payload = buildPairingQrPayload('https://idcp.example.com', token);
    const result = readPairingCode(payload);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.endpoint).toBe('https://idcp.example.com');
      expect(result.target.token).toBe(token);
    }
  });

  it('rejects another app’s QR code', () => {
    expect(readPairingCode('https://example.com/whatever')).toEqual({
      ok: false,
      reason: 'not_our_code',
    });
    expect(readPairingCode('')).toEqual({ ok: false, reason: 'not_our_code' });
  });

  it('rejects a code pointing at an insecure endpoint', () => {
    expect(readPairingCode(buildPairingQrPayload('http://203.0.113.10:8080', token))).toEqual({
      ok: false,
      reason: 'insecure',
    });
  });

  it('rejects a truncated code instead of attempting a request', () => {
    expect(readPairingCode('idcp://pair?e=https://idcp.example.com')).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('presents device names and expiry readably', () => {
    expect(describeDevice('android', 'Samsung SM-A125F')).toBe('Samsung SM-A125F');
    expect(describeDevice('ios')).toBe('iPhone');
    expect(describeDevice('android', '   ')).toBe('Android device');
    expect(formatExpiry(90)).toBe('1m 30s');
    expect(formatExpiry(42)).toBe('42s');
    expect(formatExpiry(0)).toBe('Expired');
  });
});

describe('API client', () => {
  const okPair = () =>
    new Response(
      JSON.stringify({
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresIn: 900,
        user: {
          id: 'u1',
          email: 'owner@example.com',
          displayName: 'Owner',
          role: 'owner',
          organisationId: 'org-1',
          organisationName: 'Acme',
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  it('refuses a non-HTTPS endpoint', () => {
    expect(() => assertSecureEndpoint('http://idcp.example.com')).toThrow(/https/i);
    expect(assertSecureEndpoint('https://idcp.example.com/')).toBe('https://idcp.example.com');
    expect(assertSecureEndpoint('http://localhost:8787')).toBe('http://localhost:8787');
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    const store = new MemorySecureStore();
    await store.saveTokens({ accessToken: 'stale', refreshToken: 'refresh-0' });
    const calls: string[] = [];

    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(String(url).replace('https://idcp.example.com', ''));
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (String(url).endsWith('/auth/refresh')) return okPair();
      if (auth === 'Bearer access-1') {
        return new Response(JSON.stringify({ id: 'u1', email: 'owner@example.com' }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Sign in.' } }),
        {
          status: 401,
        },
      );
    }) as unknown as typeof fetch;

    const client = new ApiClient({ baseUrl: 'https://idcp.example.com', store, fetchImpl });
    const me = await client.me();

    expect(calls).toEqual(['/auth/me', '/auth/refresh', '/auth/me']);
    expect(me).toEqual({ id: 'u1', email: 'owner@example.com' });
    expect(await store.getAccessToken()).toBe('access-1');
    expect(await store.getRefreshToken()).toBe('refresh-1');
  });

  it('clears the session when the refresh token is no longer valid', async () => {
    const store = new MemorySecureStore();
    await store.saveTokens({ accessToken: 'stale', refreshToken: 'revoked' });
    let expired = false;

    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'No.' } }), {
        status: 401,
      })) as unknown as typeof fetch;

    const client = new ApiClient({
      baseUrl: 'https://idcp.example.com',
      store,
      fetchImpl,
      onSessionExpired: () => {
        expired = true;
      },
    });

    await expect(client.me()).rejects.toBeInstanceOf(ApiError);
    expect(expired).toBe(true);
    expect(await store.getRefreshToken()).toBeNull();
  });

  it('surfaces the server’s message and code for a rejected request', async () => {
    const store = new MemorySecureStore();
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Email or password is incorrect.',
            requestId: 'r1',
          },
        }),
        { status: 400 },
      )) as unknown as typeof fetch;

    const client = new ApiClient({ baseUrl: 'https://idcp.example.com', store, fetchImpl });

    await expect(client.login({ email: 'a@b.com', password: 'nope' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
      message: 'Email or password is incorrect.',
    });
  });
});

describe('capture pipeline (MOB-002)', () => {
  const frame = { width: 4032, height: 3024 };

  it('crops to the detected document with padding, clamped to the frame', () => {
    const rect = cropRectForQuad(
      {
        topLeft: { x: 100, y: 200 },
        topRight: { x: 3900, y: 210 },
        bottomRight: { x: 3950, y: 2900 },
        bottomLeft: { x: 90, y: 2880 },
      },
      frame,
      0,
    );
    expect(rect).toEqual({ originX: 90, originY: 200, width: 3860, height: 2700 });
  });

  it('ignores a degenerate quad instead of cropping the document away', () => {
    const tap = {
      topLeft: { x: 10, y: 10 },
      topRight: { x: 14, y: 10 },
      bottomRight: { x: 14, y: 14 },
      bottomLeft: { x: 10, y: 14 },
    };
    expect(cropRectForQuad(tap, frame)).toBeNull();
    expect(cropRectForQuad(null, frame)).toBeNull();
  });

  it('downscales to the target long edge but never upscales', () => {
    expect(resizeFor({ width: 4032, height: 3024 }, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(resizeFor({ width: 1200, height: 900 }, 1600)).toBeNull();
  });

  it('chooses a quality that fits the byte budget without going below the floor', () => {
    expect(chooseJpegQuality(500_000, { maxBytes: 2_000_000 })).toEqual({
      quality: 0.85,
      fits: true,
    });

    // A 2.5 MB frame can be squeezed under 2 MB without falling below the quality floor.
    const squeezed = chooseJpegQuality(2_500_000, { maxBytes: 2_000_000 });
    expect(squeezed.quality).toBeLessThan(0.85);
    expect(squeezed.quality).toBeGreaterThanOrEqual(0.6);
    expect(squeezed.fits).toBe(true);

    const hopeless = chooseJpegQuality(60_000_000, { maxBytes: 2_000_000 });
    expect(hopeless.quality).toBe(0.6);
    expect(hopeless.fits).toBe(false);
  });

  it('plans crop, enhance, resize and compress in one explainable step list', () => {
    const plan = planProcessing({
      frame,
      quad: {
        topLeft: { x: 200, y: 200 },
        topRight: { x: 3800, y: 200 },
        bottomRight: { x: 3800, y: 2800 },
        bottomLeft: { x: 200, y: 2800 },
      },
      estimatedBytes: 8_000_000,
      washedOut: true,
    });

    expect(plan.crop).toBeTruthy();
    expect(plan.resize).toEqual({ width: 1600, height: 1156 });
    expect(plan.enhance).toBe(true);
    expect(plan.quality).toBeLessThan(0.85);
    expect(plan.steps).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^crop /),
        'resize to 1600×1156',
        'boost contrast',
      ]),
    );
  });

  it('applies the plan in order and still uploads when a step is unavailable', async () => {
    const calls: string[] = [];
    const transformer: ImageTransformer = {
      crop: async () => {
        calls.push('crop');
        throw new Error('not supported on this device');
      },
      enhance: async (uri) => {
        calls.push('enhance');
        return `${uri}#enhanced`;
      },
      resize: async (uri) => {
        calls.push('resize');
        return `${uri}#small`;
      },
      compress: async (uri, quality) => {
        calls.push(`compress:${quality}`);
        return `${uri}#compressed`;
      },
    };

    const result = await processCapture(transformer, 'file://raw.jpg', {
      frame,
      quad: {
        topLeft: { x: 200, y: 200 },
        topRight: { x: 3800, y: 200 },
        bottomRight: { x: 3800, y: 2800 },
        bottomLeft: { x: 200, y: 2800 },
      },
      estimatedBytes: 9_000_000,
      washedOut: true,
    });

    // Crop failed, so the rest still ran against the original frame.
    expect(calls[0]).toBe('crop');
    expect(result.uri).toBe('file://raw.jpg#enhanced#small#compressed');
    expect(result.plan.steps).toContain('crop unavailable, uploading the full frame');
  });
});

describe('edge detection (MOB-002)', () => {
  // A tiny seeded generator keeps the synthetic frames reproducible run to run.
  let seedState = 987654321;
  const pseudoRandom = () => {
    seedState = (seedState * 1103515245 + 12345) % 2147483648;
    return seedState / 2147483648;
  };

  /** Draws a bright page on a dark desk, optionally rotated, with a few text lines inside. */
  function syntheticFrame(
    options: {
      width?: number;
      height?: number;
      angle?: number;
      pageRatio?: number;
      noise?: number;
    } = {},
  ) {
    const width = options.width ?? 320;
    const height = options.height ?? 240;
    const angle = ((options.angle ?? 0) * Math.PI) / 180;
    const pageRatio = options.pageRatio ?? 0.6;
    const noise = options.noise ?? 4;
    const data = new Uint8ClampedArray(width * height).fill(40);

    const halfWidth = (width * pageRatio) / 2;
    const halfHeight = (height * pageRatio) / 1.6 / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const cx = width / 2;
    const cy = height / 2;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const dx = x - cx;
        const dy = y - cy;
        // Rotate the point back into the page's own axes.
        const px = dx * cos + dy * sin;
        const py = -dx * sin + dy * cos;
        if (Math.abs(px) <= halfWidth && Math.abs(py) <= halfHeight) {
          const line = Math.floor((py + halfHeight) / 9) % 2 === 0;
          data[y * width + x] = line ? 150 : 225;
        }
        data[y * width + x] = Math.max(
          0,
          Math.min(255, (data[y * width + x] ?? 0) + (pseudoRandom() - 0.5) * 2 * noise),
        );
      }
    }

    return { data, width, height };
  }

  it('outlines an upright page and reports roughly the area it covers', () => {
    const frame = syntheticFrame({ angle: 0, pageRatio: 0.6 });
    const detection = detectDocumentQuad(frame);
    expect(detection).not.toBeNull();
    expect(detection!.confidence).toBeGreaterThan(0.5);
    // The page covers 0.6 × 0.375 of the frame; allow for the threshold shifting the outline.
    expect(detection!.areaRatio).toBeGreaterThan(0.15);
    expect(detection!.areaRatio).toBeLessThan(0.4);
    const corners = [
      detection!.quad.topLeft,
      detection!.quad.topRight,
      detection!.quad.bottomRight,
      detection!.quad.bottomLeft,
    ];
    for (const corner of corners) {
      expect(corner.x).toBeGreaterThanOrEqual(0);
      expect(corner.x).toBeLessThanOrEqual(320);
      expect(corner.y).toBeGreaterThanOrEqual(0);
      expect(corner.y).toBeLessThanOrEqual(240);
    }
  });

  it('keeps the outline on the page when it is tilted', () => {
    const upright = detectDocumentQuad(syntheticFrame({ angle: 0 }));
    const tilted = detectDocumentQuad(syntheticFrame({ angle: 18 }));
    expect(upright).not.toBeNull();
    expect(tilted).not.toBeNull();
    // Rotating a rectangle preserves its area, so the detected share should stay comparable.
    expect(tilted!.areaRatio).toBeGreaterThan(upright!.areaRatio * 0.6);
    expect(tilted!.areaRatio).toBeLessThan(upright!.areaRatio * 1.6);
    // A rotation must widen the bounding box rather than leaving a corner at the upright position.
    const spread = Math.abs(tilted!.quad.topLeft.x - upright!.quad.topLeft.x);
    expect(spread).toBeGreaterThan(1);
  });

  it('returns nothing for a blank desk, a tiny frame or noise without a page', () => {
    const blank = { data: new Uint8ClampedArray(320 * 240).fill(200), width: 320, height: 240 };
    expect(detectDocumentQuad(blank)).toBeNull();
    expect(detectDocumentQuad({ data: new Uint8ClampedArray(16), width: 4, height: 4 })).toBeNull();

    // Deterministic pseudo-noise: a flaky detector test is worse than no detector test.
    let seed = 12345;
    const nextByte = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return (seed / 2147483648) * 255;
    };
    const noise = {
      data: Uint8ClampedArray.from({ length: 320 * 240 }, nextByte),
      width: 320,
      height: 240,
    };
    // Edges everywhere means no page: an outline that hugs the frame is discarded, not cropped to.
    expect(detectDocumentQuad(noise)).toBeNull();
  });

  it('honours a padded row stride, as VisionCamera planes have', () => {
    const width = 120;
    const height = 90;
    const bytesPerRow = 128;
    const data = new Uint8Array(bytesPerRow * height).fill(30);
    for (let y = 20; y < 70; y += 1) {
      for (let x = 20; x < 100; x += 1) data[y * bytesPerRow + x] = 220;
    }
    const detection = detectDocumentQuad({ data, width, height, bytesPerRow });
    expect(detection).not.toBeNull();
    expect(detection!.quad.topLeft.x).toBeGreaterThan(0);
    expect(detection!.quad.bottomRight.x).toBeLessThan(width);
  });

  it('maps the preview outline onto the photo and smooths it without jumping', () => {
    const quad = {
      topLeft: { x: 10, y: 10 },
      topRight: { x: 90, y: 10 },
      bottomRight: { x: 90, y: 70 },
      bottomLeft: { x: 10, y: 70 },
    };
    const scaled = scaleQuad(quad, { width: 100, height: 100 }, { width: 3000, height: 4000 });
    expect(scaled.topRight.x).toBeCloseTo(2700, 5);
    expect(scaled.bottomLeft.y).toBeCloseTo(2800, 5);

    const smoothed = smoothQuad(
      quad,
      { ...quad, topLeft: { x: 20, y: 20 } },
      { width: 100, height: 100 },
      0.5,
    );
    expect(smoothed.topLeft).toEqual({ x: 15, y: 15 });

    const replaced = smoothQuad(
      quad,
      { ...quad, topLeft: { x: 10, y: 110 } },
      { width: 100, height: 100 },
    );
    expect(replaced.topLeft).toEqual({ x: 10, y: 110 });
  });

  it('rejects a four-point "outline" that is really a sliver', () => {
    const sliver = {
      topLeft: { x: 0, y: 0 },
      topRight: { x: 5, y: 0 },
      bottomRight: { x: 5, y: 5 },
      bottomLeft: { x: 0, y: 5 },
    };
    expect(isPlausibleQuad(sliver, { width: 320, height: 240 })).toBe(false);
  });
});

describe('capture orientation and the frame bridge (MOB-002)', () => {
  it('turns EXIF orientation into the rotation that makes a page upright', () => {
    expect(orientationFix(1)).toBe(0);
    expect(orientationFix(3)).toBe(180);
    expect(orientationFix(6)).toBe(90);
    expect(orientationFix(8)).toBe(270);
    expect(orientationFix(0)).toBe(0);
    expect(orientationFix(99)).toBe(0);
  });

  it('rotates before cropping, so the crop rectangle is applied to upright pixels', async () => {
    const calls: string[] = [];
    const transformer = {
      rotate: async (uri: string) => {
        calls.push('rotate');
        return `${uri}-r`;
      },
      crop: async (uri: string) => {
        calls.push('crop');
        return `${uri}-c`;
      },
      resize: async (uri: string) => `${uri}-s`,
      enhance: async (uri: string) => `${uri}-e`,
      compress: async (uri: string) => `${uri}-z`,
    };

    const result = await processCapture(transformer, 'file://photo.jpg', {
      frame: { width: 3000, height: 4000 },
      orientation: 6,
      quad: {
        topLeft: { x: 100, y: 100 },
        topRight: { x: 2900, y: 120 },
        bottomRight: { x: 2880, y: 3900 },
        bottomLeft: { x: 120, y: 3860 },
      },
    });

    expect(calls.slice(0, 2)).toEqual(['rotate', 'crop']);
    expect(result.plan.rotate).toBe(90);
    expect(result.plan.steps[0]).toBe('rotate 90°');
  });

  it('keeps the last good outline when a frame has no page, and throttles evaluations', () => {
    let clock = 0;
    const bridge = createFrameBridge({ throttleMs: 100, now: () => clock });
    const seen: Array<number | null> = [];
    bridge.subscribe((detection) => seen.push(detection ? detection.confidence : null));

    const width = 240;
    const height = 180;
    const page = new Uint8ClampedArray(width * height).fill(30);
    for (let y = 40; y < 140; y += 1) {
      for (let x = 40; x < 200; x += 1) page[y * width + x] = 220;
    }

    clock = 0;
    bridge.push({ data: page, width, height });
    const first = bridge.current();
    expect(first).not.toBeNull();

    // A blank frame inside the throttle window is ignored entirely.
    clock = 50;
    bridge.push({ data: new Uint8ClampedArray(width * height).fill(120), width, height });
    expect(bridge.current()).toEqual(first);

    // Past the window, a blank frame keeps the previous detection rather than clearing it.
    clock = 200;
    bridge.push({ data: new Uint8ClampedArray(width * height).fill(120), width, height });
    expect(bridge.current()).toEqual(first);

    // reset() is the explicit way to clear it (leaving the camera, for instance).
    bridge.reset();
    expect(bridge.current()).toBeNull();
    expect(seen[seen.length - 1]).toBeNull();
  });

  it('reports brightness and contrast inside the page, so a washed-out page can be enhanced', () => {
    const width = 200;
    const height = 150;
    // A bright outline on a dark desk, but the page itself is a flat grey sheet: the sort of
    // shadowed capture that needs a contrast pass rather than a better camera angle.
    const flat = new Uint8ClampedArray(width * height).fill(35);
    for (let y = 30; y < 120; y += 1) {
      for (let x = 30; x < 170; x += 1) flat[y * width + x] = 150;
    }
    const detection = detectDocumentQuad({ data: flat, width, height });
    expect(detection).not.toBeNull();
    // Inside the page everything is 150, so the spread is small even though the scene has contrast
    // (the outline itself contributes the few boundary pixels that remain).
    expect(detection!.contrast).toBeLessThan(20);
    expect(detection!.meanLuma).toBeGreaterThan(120);
    expect(detection!.meanLuma).toBeLessThan(190);
  });
});

describe('voice guidance and commands (VOICE-001)', () => {
  const page = (overrides: Partial<Detection> = {}): Detection => ({
    quad: {
      topLeft: { x: 10, y: 10 },
      topRight: { x: 190, y: 12 },
      bottomRight: { x: 188, y: 228 },
      bottomLeft: { x: 12, y: 226 },
    },
    confidence: 0.92,
    areaRatio: 0.8,
    meanLuma: 150,
    contrast: 60,
    ...overrides,
  });

  it('names the problem with the frame, most urgent first', () => {
    expect(cueFor(null).id).toBe('searching');
    expect(cueFor(page()).id).toBe('ready');
    expect(cueFor(page({ meanLuma: 30 })).id).toBe('too_dark');
    expect(cueFor(page({ meanLuma: 253 })).id).toBe('glare');
    // A page that fills a third of the frame is too small to read, whatever the confidence says.
    expect(cueFor(page({ areaRatio: 0.2, confidence: 0.99 })).id).toBe('move_closer');
    expect(cueFor(page({ areaRatio: 0.995 })).id).toBe('move_away');
    expect(cueFor(page({ contrast: 8 })).id).toBe('flat_contrast');
    expect(cueFor(page({ confidence: 0.4 })).id).toBe('hold_still');
    expect(cueFor(page({ confidence: 0.7 })).id).toBe('page_detected');
    // Every cue is a catalogue key, so guidance speaks in the operator's language.
    expect(cueFor(page({ meanLuma: 30 })).messageKey).toBe('voice.cue.tooDark');
  });

  it('waits for a cue to hold, and does not repeat itself within the cooldown', () => {
    let clock = 0;
    const tracker = createGuidanceTracker({ now: () => clock, stableFrames: 3, cooldownMs: 5000 });

    // One dark frame is not announced: the hand is still moving.
    expect(tracker.observe(page({ meanLuma: 20 })).announce).toBeNull();
    expect(tracker.observe(page({ meanLuma: 20 })).announce).toBeNull();
    const stable = tracker.observe(page({ meanLuma: 20 }));
    expect(stable.current.id).toBe('too_dark');
    expect(stable.announce?.id).toBe('too_dark');

    // Still dark, still within the cooldown: shown, not repeated.
    clock = 1000;
    for (let frame = 0; frame < 4; frame += 1) {
      expect(tracker.observe(page({ meanLuma: 20 })).announce).toBeNull();
    }

    // After the cooldown it may speak again.
    clock = 6000;
    expect(tracker.observe(page({ meanLuma: 20 })).announce?.id).toBe('too_dark');
    expect(tracker.observe(page({ meanLuma: 20 })).announce).toBeNull();

    // A different cue resets the stability count.
    expect(tracker.observe(page()).current.id).toBe('ready');
    expect(tracker.observe(page()).announce).toBeNull();
  });

  it('says "ready" once per framing rather than forever', () => {
    let clock = 0;
    const tracker = createGuidanceTracker({ now: () => clock, stableFrames: 1, cooldownMs: 0 });
    expect(tracker.observe(page()).announce?.id).toBe('ready');
    clock = 10_000;
    expect(tracker.observe(page()).announce).toBeNull();
    // Reframing (a different cue in between) makes "ready" worth saying again.
    tracker.observe(page({ meanLuma: 20 }));
    clock = 20_000;
    expect(tracker.observe(page()).announce?.id).toBe('ready');
    tracker.reset();
    expect(tracker.observe(page()).announce?.id).toBe('ready');
  });

  it('matches commands in three languages without ever guessing', () => {
    expect(parseCommand('Take a photo')?.command).toBe('capture');
    expect(parseCommand('piga picha')?.command).toBe('capture');
    expect(parseCommand('Reprendre', 0.9, { locale: 'fr' })?.command).toBe('retake');
    // Longest phrase wins, so "next field total" is a field jump and not a bare "next".
    expect(parseCommand('next field total', 1)?.field).toBe('total');
    expect(parseCommand('next field total', 1)?.command).toBe('next_field');
    // Accents and punctuation are normalised.
    expect(parseCommand('champ précédent!', 1, { locale: 'fr' })?.command).toBe('previous_field');
    // Nothing in common with the phrase book, or a mumble: no command.
    expect(parseCommand('where is the stapler')).toBeNull();
    expect(parseCommand('approve', 0.2)).toBeNull();
    expect(parseCommand('   ')).toBeNull();
    // "again" must not fire from "against".
    expect(parseCommand('move it against the wall')).toBeNull();
  });

  it('marks filing and rejecting as destructive, and stops when the microphone is off', () => {
    const approve = parseCommand('approve')!;
    expect(approve.requiresConfirmation).toBe(true);
    expect(parseCommand('capture')!.requiresConfirmation).toBe(false);

    // With voice switched off nothing reaches the app — not even "capture".
    expect(gate(parseCommand('capture'), { listening: false }).run).toBeNull();
    expect(gate(parseCommand('capture'), { listening: true }).run).toBe('capture');
    // The approval prompt is returned instead of running.
    const gated = gate(approve, { listening: true });
    expect(gated.run).toBeNull();
    expect(gated.confirm).toBe('voice.confirm.approve');
  });

  it('needs a second utterance to file a record', () => {
    const approve = parseCommand('approve')!;
    const first = reduceVoice(initialVoiceSession(), approve, { listening: true });
    expect(first.run).toBeNull();
    expect(first.state.armed).toBe('approve');
    expect(first.confirm).toBe('voice.confirm.approve');

    const second = reduceVoice(first.state, approve, { listening: true });
    expect(second.run).toBe('approve');
    expect(second.state.armed).toBeNull();

    // Anything else between the two utterances disarms it: a stray "capture" cannot file a record.
    const other = reduceVoice(first.state, parseCommand('capture'), { listening: true });
    expect(other.run).toBe('capture');
    const after = reduceVoice(other.state, approve, { listening: true });
    expect(after.run).toBeNull();
    expect(after.confirm).toBe('voice.confirm.approve');

    // A mumble is reported, and disarms too.
    const mumble = reduceVoice(first.state, null, { listening: true });
    expect(mumble.state.armed).toBeNull();
    expect(mumble.state.heard).toEqual({ key: 'voice.noMatch' });
  });

  it('keeps voice off until permission is granted, and drops kept text when it is switched off', async () => {
    const asks: string[] = [];
    const platform: VoiceAssistantPlatform = {
      listen: async () => {
        asks.push('listen');
        return { transcript: 'capture', confidence: 0.95, audio: new Uint8Array([1, 2, 3]) };
      },
      speak: (text) => {
        asks.push(`speak:${text}`);
      },
      requestMicrophone: async () => {
        asks.push('permission');
        return true;
      },
    };
    const assistant = createVoiceAssistant(platform);

    // Off by default: nothing opens the microphone, and nothing is spoken.
    expect(assistant.settings().enabled).toBe(false);
    expect(canListen(assistant.settings())).toBe(false);
    expect(listenBlocker(assistant.settings())).toBe('voice.blocked.disabled');
    expect(await assistant.hear()).toBeNull();
    await assistant.say('hello');
    expect(asks).toEqual([]);

    // Turning it on asks for the microphone once.
    const enabled = await assistant.set('enabled', true);
    expect(enabled.enabled).toBe(true);
    expect(enabled.microphoneGranted).toBe(true);

    // A turn returns text only: the adapter's audio field never reaches the app.
    const heard = await assistant.hear();
    expect(heard).toEqual({ transcript: 'capture', confidence: 0.95 });
    expect(heard).not.toHaveProperty('audio');
    expect(transcriptOnly({ transcript: 'x', audio: new Uint8Array([9]) })).toEqual({
      transcript: 'x',
      confidence: 1,
    });

    // Guidance is spoken while voice is on and stops when it is switched off.
    await assistant.say('hold still');
    expect(asks).toContain('speak:hold still');

    // Kept command text is off by default; switching voice off discards it as well.
    expect(assistant.remember('capture')).toBeNull();
    await assistant.set('retainTranscript', true);
    expect(assistant.remember('capture')).toBe('capture');
    const off = await assistant.set('enabled', false);
    expect(off.retainTranscript).toBe(false);
    expect(assistant.remember('capture')).toBeNull();
    expect(await assistant.hear()).toBeNull();

    // A refused permission leaves the microphone closed even though the operator flipped the switch.
    const refused = createVoiceAssistant({
      listen: platform.listen,
      speak: platform.speak,
      requestMicrophone: async () => false,
    });
    const denied = await refused.set('enabled', true);
    // The intent is remembered, but the microphone stays closed and the reason is the permission.
    expect(denied.enabled).toBe(true);
    expect(canListen(denied)).toBe(false);
    expect(listenBlocker(denied)).toBe('voice.blocked.permission');
    expect(await refused.hear()).toBeNull();
  });

  it('states the audio policy it actually implements', () => {
    expect(AUDIO_POLICY).toEqual({
      audioStored: false,
      audioTransmitted: false,
      transcriptStoredByDefault: false,
      onDeviceRecognitionRequired: true,
    });
    expect(describeAudioPolicy()).toMatch(/audio is never recorded, stored or uploaded/i);
    expect(defaultVoiceSettings()).toEqual({
      enabled: false,
      microphoneGranted: false,
      spokenGuidance: true,
      retainTranscript: false,
    });
  });
});
