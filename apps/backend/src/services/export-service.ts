import {
  AppError,
  toCsv,
  type CreateExportRequest,
  type CsvCell,
  type ExportRecord,
  type Udm,
} from '@idcp/shared';
import ExcelJS from 'exceljs';
import type { Config } from '../config';
import type { Database } from '../db/database';
import type { Logger } from '../logger';
import { DocumentsRepository } from '../repositories/document-repo';
import { ExportsRepository } from '../repositories/connector-repo';
import { AuditRepository } from '../repositories/system-repo';
import { ReviewsRepository } from '../repositories/review-repo';
import type { ExportRow } from '../repositories/types';
import { buildStorageKey, extensionForMimeType, type Storage } from '../storage';
import type { AuthenticatedActor } from './auth-service';
import type { RealtimeHub } from '../realtime/hub';

interface ExportTable {
  headers: string[];
  rows: CsvCell[][];
}

export function toExportDto(row: ExportRow, downloadUrl: string | null = null): ExportRecord {
  return {
    id: row.id,
    format: row.format,
    status: row.status,
    rowCount: row.row_count,
    downloadUrl,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

/**
 * EXPORT-001 / EXPORT-002: export approved records to Excel or CSV.
 *
 * Only approved records with a human-approved UDM snapshot are exported: the export is a record of
 * decisions a person signed off, never raw AI output.
 */
export class ExportService {
  private readonly documents: DocumentsRepository;
  private readonly reviews: ReviewsRepository;
  private readonly exports: ExportsRepository;
  private readonly audit: AuditRepository;

  constructor(
    db: Database,
    private readonly config: Config,
    private readonly storage: Storage,
    private readonly hub: RealtimeHub,
    private readonly logger: Logger,
  ) {
    this.documents = new DocumentsRepository(db);
    this.reviews = new ReviewsRepository(db);
    this.exports = new ExportsRepository(db);
    this.audit = new AuditRepository(db);
  }

  async create(actor: AuthenticatedActor, request: CreateExportRequest): Promise<ExportRecord> {
    const record = await this.exports.create({
      organisationId: actor.organisationId,
      requestedBy: actor.userId,
      format: request.format,
      filter: request,
    });

    try {
      const table = await this.buildTable(actor, request);
      const extension = request.format;
      const storageKey = buildStorageKey({
        organisationId: actor.organisationId,
        kind: 'exports',
        id: record.id,
        extension,
      });
      const buffer =
        request.format === 'csv'
          ? Buffer.from(
              toCsv(table.headers, table.rows, {
                delimiter: request.delimiter ?? ',',
                bom: request.bom ?? false,
              }),
              'utf8',
            )
          : await this.buildWorkbook(table);

      await this.storage.put(storageKey, buffer, extensionForMimeType(extension));
      const expiresAt = new Date(Date.now() + this.config.EXPORTS_TTL_SECONDS * 1000).toISOString();
      await this.exports.markReady(record.id, storageKey, table.rows.length, expiresAt);

      await this.audit.record({
        organisationId: actor.organisationId,
        actorType: actor.actorType,
        actorId: actor.userId,
        action: 'export.created',
        targetType: 'export',
        targetId: record.id,
        metadata: { format: request.format, rows: table.rows.length },
      });
      this.hub.toOrganisation(actor.organisationId, 'export:ready', {
        exportId: record.id,
        rows: table.rows.length,
      });

      const updated = await this.exports.findById(actor.organisationId, record.id);
      return toExportDto(updated ?? record, `/api/v1/exports/${record.id}/download`);
    } catch (error) {
      await this.exports.markFailed(record.id);
      this.logger.warn('export failed', { exportId: record.id, error: (error as Error).message });
      throw error;
    }
  }

  async get(actor: AuthenticatedActor, id: string): Promise<ExportRecord> {
    const row = await this.exports.findById(actor.organisationId, id);
    if (!row) throw new AppError('NOT_FOUND', 'Export not found.');
    const expired = row.expires_at !== null && row.expires_at <= new Date().toISOString();
    if (expired) return toExportDto({ ...row, status: 'expired' });
    return toExportDto(row, row.status === 'ready' ? `/api/v1/exports/${id}/download` : null);
  }

  async list(actor: AuthenticatedActor): Promise<ExportRecord[]> {
    const rows = await this.exports.list(actor.organisationId);
    return rows.map((row) =>
      toExportDto(row, row.status === 'ready' ? `/api/v1/exports/${row.id}/download` : null),
    );
  }

  async download(
    actor: AuthenticatedActor,
    id: string,
  ): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
    const row = await this.exports.findById(actor.organisationId, id);
    if (!row || row.status !== 'ready' || !row.storage_key) {
      throw new AppError('NOT_FOUND', 'Export not found or not ready.');
    }
    if (row.expires_at && row.expires_at <= new Date().toISOString()) {
      throw new AppError('NOT_FOUND', 'That export has expired. Create a new one.');
    }
    const buffer = await this.storage.get(row.storage_key);
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'export.downloaded',
      targetType: 'export',
      targetId: id,
    });
    return {
      buffer,
      mimeType: extensionForMimeType(row.format),
      filename: `idcp-export-${row.created_at.slice(0, 10)}.${row.format}`,
    };
  }

  private async buildTable(
    actor: AuthenticatedActor,
    request: CreateExportRequest,
  ): Promise<ExportTable> {
    const documents = await this.documents.listApproved(actor.organisationId, {
      documentType: request.documentType,
      from: request.from,
      to: request.to,
    });

    const records: Array<{ documentId: string; udm: Udm }> = [];
    for (const document of documents) {
      const approved = await this.reviews.findApprovedUdm(document.id);
      if (approved) records.push({ documentId: document.id, udm: approved as Udm });
    }

    const fieldPaths = new Set<string>();
    for (const record of records) {
      for (const path of Object.keys(record.udm.fields)) fieldPaths.add(path);
    }
    const selected = request.columns?.length ? request.columns : [...fieldPaths].sort();
    for (const column of selected) fieldPaths.delete(column);

    const headers = ['document_id', 'document_type', ...selected];
    const rows: CsvCell[][] = records.map((record) => [
      record.documentId,
      record.udm.documentType,
      ...selected.map((path) => {
        const field = record.udm.fields[path];
        if (!field) return null;
        if (field.type === 'currency' && typeof field.value === 'number') {
          return `${field.value} ${field.currency ?? ''}`.trim();
        }
        if (typeof field.value === 'boolean') return field.value;
        if (typeof field.value === 'number') return field.value;
        return field.value === null ? null : String(field.value);
      }),
    ]);

    return { headers, rows };
  }

  private async buildWorkbook(table: ExportTable): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'IDCP';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Records');

    sheet.columns = table.headers.map((header) => ({
      header,
      key: header,
      width: Math.min(Math.max(header.length + 4, 14), 48),
    }));
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    for (const row of table.rows) {
      const values: Record<string, CsvCell> = {};
      table.headers.forEach((header, index) => {
        values[header] = row[index] ?? null;
      });
      sheet.addRow(values);
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
