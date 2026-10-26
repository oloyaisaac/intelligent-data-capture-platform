import type { TokenStore } from '../api/client';
import { ACCESS_TOKEN, DEVICE_CREDENTIAL, REFRESH_TOKEN } from './keys';
import type { SecureStore } from './secureStore';

/**
 * In-memory stand-in for the keychain.
 *
 * Deliberately in its own module: importing the keychain package pulls in React Native, so tests
 * for pure logic must never reach it (a mistake that would force a full RN jest preset).
 */
export class MemorySecureStore implements SecureStore, TokenStore {
  private readonly values = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  getAccessToken(): Promise<string | null> {
    return this.getItem(ACCESS_TOKEN);
  }

  getRefreshToken(): Promise<string | null> {
    return this.getItem(REFRESH_TOKEN);
  }

  getDeviceCredential(): Promise<string | null> {
    return this.getItem(DEVICE_CREDENTIAL);
  }

  saveDeviceCredential(credential: string): Promise<void> {
    return this.setItem(DEVICE_CREDENTIAL, credential);
  }

  async saveTokens(tokens: { accessToken: string; refreshToken: string }): Promise<void> {
    await this.setItem(ACCESS_TOKEN, tokens.accessToken);
    await this.setItem(REFRESH_TOKEN, tokens.refreshToken);
  }

  async clear(): Promise<void> {
    this.values.delete(ACCESS_TOKEN);
    this.values.delete(REFRESH_TOKEN);
  }

  async clearAll(): Promise<void> {
    this.values.clear();
  }
}
