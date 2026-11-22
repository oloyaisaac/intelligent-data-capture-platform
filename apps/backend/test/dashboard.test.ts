import { createHarness, registerAccount, uploadDocument, type Harness } from './helpers';
import { buildTimeline, statsToCsv } from '../src/services/organisation-service';
import { parseCsv } from '@idcp/shared';

/**
 * DASH-001 — the figures behind the dashboard.
 *
 * The interesting properties are: the series has no gaps (a quiet day still appears), the numbers
 * are scoped to one organisation, and an empty organisation gets zeros rather than nulls.
 */
describe('DASH-001 statistics', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('returns a 14-day series with no gaps and zeros for a new organisation', async () => {
    const account = await registerAccount(harness);
    const response = await harness.api.json('GET', '/api/v1/stats', {
      token: account.accessToken,
    });
    expect(response.statusCode).toBe(200);

    const stats = response.json<{
      totalDocuments: number;
      timeline: Array<{ date: string; uploaded: number; approved: number; failed: number }>;
      documents: Record<string, number>;
      review: { pending: number; approved: number };
      connectors: { total: number; active: number };
      exports: { total: number; ready: number };
    }>();

    expect(stats.timeline).toHaveLength(14);
    expect(new Set(stats.timeline.map((point) => point.date)).size).toBe(14);
    expect(stats.timeline.every((point) => point.uploaded === 0)).toBe(true);
    expect(stats.totalDocuments).toBe(0);
    expect(stats.review).toEqual({ pending: 0, approved: 0 });
    expect(stats.connectors).toEqual({ total: 0, active: 0 });
    expect(stats.exports).toEqual({ total: 0, ready: 0 });
  });

  it('protects formula-like text in dashboard CSV while retaining its multi-section format', async () => {
    const account = await registerAccount(harness);
    const response = await harness.api.get('/api/v1/stats', account.accessToken);
    const stats = response.json<Awaited<ReturnType<typeof harness.services.organisation.stats>>>();
    stats.timeline[0]!.date = '  =1+1';
    const csv = statsToCsv(stats);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual(['date', 'uploaded', 'approved', 'failed']);
    expect(rows[1]![0]).toBe("'  =1+1");
    expect(rows).toContainEqual(['metric', 'value']);
  });

  it('counts uploads by status, type and day for the calling organisation only', async () => {
    const account = await registerAccount(harness);
    await uploadDocument(harness, account, {
      idempotencyKey: 'dash-key-1',
      documentType: 'invoice',
    });
    await uploadDocument(harness, account, {
      idempotencyKey: 'dash-key-2',
      documentType: 'receipt',
    });

    const other = await registerAccount(harness);
    await uploadDocument(harness, other, { idempotencyKey: 'other-key-1' });

    const response = await harness.api.json('GET', '/api/v1/stats', {
      token: account.accessToken,
    });
    const stats = response.json<{
      totalDocuments: number;
      documents: Record<string, number>;
      documentTypes: Record<string, number>;
      timeline: Array<{ date: string; uploaded: number }>;
    }>();

    expect(stats.totalDocuments).toBe(2);
    expect(stats.documents.queued).toBe(2);
    expect(stats.documentTypes).toMatchObject({ invoice: 1, receipt: 1 });

    const today = new Date().toISOString().slice(0, 10);
    expect(stats.timeline.find((point) => point.date === today)?.uploaded).toBe(2);
  });

  it('scopes connector and export aggregates and excludes deleted documents', async () => {
    const account = await registerAccount(harness);
    const other = await registerAccount(harness);
    const upload = await uploadDocument(harness, account, { idempotencyKey: 'deleted-dashboard' });
    const documentId = upload.json<{ id: string }>().id;
    const now = new Date().toISOString();
    await harness.db.execute('UPDATE documents SET deleted_at = ? WHERE id = ?', [now, documentId]);
    for (const [id, owner, status] of [
      ['own-active', account, 'active'],
      ['own-other', account, 'disabled'],
      ['other-active', other, 'active'],
    ] as const) {
      await harness.db.execute(
        `INSERT INTO connectors (id, organisation_id, type, name, status, created_at, updated_at)
         VALUES (?, ?, 'csv', 'fixture', ?, ?, ?)`,
        [id, owner.organisationId, status, now, now],
      );
    }
    for (const [id, owner, status] of [
      ['own-ready', account, 'ready'],
      ['own-pending', account, 'pending'],
      ['other-ready', other, 'ready'],
    ] as const) {
      await harness.db.execute(
        `INSERT INTO exports (id, organisation_id, requested_by, format, status, created_at)
         VALUES (?, ?, ?, 'csv', ?, ?)`,
        [id, owner.organisationId, owner.userId, status, now],
      );
    }
    const response = await harness.api.get('/api/v1/stats', account.accessToken);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      totalDocuments: 0,
      connectors: { total: 2, active: 1 },
      exports: { total: 2, ready: 1 },
      review: { pending: 0, approved: 0 },
    });
  });

  it('fills missing days so a quiet day is a zero, not an omission', () => {
    const now = new Date('2026-10-26T09:00:00.000Z');
    const timeline = buildTimeline(
      [
        { day: '2026-10-26', status: 'approved', count: 3 },
        { day: '2026-10-24', status: 'failed', count: 1 },
      ],
      3,
      now,
    );

    expect(timeline).toEqual([
      { date: '2026-10-24', uploaded: 1, approved: 0, failed: 1 },
      { date: '2026-10-25', uploaded: 0, approved: 0, failed: 0 },
      { date: '2026-10-26', uploaded: 3, approved: 3, failed: 0 },
    ]);
  });

  it('honours a longer window but never beyond 90 days', async () => {
    const account = await registerAccount(harness);
    const response = await harness.api.json('GET', '/api/v1/stats?days=30', {
      token: account.accessToken,
    });
    expect(response.json<{ timeline: unknown[] }>().timeline).toHaveLength(30);

    const clamped = await harness.api.json('GET', '/api/v1/stats?days=9999', {
      token: account.accessToken,
    });
    expect(clamped.json<{ timeline: unknown[] }>().timeline).toHaveLength(90);
  });

  it('exports the dashboard figures as CSV', async () => {
    const account = await registerAccount(harness);
    await uploadDocument(harness, account, {
      idempotencyKey: 'csv-dash-1',
      documentType: 'invoice',
    });

    const csv = await harness.api.download('/api/v1/stats.csv', account.accessToken);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/);
    expect(csv.headers.get('content-disposition')).toMatch(/dashboard-\d{4}-\d{2}-\d{2}\.csv/);

    const text = csv.buffer().toString('utf8');
    expect(text.startsWith('\uFEFF')).toBe(true);
    expect(text).toContain('date,uploaded,approved,failed');
    expect(text).toContain('total_documents,1');
    expect(text).toContain('type:invoice,1');
  });
});
