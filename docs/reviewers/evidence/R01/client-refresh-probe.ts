// R01 synthetic client-contract probe. Fake fetch only: no network, users, tokens or production data.
// TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/client-refresh-probe.ts
import assert from 'node:assert/strict';
import {
  ApiClient as DesktopClient,
  MemoryTokenStorage,
} from '../../../../apps/desktop/src/api/client';
import { ApiClient as MobileClient, type TokenStore } from '../../../../apps/mobile/src/api/client';

/** Mobile's store contract: session tokens plus a paired-device credential, all in memory here. */
class MemoryMobileStore implements TokenStore {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private deviceCredential: string | null = null;

  async getAccessToken() {
    return this.accessToken;
  }
  async getRefreshToken() {
    return this.refreshToken;
  }
  async saveTokens(tokens: { accessToken: string; refreshToken: string }) {
    this.accessToken = tokens.accessToken;
    this.refreshToken = tokens.refreshToken;
  }
  async clear() {
    this.accessToken = null;
    this.refreshToken = null;
  }
  async getDeviceCredential() {
    return this.deviceCredential;
  }
  async saveDeviceCredential(credential: string) {
    this.deviceCredential = credential;
  }
}

const pair = (access: string, refresh: string) =>
  new Response(JSON.stringify({ accessToken: access, refreshToken: refresh, sessionId: 's1' }), {
    status: 200,
  });

const unauthorised = () =>
  new Response('{"error":{"code":"UNAUTHENTICATED","message":"Sign in."}}', { status: 401 });

async function main(): Promise<void> {
  // 1. Desktop: two concurrent 401s each call refresh() with the same stored refresh token.
  const desktopStore = new MemoryTokenStorage();
  await desktopStore.write({ accessToken: 'stale', refreshToken: 'r0' });
  const desktopRefreshes: string[] = [];
  let desktopRequests = 0;
  const desktopFetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as { refreshToken: string }) : null;
    if (String(url).endsWith('/auth/refresh')) {
      desktopRefreshes.push(body!.refreshToken);
      const n = desktopRefreshes.length;
      return pair(`access-${n}`, `r${n}`);
    }
    desktopRequests += 1;
    const auth = (init?.headers as Record<string, string>).authorization;
    if (auth === 'Bearer access-1' || auth === 'Bearer access-2') {
      return new Response('{"ok":true}', { status: 200 });
    }
    return unauthorised();
  }) as unknown as typeof fetch;
  const desktop = new DesktopClient({ storage: desktopStore, fetchImpl: desktopFetch });
  await Promise.all([desktop.request('/one'), desktop.request('/two')]);

  // 2. Mobile: same shape, but a stub server that enforces single use rejects the repeat.
  const mobileStore = new MemoryMobileStore();
  await mobileStore.saveTokens({ accessToken: 'stale', refreshToken: 'r0' });
  const mobileRefreshes: string[] = [];
  const used = new Set<string>();
  const mobileFetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as { refreshToken: string }) : null;
    if (String(url).endsWith('/auth/refresh')) {
      mobileRefreshes.push(body!.refreshToken);
      if (used.has(body!.refreshToken)) return unauthorised();
      used.add(body!.refreshToken);
      const n = mobileRefreshes.length;
      return pair(`access-${n}`, `r${n}`);
    }
    return unauthorised();
  }) as unknown as typeof fetch;
  let expired = 0;
  const mobile = new MobileClient({
    baseUrl: 'https://idcp.test/api/v1',
    store: mobileStore,
    fetchImpl: mobileFetch,
    onSessionExpired: () => (expired += 1),
  });
  await Promise.allSettled([mobile.request('/one'), mobile.request('/two')]);

  const desktopStored = (await desktopStore.read()).refreshToken;
  const mobileStored = await mobileStore.getRefreshToken();
  assert.equal(desktopRefreshes.length, 2, 'desktop refreshed independently per request');
  assert.equal(mobileRefreshes.length, 2, 'mobile refreshed independently per request');

  process.stdout.write(
    'Fake-fetch client probe; no network, real token, user or production data.\n' +
      `Desktop: ${desktopRequests} document requests; /auth/refresh tokens [${desktopRefreshes.join(', ')}].\n` +
      `Desktop: both retries succeeded only because the stub accepted either rotation; stored refresh token ${desktopStored}.\n` +
      `Mobile: /auth/refresh tokens [${mobileRefreshes.join(', ')}]; single-use stub rejected the repeat.\n` +
      `Mobile: onSessionExpired fired ${expired} time(s); stored refresh token after the race: ${mobileStored}.\n` +
      'By inspection neither client shares an in-flight refresh promise or serialises 401 retries.\n',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`Probe failed: ${String(error)}\n`);
  process.exitCode = 1;
});
