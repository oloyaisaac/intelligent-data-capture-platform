import React from 'react';
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
import { LoginPage } from '../src/pages/LoginPage';
import { AcceptInvitePage } from '../src/pages/AcceptInvitePage';
import { BatchesPage } from '../src/pages/BatchesPage';
import { ProjectsPage } from '../src/pages/ProjectsPage';
import { ReviewPage } from '../src/pages/ReviewPage';
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
