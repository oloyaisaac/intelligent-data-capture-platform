/**
 * Electron preload (DESK-001).
 *
 * The renderer gets exactly four capabilities and nothing else. `contextIsolation` is on and
 * `nodeIntegration` is off, so the renderer cannot touch the filesystem or spawn processes.
 *
 * `electron` is a packaging-time dependency: the source stays free of a hard compile-time import so
 * the renderer build and the test suite do not need the Electron binary installed.
 */

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

interface ContextBridgeLike {
  exposeInMainWorld(key: string, api: unknown): void;
}

export interface DesktopBridge {
  readTokens(): Promise<{ accessToken: string | null; refreshToken: string | null }>;
  writeTokens(tokens: { accessToken: string | null; refreshToken: string | null }): Promise<void>;
  checkForUpdates(): Promise<{ status: 'disabled' | 'up_to_date' | 'available'; version?: string }>;
  appVersion(): Promise<string>;
}

function buildBridge(ipcRenderer: IpcRendererLike): DesktopBridge {
  return {
    readTokens: () =>
      ipcRenderer.invoke('idcp:tokens:read') as Promise<{
        accessToken: string | null;
        refreshToken: string | null;
      }>,
    writeTokens: (tokens) => ipcRenderer.invoke('idcp:tokens:write', tokens) as Promise<void>,
    checkForUpdates: () =>
      ipcRenderer.invoke('idcp:updates:check') as Promise<{
        status: 'disabled' | 'up_to_date' | 'available';
        version?: string;
      }>,
    appVersion: () => ipcRenderer.invoke('idcp:app:version') as Promise<string>,
  };
}

export function registerPreload(
  contextBridge: ContextBridgeLike,
  ipcRenderer: IpcRendererLike,
): void {
  contextBridge.exposeInMainWorld('idcpDesktop', buildBridge(ipcRenderer));
}

// Inside Electron this module is loaded by the preload loader, which provides `electron`.
if (
  typeof process !== 'undefined' &&
  process.versions?.['electron'] &&
  !process.env.IDCP_NO_PRELOAD
) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { contextBridge, ipcRenderer } = require('electron') as {
    contextBridge: ContextBridgeLike;
    ipcRenderer: IpcRendererLike;
  };
  registerPreload(contextBridge, ipcRenderer);
}
