#!/usr/bin/env -S npx tsx
/** Offline publisher tool. Never run this in the application server or with a production key on an untrusted host. */
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  FIRST_PARTY_CATALOGUE,
  MarketplacePackageSchema,
  packageSigningBytes,
} from '../apps/backend/src/marketplace/catalog';

function main(): void {
  const [source, privateKeyPath, ...extra] = process.argv.slice(2);
  if (!source || !privateKeyPath || extra.length)
    throw new Error(
      'Usage: tsx scripts/sign-marketplace.ts <unsigned.json|--bundled> <ed25519-private-key.pem>',
    );
  const sourceData: unknown =
    source === '--bundled' ? FIRST_PARTY_CATALOGUE : JSON.parse(readFileSync(source, 'utf8'));
  const catalogue = z.array(MarketplacePackageSchema).min(1).max(1000).parse(sourceData);
  if (catalogue.some((pkg) => pkg.signature !== null))
    throw new Error('Input signatures must be null; review the unsigned manifests before signing.');
  const ids = new Set(catalogue.map((pkg) => JSON.stringify([pkg.id, pkg.version])));
  if (ids.size !== catalogue.length) throw new Error('Duplicate package version.');
  const privateKey = createPrivateKey(readFileSync(privateKeyPath));
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519')
    throw new Error('An Ed25519 private key is required.');
  const signed = catalogue.map((pkg) => ({
    ...pkg,
    signature: sign(null, packageSigningBytes(pkg), privateKey).toString('base64'),
  }));
  process.stdout.write(`${JSON.stringify(signed, null, 2)}\n`);
}

try {
  main();
} catch {
  // Do not print key material or file contents on failure.
  process.stderr.write(
    'Could not sign marketplace catalogue. Provide reviewed, unsigned manifests and an Ed25519 private key.\n',
  );
  process.exitCode = 1;
}
