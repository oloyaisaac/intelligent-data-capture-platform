import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiClient, ApiError, MemoryTokenStorage } from '../src/api/client';
import { parseRoute, routeHref } from '../src/App';
import {
  confidenceTone,
  formatBytes,
  formatDateTime,
  formatPercent,
  humanisePath,
  statusTone,
  titleCase,
} from '../src/lib/format';
import { bulkApprovable, canApprove, pendingChanges, reviewRows } from '../src/lib/review';
import { connectRealtime, eventsUrl } from '../src/lib/realtime';
import { buildBarChart, describeChart, shares } from '../src/lib/charts';
import { DashboardPage } from '../src/pages/DashboardPage';
import { LOCALE_OPTIONS, loadLocale, resolveLocale, saveLocale, translator } from '../src/lib/i18n';
import { createTranslator, translationCoverage } from '@idcp/shared';
import { LoginPage } from '../src/pages/LoginPage';
import { AcceptInvitePage } from '../src/pages/AcceptInvitePage';
import { SendToDestination } from '../src/components/SendToDestination';
import { BatchesPage } from '../src/pages/BatchesPage';
import { DocumentsPage } from '../src/pages/DocumentsPage';
import { ProjectsPage } from '../src/pages/ProjectsPage';
import { ReviewPage } from '../src/pages/ReviewPage';
import { SettingsPage } from '../src/pages/SettingsPage';
import { AccountPage } from '../src/pages/AccountPage';
import { MarketplacePage, permissionLabel } from '../src/marketplace/MarketplacePage';
import { LocaleProvider, applyDocumentLocale, useTranslator } from '../src/lib/locale';
import { documentTypeLabel, roleLabel, statusLabel } from '../src/lib/labels';
import { formatNumber, formatRelative } from '../src/lib/format';
import { directionFor } from '@idcp/shared';
import {
  DESTRUCTIVE_ACTIONS,
  WorkflowsPage,
  actionLabel,
  describeRule,
} from '../src/workflows/WorkflowsPage';
import type { Udm } from '@idcp/shared';

/**
 * A Response stand-in.
 *
 * The jsdom test environment does not expose the Fetch API globals (Node's undici globals do not
 * leak into jsdom), and the client only needs a handful of members, so tests provide this small,
 * explicit fake instead of pulling in a polyfill.
 */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    text: async () => text,
    json: async () => JSON.parse(text),
    blob: async () => new Blob([text]),
  } as unknown as Response;
}

/**
 * Desktop behaviour tests.
 *
 * These cover the parts that would silently break a reviewer's day: the client's token handling,
 * the review ordering/approval rules, import-safe routing, the SSE client, and the two screens the
 * acceptance criteria describe in the most concrete terms (sign-in errors and review editing).
 */

const udm: Udm = {
  udmVersion: '1.0.0',
  documentType: 'invoice',
  documentTypeConfidence: 0.62,
  source: { documentId: 'doc-1', pageCount: 1 },
  fields: {
    'invoice.number': {
      label: 'Invoice number',
      value: 'INV-1',
      type: 'string',
      confidence: 0.95,
    },
    'invoice.total': {
      label: 'Total',
      value: 1250,
      type: 'currency',
      currency: 'USD',
      confidence: 0.55,
    },
    'invoice.due_date': { label: 'Due date', value: null, type: 'date', confidence: 0.2 },
  },
  tables: [],
  extractedAt: new Date().toISOString(),
};

describe('formatting', () => {
  it('formats sizes, percentages and dates without throwing on junk', () => {
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(-1)).toBe('—');
    expect(formatPercent(0.876)).toBe('88%');
    expect(formatPercent(null)).toBe('—');
    expect(formatDateTime('not a date')).toBe('—');
    expect(formatDateTime(null)).toBe('—');
    expect(titleCase('purchase_order')).toBe('Purchase Order');
    expect(humanisePath('invoice.purchaseOrder')).toBe('Purchase Order');
  });

  it('labels confidence and status without relying on colour alone', () => {
    expect(confidenceTone(0.9)).toBe('ok');
    expect(confidenceTone(0.7)).toBe('medium');
    expect(confidenceTone(0.3)).toBe('low');
    expect(confidenceTone(undefined)).toBe('low');
    expect(statusTone('approved')).toBe('success');
    expect(statusTone('needs_review')).toBe('warning');
    expect(statusTone('failed')).toBe('danger');
  });
});

describe('review rules (REV-001)', () => {
  const blocking = [
    { path: 'invoice.due_date', reason: 'missing_value' as const, confidence: 0.2 },
    { path: 'invoice.total', reason: 'low_confidence' as const, confidence: 0.55 },
    { path: 'documentType', reason: 'low_confidence' as const, confidence: 0.62 },
    { path: 'invoice.purchase_order', reason: 'missing_value' as const, confidence: 0 },
  ];

  it('puts missing values first, then the least confident field', () => {
    const rows = reviewRows(udm, blocking);
    expect(rows[0]!.reason).toBe('missing_value');
    expect(rows.map((row) => row.path)).toContain('invoice.purchase_order');
    const totalIndex = rows.findIndex((row) => row.path === 'invoice.total');
    const okIndex = rows.findIndex((row) => row.path === 'invoice.number');
    expect(totalIndex).toBeLessThan(okIndex);
  });

  it('only allows approval when nothing is unresolved', () => {
    expect(canApprove([])).toBe(true);
    expect(canApprove(blocking)).toBe(false);
  });

  it('does not bulk-approve a record with unresolved fields', () => {
    expect(bulkApprovable(['a', 'b', 'c'], { a: [], b: blocking, c: [] })).toEqual(['a', 'c']);
  });

  it('builds a PATCH body from edited values only, with type coercion', () => {
    const rows = reviewRows(udm, blocking);
    const changes = pendingChanges(rows, {
      'invoice.total': '1,300',
      'invoice.number': 'INV-1',
      'invoice.due_date': '2024-04-01',
    });

    // Order follows the on-screen order: the missing value is the first row.
    expect(changes).toEqual([
      { fieldPath: 'invoice.due_date', value: '2024-04-01' },
      { fieldPath: 'invoice.total', value: 1300 },
    ]);
  });
});

describe('interface language (I18N-001)', () => {
  afterEach(() => {
    window.localStorage.clear();
    cleanup();
  });

  it('prefers a stored choice, then the browser language, then English', () => {
    expect(resolveLocale('sw', 'fr-FR')).toBe('sw');
    expect(resolveLocale(null, 'sw-KE')).toBe('sw');
    expect(resolveLocale(null, 'fr')).toBe('fr');
    expect(resolveLocale('de', null)).toBe('en');
    expect(resolveLocale(null, null)).toBe('en');
  });

  it('remembers a choice and offers each locale by its own name', () => {
    expect(loadLocale()).toBe('en');
    saveLocale('fr');
    expect(loadLocale()).toBe('fr');
    expect(LOCALE_OPTIONS.map((option) => option.label)).toEqual([
      'English',
      'Kiswahili',
      'Français',
    ]);
  });

  it('translates the navigation and falls back to English for gaps', () => {
    expect(translator('sw')('nav.documents')).toBe('Nyaraka');
    expect(translator('fr')('nav.projects')).toBe('Projets');
    expect(createTranslator('sw')('app.name')).toBe('IDCP');
    // Every locale covers the navigation, so no screen is half in one language.
    for (const locale of ['sw', 'fr'] as const) {
      // I18N-001: the sweep is finished, so both shipped translations cover the whole catalogue.
      expect(translationCoverage(locale)).toBe(1);
      expect(createTranslator(locale)('nav.batches')).toBeTruthy();
    }
  });
});

describe('chart geometry (DASH-001)', () => {
  const points = [
    { date: '2026-10-24', uploaded: 2, approved: 1, failed: 0 },
    { date: '2026-10-25', uploaded: 0, approved: 0, failed: 0 },
    { date: '2026-10-26', uploaded: 4, approved: 4, failed: 1 },
  ];

  it('scales bars to the tallest day and flips y for SVG', () => {
    const chart = buildBarChart(points, 'uploaded', { width: 300, height: 100, gap: 0 });
    expect(chart.max).toBe(4);
    expect(chart.bars).toHaveLength(3);
    expect(chart.bars[0]?.width).toBe(100);
    // The tallest bar reaches the top; the empty day has no height but keeps its slot.
    expect(chart.bars[2]).toMatchObject({ y: 0, height: 100 });
    expect(chart.bars[1]).toMatchObject({ y: 100, height: 0 });
  });

  it('does not divide by zero when nothing has happened', () => {
    const chart = buildBarChart(
      points.map((point) => ({ ...point, uploaded: 0 })),
      'uploaded',
    );
    expect(chart.max).toBe(1);
    expect(chart.bars.every((bar) => bar.height === 0)).toBe(true);
    expect(describeChart(chart, 'documents')).toContain('0 documents');
  });

  it('rounds shares to exactly 100 percent', () => {
    expect(shares({ a: 1, b: 1, c: 1 })).toEqual([
      { key: 'a', value: 1, percent: 34 },
      { key: 'b', value: 1, percent: 33 },
      { key: 'c', value: 1, percent: 33 },
    ]);
    expect(shares({})).toEqual([]);
    expect(shares({ zero: 0, one: 5 })).toEqual([{ key: 'one', value: 5, percent: 100 }]);
  });
});

describe('dashboard (DASH-001)', () => {
  afterEach(cleanup);

  it('draws the 14-day series and states the peak day for screen readers', async () => {
    const timeline = Array.from({ length: 14 }, (_, index) => ({
      date: `2026-10-${String(index + 13).padStart(2, '0')}`,
      uploaded: index === 5 ? 7 : 1,
      approved: 0,
      failed: 0,
    }));

    const client = new ApiClient({
      baseUrl: 'https://idcp.test/api/v1',
      fetchImpl: (async (url: string) => {
        if (String(url).includes('/stats')) {
          return jsonResponse({
            organisationId: 'org-1',
            documents: { queued: 3, approved: 2 },
            totalDocuments: 5,
            jobs: { completed: 5 },
            documentTypes: { invoice: 4, receipt: 1 },
            timeline,
            connectors: { total: 1, active: 1 },
            exports: { total: 1, ready: 1 },
            review: { pending: 3, approved: 2 },
            generatedAt: new Date().toISOString(),
          });
        }
        return jsonResponse({ items: [] });
      }) as unknown as typeof fetch,
    });

    render(<DashboardPage client={client} accessToken={null} />);

    const chart = await screen.findByRole('img');
    expect(chart.getAttribute('aria-label')).toContain('the highest day');
    expect(await screen.findByText('Peak day: 7')).toBeTruthy();
    expect(await screen.findByText(/invoice 4/)).toBeTruthy();
  });
});

describe('routing', () => {
  it('parses hash routes, including a deep link to a record', () => {
    expect(parseRoute('')).toEqual({ name: 'dashboard' });
    expect(parseRoute('#/review?documentId=abc')).toEqual({ name: 'review', documentId: 'abc' });
    expect(parseRoute('#/documents?status=needs_review')).toEqual({
      name: 'documents',
      status: 'needs_review',
    });
    expect(parseRoute('#/nonsense')).toEqual({ name: 'dashboard' });
  });

  it('parses the invitation link the backend mints', () => {
    expect(parseRoute('#/accept-invite?token=abc123')).toEqual({
      name: 'accept-invite',
      token: 'abc123',
    });
    expect(parseRoute('#/batches')).toEqual({ name: 'batches' });
    expect(parseRoute('#/projects')).toEqual({ name: 'projects' });
  });

  it('round-trips a route through its href', () => {
    const href = routeHref({ name: 'review', documentId: 'a b' });
    expect(href).toBe('#/review?documentId=a%20b');
    expect(parseRoute(href)).toEqual({ name: 'review', documentId: 'a b' });
  });
});

describe('API client', () => {
  const okTokens = () =>
    jsonResponse({
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
    });

  it('refreshes once on 401 and retries with the rotated token', async () => {
    const storage = new MemoryTokenStorage();
    await storage.write({ accessToken: 'stale', refreshToken: 'refresh-0' });
    const paths: string[] = [];

    const fetchImpl = (async (url: string, init?: RequestInit) => {
      paths.push(String(url));
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (String(url).endsWith('/auth/refresh')) return okTokens();
      if (authorization === 'Bearer access-1') return jsonResponse({ ok: true });
      return jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'Sign in.' } }, 401);
    }) as unknown as typeof fetch;

    const client = new ApiClient({ baseUrl: 'https://idcp.test/api/v1', storage, fetchImpl });
    const result = await client.request<{ ok: boolean }>('/documents');

    expect(result).toEqual({ ok: true });
    expect(paths).toHaveLength(3);
    expect((await storage.read()).refreshToken).toBe('refresh-1');
    expect(client.currentAccessToken()).toBe('access-1');
  });

  it('surfaces the server message and code, and ends the session when refresh fails', async () => {
    const storage = new MemoryTokenStorage();
    await storage.write({ accessToken: 'stale', refreshToken: 'revoked' });
    let expired = false;

    const fetchImpl = (async () =>
      jsonResponse(
        { error: { code: 'FORBIDDEN', message: 'You do not have permission to do that.' } },
        403,
      )) as unknown as typeof fetch;

    const client = new ApiClient({
      baseUrl: 'https://idcp.test/api/v1',
      storage,
      fetchImpl,
      onSessionExpired: () => {
        expired = true;
      },
    });

    await expect(client.request('/exports')).rejects.toBeInstanceOf(ApiError);
    await expect(client.request('/exports')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
      message: 'You do not have permission to do that.',
    });
    expect(expired).toBe(false); // a 403 is not an expired session
  });
});

describe('realtime client (DESK-002)', () => {
  it('builds an events URL that keeps the token out of the body', () => {
    expect(eventsUrl(null)).toBe('/api/v1/events');
    expect(eventsUrl('a b')).toBe('/api/v1/events?access_token=a%20b');
  });

  it('delivers named events and closes cleanly', async () => {
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      listeners = new Map<string, (event: MessageEvent<string>) => void>();
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      closed = false;

      constructor(readonly url: string) {
        FakeEventSource.instances.push(this);
        setTimeout(() => this.onopen?.(), 0);
      }

      addEventListener(name: string, handler: (event: MessageEvent<string>) => void) {
        this.listeners.set(name, handler);
      }

      close() {
        this.closed = true;
      }
    }

    const received: Array<{ event: string; payload: Record<string, unknown> }> = [];
    let status = '';

    const client = connectRealtime({
      url: '/api/v1/events',
      EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      onStatusChange: (next) => {
        status = next;
      },
      onEvent: (event, payload) => received.push({ event, payload }),
    });

    const source = FakeEventSource.instances[0]!;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(status).toBe('live');

    source.listeners.get('document:approved')?.({
      data: '{"documentId":"doc-9"}',
    } as MessageEvent<string>);
    expect(received).toEqual([{ event: 'document:approved', payload: { documentId: 'doc-9' } }]);

    // Malformed payloads must not throw into the dashboard.
    source.listeners.get('document:failed')?.({ data: 'not json' } as MessageEvent<string>);
    expect(received[1]).toEqual({ event: 'document:failed', payload: {} });

    client.close();
    expect(source.closed).toBe(true);
  });
});

describe('sign-in screen', () => {
  afterEach(cleanup);

  it('shows the server’s message when the password is wrong', async () => {
    const client = new ApiClient({
      baseUrl: 'https://idcp.test/api/v1',
      fetchImpl: (async () =>
        jsonResponse(
          { error: { code: 'UNAUTHENTICATED', message: 'Email or password is incorrect.' } },
          401,
        )) as unknown as typeof fetch,
    });

    render(<LoginPage client={client} onSignedIn={() => undefined} />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'wrong password here' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Email or password is incorrect.');
  });

  it('will not create an account until the terms are accepted (DEC-032)', async () => {
    const register = jest.fn(async () => ({
      id: 'user-1',
      email: 'new@example.com',
      displayName: 'New',
      role: 'owner' as const,
      organisationId: 'org-1',
      organisationName: 'Acme',
    }));
    const client = { register } as unknown as ApiClient;
    render(<LoginPage client={client} onSignedIn={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'Create a new workspace' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText(/^Password/), {
      target: { value: 'a long enough password' },
    });
    fireEvent.change(screen.getByLabelText(/Organisation/), { target: { value: 'Acme' } });

    const submit = screen.getByRole('button', { name: 'Create account' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText(/I accept the Terms of Service/));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    // The checkbox is transmitted as a literal true; the server records the version it shipped.
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ acceptTerms: true }));
  });

  it('offers the 12-character rule while creating an account', () => {
    const client = new ApiClient({
      baseUrl: 'https://idcp.test/api/v1',
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
    });
    render(<LoginPage client={client} onSignedIn={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'Create a new workspace' }));
    expect(screen.getByText('At least 12 characters.')).toBeTruthy();
    expect(screen.getByLabelText(/Organisation/)).toBeTruthy();
  });
});

describe('review screen', () => {
  afterEach(cleanup);

  const reviewSession = {
    reviewId: 'rev-1',
    status: 'in_progress' as const,
    document: {
      id: 'doc-1',
      status: 'needs_review',
      documentType: 'invoice' as const,
      mimeType: 'image/png',
      sizeBytes: 1024,
      pageCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    documentType: 'invoice' as const,
    documentTypeConfidence: 0.62,
    udm,
    blocking: [
      { path: 'invoice.total', reason: 'low_confidence' as const, confidence: 0.55 },
      { path: 'invoice.due_date', reason: 'missing_value' as const, confidence: 0.2 },
    ],
    changes: [],
  };

  function fakeClient(overrides: Partial<ApiClient> = {}): ApiClient {
    const client = {
      reviewQueue: async () => ({
        items: [
          {
            document: reviewSession.document,
            extractionId: 'ext-1',
            confidence: 0.62,
            blockingFields: reviewSession.blocking,
          },
        ],
        total: 1,
      }),
      openReview: async () => reviewSession,
      patchFields: jest.fn(async () => ({
        blocking: [],
        reviewId: 'rev-1',
        extractionId: 'ext-2',
        applied: 1,
        documentType: 'invoice',
      })),
      approveReview: jest.fn(async () => ({
        reviewId: 'rev-1',
        documentId: 'doc-1',
        status: 'approved',
      })),
      rejectReview: jest.fn(),
    };
    return Object.assign(client, overrides) as unknown as ApiClient;
  }

  it('shows the queue and disables approval until the blockers are resolved', async () => {
    const client = fakeClient();
    render(<ReviewPage client={client} initialDocumentId="doc-1" />);

    await waitFor(() => expect(screen.getByText('Invoice number')).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText('2 to resolve')).toBeTruthy();
  });

  it('records a correction and enables approval when nothing is left to check', async () => {
    const client = fakeClient();
    render(<ReviewPage client={client} initialDocumentId="doc-1" />);

    const dueDate = await screen.findByLabelText('Due date value');
    fireEvent.change(dueDate, { target: { value: '2024-04-01' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(client.patchFields).toHaveBeenCalled());
    expect((client.patchFields as jest.Mock).mock.calls[0]![1]).toEqual([
      { fieldPath: 'invoice.due_date', value: '2024-04-01' },
    ]);
  });
});

describe('batch screen (BATCH-001)', () => {
  afterEach(cleanup);

  const batch = {
    id: 'batch-1',
    name: 'Morning intake',
    total: 2,
    processed: 2,
    succeeded: 1,
    failed: 1,
    status: 'completed_with_errors' as const,
    createdAt: new Date().toISOString(),
    items: [
      { position: 0, filename: 'a.png', documentId: 'doc-a', status: 'succeeded' as const },
      {
        position: 1,
        filename: 'notes.txt',
        documentId: null,
        status: 'failed' as const,
        error: 'That file type is not supported.',
      },
    ],
  };

  it('shows per-file failures instead of hiding them', async () => {
    const client = new ApiClient({
      baseUrl: 'https://idcp.test/api/v1',
      fetchImpl: (async (url: string) => {
        if (String(url).includes('/projects')) return jsonResponse({ items: [] });
        return jsonResponse({ items: [batch] });
      }) as unknown as typeof fetch,
    });

    render(<BatchesPage client={client} />);

    expect(await screen.findByText('Morning intake')).toBeTruthy();
    expect(screen.getByText('completed with errors')).toBeTruthy();
    expect(screen.getByText('1 failed', { exact: false })).toBeTruthy();
  });
});

describe('projects screen (TEAM-001)', () => {
  afterEach(cleanup);

  it('archives a project rather than deleting it', async () => {
    const calls: string[] = [];
    const client = new ApiClient({
      baseUrl: 'https://idcp.test/api/v1',
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if ((init?.method ?? 'GET') === 'PATCH') {
          return jsonResponse({
            id: 'p1',
            name: 'Records',
            key: 'REC',
            archivedAt: new Date().toISOString(),
          });
        }
        return jsonResponse({
          items: [{ id: 'p1', name: 'Records', key: 'REC', createdAt: new Date().toISOString() }],
        });
      }) as unknown as typeof fetch,
    });

    render(<ProjectsPage client={client} canManage />);

    expect(await screen.findByText('Records')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(calls.some((call) => call.startsWith('PATCH'))).toBe(true));
  });
});

describe('accept-invitation screen (TEAM-001)', () => {
  afterEach(cleanup);

  it('insists the two passwords match before calling the API', async () => {
    let called = false;
    const client = new ApiClient({
      baseUrl: 'https://idcp.test/api/v1',
      fetchImpl: (async () => {
        called = true;
        return jsonResponse({});
      }) as unknown as typeof fetch,
    });

    render(<AcceptInvitePage client={client} token="token-123" onAccepted={() => undefined} />);

    fireEvent.change(screen.getByLabelText(/^Password/), {
      target: { value: 'a much better password' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'something else entirely' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set password and sign in' }));

    expect((await screen.findByRole('alert')).textContent).toContain('do not match');
    expect(called).toBe(false);
  });
});

describe('duplicate check before sending (DUP-001)', () => {
  afterEach(cleanup);

  function stubClient(overrides: Partial<Record<string, unknown>> = {}): ApiClient {
    return {
      listConnectors: async () => ({
        items: [
          {
            id: 'conn-1',
            type: 'sqlite',
            name: 'Accounts DB',
            status: 'active',
            config: {},
            createdAt: new Date().toISOString(),
          },
        ],
      }),
      listMappingProfiles: async () => ({
        items: [
          {
            id: 'map-1',
            connectorId: 'conn-1',
            documentType: 'invoice',
            name: 'Invoices',
            fieldMap: [],
            duplicatePolicy: 'skip',
            duplicateKeys: ['invoice_number'],
            createdAt: new Date().toISOString(),
          },
        ],
      }),
      checkDuplicates: async () => ({
        connectorId: 'conn-1',
        mappingProfileId: 'map-1',
        documentId: 'doc-1',
        keys: ['invoice_number'],
        policy: 'skip',
        threshold: 0.85,
        isDuplicate: true,
        bestScore: 1,
        matchedKeys: ['invoice_number'],
        candidates: [
          { score: 1, matchedKeys: ['invoice_number'], values: { invoice_number: 'INV-1042' } },
        ],
      }),
      sendDocument: async () => ({
        status: 'skipped_duplicate',
        summary: 'A matching record already exists; skipped.',
        created: 0,
        updated: 0,
        skipped: 1,
      }),
      ...overrides,
    } as unknown as ApiClient;
  }

  it('shows the score, the matched keys and the existing row', async () => {
    render(<SendToDestination client={stubClient()} documentId="doc-1" approved />);

    // Wait for the connector to load: a select cannot take a value it does not yet offer.
    await screen.findByRole('option', { name: 'Accounts DB' });
    fireEvent.change(screen.getByLabelText('Connector'), { target: { value: 'conn-1' } });
    fireEvent.change(await screen.findByLabelText('Mapping profile'), {
      target: { value: 'map-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check for duplicates' }));

    expect(await screen.findByText('duplicate found')).toBeTruthy();
    // The matched key and the existing row are shown as evidence, not just a verdict.
    expect((await screen.findAllByText(/invoice_number/)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/INV-1042/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/best score 100%/)).toBeTruthy();
  });

  it('does not offer sending for an unapproved record', () => {
    render(<SendToDestination client={stubClient()} documentId="doc-1" approved={false} />);
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(screen.getByText(/Approve this record before sending/i)).toBeTruthy();
  });
});

describe('correction learning (REV-002)', () => {
  const stats = {
    optIn: false,
    total: 3,
    byField: [
      { fieldPath: 'invoice.number', corrections: 2, averageConfidence: 0.42 },
      { fieldPath: 'total.amount', corrections: 1, averageConfidence: 0.71 },
    ],
    byDocumentType: [{ documentType: 'invoice', corrections: 3, averageConfidence: 0.5 }],
  };

  function settingsClient(overrides: Record<string, unknown> = {}): ApiClient {
    return {
      organisation: async () => ({
        id: 'org-1',
        name: 'Test Trading',
        slug: 'test-trading',
        plan: 'free',
        retentionDays: 90,
        aiProvider: 'local',
        learningOptIn: false,
        createdAt: new Date().toISOString(),
      }),
      listUsers: async () => ({ items: [] }),
      auditLogs: async () => ({ items: [] }),
      listApiKeys: async () => ({ items: [] }),
      correctionStats: async () => stats,
      updateOrganisation: async (input: { learningOptIn?: boolean }) => ({
        id: 'org-1',
        name: 'Test Trading',
        slug: 'test-trading',
        plan: 'free',
        retentionDays: 90,
        aiProvider: 'local',
        learningOptIn: Boolean(input.learningOptIn),
        createdAt: new Date().toISOString(),
      }),
      exportCorrections: async () => ({
        organisationId: 'org-1',
        exportedAt: new Date().toISOString(),
        rows: [],
      }),
      ...overrides,
    } as unknown as ApiClient;
  }

  it('shows which fields keep needing correction, without any document content', async () => {
    render(<SettingsPage client={settingsClient()} role="owner" />);

    expect(await screen.findByText('invoice.number')).toBeTruthy();
    expect(screen.getByText('total.amount')).toBeTruthy();
    // Average confidence is formatted for humans, not printed as a raw float.
    expect(screen.getByText('42%')).toBeTruthy();
    expect(screen.getByText('Not enabled')).toBeTruthy();
  });

  it('keeps training export off until an admin opts in', async () => {
    const updateOrganisation = jest.fn(async () => ({
      id: 'org-1',
      name: 'Test Trading',
      slug: 'test-trading',
      plan: 'free',
      retentionDays: 90,
      aiProvider: 'local',
      learningOptIn: true,
      createdAt: new Date().toISOString(),
    }));
    render(<SettingsPage client={settingsClient({ updateOrganisation })} role="owner" />);

    const toggle = (await screen.findByLabelText(
      /Use corrections to improve extraction/i,
    )) as HTMLInputElement;
    const exportButton = screen.getByRole('button', {
      name: 'Export corrections',
    }) as HTMLButtonElement;
    expect(toggle.checked).toBe(false);
    expect(exportButton.disabled).toBe(true);

    fireEvent.click(toggle);
    await waitFor(() => expect(updateOrganisation).toHaveBeenCalled());
    expect(updateOrganisation).toHaveBeenCalledWith({ learningOptIn: true });
  });

  it('downloads the audit log as a file for an auditor (AUDIT-2026-10)', async () => {
    URL.createObjectURL = jest.fn(() => 'blob:audit');
    URL.revokeObjectURL = jest.fn();
    const auditLogCsv = jest.fn(async () => ({
      blob: new Blob(['created_at,action\r\n'], { type: 'text/csv' }),
      filename: 'audit-log-2026-10-27.csv',
    }));
    render(<SettingsPage client={settingsClient({ auditLogCsv })} role="owner" />);
    await screen.findByText('invoice.number');

    fireEvent.click(screen.getByRole('button', { name: 'Download audit log' }));

    await waitFor(() => expect(auditLogCsv).toHaveBeenCalledTimes(1));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect((await screen.findByRole('status')).textContent).toContain('Audit log downloaded');
  });

  it('does not show the opt-in to a reviewer', async () => {
    render(<SettingsPage client={settingsClient()} role="reviewer" />);
    await screen.findByText('invoice.number');
    expect(screen.queryByRole('button', { name: 'Export corrections' })).toBeNull();
  });
});

describe('desktop job dashboard (DESK-002)', () => {
  afterEach(cleanup);

  const cleanDocument = {
    id: 'doc-clean',
    status: 'needs_review',
    documentType: 'receipt' as const,
    mimeType: 'image/png',
    sizeBytes: 512,
    pageCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const blockedDocument = { ...cleanDocument, id: 'doc-blocked', documentType: 'invoice' as const };

  it('bulk approves only the records with nothing left to check, and says what it skipped', async () => {
    const bulkApprove = jest.fn(async () => ({
      approved: ['doc-clean'],
      skipped: [{ documentId: 'doc-blocked', blocking: [] }],
    }));
    const client = {
      reviewQueue: async () => ({
        items: [
          { document: cleanDocument, extractionId: 'e1', confidence: 0.97, blockingFields: [] },
          {
            document: blockedDocument,
            extractionId: 'e2',
            confidence: 0.4,
            blockingFields: [{ path: 'invoice.total', reason: 'low_confidence', confidence: 0.4 }],
          },
        ],
        total: 2,
      }),
      bulkApprove,
    } as unknown as ApiClient;

    render(<ReviewPage client={client} />);

    const select = await screen.findByRole('button', { name: 'Select clean (1)' });
    fireEvent.click(select);
    fireEvent.click(screen.getByRole('button', { name: 'Approve selected (1)' }));

    await waitFor(() => expect(bulkApprove).toHaveBeenCalledWith(['doc-clean']));
    expect(await screen.findByText(/Skipped 1\./)).toBeTruthy();
    expect(screen.getByText(/invoice \(1\)/)).toBeTruthy();
  });

  it('narrows the document list by device, alongside status, type and date', async () => {
    const listDocuments = jest.fn(async (_query: Record<string, unknown>) => ({
      items: [],
      nextCursor: null,
    }));
    const client = {
      listDevices: async () => ({
        items: [{ id: 'dev-1', name: 'Front desk phone', platform: 'android', status: 'active' }],
      }),
      listDocuments,
    } as unknown as ApiClient;

    render(<DocumentsPage client={client} onOpenReview={() => undefined} />);

    const device = await screen.findByLabelText('Device');
    await screen.findByRole('option', { name: 'Front desk phone' });
    fireEvent.change(device, { target: { value: 'dev-1' } });

    await waitFor(() =>
      expect(listDocuments).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'dev-1' })),
    );
  });
});

describe('connector marketplace (MARKET-001)', () => {
  afterEach(cleanup);

  const hubspot = {
    id: 'hubspot-crm',
    type: 'hubspot',
    label: 'HubSpot CRM',
    vendor: 'HubSpot',
    version: '1.1.0',
    summary: 'Create and update HubSpot objects from approved documents.',
    permissions: ['documents:read', 'destination:write', 'network:outbound'],
    status: 'verified' as const,
    signature: 'sig',
    signatureVerified: true,
    installedVersions: [],
    availableVersions: ['1.1.0', '1.0.0'],
    activeInstallId: null,
    installable: true,
    blocker: null,
    availableConnectors: [{ id: 'conn-1', name: 'HubSpot sandbox' }],
  };
  const withdrawn = {
    ...hubspot,
    id: 'zoho-crm',
    type: 'zoho',
    label: 'Zoho CRM (withdrawn)',
    vendor: 'Zoho',
    version: '0.9.0',
    status: 'revoked' as const,
    revokedReason: 'Withdrawn by the vendor: the API version it used is retired.',
    installedVersions: [],
    availableVersions: ['0.9.0'],
    installable: false,
    blocker: 'Zoho CRM (withdrawn) has been withdrawn: the API version it used is retired.',
    availableConnectors: [],
  };

  function marketplaceClient(overrides: Record<string, unknown> = {}) {
    const installPackage = jest.fn(async () => ({
      id: 'install-1',
      packageId: 'hubspot-crm',
      version: '1.1.0',
      connectorId: 'conn-1',
      permissions: hubspot.permissions,
      installedAt: new Date().toISOString(),
      status: 'active',
    }));
    const rollbackPackage = jest.fn(async () => ({
      rolledBack: 'hubspot-crm',
      activeVersion: '1.0.0',
      message: 'Rolled back to 1.0.0.',
    }));
    return {
      installPackage,
      rollbackPackage,
      client: {
        listMarketplace: async () => ({ items: [hubspot, withdrawn] }),
        installPackage,
        rollbackPackage,
        ...overrides,
      } as unknown as ApiClient,
    };
  }

  it('discloses what a package will be allowed to do before it can be installed', async () => {
    const { client } = marketplaceClient();
    render(<MarketplacePage client={client} />);

    expect(await screen.findByText('HubSpot CRM')).toBeTruthy();
    // Permissions are sentences, not scope strings. Two packages disclose the same permission, so
    // both lists are expected.
    expect(screen.getAllByText('Create records in the destination').length).toBe(2);
    expect(screen.getAllByText('Make outbound network requests').length).toBeGreaterThan(0);
    expect(permissionLabel('destination:update')).toMatch(/Change records/);
    expect(screen.getAllByText('signature verified').length).toBe(2);
  });

  it('keeps a withdrawn package visible and refuses to install it', async () => {
    const { client } = marketplaceClient();
    render(<MarketplacePage client={client} />);

    await screen.findByText('HubSpot CRM');
    expect(screen.getByText('Zoho CRM (withdrawn)')).toBeTruthy();
    expect(screen.getByText(/Withdrawn by the vendor/)).toBeTruthy();

    const installButtons = screen.getAllByRole('button', {
      name: 'Install',
    }) as HTMLButtonElement[];
    // The withdrawn package's button is disabled; the signed one is not.
    expect(installButtons.some((button) => button.disabled)).toBe(true);
    expect(installButtons.some((button) => !button.disabled)).toBe(true);
  });

  it('installs onto the chosen connector and rolls back when asked', async () => {
    const { client, installPackage, rollbackPackage } = marketplaceClient({
      listMarketplace: async () => ({
        items: [
          { ...hubspot, activeInstallId: 'install-1', installedVersions: ['1.1.0'] },
          withdrawn,
        ],
      }),
    });
    render(<MarketplacePage client={client} />);

    const connector = await screen.findByLabelText('Connector for HubSpot CRM');
    expect((connector as HTMLSelectElement).value).toBe('conn-1');

    fireEvent.click(screen.getByRole('button', { name: 'Roll back' }));
    await waitFor(() => expect(rollbackPackage).toHaveBeenCalledWith('install-1'));
    expect(await screen.findByText('Rolled back to 1.0.0.')).toBeTruthy();
    expect(installPackage).not.toHaveBeenCalled();
  });

  it('installs a package and reports the version that landed', async () => {
    const { client, installPackage } = marketplaceClient();
    render(<MarketplacePage client={client} />);

    await screen.findByText('HubSpot CRM');
    // The withdrawn package also renders an (disabled) Install button, so pick the enabled one.
    const install = screen
      .getAllByRole('button', { name: 'Install' })
      .find((button) => !(button as HTMLButtonElement).disabled)!;
    fireEvent.click(install);

    await waitFor(() =>
      expect(installPackage).toHaveBeenCalledWith({
        packageId: 'hubspot-crm',
        connectorId: 'conn-1',
      }),
    );
    expect(await screen.findByText('HubSpot CRM 1.1.0 installed.')).toBeTruthy();
  });
});

describe('workflow automation (AGENT-001)', () => {
  afterEach(cleanup);

  const rule = {
    id: 'wf-1',
    name: 'File large invoices',
    trigger: 'document.approved',
    documentType: 'invoice',
    conditions: [{ field: 'total.amount', operator: 'greater_than', value: 100 }],
    actions: [{ type: 'notify' }, { type: 'send_to_connector' }],
    approvalPolicy: 'always_ask' as const,
    enabled: true,
  };
  const pendingRun = {
    id: 'run-1',
    workflowId: 'wf-1',
    documentId: 'doc-1',
    trigger: 'document.approved',
    status: 'awaiting_approval' as const,
    matched: true,
    explanation: 'Matched: Applies to invoice, total.amount greater than 100.',
    actions: [
      {
        type: 'send_to_connector',
        requiresApproval: true,
        reason: 'Writes to an external system.',
      },
    ],
    outputs: [],
    failure: null,
    approvedBy: null,
    createdAt: new Date().toISOString(),
  };

  it('reads a rule back as a sentence and flags the steps that wait for a person', () => {
    expect(describeRule(rule)).toBe(
      'When a invoice is document approved, if total.amount greater than 100, ' +
        'send a notification, then send the record to a connector ' +
        '(a person approves the destructive steps).',
    );
    // Plain notification needs nobody; anything touching a destination, an export or a delete does.
    expect(DESTRUCTIVE_ACTIONS).toEqual(['send_to_connector', 'create_export', 'delete_document']);
    expect(actionLabel('delete_document')).toBe('Delete the document');
  });

  function workflowClient(overrides: Record<string, unknown> = {}) {
    const approveWorkflowRun = jest.fn(async () => ({
      ...pendingRun,
      status: 'completed' as const,
      outputs: ['send queued for connector conn-9'],
      approvedBy: 'user-1',
    }));
    const createWorkflow = jest.fn(async () => rule);
    return {
      approveWorkflowRun,
      createWorkflow,
      client: {
        listWorkflows: async () => ({ items: [rule] }),
        workflowRuns: async () => ({ items: [pendingRun] }),
        createWorkflow,
        setWorkflowEnabled: async () => ({ ...rule, enabled: false }),
        approveWorkflowRun,
        ...overrides,
      } as unknown as ApiClient,
    };
  }

  it('surfaces a run waiting for approval and shows what it will do', async () => {
    const { client, approveWorkflowRun } = workflowClient();
    render(<WorkflowsPage client={client} />);

    expect(await screen.findByText(/Waiting for approval/)).toBeTruthy();
    // It appears twice on purpose: in the approval queue and in the run log below it.
    expect(screen.getAllByText(pendingRun.explanation).length).toBe(2);
    // The builder shows the sentence it is about to save.
    expect(screen.getByText(/When a record is document approved/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Approve run' }));
    await waitFor(() => expect(approveWorkflowRun).toHaveBeenCalledWith('run-1'));
    expect(await screen.findByText(/send queued for connector conn-9/)).toBeTruthy();
  });

  it('saves the rule the builder described', async () => {
    const { client, createWorkflow } = workflowClient();
    render(<WorkflowsPage client={client} />);

    const name = await screen.findByPlaceholderText('File large invoices');
    fireEvent.change(name, { target: { value: 'Notify on approval' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }));
    await waitFor(() =>
      expect(createWorkflow).toHaveBeenCalledWith({
        name: 'Notify on approval',
        trigger: 'document.approved',
        documentType: null,
        conditions: [],
        actions: [{ type: 'notify' }],
        approvalPolicy: 'always_ask',
      }),
    );

    // The saved rule is listed, and its state can be changed.
    expect(await screen.findByText('File large invoices')).toBeTruthy();
    expect(screen.getAllByText('enabled').length).toBeGreaterThan(0);
  });
});

describe('localisation sweep (I18N-001)', () => {
  afterEach(cleanup);

  const client = {} as unknown as ApiClient;

  it('renders a page in Swahili when the provider says so, and switches at runtime', async () => {
    function Switcher(): React.JSX.Element {
      const [locale, setLocale] = React.useState<'en' | 'sw'>('en');
      return (
        <>
          <button type="button" onClick={() => setLocale('sw')}>
            switch
          </button>
          <LocaleProvider locale={locale}>
            <LoginPage client={client} onSignedIn={() => undefined} />
          </LocaleProvider>
        </>
      );
    }
    render(<Switcher />);

    // English first, then the same component with a different provider value.
    expect(await screen.findByText('Sign in to IDCP')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'switch' }));
    expect(await screen.findByText('Ingia kwenye IDCP')).toBeTruthy();
    // The fields are translated too, not just the heading.
    expect(screen.getAllByText('Nenosiri').length).toBeGreaterThan(0);
  });

  it('formats dates and numbers for the reader, not the server', () => {
    const iso = '2026-10-26T14:05:00.000Z';
    const english = formatDateTime(iso, 'en');
    const french = formatDateTime(iso, 'fr');
    expect(english).not.toBe(french);
    expect(english).toContain('2026');
    expect(french).toContain('2026');
    // Percentages use the locale's own separator and spacing.
    expect(formatPercent(0.85, 'en')).toBe('85%');
    expect(formatPercent(0.85, 'fr')).toMatch(/85\s*%/u);
    // Thousands separators, and a relative phrase from Intl rather than a hand-rolled table.
    expect(formatNumber(1234567, 'en')).toBe('1,234,567');
    expect(formatNumber(1234567, 'fr')).not.toBe('1,234,567');
    expect(formatRelative('2026-10-26T13:00:00.000Z', 'en', Date.parse(iso))).toBe('1 hour ago');
    expect(formatDateTime(null, 'fr')).toBe('—');
  });

  it('labels enum values from the catalogue and falls back to the raw value', () => {
    const t = translator('sw');
    expect(statusLabel(t, 'needs_review')).toBe('Inahitaji ukaguzi');
    expect(documentTypeLabel(t, 'invoice')).toBe('Ankara');
    expect(roleLabel(t, 'admin')).toBe('Msimamizi');
    // A status the catalogue does not know yet stays readable instead of showing underscores.
    expect(statusLabel(translator('en'), 'brand_new')).toBe('brand new');
  });

  it('sets the document direction from the language', () => {
    applyDocumentLocale('fr');
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('fr');

    // The shipped locales are LTR; an RTL language flips the root element with no layout change.
    applyDocumentLocale('ar' as never);
    expect(document.documentElement.dir).toBe('rtl');
    expect(directionFor('ar')).toBe('rtl');
    expect(directionFor('sw')).toBe('ltr');

    applyDocumentLocale('en');
  });

  it('has no physical left/right CSS left to clip an RTL layout', () => {
    const css = readFileSync(join(__dirname, '../src/styles.css'), 'utf8');
    expect(css).toContain('border-inline-end');
    expect(css).toContain('text-align: start');
    expect(css).toContain("[dir='rtl']");
    expect(css).not.toMatch(/border-(left|right):/);
    expect(css).not.toMatch(/(margin|padding)-(left|right):/);
    expect(css).not.toMatch(/text-align:\s*(left|right);/);
  });

  it('uses logical alignment in the components as well', () => {
    const files = [
      'pages/DocumentsPage.tsx',
      'pages/SettingsPage.tsx',
      'workflows/WorkflowsPage.tsx',
    ];
    for (const file of files) {
      const source = readFileSync(join(__dirname, '../src', file), 'utf8');
      expect(source).not.toMatch(/textAlign:\s*'(left|right)'/);
    }
  });

  it('exposes the translator to any component, defaulting to English without a provider', () => {
    function Probe(): React.JSX.Element {
      const t = useTranslator();
      return <span>{t('nav.documents')}</span>;
    }
    render(<Probe />);
    expect(screen.getByText('Documents')).toBeTruthy();
  });
});

describe('account page: password, sessions and privacy', () => {
  afterEach(cleanup);

  const session = (
    id: string,
    overrides: Partial<{ userAgent: string | null; current: boolean }> = {},
  ) => ({
    id,
    createdAt: '2026-10-27T08:00:00.000Z',
    expiresAt: '2026-11-26T08:00:00.000Z',
    userAgent: overrides.userAgent ?? 'Firefox on Linux',
    current: overrides.current ?? false,
  });

  function accountClient(overrides: Partial<ApiClient> = {}): ApiClient {
    const client = {
      sessions: async () => [
        session('s-1', { userAgent: 'Firefox on Linux', current: true }),
        session('s-2', { userAgent: 'Pixel 8' }),
      ],
      me: async () => ({
        id: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner',
        role: 'owner',
        organisationId: 'org-1',
        organisationName: 'Acme',
        terms: { acceptedAt: '2026-10-27T08:00:00.000Z', version: '2026-10', current: true },
      }),
      acceptTerms: jest.fn(async () => ({
        acceptedAt: '2026-10-27T09:00:00.000Z',
        version: '2026-10',
        current: true,
      })),
      changePassword: jest.fn(async () => ({ revokedSessions: 2 })),
      revokeSession: jest.fn(async () => undefined),
      logoutAll: jest.fn(async () => ({ revokedSessions: 2 })),
      exportMyData: jest.fn(async () => ({
        generatedAt: '2026-10-27T08:30:00.000Z',
        formatVersion: 1,
        account: {
          id: 'user-1',
          email: 'owner@example.com',
          displayName: 'Owner',
          locale: 'en',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastLoginAt: null,
        },
        organisations: [],
        documents: [],
        reviews: [],
        auditEntries: [],
        notes: [],
      })),
      eraseAccount: jest.fn(async () => ({
        erased: true,
        anonymisedAt: '2026-10-27T08:35:00.000Z',
        retainedRecords: 'Approved records',
      })),
      ...overrides,
    };
    return client as unknown as ApiClient;
  }

  beforeEach(() => {
    // jsdom has neither, and a real download is not what is under test here.
    URL.createObjectURL = jest.fn(() => 'blob:my-data');
    URL.revokeObjectURL = jest.fn();
  });

  it('lists the sessions and marks the one the app is using', async () => {
    render(<AccountPage client={accountClient()} onSessionEnded={() => undefined} />);

    expect(await screen.findAllByTestId('session-row')).toHaveLength(2);
    expect(screen.getByText('Firefox on Linux')).toBeTruthy();
    expect(screen.getByText('Pixel 8')).toBeTruthy();
    expect(screen.getAllByText(/This device/).length).toBeGreaterThan(0);
  });

  it('signs out everywhere and hands the shell back to the sign-in screen', async () => {
    const client = accountClient();
    const onSessionEnded = jest.fn();
    render(<AccountPage client={client} onSessionEnded={onSessionEnded} />);
    await screen.findAllByTestId('session-row');

    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));

    await waitFor(() => expect(client.logoutAll).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalledTimes(1));
  });

  it('changes the password and says how many other sign-ins were ended', async () => {
    const client = accountClient();
    render(<AccountPage client={client} onSessionEnded={() => undefined} />);
    await screen.findAllByTestId('session-row');

    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'correct horse battery staple' },
    });
    fireEvent.change(screen.getByLabelText(/^New password/), {
      target: { value: 'a brand new passphrase' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() => expect(client.changePassword).toHaveBeenCalledTimes(1));
    expect((await screen.findByRole('status')).textContent).toContain('2 other sign-in');
  });

  it('downloads the data export as a dated json file', async () => {
    const client = accountClient();
    render(<AccountPage client={client} onSessionEnded={() => undefined} />);
    await screen.findAllByTestId('session-row');

    fireEvent.click(screen.getByRole('button', { name: 'Download my data' }));

    await waitFor(() => expect(client.exportMyData).toHaveBeenCalledTimes(1));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect((await screen.findByRole('status')).textContent).toContain('downloaded');
  });

  it('shows which version of the terms this account accepted', async () => {
    render(<AccountPage client={accountClient()} onSessionEnded={() => undefined} />);
    await screen.findAllByTestId('session-row');

    expect(screen.getByText(/Terms version 2026-10 accepted on/)).toBeTruthy();
    // Nothing to press when the record is current.
    expect(screen.queryByRole('button', { name: 'Accept the current terms' })).toBeNull();
  });

  it('asks an account on an older pack to accept, and records it', async () => {
    const client = accountClient({
      me: async () => ({
        id: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner',
        role: 'owner',
        organisationId: 'org-1',
        organisationName: 'Acme',
        terms: { acceptedAt: '2020-01-10T08:00:00.000Z', version: '2020-01', current: false },
      }),
    });
    render(<AccountPage client={client} onSessionEnded={() => undefined} />);
    await screen.findAllByTestId('session-row');

    expect(
      screen.getByText(/The terms were revised after you accepted version 2020-01/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept the current terms' }));

    await waitFor(() => expect(client.acceptTerms).toHaveBeenCalledTimes(1));
    expect((await screen.findByRole('status')).textContent).toContain('current terms are accepted');
  });

  it('will not erase until DELETE is typed, then ends the session', async () => {
    const client = accountClient();
    const onSessionEnded = jest.fn();
    render(<AccountPage client={client} onSessionEnded={onSessionEnded} />);
    await screen.findAllByTestId('session-row');

    const button = screen.getByRole('button', { name: 'Erase permanently' }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), {
      target: { value: 'delete' },
    });
    fireEvent.change(screen.getByLabelText(/^Password/), {
      target: { value: 'secret passphrase' },
    });
    expect(button.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), {
      target: { value: 'DELETE' },
    });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);

    await waitFor(() =>
      expect(client.eraseAccount).toHaveBeenCalledWith({ password: 'secret passphrase' }),
    );
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalledTimes(1));
  });
});
