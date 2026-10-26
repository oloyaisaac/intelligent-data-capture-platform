import {
  AppError,
  buildPairingQrPayload,
  unprocessable,
  type CompletePairingRequest,
  type CompletePairingResponse,
  type CreatePairingSessionResponse,
  type Device,
} from '@idcp/shared';
import { hashIp, hashToken, newToken } from '@idcp/shared/ids';
import type { Config } from '../config';
import type { Database } from '../db/database';
import { nowIso } from '../db/database';
import type { Logger } from '../logger';
import { DevicesRepository, PairingRepository } from '../repositories/device-repo';
import { AuditRepository } from '../repositories/system-repo';
import type { DeviceRow } from '../repositories/types';
import type { TokenService } from '../auth/tokens';
import type { AuthenticatedActor } from './auth-service';
import type { RealtimeHub } from '../realtime/hub';

export function toDeviceDto(row: DeviceRow): Device {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    appVersion: row.app_version,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export class PairingService {
  private readonly pairings: PairingRepository;
  private readonly devices: DevicesRepository;
  private readonly audit: AuditRepository;

  constructor(
    db: Database,
    private readonly config: Config,
    private readonly tokens: TokenService,
    private readonly hub: RealtimeHub,
    private readonly logger: Logger,
  ) {
    this.pairings = new PairingRepository(db);
    this.devices = new DevicesRepository(db);
    this.audit = new AuditRepository(db);
  }

  /** PAIR-001: the desktop asks for a short-lived pairing session and renders it as a QR code. */
  async createSession(actor: AuthenticatedActor): Promise<CreatePairingSessionResponse> {
    const token = newToken(24);
    const expiresAt = new Date(
      Date.now() + this.config.PAIRING_TOKEN_TTL_SECONDS * 1000,
    ).toISOString();

    const session = await this.pairings.create({
      organisationId: actor.organisationId,
      createdBy: actor.userId,
      tokenHash: hashToken(token),
      expiresAt,
    });

    const endpoint = this.config.API_BASE_URL;
    return {
      id: session.id,
      token,
      endpoint,
      expiresAt,
      expiresInSeconds: this.config.PAIRING_TOKEN_TTL_SECONDS,
      qrPayload: buildPairingQrPayload(endpoint, token),
    };
  }

  async getSession(actor: AuthenticatedActor, id: string) {
    await this.pairings.expireStale();
    const session = await this.pairings.findById(actor.organisationId, id);
    if (!session) throw new AppError('NOT_FOUND', 'Pairing session not found.');
    return {
      id: session.id,
      status: session.status,
      expiresAt: session.expires_at,
      deviceId: session.device_id,
    };
  }

  /**
   * PAIR-002: the phone exchanges the scanned token for a device credential.
   * Single-use is enforced by an atomic claim, so replaying a photographed QR code fails.
   */
  async complete(
    input: CompletePairingRequest,
    context: { ip?: string } = {},
  ): Promise<CompletePairingResponse> {
    await this.pairings.expireStale();
    const session = await this.pairings.findByTokenHash(hashToken(input.token));
    if (!session) {
      throw unprocessable('That pairing code is not valid. Generate a new one on your computer.');
    }
    if (session.status === 'completed') {
      throw new AppError('PAIRING_TOKEN_USED', 'That pairing code has already been used.');
    }
    if (session.status === 'expired' || session.expires_at <= nowIso()) {
      throw new AppError(
        'PAIRING_TOKEN_EXPIRED',
        'That pairing code has expired. Generate a new one.',
      );
    }

    const credential = this.tokens.createDeviceCredential();
    const device = await this.devices.create({
      organisationId: session.organisation_id,
      userId: session.created_by,
      name: input.device.name,
      platform: input.device.platform,
      appVersion: input.device.appVersion ?? null,
      credentialHash: credential.hash,
    });

    const claimed = await this.pairings.claim(session.id, device.id);
    if (!claimed) {
      // Lost the race against another scan of the same code.
      throw new AppError('PAIRING_TOKEN_USED', 'That pairing code has already been used.');
    }

    await this.audit.record({
      organisationId: session.organisation_id,
      actorType: 'device',
      actorId: device.id,
      action: 'device.paired',
      targetType: 'device',
      targetId: device.id,
      ipHash: context.ip ? hashIp(context.ip) : null,
      metadata: { platform: device.platform, name: device.name },
    });

    this.hub.toOrganisation(session.organisation_id, 'device:paired', {
      deviceId: device.id,
      name: device.name,
      platform: device.platform,
      pairedAt: device.created_at,
    });
    this.logger.info('device paired', { deviceId: device.id, platform: device.platform });

    return {
      deviceId: device.id,
      deviceCredential: credential.token,
      organisationId: session.organisation_id,
      deviceName: device.name,
    };
  }

  async listDevices(actor: AuthenticatedActor): Promise<Device[]> {
    const rows = await this.devices.listForOrganisation(actor.organisationId);
    return rows.map(toDeviceDto);
  }

  async rename(actor: AuthenticatedActor, deviceId: string, name: string): Promise<Device> {
    const ok = await this.devices.rename(actor.organisationId, deviceId, name);
    if (!ok) throw new AppError('NOT_FOUND', 'Device not found.');
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'device.renamed',
      targetType: 'device',
      targetId: deviceId,
      metadata: { name },
    });
    const row = await this.devices.findById(actor.organisationId, deviceId);
    return toDeviceDto(row as DeviceRow);
  }

  /** PAIR-004: revocation takes effect on the very next request and closes live sockets. */
  async revoke(actor: AuthenticatedActor, deviceId: string): Promise<void> {
    const ok = await this.devices.revoke(actor.organisationId, deviceId);
    if (!ok) throw new AppError('NOT_FOUND', 'Device not found.');
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'device.revoked',
      targetType: 'device',
      targetId: deviceId,
    });
    this.hub.toOrganisation(actor.organisationId, 'device:revoked', { deviceId });
    this.hub.disconnectDevice(deviceId);
  }

  /** Used by the auth guard on every device-authenticated request. */
  async findActiveDeviceByCredential(credential: string): Promise<DeviceRow | null> {
    const device = await this.devices.findByCredentialHash(hashToken(credential));
    if (!device || device.revoked_at) return null;
    await this.devices.touch(device.id);
    return device;
  }
}
