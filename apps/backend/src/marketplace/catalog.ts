/**
 * The connector marketplace catalogue (MARKET-001).
 *
 * Only reviewed, signed packages appear here. A package is a *manifest*, not code: it names a
 * connector type that already ships in `@idcp/connectors` and declares its permissions. A separately
 * supplied Ed25519 public key verifies detached publisher signatures; the running service never signs.
 */
import { verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';

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
  /** Detached Ed25519 signature of the canonical manifest, base64. */
  signature: string | null;
}

/** Strict schema for a signed catalogue loaded from an operator-controlled file. */
export const MarketplacePackageSchema = z
  .object({
    id: z.string().min(1).max(128),
    type: z.string().min(1).max(128),
    label: z.string().min(1).max(256),
    vendor: z.string().min(1).max(256),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    summary: z.string().min(1).max(2048),
    permissions: z.array(z.enum(MARKETPLACE_PERMISSIONS)).max(MARKETPLACE_PERMISSIONS.length),
    status: z.enum(['verified', 'revoked']),
    revokedReason: z.string().min(1).max(2048).optional(),
    signature: z.string().nullable(),
  })
  .strict()
  .superRefine((pkg, ctx) => {
    if (new Set(pkg.permissions).size !== pkg.permissions.length) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate permissions' });
    }
    if (pkg.status === 'revoked' && !pkg.revokedReason) {
      ctx.addIssue({ code: 'custom', message: 'A revoked package needs a reason' });
    }
  });

/** Canonical, versioned bytes cover every field shown to users or used in install decisions. */
export function packageSigningBytes(pkg: Omit<MarketplacePackage, 'signature'>): Buffer {
  return Buffer.from(
    JSON.stringify([
      'idcp-marketplace-manifest-v1',
      pkg.id,
      pkg.type,
      pkg.label,
      pkg.vendor,
      pkg.version,
      pkg.summary,
      pkg.permissions,
      pkg.status,
      pkg.revokedReason ?? null,
    ]),
    'utf8',
  );
}

/** Bundled catalogue is informational only until an operator provides signed manifests. */
export const FIRST_PARTY_CATALOGUE: MarketplacePackage[] = [
  {
    id: 'hubspot-crm',
    type: 'hubspot',
    label: 'HubSpot CRM',
    vendor: 'HubSpot',
    version: '1.1.0',
    summary: 'Create and update HubSpot objects from approved documents.',
    permissions: ['documents:read', 'destination:write', 'destination:update', 'network:outbound'],
    status: 'verified',
    signature: null,
  },
  {
    id: 'odoo-erp',
    type: 'odoo',
    label: 'Odoo ERP',
    vendor: 'Odoo S.A.',
    version: '1.0.0',
    summary: 'Write invoices and partners into an Odoo database over JSON-RPC.',
    permissions: ['documents:read', 'destination:write', 'destination:update', 'network:outbound'],
    status: 'verified',
    signature: null,
  },
  {
    id: 'quickbooks-online',
    type: 'quickbooks',
    label: 'QuickBooks Online',
    vendor: 'Intuit',
    version: '1.2.1',
    summary: 'Post bills and invoices to QuickBooks Online.',
    permissions: ['documents:read', 'destination:write', 'destination:update', 'network:outbound'],
    status: 'verified',
    signature: null,
  },
  {
    id: 'google-sheets',
    type: 'google_sheets',
    label: 'Google Sheets',
    vendor: 'Google',
    version: '1.0.3',
    summary: 'Append approved records to a spreadsheet.',
    permissions: ['documents:read', 'destination:write', 'network:outbound', 'secrets:read'],
    status: 'verified',
    signature: null,
  },
  {
    id: 'zoho-crm',
    type: 'zoho',
    label: 'Zoho CRM (withdrawn)',
    vendor: 'Zoho',
    version: '0.9.0',
    summary: 'Withdrawn by the vendor: the API version it used is retired.',
    permissions: ['documents:read', 'destination:write', 'network:outbound'],
    status: 'revoked',
    revokedReason: 'Withdrawn by the vendor on 2026-10-01; installations must move to another CRM.',
    signature: null,
  },
];

/** Verify without access to the publisher's private signing key. */
export function verifyPackageSignature(
  pkg: MarketplacePackage,
  publicKey: KeyObject | null,
): boolean {
  if (!publicKey || publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519')
    return false;
  if (!MarketplacePackageSchema.safeParse(pkg).success || !pkg.signature) return false;
  // Ed25519 signatures are exactly 64 bytes (88 canonical base64 characters).
  if (!/^[A-Za-z0-9+/]{86}==$/.test(pkg.signature)) return false;
  try {
    const signature = Buffer.from(pkg.signature, 'base64');
    return (
      signature.length === 64 &&
      signature.toString('base64') === pkg.signature &&
      verify(null, packageSigningBytes(pkg), publicKey, signature)
    );
  } catch {
    return false;
  }
}

/** Why a package cannot be installed right now, or null when it can. */
export function installBlocker(
  pkg: MarketplacePackage,
  installedVersions: string[],
  publicKey: KeyObject | null,
): string | null {
  if (!verifyPackageSignature(pkg, publicKey)) {
    return `${pkg.label} is not signed by a trusted publisher, so it cannot be installed.`;
  }
  if (pkg.status === 'revoked') {
    return `${pkg.label} has been withdrawn${pkg.revokedReason ? `: ${pkg.revokedReason}` : '.'}`;
  }
  if (installedVersions.includes(pkg.version)) {
    return `${pkg.label} ${pkg.version} is already installed.`;
  }
  return null;
}
