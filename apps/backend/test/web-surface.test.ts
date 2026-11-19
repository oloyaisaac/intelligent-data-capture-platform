import { createHarness, type Harness } from './helpers';

/**
 * The public web surface: security headers and the legal documents.
 *
 * Headers are checked on a real response because that is the only place they matter; the legal
 * documents are checked through the API because that is how the desktop app and a customer's auditor
 * reach them — no sign-in required, and no path traversal.
 */
describe('HTTP surface', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('sends the baseline security headers on every response', async () => {
    const response = await harness.api.get('/api/v1/health');
    expect(response.statusCode).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('permissions-policy')).toContain('microphone=()');
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('returns degraded readiness when the database probe fails', async () => {
    const probe = jest
      .spyOn(harness.db, 'one')
      .mockRejectedValueOnce(new Error('database offline'));
    try {
      const response = await harness.api.get('/api/v1/health');
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ status: 'degraded', dependencies: { db: 'error' } });
      expect(response.body).not.toContain('database offline');
    } finally {
      probe.mockRestore();
    }
  });

  it('returns the version injected into the service configuration', async () => {
    const configured = await createHarness({ npm_package_version: '9.8.7-test' });
    try {
      const response = await configured.api.get('/api/v1/health');
      expect(response.statusCode).toBe(200);
      expect(response.json<{ version: string }>().version).toBe('9.8.7-test');
    } finally {
      await configured.close();
    }
  });

  it('does not send HSTS from a development server', async () => {
    const response = await harness.api.get('/api/v1/health');
    // Sending HSTS over plain HTTP would poison localhost for the developer's browser.
    expect(response.headers.get('strict-transport-security')).toBeNull();
  });

  it('serves the legal documents without a session', async () => {
    const index = await harness.api.get('/api/v1/legal');
    expect(index.statusCode).toBe(200);
    const body = index.json<{ documents: Array<{ slug: string; title: string }> }>();
    expect(body.documents.map((entry) => entry.slug)).toEqual([
      'privacy',
      'terms',
      'dpa',
      'subprocessors',
      'security',
    ]);

    const privacy = await harness.api.get('/api/v1/legal/privacy');
    expect(privacy.statusCode).toBe(200);
    expect(privacy.headers.get('content-type')).toContain('text/plain');
    expect(privacy.body).toContain('Privacy Policy');
    expect(privacy.body).toContain('Data Protection and Privacy Act');
  });

  it('refuses an unknown document and a traversal attempt', async () => {
    const unknown = await harness.api.get('/api/v1/legal/nope');
    expect(unknown.statusCode).toBe(404);
    const traversal = await harness.api.get('/api/v1/legal/..%2F..%2Fpackage.json');
    expect(traversal.statusCode).toBe(404);
  });
});
