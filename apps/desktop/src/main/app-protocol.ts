import { join, resolve, sep } from 'node:path';

/**
 * Packaged-app origin handling (MC-01 / MC-02, formerly DESK-001 pass-through).
 *
 * The defect this module exists to fix: the packaged renderer was loaded with `loadFile()`, so its
 * origin was `file://`. A relative `/api/v1` request therefore resolved to `file:///api/v1` and every
 * call failed — sign-in included — while the test suite passed because every test injected an
 * absolute `baseUrl`.
 *
 * Two things were needed:
 *
 *   1. A real, secure origin. `file://` is an opaque origin: it cannot be listed in a CSP, it cannot
 *      be a CORS origin, and `'self'` in `connect-src` means "the file system". Serving the renderer
 *      over a privileged custom scheme (`app://`) gives it an origin the backend can allow and the
 *      policy can name.
 *   2. A policy that names the API. `connect-src 'self' ws:` blocked every production API host, so
 *      fixing (1) alone would still have produced a sign-in that silently failed. The two fixes are
 *      inseparable and ship together.
 *
 * Everything here is a pure function so it can be tested without the Electron binary installed.
 */

/** Scheme the packaged renderer is served from. Registered as standard + secure. */
export const APP_SCHEME = 'app';
export const APP_HOST = 'idcp';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
/** Entry point inside the packaged renderer. */
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`;

/**
 * electron-builder keeps `dist/` and `dist-electron/` as siblings inside app.asar.
 * From `app.asar/dist-electron`, the renderer is one parent up — not two (two parents escape the
 * ASAR archive into `resources/`, where there is no `dist/`).
 */
export function rendererDirectory(mainDirectory: string): string {
  return resolve(mainDirectory, '../dist');
}

export class ApiBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiBaseUrlError';
  }
}

/** Parse the generated package config without silently accepting malformed JSON. */
export function apiBaseUrlFromBuildConfig(json: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ApiBaseUrlError('The packaged API configuration is not valid JSON. Rebuild the app.');
  }
  if (typeof value !== 'object' || value === null || !('apiBaseUrl' in value)) return undefined;
  const configured = (value as { apiBaseUrl?: unknown }).apiBaseUrl;
  return typeof configured === 'string' ? configured : undefined;
}

/**
 * Loopback hosts may use plain http, because a locally-run backend is the documented development
 * setup. Everything else must be https: an API token over cleartext is not a negotiable default.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
  );
}

/**
 * Resolve the API base URL the renderer must use.
 *
 * @param configured Raw value from the generated desktop `API_BASE_URL` build configuration.
 * @param packaged   True inside a packaged build (no dev server to proxy `/api`).
 *
 * Returns `''` when the renderer should keep using the same-origin relative default, which is the
 * correct behaviour only in development, where the Vite server proxies `/api` to the backend.
 * A packaged build with no configured origin is a configuration error and fails loudly rather than
 * starting into an app whose every request 404s against the file system — which is exactly how
 * MC-01 reached a release candidate.
 */
export function resolveApiBaseUrl(configured: string | undefined, packaged: boolean): string {
  const raw = (configured ?? '').trim();

  if (raw === '') {
    if (packaged) {
      throw new ApiBaseUrlError(
        'API_BASE_URL is required for a packaged build. Set it to the absolute API base URL ' +
          '(for example https://api.example.com/api/v1) at build time, or the desktop app cannot ' +
          'reach its backend.',
      );
    }
    return '';
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiBaseUrlError(
      `API_BASE_URL must be an absolute URL including the scheme (received "${raw}").`,
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ApiBaseUrlError(
      `API_BASE_URL must use https: (received protocol "${url.protocol}").`,
    );
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new ApiBaseUrlError(
      `API_BASE_URL must use https: for a non-loopback host (received "${raw}"). ` +
        'A bearer token over cleartext is not acceptable.',
    );
  }
  if (url.username || url.password) {
    throw new ApiBaseUrlError('API_BASE_URL must not embed credentials.');
  }
  if (url.search || url.hash) {
    throw new ApiBaseUrlError('API_BASE_URL must not contain a query string or fragment.');
  }

  // Normalise: exactly one trailing slash removed, path preserved.
  return `${url.origin}${url.pathname}`.replace(/\/$/, '');
}

/** The origin (scheme + host + port) of an absolute base URL, or `null` for a relative one. */
export function originOf(absoluteUrl: string): string | null {
  if (absoluteUrl === '') return null;
  try {
    return new URL(absoluteUrl).origin;
  } catch {
    return null;
  }
}

/**
 * Build the renderer Content-Security-Policy.
 *
 * The API origin is derived from the configured base URL rather than hard-coded: the shipped policy
 * previously listed only `'self' ws:`, which under `file://` meant "the local disk", so every
 * production API host was blocked. `frame-ancestors`, `object-src` and `base-uri` are pinned shut
 * because the renderer has no legitimate use for any of them.
 *
 * @param apiBaseUrl Absolute API base URL, or `''` when same-origin (development proxy).
 * @param devServerUrl Set in development so the HMR websocket is allowed.
 */
export function buildContentSecurityPolicy(apiBaseUrl: string, devServerUrl?: string): string {
  const connect = ["'self'"];

  const apiOrigin = originOf(apiBaseUrl);
  if (apiOrigin) {
    connect.push(apiOrigin);
    // EventSource for the live dashboard shares the API origin; ws is only needed if the API origin
    // is itself reached over a websocket-style upgrade on a different port, which it is not. Adding
    // the http origin above covers SSE. Keep ws: limited to development below.
  }

  if (devServerUrl) {
    try {
      const dev = new URL(devServerUrl);
      connect.push(dev.origin);
      connect.push(`ws://${dev.host}`, `wss://${dev.host}`);
    } catch {
      // A malformed dev server URL must not silently widen the policy; ignore it.
    }
  }

  return [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Map a request URL on the app scheme to a file inside the renderer build directory.
 *
 * Returns `{ notFound: true }` when the request does not belong to the app origin or escapes the
 * dist directory. Traversal is rejected both before and after URL parsing, so encoded sequences
 * (`%2e%2e%2f`) cannot evade the containment check.
 *
 * @param requestUrl e.g. `app://idcp/index.html`
 * @param distDir    Absolute path to the built renderer.
 * @returns `{ filePath }` for a servable file, or `{ notFound: true }` for an unknown route.
 */
export function resolveAppAsset(
  requestUrl: string,
  distDir: string,
): { filePath: string } | { notFound: true } {
  // Reject parent-directory segments before the URL parser sees the path. The parser silently
  // collapses `..` against the root, which would turn `app://idcp/assets/../../etc/passwd` into a
  // request for `etc/passwd` inside the build directory — harmless, but it hides the attempt.
  // Checking the raw path also catches `%2e%2e` and `..%2f`, which only become separators later.
  const rawPath = requestUrl.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/, '');
  const rawSegments = rawPath.split('/').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  if (rawSegments.some((segment) => segment === '..')) return { notFound: true };

  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { notFound: true };
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.hostname !== APP_HOST) return { notFound: true };

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return { notFound: true };
  }
  const segments = decodedPath.replace(/\\/g, '/').split('/');
  if (segments.some((segment) => segment === '..' || segment.includes('\0'))) {
    return { notFound: true };
  }

  // Hash-based routes stay in the fragment; only the origin root maps to the entry document.
  const relative = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');

  const root = resolve(distDir);
  const filePath = resolve(join(root, relative));

  // Backstop: the resolved file must stay inside the renderer directory.
  if (filePath !== root && !filePath.startsWith(root + sep)) return { notFound: true };

  return { filePath };
}

/** MIME type for the handful of asset kinds the renderer emits. */
export function contentTypeFor(filePath: string): string {
  const extension = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  switch (extension) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.avif':
      return 'image/avif';
    case '.ico':
      return 'image/x-icon';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    case '.map':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Encode the API base URL into the `additionalArguments` passed to the preload script.
 *
 * The preload parses this argument locally; it must stay a self-contained script because Electron's
 * sandboxed preload has a restricted `require` and cannot import this Node-dependent module.
 */
export const API_BASE_ARG_PREFIX = '--idcp-api-base-url=';

export function apiBaseArgument(apiBaseUrl: string): string {
  return `${API_BASE_ARG_PREFIX}${encodeURIComponent(apiBaseUrl)}`;
}
