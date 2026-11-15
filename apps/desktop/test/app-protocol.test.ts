import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APP_ORIGIN,
  apiBaseUrlFromBuildConfig,
  ApiBaseUrlError,
  buildContentSecurityPolicy,
  contentTypeFor,
  originOf,
  rendererDirectory,
  resolveApiBaseUrl,
  resolveAppAsset,
} from '../src/main/app-protocol';

/**
 * MC-01 / MC-02 — the packaged app must be able to reach its backend.
 *
 * The original defect: the renderer was loaded with `loadFile()`, so `/api/v1` resolved against
 * `file://` and every request failed, including sign-in. These tests fail against that code because
 * there was no API-origin resolution at all and the policy never contained an API origin.
 */
describe('packaged API origin (MC-01)', () => {
  it('reads the generated build configuration and rejects malformed JSON', () => {
    expect(apiBaseUrlFromBuildConfig('{"apiBaseUrl":"https://api.example.com/api/v1"}')).toBe(
      'https://api.example.com/api/v1',
    );
    expect(apiBaseUrlFromBuildConfig('{"other":"value"}')).toBeUndefined();
    expect(apiBaseUrlFromBuildConfig('{"apiBaseUrl":42}')).toBeUndefined();
    expect(() => apiBaseUrlFromBuildConfig('{')).toThrow(ApiBaseUrlError);
  });

  it('requires an absolute API origin for a packaged build instead of silently defaulting', () => {
    // The old behaviour: no baseUrl → '/api/v1' → file:///api/v1 in the packaged app.
    expect(() => resolveApiBaseUrl(undefined, true)).toThrow(ApiBaseUrlError);
    expect(() => resolveApiBaseUrl('   ', true)).toThrow(/API_BASE_URL is required/);
  });

  it('keeps the relative default in development, where the dev server proxies /api', () => {
    expect(resolveApiBaseUrl(undefined, false)).toBe('');
  });

  it('accepts an absolute https origin and normalises a trailing slash', () => {
    expect(resolveApiBaseUrl('https://api.example.com/api/v1/', false)).toBe(
      'https://api.example.com/api/v1',
    );
    expect(resolveApiBaseUrl('https://api.example.com/api/v1', true)).toBe(
      'https://api.example.com/api/v1',
    );
  });

  it('allows plain http only for loopback, because a token over cleartext is not acceptable', () => {
    expect(resolveApiBaseUrl('http://localhost:4000/api/v1', true)).toBe(
      'http://localhost:4000/api/v1',
    );
    expect(resolveApiBaseUrl('http://127.0.0.1:4000/api/v1', true)).toBe(
      'http://127.0.0.1:4000/api/v1',
    );
    expect(() => resolveApiBaseUrl('http://api.example.com/api/v1', true)).toThrow(/https:/);
  });

  it('rejects a relative, a non-http scheme, embedded credentials, and a query string', () => {
    expect(() => resolveApiBaseUrl('/api/v1', true)).toThrow(/absolute URL/);
    expect(() => resolveApiBaseUrl('file:///tmp/x', true)).toThrow(/must use https/);
    expect(() => resolveApiBaseUrl('https://user:pass@api.example.com', true)).toThrow(
      /must not embed credentials/,
    );
    expect(() => resolveApiBaseUrl('https://api.example.com/api?v=1', true)).toThrow(
      /query string or fragment/,
    );
  });
});

describe('content security policy (MC-02)', () => {
  it('names the configured API origin in connect-src, which the static meta tag could not', () => {
    const policy = buildContentSecurityPolicy('https://api.example.com/api/v1');
    expect(policy).toContain('connect-src');
    expect(policy).toContain('https://api.example.com');
    // The old policy, verbatim, is what must no longer be produced for a packaged build.
    expect(policy).not.toBe("connect-src 'self' ws:");
  });

  it('keeps the policy closed even when an API origin is present', () => {
    const policy = buildContentSecurityPolicy('https://api.example.com/api/v1');
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("script-src 'self'");
    // No wildcard host may appear, or the origin restriction is decorative.
    expect(policy).not.toContain('*');
  });

  it('adds the dev server and its websocket in development only', () => {
    const withDev = buildContentSecurityPolicy('', 'http://localhost:5173');
    expect(withDev).toContain('http://localhost:5173');
    expect(withDev).toContain('ws://localhost:5173');

    const packaged = buildContentSecurityPolicy('https://api.example.com/api/v1');
    expect(packaged).not.toContain('ws://');
  });

  it('does not widen the policy when the dev server URL is malformed', () => {
    const policy = buildContentSecurityPolicy('https://api.example.com/api/v1', 'not a url');
    expect(policy).toContain('https://api.example.com');
    expect(policy).not.toContain('not a url');
  });

  it('derives the origin from the base URL, ignoring the path', () => {
    expect(originOf('https://api.example.com:8443/api/v1')).toBe('https://api.example.com:8443');
    expect(originOf('')).toBeNull();
    expect(originOf('not-a-url')).toBeNull();
  });

  it('does not ship a static meta CSP that would intersect with the packaged response header', () => {
    const html = readFileSync(join(__dirname, '../index.html'), 'utf8');
    expect(html).not.toMatch(/http-equiv\s*=\s*['"]Content-Security-Policy/i);
  });
});

describe('app:// asset serving', () => {
  const dist = '/tmp/idcp-dist';

  it('resolves the renderer as a sibling inside the ASAR archive', () => {
    expect(rendererDirectory('/opt/IDCP/resources/app.asar/dist-electron')).toBe(
      '/opt/IDCP/resources/app.asar/dist',
    );
  });

  it('serves the entry document and hashed assets from the build directory', () => {
    expect(resolveAppAsset('app://idcp/index.html', dist)).toEqual({
      filePath: '/tmp/idcp-dist/index.html',
    });
    expect(resolveAppAsset('app://idcp/assets/main-abc123.js', dist)).toEqual({
      filePath: '/tmp/idcp-dist/assets/main-abc123.js',
    });
    // A deep link reload arrives as a directory-ish path; the entry document handles it.
    expect(resolveAppAsset('app://idcp/documents/42', dist)).toEqual({
      filePath: '/tmp/idcp-dist/documents/42',
    });
    expect(resolveAppAsset('app://idcp/', dist)).toEqual({ filePath: '/tmp/idcp-dist/index.html' });
  });

  it('rejects path traversal, including percent-encoded forms', () => {
    // The classic escapes. Each must be refused, not normalised into a working path.
    for (const attempt of [
      'app://idcp/../../etc/passwd',
      'app://idcp/%2e%2e/%2e%2e/etc/passwd',
      'app://idcp/..%2f..%2fetc%2fpasswd',
      'app://idcp/%2e%2e%5c%2e%2e%5csecret',
      'app://idcp/%E0%A4%A',
      'app://idcp/assets/../../../../etc/passwd',
    ]) {
      expect(resolveAppAsset(attempt, dist)).toEqual({ notFound: true });
    }
  });

  it('rejects other hosts and other schemes so the handler cannot be repurposed', () => {
    expect(resolveAppAsset('app://evil/index.html', dist)).toEqual({ notFound: true });
    expect(resolveAppAsset('https://idcp/index.html', dist)).toEqual({ notFound: true });
    expect(resolveAppAsset('not a url', dist)).toEqual({ notFound: true });
  });

  it('assigns a content type per asset kind', () => {
    expect(contentTypeFor('/x/index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('/x/main.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('/x/main.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('/x/logo.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('/x/photo.webp')).toBe('image/webp');
    expect(contentTypeFor('/x/favicon.ico')).toBe('image/x-icon');
    expect(contentTypeFor('/x/font.woff2')).toBe('font/woff2');
    expect(contentTypeFor('/x/unknown.bin')).toBe('application/octet-stream');
  });

  it('uses a dedicated scheme and host, so the origin is stable and nameable', () => {
    // file:// has no origin at all, which is why CSP and CORS could not name the packaged app.
    expect(APP_ORIGIN).toBe('app://idcp');
    expect(new URL(`${APP_ORIGIN}/index.html`).protocol).toBe('app:');
  });
});
