import React, { useState } from 'react';
import type { Translate, TranslationKey } from '@idcp/shared';
import type { ApiClient } from '../api/client';
import { Badge, Card, EmptyState, ErrorBanner, useAsync } from '../components/ui';
import { useTranslator } from '../lib/locale';

/**
 * The connector marketplace (MARKET-001).
 *
 * The rule this screen follows: nothing gets installed before the person installing it has seen
 * what the package will be allowed to do. Permissions are listed as plain sentences, the signature
 * state is shown for every package, and a withdrawn package stays visible with the vendor's reason
 * instead of disappearing.
 */

export interface MarketplacePackageView {
  id: string;
  type: string;
  label: string;
  vendor: string;
  version: string;
  summary: string;
  permissions: string[];
  status: 'verified' | 'revoked';
  revokedReason?: string;
  signature: string | null;
  signatureVerified: boolean;
  installedVersions: string[];
  availableVersions: string[];
  activeInstallId: string | null;
  installable: boolean;
  blocker: string | null;
  availableConnectors: Array<{ id: string; name: string }>;
}

/** Permissions are shown as consequences, not as scope strings. */
/**
 * I18N-001 — a permission is explained as a sentence, in the reader's language.
 *
 * `PERMISSION_LABELS` stays the English source of truth (and the fallback), so a permission added by
 * the backend is still disclosed before its translation ships.
 */
export const PERMISSION_LABELS: Record<string, string> = {
  'documents:read': 'Read the extracted values of documents you send',
  'destination:write': 'Create records in the destination',
  'destination:update': 'Change records that already exist in the destination',
  'network:outbound': 'Make outbound network requests',
  'secrets:read': 'Use the credentials stored for this connector',
};

const PERMISSION_KEYS: Record<string, TranslationKey> = {
  'documents:read': 'marketplace.permission.documentsRead',
  'destination:write': 'marketplace.permission.destinationWrite',
  'destination:update': 'marketplace.permission.destinationUpdate',
  'network:outbound': 'marketplace.permission.networkOutbound',
  'secrets:read': 'marketplace.permission.secretsRead',
};

export function permissionLabel(permission: string, t?: Translate): string {
  const key = PERMISSION_KEYS[permission];
  if (t && key) return t(key);
  return PERMISSION_LABELS[permission] ?? permission;
}

export function MarketplacePage({ client }: { client: ApiClient }): React.JSX.Element {
  const t = useTranslator();
  const packages = useAsync(() => client.listMarketplace(), []);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const items: MarketplacePackageView[] = packages.data?.items ?? [];

  const install = async (pkg: MarketplacePackageView) => {
    const connectorId = selected[pkg.id] ?? pkg.availableConnectors[0]?.id;
    if (!connectorId) {
      setError(t('marketplace.createConnectorFirst', { type: pkg.type, package: pkg.label }));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await client.installPackage({ packageId: pkg.id, connectorId });
      setNotice(t('marketplace.installed', { package: pkg.label, version: result.version }));
      await packages.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('marketplace.installFailed'));
    } finally {
      setBusy(false);
    }
  };

  const rollback = async (pkg: MarketplacePackageView) => {
    if (!pkg.activeInstallId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await client.rollbackPackage(pkg.activeInstallId);
      setNotice(result.message);
      await packages.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('marketplace.rollbackFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <h1>{t('marketplace.title')}</h1>
      <p className="dim" style={{ margin: 0 }}>
        {t('marketplace.intro')}
      </p>

      <ErrorBanner message={error ?? packages.error} />
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}

      {packages.loading && !packages.data ? (
        <Card>
          <EmptyState title={t('marketplace.loading')} />
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState title={t('marketplace.empty')} hint={t('marketplace.emptyHint')} />
        </Card>
      ) : (
        items.map((pkg) => (
          <Card
            key={pkg.id}
            title={pkg.label}
            actions={
              <div className="row">
                <Badge tone={pkg.status === 'revoked' ? 'danger' : 'neutral'}>{pkg.vendor}</Badge>
                <Badge tone={pkg.signatureVerified ? 'success' : 'danger'}>
                  {pkg.signatureVerified
                    ? t('marketplace.signatureVerified')
                    : t('marketplace.unsigned')}
                </Badge>
                {pkg.activeInstallId && (
                  <Badge tone="info">
                    {t('marketplace.installedVersion', { version: pkg.version })}
                  </Badge>
                )}
              </div>
            }
          >
            <div className="stack">
              <p style={{ margin: 0 }}>{pkg.summary}</p>
              <div className="dim">
                {t('marketplace.versionLine', { version: pkg.version })}
                {pkg.availableVersions.length > 1
                  ? ` · ${t('marketplace.available', { versions: pkg.availableVersions.join(', ') })}`
                  : ''}
              </div>

              <div>
                <div className="label">{t('marketplace.willBeAble')}</div>
                <ul style={{ margin: '4px 0 0 18px' }}>
                  {pkg.permissions.map((permission) => (
                    <li key={permission}>{permissionLabel(permission, t)}</li>
                  ))}
                </ul>
              </div>

              {pkg.status === 'revoked' && (
                <p className="dim" style={{ margin: 0 }}>
                  {pkg.revokedReason ?? t('marketplace.withdrawn')}
                </p>
              )}

              <div className="toolbar">
                {pkg.availableConnectors.length > 0 && (
                  <label className="field" style={{ minWidth: 220 }}>
                    <span className="label">{t('marketplace.installOn')}</span>
                    <select
                      className="select"
                      aria-label={t('marketplace.connectorFor', { package: pkg.label })}
                      value={selected[pkg.id] ?? pkg.availableConnectors[0]!.id}
                      onChange={(event) =>
                        setSelected({ ...selected, [pkg.id]: event.target.value })
                      }
                    >
                      {pkg.availableConnectors.map((connector) => (
                        <option key={connector.id} value={connector.id}>
                          {connector.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <button
                  className="button"
                  type="button"
                  disabled={busy || !pkg.installable}
                  title={pkg.blocker ?? undefined}
                  onClick={() => void install(pkg)}
                >
                  {pkg.activeInstallId ? t('marketplace.reinstall') : t('marketplace.install')}
                </button>
                {pkg.activeInstallId && (
                  <button
                    className="button secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => void rollback(pkg)}
                  >
                    {t('marketplace.rollback')}
                  </button>
                )}
              </div>

              {pkg.blocker && (
                <p className="dim" style={{ margin: 0 }}>
                  {pkg.blocker}
                </p>
              )}
              {!pkg.blocker && pkg.availableConnectors.length === 0 && (
                <p className="dim" style={{ margin: 0 }}>
                  {t('marketplace.createConnectorHere', { type: pkg.type })}
                </p>
              )}
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
