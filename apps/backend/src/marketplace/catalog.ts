/**
 * The connector marketplace catalogue (MARKET-001).
 *
 * Only reviewed, signed packages appear here. A package is a *manifest*, not code: it names a
 * connector type that already ships in `@idcp/connectors`, declares which permissions installing it
 * grants, and carries an HMAC over those facts. The signature check is what stops a tampered
 * manifest — or a package somebody forgot to sign — from being installed.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const MARKETPLACE_PERMISSIONS = [
  'documents:read',
  'destination:write',
  'destination:update',
  'network:outbound',
  'secrets:read',
] as const;
export type MarketplacePermission = (typeof MARKETPLACE_PERMISSIONS)[number];

export interface MarketplacePackage {
  id: string;
  type: string;
  label: string;
  vendor: string;
  version: string;
  summary: string;
  /** What the connector will be able to do once installed. Shown before installing. */
  permissions: MarketplacePermission[];
  /** `verified` packages are installable; `revoked` ones stay visible with the reason. */
  status: 'verified' | 'revoked';
  revokedReason?: string;
  /** HMAC-SHA256 of the manifest fields, base64. `null` means it was never signed. */
  signature: string | null;
}

/**
 * The signing key belongs to whoever publishes the catalogue. In a deployment this is a secret; the
 * default only exists so the first-party catalogue can be verified out of the box.
 */
export function manifestSigningKey(): string {
  return process.env.MARKETPLACE_SIGNING_KEY ?? 'idcp-first-party-catalogue-key';
}

/** The exact bytes a signature covers — everything a manifest could lie about that matters. */
export function signPackage(fields: {
  id: string;
  type: string;
  version: string;
  permissions: readonly string[];
}): string {
  return createHmac('sha256', manifestSigningKey())
    .update(
      `${fields.id}@${fields.version}|${fields.type}|${[...fields.permissions].sort().join(',')}`,
    )
    .digest('base64');
}

function signed(pkg: Omit<MarketplacePackage, 'signature'>): MarketplacePackage {
  return { ...pkg, signature: signPackage(pkg) };
}

/** First-party packages: each one wraps a connector that is already in the registry. */
export const FIRST_PARTY_CATALOGUE: MarketplacePackage[] = [
  signed({
    id: 'hubspot-crm',
    type: 'hubspot',
    label: 'HubSpot CRM',
    vendor: 'HubSpot',
    version: '1.1.0',
    summary: 'Create and update HubSpot objects from approved documents.',
    permissions: ['documents:read', 'destination:write', 'destination:update', 'network:outbound'],
    status: 'verified',
  }),
  signed({
    id: 'odoo-erp',
    type: 'odoo',
    label: 'Odoo ERP',
    vendor: 'Odoo S.A.',
    version: '1.0.0',
    summary: 'Write invoices and partners into an Odoo database over JSON-RPC.',
    permissions: ['documents:read', 'destination:write', 'destination:update', 'network:outbound'],
    status: 'verified',
  }),
  signed({
    id: 'quickbooks-online',
    type: 'quickbooks',
    label: 'QuickBooks Online',
    vendor: 'Intuit',
    version: '1.2.1',
    summary: 'Post bills and invoices to QuickBooks Online.',
    permissions: ['documents:read', 'destination:write', 'destination:update', 'network:outbound'],
    status: 'verified',
  }),
  signed({
    id: 'google-sheets',
    type: 'google_sheets',
    label: 'Google Sheets',
    vendor: 'Google',
    version: '1.0.3',
    summary: 'Append approved records to a spreadsheet.',
    permissions: ['documents:read', 'destination:write', 'network:outbound', 'secrets:read'],
    status: 'verified',
  }),
  signed({
    id: 'zoho-crm',
    type: 'zoho',
    label: 'Zoho CRM (withdrawn)',
    vendor: 'Zoho',
    version: '0.9.0',
    summary: 'Withdrawn by the vendor: the API version it used is retired.',
    permissions: ['documents:read', 'destination:write', 'network:outbound'],
    status: 'revoked',
    revokedReason: 'Withdrawn by the vendor on 2026-10-01; installations must move to another CRM.',
  }),
];

/** Recomputes the signature and compares it in constant time. */
export function verifyPackageSignature(
  pkg: Pick<MarketplacePackage, 'id' | 'type' | 'version' | 'permissions' | 'signature'>,
): boolean {
  if (!pkg.signature) return false;
  const expected = Buffer.from(
    signPackage({ id: pkg.id, type: pkg.type, version: pkg.version, permissions: pkg.permissions }),
  );
  const actual = Buffer.from(pkg.signature);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** Why a package cannot be installed right now, or null when it can. */
export function installBlocker(
  pkg: MarketplacePackage,
  installedVersions: string[],
): string | null {
  if (pkg.status === 'revoked') {
    return `${pkg.label} has been withdrawn${pkg.revokedReason ? `: ${pkg.revokedReason}` : '.'}`;
  }
  if (!verifyPackageSignature(pkg)) {
    return `${pkg.label} is not signed by a trusted publisher, so it cannot be installed.`;
  }
  if (installedVersions.includes(pkg.version)) {
    return `${pkg.label} ${pkg.version} is already installed.`;
  }
  return null;
}
