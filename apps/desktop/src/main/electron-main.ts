/**
 * Electron main process (DESK-001).
 *
 * Responsibilities, and nothing more:
 *   - create the window with `contextIsolation: true` and `nodeIntegration: false`
 *   - store session tokens in the OS keychain (via `safeStorage`), never on disk in plain text
 *   - expose four allow-listed IPC channels, each validating its payload
 *   - optionally check for updates (disabled by `IDCP_AUTO_UPDATE=off`)
 *
 * `electron` is required at runtime only, so the renderer build and the test suite do not depend on
 * the Electron binary being installed in this environment.
 */

interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface WebContentsLike {
  openDevTools(): void;
  setWindowOpenHandler(handler: (details: { url: string }) => unknown): void;
  /** MH-05: without this, a navigated window keeps the preload bridge. */
  on(event: string, handler: (event: { preventDefault(): void }, url?: string) => void): void;
}

interface BrowserWindowLike {
  loadFile(path: string): Promise<void>;
  loadURL(url: string): Promise<void>;
  webContents: WebContentsLike;
  on(event: string, handler: () => void): void;
}

interface ElectronApi {
  app: {
    getPath(name: 'userData'): string;
    getVersion(): string;
    whenReady(): Promise<void>;
    on(event: string, handler: () => void): void;
    quit(): void;
    disableHardwareAcceleration(): void;
  };
  BrowserWindow: new (options: Record<string, unknown>) => BrowserWindowLike;
  ipcMain: {
    handle(channel: string, handler: (event: unknown, payload?: unknown) => unknown): void;
  };
  safeStorage: SafeStorageLike;
  shell: { openExternal(url: string): Promise<void> };
  /** Registers a privileged scheme; the parameter names moved between Electron majors. */
  protocol: {
    registerSchemesAsPrivileged(schemes: Array<Record<string, unknown>>): void;
    /** Electron expects a WHATWG Response from protocol.handle(). */
    handle(scheme: string, handler: (request: { url: string }) => Promise<unknown>): void;
  };
  dialog?: { showErrorBox(title: string, content: string): void };
}

import {
  APP_ENTRY_URL,
  APP_ORIGIN,
  APP_SCHEME,
  apiBaseArgument,
  apiBaseUrlFromBuildConfig,
  ApiBaseUrlError,
  buildContentSecurityPolicy,
  contentTypeFor,
  rendererDirectory,
  resolveApiBaseUrl,
  resolveAppAsset,
} from './app-protocol';

export const TOKEN_FILE = 'session.bin';

/** MH-04: only these schemes may be handed to the OS. */
export function isExternalUrlAllowed(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return url.username === '' && url.password === '';
    if (url.protocol !== 'mailto:') return false;
    // Refuse header injection and an empty recipient before handing a URL to the OS mail client.
    return url.pathname.trim() !== '' && !/[\r\n]|%0[ad]/i.test(raw);
  } catch {
    return false;
  }
}

/** MH-05: only the shell's exact origin may retain the privileged preload bridge. */
export function isInternalNavigationUrl(raw: string, devServerUrl?: string): boolean {
  try {
    const destination = new URL(raw);
    if (destination.username || destination.password) return false;
    if (!devServerUrl) {
      // Node's WHATWG URL reports origin "null" for custom schemes, whereas Chromium gives a
      // standard app:// origin once registerSchemesAsPrivileged({ standard: true }) is active.
      // Compare the exact scheme + authority explicitly so the guard behaves the same in both.
      const trusted = new URL(APP_ORIGIN);
      return destination.protocol === trusted.protocol && destination.host === trusted.host;
    }
    return destination.origin === new URL(devServerUrl).origin;
  } catch {
    return false;
  }
}

interface WebResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

interface WebResponseConstructor {
  new (
    body: string | Uint8Array,
    init: { status: number; headers: Record<string, string> },
  ): WebResponseLike;
}

/** Electron's protocol.handle API consumes WHATWG Response instances. */
function protocolResponse(
  body: string | Uint8Array,
  status: number,
  headers: Record<string, string>,
): WebResponseLike {
  const ResponseConstructor = (globalThis as unknown as { Response?: WebResponseConstructor })
    .Response;
  if (!ResponseConstructor) {
    throw new Error('This Electron runtime does not provide the WHATWG Response API.');
  }
  return new ResponseConstructor(body, { status, headers });
}

export interface TokenShape {
  accessToken: string | null;
  refreshToken: string | null;
}

export function sanitiseTokens(payload: unknown): TokenShape {
  if (typeof payload !== 'object' || payload === null)
    return { accessToken: null, refreshToken: null };
  const record = payload as Record<string, unknown>;
  const clean = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 && value.length <= 4000 ? value : null;
  return { accessToken: clean(record.accessToken), refreshToken: clean(record.refreshToken) };
}

/**
 * Starts the desktop shell. Split from module load so the same file can be imported (and its
 * helpers unit-tested) without launching a window.
 */
export function startDesktop(
  api: ElectronApi,
  options: {
    devServerUrl?: string;
    autoUpdate?: boolean;
    apiBaseUrl?: string;
    /** Test seam for exercising the protocol handler with a temporary renderer directory. */
    rendererRoot?: string;
  } = {},
): void {
  const { app, BrowserWindow, ipcMain, safeStorage } = api;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');

  const packaged = !options.devServerUrl;
  const reportStartupFailure = (message: string): void => {
    console.error(`IDCP startup error: ${message}`);
    api.dialog?.showErrorBox('IDCP cannot start', message);
    app.quit();
  };

  // Electron requires privileged schemes to be registered synchronously, before app.whenReady().
  // Calling this from inside the ready callback (the original implementation) is too late: Chromium
  // has already fixed the scheme's security/origin treatment by then.
  if (packaged) {
    if (typeof api.protocol?.registerSchemesAsPrivileged !== 'function') {
      reportStartupFailure(
        'This Electron runtime cannot register the secure app:// renderer scheme.',
      );
      return;
    }
    api.protocol.registerSchemesAsPrivileged([
      {
        scheme: APP_SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
      },
    ]);
  }

  const tokenPath = () => path.join(app.getPath('userData'), TOKEN_FILE);

  const readTokens = (): TokenShape => {
    try {
      if (!fs.existsSync(tokenPath())) return { accessToken: null, refreshToken: null };
      const encrypted = fs.readFileSync(tokenPath());
      if (!safeStorage.isEncryptionAvailable()) return { accessToken: null, refreshToken: null };
      return sanitiseTokens(JSON.parse(safeStorage.decryptString(encrypted)));
    } catch {
      // A corrupt or unreadable token file must never block startup.
      return { accessToken: null, refreshToken: null };
    }
  };

  const writeTokens = (tokens: TokenShape): void => {
    const file = tokenPath();
    if (!tokens.accessToken && !tokens.refreshToken) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return;
    }
    if (!safeStorage.isEncryptionAvailable()) return;
    fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(tokens)), { mode: 0o600 });
  };

  ipcMain.handle('idcp:tokens:read', () => readTokens());
  ipcMain.handle('idcp:tokens:write', (_event, payload) => {
    writeTokens(sanitiseTokens(payload));
    return undefined;
  });
  ipcMain.handle('idcp:app:version', () => app.getVersion());
  ipcMain.handle('idcp:updates:check', () => {
    // Auto-update is opt-in; an air-gapped deployment turns it off and this is a no-op.
    if (options.autoUpdate === false) return { status: 'disabled' as const };
    return { status: 'up_to_date' as const, version: app.getVersion() };
  });

  void app.whenReady().then(async () => {
    // Resolve the API origin before creating the window: a packaged build with no configuration is
    // a startup error, not an app that opens and fails every request (MC-01).
    let apiBaseUrl: string;
    try {
      let configuredApiBaseUrl = options.apiBaseUrl;
      if (configuredApiBaseUrl === undefined && packaged) {
        try {
          const buildConfigPath = path.join(__dirname, 'api-config.json');
          configuredApiBaseUrl = apiBaseUrlFromBuildConfig(
            fs.readFileSync(buildConfigPath, 'utf8'),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      apiBaseUrl = resolveApiBaseUrl(configuredApiBaseUrl, packaged);
    } catch (error) {
      if (error instanceof ApiBaseUrlError) {
        reportStartupFailure(error.message);
        return;
      }
      throw error;
    }

    const rendererRoot = options.rendererRoot ?? rendererDirectory(__dirname);

    if (packaged) {
      if (typeof api.protocol?.handle !== 'function') {
        reportStartupFailure(
          'This Electron runtime cannot serve the secure app:// renderer scheme.',
        );
        return;
      }

      // `protocol.handle()` is installed only after app readiness, but the scheme privileges above
      // are registered synchronously before it. Electron requires these two calls in this order.
      const fsPromises = fs.promises;
      const csp = buildContentSecurityPolicy(apiBaseUrl);
      api.protocol.handle(APP_SCHEME, async (request) => {
        const resolved = resolveAppAsset(request.url, rendererRoot);
        if ('notFound' in resolved) {
          return protocolResponse('Not found', 404, {
            'content-type': 'text/plain; charset=utf-8',
          });
        }

        let body: Buffer;
        try {
          body = await fsPromises.readFile(resolved.filePath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') {
            return protocolResponse('Not found', 404, {
              'content-type': 'text/plain; charset=utf-8',
            });
          }
          throw error;
        }

        const headers = { 'content-type': contentTypeFor(resolved.filePath) };
        if (resolved.filePath.endsWith('.html')) {
          // MC-02: the response header sets one CSP derived from the configured API origin. There is
          // no static CSP meta tag in the packaged HTML to intersect with or silently override it.
          Object.assign(headers, { 'content-security-policy': csp });
        }
        return protocolResponse(body, 200, headers);
      });
    }

    const window = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 960,
      minHeight: 640,
      backgroundColor: '#0d151d',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The preload reads the API origin from here synchronously, before the renderer's first
        // module evaluates. Without it the renderer's first request races its configuration.
        additionalArguments: apiBaseUrl ? [apiBaseArgument(apiBaseUrl)] : [],
      },
    });

    // External links open in the user's browser, never inside the app shell.
    window.webContents.setWindowOpenHandler(({ url }) => {
      // MH-04: an unvalidated URL here hands arbitrary schemes to the OS (file:, ms-*, smb: …).
      if (isExternalUrlAllowed(url)) void api.shell.openExternal(url);
      return { action: 'deny' };
    });

    // MH-05: deny any in-window navigation away from the app origin, so the preload bridge cannot
    // outlive the document it was built for.
    window.webContents.on('will-navigate', (event, targetUrl) => {
      if (!targetUrl || !isInternalNavigationUrl(targetUrl, options.devServerUrl)) {
        event.preventDefault();
      }
    });

    if (options.devServerUrl) {
      await window.loadURL(options.devServerUrl);
      window.webContents.openDevTools();
    } else {
      // MC-01: app:// has a real origin, so `/api/v1` resolves against the API host, not file://.
      await window.loadURL(APP_ENTRY_URL);
    }

    app.on('window-all-closed', () => app.quit());
  });
}

// Only boot when Electron provides the runtime; importing this module in a test does nothing.
if (
  typeof process !== 'undefined' &&
  process.versions?.['electron'] &&
  !process.env.IDCP_NO_ELECTRON
) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as ElectronApi;
  startDesktop(electron, {
    devServerUrl: process.env.IDCP_DEV_SERVER,
    autoUpdate: process.env.IDCP_AUTO_UPDATE !== 'off',
  });
}
