import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { CreatePairingSessionResponse, Device } from '@idcp/shared';
import type { ApiClient } from '../api/client';
import { formatDateTime } from '../lib/format';
import { Badge, Card, EmptyState, ErrorBanner, Modal, useAsync } from '../components/ui';
import { useLocale, useTranslator } from '../lib/locale';

/**
 * PAIR-001 / PAIR-004 — pairing and device management.
 *
 * The desktop generates a single-use code with a two-minute life and renders it as a QR image. The
 * token is shown as text too, so pairing still works when a camera cannot see the screen. Revoking
 * a device takes effect on its next request.
 */
export function DevicesPage({ client }: { client: ApiClient }): React.JSX.Element {
  const t = useTranslator();
  const { locale } = useLocale();
  const devices = useAsync(() => client.listDevices(), []);
  const [session, setSession] = useState<CreatePairingSessionResponse | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session) return;
    const deadline = new Date(session.expiresAt).getTime();
    const tick = () => setRemaining(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [session]);

  const startPairing = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await client.createPairingSession();
      setSession(created);
      setQr(await QRCode.toDataURL(created.qrPayload, { margin: 1, width: 260 }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('devices.startPairingFailed'));
    } finally {
      setBusy(false);
    }
  };

  const items: Device[] = devices.data?.items ?? [];

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>{t('devices.title')}</h1>
        <button
          className="button"
          type="button"
          onClick={() => void startPairing()}
          disabled={busy}
        >
          {busy ? t('devices.preparing') : t('devices.pairPhone')}
        </button>
      </div>

      <ErrorBanner message={error ?? devices.error} />

      <Card title={t('devices.paired')}>
        {items.length === 0 ? (
          <EmptyState title={t('devices.none')} hint={t('devices.noneHint')} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('settings.name')}</th>
                <th>{t('table.platform')}</th>
                <th>{t('table.lastSeen')}</th>
                <th>{t('table.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((device) => (
                <tr key={device.id}>
                  <td>{device.name}</td>
                  <td>{device.platform}</td>
                  <td className="dim">{formatDateTime(device.lastSeenAt ?? null, locale)}</td>
                  <td>
                    <Badge tone={device.revokedAt ? 'danger' : 'success'}>
                      {device.revokedAt ? 'revoked' : 'active'}
                    </Badge>
                  </td>
                  <td style={{ textAlign: 'end' }}>
                    {!device.revokedAt && (
                      <button
                        className="button danger small"
                        type="button"
                        onClick={async () => {
                          if (!window.confirm(t('devices.revokeConfirm', { name: device.name })))
                            return;
                          try {
                            await client.revokeDevice(device.id);
                            await devices.reload();
                          } catch (caught) {
                            setError(
                              caught instanceof Error
                                ? caught.message
                                : t('devices.couldNotRevoke'),
                            );
                          }
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {session && (
        <Modal
          title={t('devices.pairPhone')}
          onClose={() => {
            setSession(null);
            setQr(null);
            void devices.reload();
          }}
          footer={
            <button
              className="button secondary"
              type="button"
              onClick={() => {
                setSession(null);
                setQr(null);
                void devices.reload();
              }}
            >
              {t('devices.done')}
            </button>
          }
        >
          <p className="muted" style={{ margin: 0 }}>
            {t('devices.scanHint', {
              minutes: Math.max(0, Math.floor(remaining / 60)),
              seconds: remaining % 60,
            })}
          </p>
          <div className="qr-frame">
            {qr ? (
              <img src={qr} alt={t('devices.qrAlt')} width={260} height={260} />
            ) : (
              <span>{t('devices.rendering')}</span>
            )}
          </div>
          <div className="code-block">{session.qrPayload}</div>
          {remaining === 0 && (
            <div className="error-banner" role="alert">
              {t('devices.expired')}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
