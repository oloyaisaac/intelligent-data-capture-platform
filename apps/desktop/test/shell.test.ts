import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitiseTokens, startDesktop, TOKEN_FILE } from '../src/main/electron-main';
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
}

function fakeElectron(userDataDir: string) {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
  const windows: RecordedWindow[] = [];
  const external: string[] = [];
  const quit = jest.fn();
  let windowClosed: (() => void) | null = null;

  class BrowserWindow {
    options: Record<string, unknown>;
    webContents = {
      openDevTools: jest.fn(),
      setWindowOpenHandler: (handler: (details: { url: string }) => unknown) => {
        this.record.openHandler = handler;
      },
    };
    constructor(options: Record<string, unknown>) {
      this.options = options;
      const record: RecordedWindow = { options, loaded: {}, openHandler: null };
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
      whenReady: async () => undefined,
      on: jest.fn(),
      quit,
      disableHardwareAcceleration: jest.fn(),
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
  };

  return {
    api,
    handlers,
    windows,
    external,
    quit,
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

  it('creates an isolated, sandboxed window that cannot reach Node', async () => {
    const fake = fakeElectron(dir);
    startDesktop(fake.api as never);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.windows).toHaveLength(1);
    const webPreferences = fake.windows[0]!.options.webPreferences as Record<string, unknown>;
    expect(webPreferences.contextIsolation).toBe(true);
    expect(webPreferences.nodeIntegration).toBe(false);
    expect(webPreferences.sandbox).toBe(true);
    // The production window loads the packaged renderer from disk, not a remote origin.
    expect(fake.windows[0]!.loaded.file).toContain('dist/index.html');
    expect(fake.windows[0]!.loaded.url).toBeUndefined();
  });

  it('opens external links in the browser and denies in-app navigation', async () => {
    const fake = fakeElectron(dir);
    startDesktop(fake.api as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const handler = fake.windows[0]!.openHandler;
    expect(handler).not.toBeNull();
    expect(handler!({ url: 'https://example.com/docs' })).toEqual({ action: 'deny' });
    expect(fake.external).toEqual(['https://example.com/docs']);
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
    startDesktop(fake.api as never);
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
    startDesktop(fake.api as never);

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
    startDesktop(fake.api as never, { autoUpdate: false });
    expect(await fake.handlers.get('idcp:updates:check')!(null)).toEqual({ status: 'disabled' });

    const enabled = fakeElectron(dir);
    startDesktop(enabled.api as never, { autoUpdate: true });
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
    );

    expect(exposed!.key).toBe('idcpDesktop');
    expect(Object.keys(exposed!.api).sort()).toEqual([
      'appVersion',
      'checkForUpdates',
      'readTokens',
      'writeTokens',
    ]);

    await exposed!.api.writeTokens({ accessToken: 'a', refreshToken: 'r' });
    expect(invoked).toEqual([
      { channel: 'idcp:tokens:write', payload: { accessToken: 'a', refreshToken: 'r' } },
    ]);
  });
});
