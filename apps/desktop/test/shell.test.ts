/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isExternalUrlAllowed,
  isInternalNavigationUrl,
  sanitiseTokens,
  startDesktop,
  TOKEN_FILE,
} from '../src/main/electron-main';
import { registerPreload } from '../src/main/preload';

/**
 * DESK-001 — the shell itself.
 *
 * Electron is not installed in CI, so the main process is exercised through a stand-in that records
 * what the shell asks of it. That is enough to prove the security posture (isolated renderer,
 * encrypted token file, allow-listed IPC) without a display.
 */
interface RecordedWindow {
  options: Record<string, unknown>;
  loaded: { file?: string; url?: string };
  openHandler: ((details: { url: string }) => unknown) | null;
  navigationHandler: ((event: { preventDefault(): void }, url?: string) => void) | null;
}

function fakeElectron(userDataDir: string) {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
  const windows: RecordedWindow[] = [];
  const external: string[] = [];
  const quit = jest.fn();
  const privilegedSchemes: Array<Record<string, unknown>> = [];
  const protocolHandlers = new Map<string, (request: { url: string }) => unknown>();
  const lifecycle: string[] = [];
  const errorBoxes: Array<{ title: string; content: string }> = [];
  let windowClosed: (() => void) | null = null;

  class BrowserWindow {
    options: Record<string, unknown>;
    webContents = {
      openDevTools: jest.fn(),
      setWindowOpenHandler: (handler: (details: { url: string }) => unknown) => {
        this.record.openHandler = handler;
      },
      on: (event: string, handler: (event: { preventDefault(): void }, url?: string) => void) => {
        if (event === 'will-navigate') this.record.navigationHandler = handler;
      },
    };
    constructor(options: Record<string, unknown>) {
      this.options = options;
      const record: RecordedWindow = {
        options,
        loaded: {},
        openHandler: null,
        navigationHandler: null,
      };
      windows.push(record);
      this.record = record;
    }
    record: RecordedWindow;
    async loadFile(path: string) {
      this.record.loaded.file = path;
    }
    async loadURL(url: string) {
      this.record.loaded.url = url;
    }
    on(event: string, handler: () => void) {
      if (event === 'window-all-closed') windowClosed = handler;
    }
  }

  const api = {
    app: {
      getPath: () => userDataDir,
      getVersion: () => '0.1.0',
      whenReady: async () => {
        lifecycle.push('when-ready');
      },
      on: jest.fn(),
      quit,
      disableHardwareAcceleration: jest.fn(),
    },
    dialog: {
      showErrorBox: (title: string, content: string) => errorBoxes.push({ title, content }),
    },
    BrowserWindow,
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
        handlers.set(channel, handler);
      },
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      // Stand-in for the keychain: bytes on disk must not be the plain token.
      encryptString: (plain: string) => Buffer.from(Buffer.from(plain, 'utf8').toString('base64')),
      decryptString: (buffer: Buffer) =>
        Buffer.from(buffer.toString('utf8'), 'base64').toString('utf8'),
    },
    shell: { openExternal: async (url: string) => void external.push(url) },
    protocol: {
      registerSchemesAsPrivileged: (schemes: Array<Record<string, unknown>>) => {
        lifecycle.push('register-scheme');
        privilegedSchemes.push(...schemes);
      },
      handle: (scheme: string, handler: (request: { url: string }) => unknown) => {
        lifecycle.push('register-handler');
        protocolHandlers.set(scheme, handler);
      },
    },
  };

  return {
    api,
    handlers,
    windows,
    external,
    quit,
    privilegedSchemes,
    protocolHandlers,
    lifecycle,
    errorBoxes,
    closeAll: () => windowClosed?.(),
  };
}

describe('desktop shell (DESK-001)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'idcp-shell-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates an isolated window and serves the packaged HTML with its API-specific CSP', async () => {
    const fake = fakeElectron(dir);
    const rendererRoot = join(dir, 'renderer');
    mkdirSync(rendererRoot, { recursive: true });
    writeFileSync(join(rendererRoot, 'index.html'), '<!doctype html><title>IDCP</title>');

    startDesktop(fake.api as never, {
      apiBaseUrl: 'https://api.example.com/api/v1',
      rendererRoot,
    });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.windows).toHaveLength(1);
    const webPreferences = fake.windows[0]!.options.webPreferences as Record<string, unknown>;
    expect(webPreferences.contextIsolation).toBe(true);
    expect(webPreferences.nodeIntegration).toBe(false);
    expect(webPreferences.sandbox).toBe(true);
    // MC-01: the packaged renderer is served over app://, not file://, so it has an origin.
    expect(fake.windows[0]!.loaded.url).toBe('app://idcp/index.html');
    expect(fake.windows[0]!.loaded.file).toBeUndefined();
    expect(fake.lifecycle.indexOf('register-scheme')).toBeLessThan(
      fake.lifecycle.indexOf('when-ready'),
    );
    expect(fake.lifecycle.indexOf('register-handler')).toBeGreaterThan(
      fake.lifecycle.indexOf('when-ready'),
    );
    expect(fake.privilegedSchemes).toEqual([
      {
        scheme: 'app',
        privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
      },
    ]);
    // The API origin reaches the preload synchronously, before the renderer's first request.
    expect(webPreferences.additionalArguments).toEqual([
      `--idcp-api-base-url=${encodeURIComponent('https://api.example.com/api/v1')}`,
    ]);

    const handler = fake.protocolHandlers.get('app');
    expect(handler).toBeDefined();
    const response = (await handler!({ url: 'app://idcp/index.html' })) as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toContain(
      "connect-src 'self' https://api.example.com",
    );
    expect(response.headers.get('content-security-policy')).not.toContain('ws:');
    expect(await response.text()).toBe('<!doctype html><title>IDCP</title>');
  });

  it('fails closed before creating a window if packaged API configuration is missing', async () => {
    const fake = fakeElectron(dir);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      startDesktop(fake.api as never);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(fake.windows).toHaveLength(0);
      expect(fake.quit).toHaveBeenCalled();
      expect(fake.errorBoxes).toHaveLength(1);
      expect(fake.errorBoxes[0]!.content).toMatch(/API_BASE_URL is required/);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('opens only allowed external URLs and denies every cross-origin navigation', async () => {
    const fake = fakeElectron(dir);
    startDesktop(fake.api as never, { apiBaseUrl: 'https://api.example.com/api/v1' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const handler = fake.windows[0]!.openHandler;
    expect(handler).not.toBeNull();
    for (const url of [
      'https://example.com/docs',
      'mailto:support@example.com',
      'http://example.com/insecure',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hello',
    ]) {
      expect(handler!({ url })).toEqual({ action: 'deny' });
    }
    expect(fake.external).toEqual(['https://example.com/docs', 'mailto:support@example.com']);

    const navigate = fake.windows[0]!.navigationHandler;
    expect(navigate).not.toBeNull();
    const preventDefault = jest.fn();
    navigate!({ preventDefault }, 'app://idcp/index.html');
    expect(preventDefault).not.toHaveBeenCalled();
    navigate!({ preventDefault }, 'app://evil/index.html');
    navigate!({ preventDefault }, 'app://idcp.evil/index.html');
    navigate!({ preventDefault }, 'https://attacker.example/');
    expect(preventDefault).toHaveBeenCalledTimes(3);
  });

  it('allows only HTTPS and safe mailto URLs for external opening', () => {
    expect(isExternalUrlAllowed('https://example.com/docs')).toBe(true);
    expect(isExternalUrlAllowed('mailto:support@example.com')).toBe(true);
    expect(isExternalUrlAllowed('http://example.com')).toBe(false);
    expect(isExternalUrlAllowed('file:///etc/passwd')).toBe(false);
    expect(isExternalUrlAllowed('javascript:alert(1)')).toBe(false);
    expect(isExternalUrlAllowed('mailto:')).toBe(false);
    expect(isExternalUrlAllowed('mailto:support@example.com%0d%0aBcc:bad@example.com')).toBe(false);
  });

  it('allows navigation only to the exact trusted origin', () => {
    expect(isInternalNavigationUrl('app://idcp/index.html')).toBe(true);
    expect(isInternalNavigationUrl('app://idcp.evil/index.html')).toBe(false);
    expect(isInternalNavigationUrl('app://evil/index.html')).toBe(false);
    expect(isInternalNavigationUrl('http://localhost:5173/page', 'http://localhost:5173')).toBe(
      true,
    );
    expect(
      isInternalNavigationUrl('http://localhost:5173.evil.example/page', 'http://localhost:5173'),
    ).toBe(false);
  });

  it('keeps only well-formed tokens, so a malformed payload cannot poison the store', () => {
    expect(sanitiseTokens(null)).toEqual({ accessToken: null, refreshToken: null });
    expect(sanitiseTokens('token')).toEqual({ accessToken: null, refreshToken: null });
    expect(sanitiseTokens({ accessToken: 'a'.repeat(5000), refreshToken: 'ok' })).toEqual({
      accessToken: null,
      refreshToken: 'ok',
    });
    expect(sanitiseTokens({ accessToken: 'access', refreshToken: 42 })).toEqual({
      accessToken: 'access',
      refreshToken: null,
    });
  });

  it('stores tokens encrypted in the OS keychain file, and deletes the file on sign-out', async () => {
    const fake = fakeElectron(dir);
    startDesktop(fake.api as never, { apiBaseUrl: 'https://api.example.com/api/v1' });
    const write = fake.handlers.get('idcp:tokens:write');
    const read = fake.handlers.get('idcp:tokens:read');
    expect(write).toBeDefined();
    expect(read).toBeDefined();

    await write!(null, { accessToken: 'access-token', refreshToken: 'refresh-token' });
    const path = join(dir, TOKEN_FILE);
    expect(existsSync(path)).toBe(true);
    // On disk it is the keychain's ciphertext, never the token itself.
    expect(readFileSync(path, 'utf8')).not.toContain('access-token');
    expect(await read!(null)).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });

    await write!(null, { accessToken: null, refreshToken: null });
    expect(existsSync(path)).toBe(false);
    expect(await read!(null)).toEqual({ accessToken: null, refreshToken: null });
  });

  it('exposes exactly four IPC channels and no filesystem primitive', async () => {
    const fake = fakeElectron(dir);
    startDesktop(fake.api as never, { apiBaseUrl: 'https://api.example.com/api/v1' });

    expect([...fake.handlers.keys()].sort()).toEqual([
      'idcp:app:version',
      'idcp:tokens:read',
      'idcp:tokens:write',
      'idcp:updates:check',
    ]);
    expect(fake.handlers.get('idcp:app:version')!(null)).toBe('0.1.0');
  });

  it('turns the update check off when auto-update is disabled by configuration', async () => {
    const fake = fakeElectron(dir);
    startDesktop(fake.api as never, {
      autoUpdate: false,
      apiBaseUrl: 'https://api.example.com/api/v1',
    });
    expect(await fake.handlers.get('idcp:updates:check')!(null)).toEqual({ status: 'disabled' });

    const enabled = fakeElectron(dir);
    startDesktop(enabled.api as never, {
      autoUpdate: true,
      apiBaseUrl: 'https://api.example.com/api/v1',
    });
    expect(await enabled.handlers.get('idcp:updates:check')!(null)).toEqual({
      status: 'up_to_date',
      version: '0.1.0',
    });
  });

  it('gives the renderer a four-method bridge and nothing else', async () => {
    const invoked: Array<{ channel: string; payload?: unknown }> = [];
    let exposed: { key: string; api: Record<string, unknown> } | null = null;

    registerPreload(
      {
        exposeInMainWorld: (key, api) =>
          void (exposed = { key, api: api as Record<string, unknown> }),
      },
      { invoke: async (channel, ...args) => void invoked.push({ channel, payload: args[0] }) },
      [`--idcp-api-base-url=${encodeURIComponent('https://api.example.com/api/v1')}`],
    );

    expect(exposed!.key).toBe('idcpDesktop');
    expect(Object.keys(exposed!.api).sort()).toEqual([
      'apiBaseUrl',
      'appVersion',
      'checkForUpdates',
      'readTokens',
      'writeTokens',
    ]);
    // The API origin is configuration, not a capability: it must not be callable.
    expect(exposed!.api.apiBaseUrl).toBe('https://api.example.com/api/v1');

    await exposed!.api.writeTokens({ accessToken: 'a', refreshToken: 'r' });
    expect(invoked).toEqual([
      { channel: 'idcp:tokens:write', payload: { accessToken: 'a', refreshToken: 'r' } },
    ]);
  });
});
