import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { CreatePairingSessionResponse, Device } from '@idcp/shared';
import type { ApiClient } from '../api/client';
import { formatDateTime } from '../lib/format';
import { Badge, Card, EmptyState, ErrorBanner, Modal, useAsync } from '../components/ui';

/**
 * PAIR-001 / PAIR-004 — pairing and device management.
 *
 * The desktop generates a single-use code with a two-minute life and renders it as a QR image. The
 * token is shown as text too, so pairing still works when a camera cannot see the screen. Revoking
 * a device takes effect on its next request.
 */
export function DevicesPage({ client }: { client: ApiClient }): React.JSX.Element {
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
      setError(caught instanceof Error ? caught.message : 'Could not start pairing.');
    } finally {
      setBusy(false);
    }
  };

  const items: Device[] = devices.data?.items ?? [];

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Devices</h1>
        <button
          className="button"
          type="button"
          onClick={() => void startPairing()}
          disabled={busy}
        >
          {busy ? 'Preparing…' : 'Pair a phone'}
        </button>
      </div>

      <ErrorBanner message={error ?? devices.error} />

      <Card title="Paired devices">
        {items.length === 0 ? (
          <EmptyState title="No devices paired" hint="Pair a phone to start capturing documents." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Platform</th>
                <th>Last seen</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((device) => (
                <tr key={device.id}>
                  <td>{device.name}</td>
                  <td>{device.platform}</td>
                  <td className="dim">{formatDateTime(device.lastSeenAt ?? null)}</td>
                  <td>
                    <Badge tone={device.revokedAt ? 'danger' : 'success'}>
                      {device.revokedAt ? 'revoked' : 'active'}
                    </Badge>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {!device.revokedAt && (
                      <button
                        className="button danger small"
                        type="button"
                        onClick={async () => {
                          if (
                            !window.confirm(
                              `Revoke ${device.name}? It will need to be paired again.`,
                            )
                          )
                            return;
                          try {
                            await client.revokeDevice(device.id);
                            await devices.reload();
                          } catch (caught) {
                            setError(
                              caught instanceof Error
                                ? caught.message
                                : 'Could not revoke that device.',
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
          title="Pair a phone"
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
              Done
            </button>
          }
        >
          <p className="muted" style={{ margin: 0 }}>
            Open the IDCP app on the phone and scan this code. It works once and expires in{' '}
            {Math.max(0, Math.floor(remaining / 60))}m {remaining % 60}s.
          </p>
          <div className="qr-frame">
            {qr ? (
              <img src={qr} alt="Pairing QR code" width={260} height={260} />
            ) : (
              <span>Rendering…</span>
            )}
          </div>
          <div className="code-block">{session.qrPayload}</div>
          {remaining === 0 && (
            <div className="error-banner" role="alert">
              This code has expired. Close this dialog and generate a new one.
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
