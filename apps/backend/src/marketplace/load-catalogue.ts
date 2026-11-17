import { createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Config } from '../config';
import {
  FIRST_PARTY_CATALOGUE,
  MarketplacePackageSchema,
  verifyPackageSignature,
  type MarketplacePackage,
} from './catalog';

export interface MarketplaceTrust {
  catalogue: MarketplacePackage[];
  publicKey: KeyObject | null;
}

/** Load a deployment-supplied, pre-signed catalogue. No signing key is available to the server. */
export function loadMarketplaceTrust(config: Config): MarketplaceTrust {
  if (!config.MARKETPLACE_CATALOGUE_PATH && !config.MARKETPLACE_PUBLIC_KEY_PATH) {
    return { catalogue: FIRST_PARTY_CATALOGUE, publicKey: null };
  }
  if (!config.MARKETPLACE_CATALOGUE_PATH || !config.MARKETPLACE_PUBLIC_KEY_PATH) {
    throw new Error('Marketplace configuration requires both catalogue and public key paths.');
  }
  let key: KeyObject;
  let json: unknown;
  try {
    const pem = readFileSync(config.MARKETPLACE_PUBLIC_KEY_PATH, 'utf8');
    if (!pem.trim().startsWith('-----BEGIN PUBLIC KEY-----'))
      throw new Error('public key required');
    key = createPublicKey(pem);
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519')
      throw new Error('Ed25519 required');
    const data = readFileSync(config.MARKETPLACE_CATALOGUE_PATH, 'utf8');
    if (Buffer.byteLength(data, 'utf8') > 2_000_000) throw new Error('catalogue too large');
    json = JSON.parse(data) as unknown;
  } catch {
    throw new Error(
      'Invalid marketplace configuration: could not read the catalogue or Ed25519 public key.',
    );
  }
  const result = z.array(MarketplacePackageSchema).min(1).max(1000).safeParse(json);
  if (!result.success) throw new Error('Invalid marketplace catalogue format.');
  const identifiers = new Set<string>();
  for (const pkg of result.data) {
    const identity = JSON.stringify([pkg.id, pkg.version]);
    if (identifiers.has(identity))
      throw new Error('Duplicate package version in marketplace catalogue.');
    identifiers.add(identity);
    if (!verifyPackageSignature(pkg, key))
      throw new Error('Marketplace catalogue contains an untrusted or unsigned manifest.');
  }
  return { catalogue: result.data, publicKey: key };
}
