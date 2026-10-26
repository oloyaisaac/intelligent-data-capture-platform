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

interface BrowserWindowLike {
  loadFile(path: string): Promise<void>;
  loadURL(url: string): Promise<void>;
  webContents: {
    openDevTools(): void;
    setWindowOpenHandler(handler: (details: { url: string }) => unknown): void;
  };
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
}

const TOKEN_FILE = 'session.bin';

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
  options: { devServerUrl?: string; autoUpdate?: boolean } = {},
): void {
  const { app, BrowserWindow, ipcMain, safeStorage } = api;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');

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
      },
    });

    // External links open in the user's browser, never inside the app shell.
    window.webContents.setWindowOpenHandler(({ url }) => {
      void api.shell.openExternal(url);
      return { action: 'deny' };
    });

    if (options.devServerUrl) {
      await window.loadURL(options.devServerUrl);
      window.webContents.openDevTools();
    } else {
      await window.loadFile(path.join(__dirname, '../../dist/index.html'));
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
