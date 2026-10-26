import * as Keychain from 'react-native-keychain';
import type { TokenStore } from '../api/client';

/**
 * Device credential and session storage (SECURITY.md §4, §6.4).
 *
 * Tokens and the device credential live in the OS keychain/keystore — never in plain
 * preferences or AsyncStorage. The in-memory implementation exists only for tests.
 */

import {
  ACCESS_TOKEN,
  CREDENTIAL_SERVICE as SERVICE,
  DEVICE_CREDENTIAL,
  REFRESH_TOKEN,
} from './keys';

export interface SecureStore extends TokenStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export class KeychainStore implements SecureStore {
  private async readAll(): Promise<Record<string, string>> {
    const credentials = await Keychain.getGenericPassword({ service: SERVICE });
    if (!credentials) return {};
    try {
      return JSON.parse(credentials.password) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private async writeAll(values: Record<string, string>): Promise<void> {
    if (Object.keys(values).length === 0) {
      await Keychain.resetGenericPassword({ service: SERVICE });
      return;
    }
    await Keychain.setGenericPassword('idcp', JSON.stringify(values), {
      service: SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }

  async getItem(key: string): Promise<string | null> {
    const values = await this.readAll();
    return values[key] ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    const values = await this.readAll();
    await this.writeAll({ ...values, [key]: value });
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
    const values = await this.readAll();
    await this.writeAll({
      ...values,
      [ACCESS_TOKEN]: tokens.accessToken,
      [REFRESH_TOKEN]: tokens.refreshToken,
    });
  }

  /** Clears the session but keeps the paired-device credential. */
  async clear(): Promise<void> {
    const values = await this.readAll();
    delete values[ACCESS_TOKEN];
    delete values[REFRESH_TOKEN];
    await this.writeAll(values);
  }

  /** Full reset, e.g. after a device is revoked. */
  async clearAll(): Promise<void> {
    await Keychain.resetGenericPassword({ service: SERVICE });
  }
}
