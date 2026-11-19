import {
  AppError,
  applyCorrections,
  blockingFields,
  canApprove,
  parseUdm,
  roleAtLeast,
  type DocumentSummary,
  type DocumentType,
  type Udm,
} from '@idcp/shared';
import { nowIso } from '../db/database';
import type { Logger } from '../logger';
import type { DocumentsRepository, ExtractionsRepository } from '../repositories/document-repo';
import type { OrganisationsRepository } from '../repositories/auth-repo';
import type { ReviewChangesRepository, ReviewsRepository } from '../repositories/review-repo';
import type { AuditRepository } from '../repositories/system-repo';
import type { DocumentRow } from '../repositories/types';
import { toDocumentSummary } from './document-service';
import type { AuthenticatedActor } from './auth-service';
import type { RealtimeHub } from '../realtime/hub';

export interface ReviewQueueItem {
  document: DocumentSummary;
  extractionId: string | null;
  confidence: number | null;
  blockingFields: Array<{ path: string; reason: string; confidence: number }>;
}

export interface ReviewServiceRepositories {
  documents: Pick<
    DocumentsRepository,
    'list' | 'findById' | 'updateAnyDocumentType' | 'updateStatus'
  >;
  extractions: Pick<ExtractionsRepository, 'findLatestForDocument' | 'findById' | 'create'>;
  reviews: Pick<ReviewsRepository, 'findById' | 'openOrResume' | 'setExtraction' | 'complete'>;
  changes: Pick<
    ReviewChangesRepository,
    | 'create'
    | 'listForReview'
    | 'listForTraining'
    | 'statisticsByDocumentType'
    | 'statisticsForOrganisation'
  >;
  audit: Pick<AuditRepository, 'record'>;
  organisations: Pick<OrganisationsRepository, 'findLearningOptIn'>;
}

export class ReviewService {
  private readonly documents: ReviewServiceRepositories['documents'];
  private readonly extractions: ReviewServiceRepositories['extractions'];
  private readonly reviews: ReviewServiceRepositories['reviews'];
  private readonly changes: ReviewServiceRepositories['changes'];
  private readonly audit: ReviewServiceRepositories['audit'];
  private readonly organisations: ReviewServiceRepositories['organisations'];

  constructor(
    repositories: ReviewServiceRepositories,
    private readonly hub: RealtimeHub,
    private readonly logger: Logger,
  ) {
    this.documents = repositories.documents;
    this.extractions = repositories.extractions;
    this.reviews = repositories.reviews;
    this.changes = repositories.changes;
    this.audit = repositories.audit;
    this.organisations = repositories.organisations;
  }

  /** REV-001: the queue puts the least confident records first — that is where attention pays off. */
  async queue(
    actor: AuthenticatedActor,
    limit = 25,
  ): Promise<{ items: ReviewQueueItem[]; total: number }> {
    const rows = await this.documents.list(actor.organisationId, { status: 'needs_review', limit });
    const items: ReviewQueueItem[] = [];
    for (const row of rows) {
      const extraction = await this.extractions.findLatestForDocument(row.id);
      if (!extraction) continue;
      const udm = parseUdm(JSON.parse(extraction.udm) as unknown);
      items.push({
        document: toDocumentSummary(row),
        extractionId: extraction.id,
        confidence: extraction.confidence,
        blockingFields: blockingFields(udm),
      });
    }
    items.sort((a, b) => (a.confidence ?? 0) - (b.confidence ?? 0));
    return { items, total: items.length };
  }

  async open(actor: AuthenticatedActor, documentId: string) {
    const document = await this.requireDocument(actor, documentId);
    const extraction = await this.extractions.findLatestForDocument(documentId);
    if (!extraction) throw new AppError('CONFLICT', 'This document has not been processed yet.');
    const review = await this.reviews.openOrResume({
      organisationId: actor.organisationId,
      documentId,
      extractionId: extraction.id,
      reviewerId: actor.userId,
    });
    const udm = parseUdm(JSON.parse(extraction.udm) as unknown);
    return {
      reviewId: review.id,
      status: review.status,
      document: toDocumentSummary(document),
      documentType: udm.documentType,
      documentTypeConfidence: udm.documentTypeConfidence,
      udm,
      blocking: blockingFields(udm),
      changes: await this.changes.listForReview(review.id),
    };
  }

  /**
   * Applies corrections, records every change for audit and learning, and re-evaluates whether
   * the record can now be approved.
   */
  async patchFields(
    actor: AuthenticatedActor,
    reviewId: string,
    changes: Array<{ fieldPath: string; value: string | number | boolean | null }>,
    options: { documentType?: DocumentType } = {},
  ) {
    const review = await this.reviews.findById(actor.organisationId, reviewId);
    if (!review) throw new AppError('NOT_FOUND', 'Review not found.');
    if (review.status !== 'in_progress') {
      throw new AppError('CONFLICT', 'This review is already closed.');
    }

    const extraction = await this.extractions.findById(actor.organisationId, review.extraction_id);
    if (!extraction) throw new AppError('NOT_FOUND', 'Extraction not found.');

    const udm = parseUdm(JSON.parse(extraction.udm) as unknown);
    const { udm: corrected, applied } = applyCorrections(udm, changes);

    // Confirming (or correcting) the classification is itself a human decision, so it becomes
    // full-confidence and clears the related blocker.
    let updated = corrected;
    if (options.documentType) {
      const previousType = corrected.documentType;
      updated = {
        ...corrected,
        documentType: options.documentType,
        documentTypeConfidence: 1,
      };
      await this.changes.create({
        reviewId: review.id,
        fieldPath: 'documentType',
        originalValue: previousType,
        correctedValue: options.documentType,
        originalConfidence: corrected.documentTypeConfidence,
        changedBy: actor.userId,
        documentType: options.documentType,
      });
      await this.documents.updateAnyDocumentType(review.document_id, options.documentType);
      await this.audit.record({
        organisationId: actor.organisationId,
        actorType: actor.actorType,
        actorId: actor.userId,
        action: 'document.field_corrected',
        targetType: 'document',
        targetId: review.document_id,
        metadata: { fieldPath: 'documentType', from: previousType, to: options.documentType },
      });
    }

    for (const change of applied) {
      await this.changes.create({
        reviewId: review.id,
        fieldPath: change.fieldPath,
        originalValue: change.before?.value ?? null,
        correctedValue: change.after.value,
        originalConfidence: change.before?.confidence ?? null,
        changedBy: actor.userId,
        documentType: updated.documentType,
      });
      await this.audit.record({
        organisationId: actor.organisationId,
        actorType: actor.actorType,
        actorId: actor.userId,
        action: 'document.field_corrected',
        targetType: 'document',
        targetId: review.document_id,
        metadata: { fieldPath: change.fieldPath },
      });
    }

    // Persist the corrected record as a new extraction attempt so history is never rewritten.
    const saved = await this.extractions.create({
      documentId: review.document_id,
      organisationId: actor.organisationId,
      udm: { ...updated, needsReview: blockingFields(updated).length > 0 },
      udmVersion: extraction.udm_version,
      provider: extraction.provider,
      confidence: extraction.confidence,
      needsReview: blockingFields(updated).length > 0,
    });

    // Re-point the open review at the new attempt.
    await this.reviews.setExtraction(review.id, saved.id, nowIso());

    return {
      reviewId: review.id,
      extractionId: saved.id,
      blocking: blockingFields(updated),
      applied: applied.length + (options.documentType ? 1 : 0),
      documentType: updated.documentType,
    };
  }

  async approve(actor: AuthenticatedActor, reviewId: string, notes?: string) {
    const review = await this.reviews.findById(actor.organisationId, reviewId);
    if (!review) throw new AppError('NOT_FOUND', 'Review not found.');
    if (review.status !== 'in_progress')
      throw new AppError('CONFLICT', 'This review is already closed.');

    const extraction = await this.extractions.findById(actor.organisationId, review.extraction_id);
    if (!extraction) throw new AppError('NOT_FOUND', 'Extraction not found.');

    const udm = parseUdm(JSON.parse(extraction.udm) as unknown);
    const check = canApprove(udm);
    if (!check.ok) {
      throw new AppError(
        'UNPROCESSABLE',
        'Some fields still need your attention before this record can be approved.',
        check.blocking,
      );
    }

    const approved: Udm = { ...udm, needsReview: false };
    await this.reviews.complete(review.id, {
      status: 'approved',
      approvedUdm: approved,
      notes: notes ?? null,
    });
    await this.documents.updateStatus(review.document_id, 'approved');
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'document.approved',
      targetType: 'document',
      targetId: review.document_id,
    });
    this.hub.toOrganisation(actor.organisationId, 'document:approved', {
      documentId: review.document_id,
      reviewedBy: actor.userId,
    });

    return { reviewId: review.id, documentId: review.document_id, status: 'approved' };
  }

  async reject(actor: AuthenticatedActor, reviewId: string, reason: string) {
    const review = await this.reviews.findById(actor.organisationId, reviewId);
    if (!review) throw new AppError('NOT_FOUND', 'Review not found.');
    if (review.status !== 'in_progress')
      throw new AppError('CONFLICT', 'This review is already closed.');

    await this.reviews.complete(review.id, { status: 'rejected', notes: reason });
    await this.documents.updateStatus(review.document_id, 'failed');
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'document.rejected',
      targetType: 'document',
      targetId: review.document_id,
      metadata: { reason },
    });
    return { reviewId: review.id, status: 'rejected' };
  }

  /**
   * Bulk approve (REV-001): records with unresolved low-confidence fields are skipped and
   * reported — never silently approved.
   */
  async bulkApprove(actor: AuthenticatedActor, documentIds: string[]) {
    const approved: string[] = [];
    const skipped: Array<{ documentId: string; blocking: unknown }> = [];

    for (const documentId of documentIds) {
      const document = await this.documents.findById(actor.organisationId, documentId);
      if (!document || document.deleted_at) {
        skipped.push({ documentId, blocking: [{ path: '*', reason: 'not_found', confidence: 0 }] });
        continue;
      }
      const extraction = await this.extractions.findLatestForDocument(documentId);
      if (!extraction) {
        skipped.push({
          documentId,
          blocking: [{ path: '*', reason: 'not_processed', confidence: 0 }],
        });
        continue;
      }
      const udm = parseUdm(JSON.parse(extraction.udm) as unknown);
      const check = canApprove(udm);
      if (!check.ok) {
        skipped.push({ documentId, blocking: check.blocking });
        continue;
      }

      const review = await this.reviews.openOrResume({
        organisationId: actor.organisationId,
        documentId,
        extractionId: extraction.id,
        reviewerId: actor.userId,
      });
      await this.reviews.complete(review.id, {
        status: 'approved',
        approvedUdm: { ...udm, needsReview: false },
      });
      await this.documents.updateStatus(documentId, 'approved');
      await this.audit.record({
        organisationId: actor.organisationId,
        actorType: actor.actorType,
        actorId: actor.userId,
        action: 'document.approved',
        targetType: 'document',
        targetId: documentId,
        metadata: { bulk: true },
      });
      approved.push(documentId);
    }

    this.logger.info('bulk approve completed', {
      approved: approved.length,
      skipped: skipped.length,
    });
    return { approved, skipped };
  }

  /**
   * REV-002: what the organisation keeps getting wrong.
   *
   * Aggregates only — no field values — so a reviewer can see the pattern without correction
   * content leaving the review screens.
   */
  async correctionStats(actor: AuthenticatedActor) {
    const organisation = await this.organisations.findLearningOptIn(actor.organisationId);
    const byField = await this.changes.statisticsForOrganisation(actor.organisationId);
    const byDocumentType = await this.changes.statisticsByDocumentType(actor.organisationId);

    return {
      optIn: Number(organisation?.learning_opt_in ?? 0) === 1,
      total: byField.reduce((sum, row) => sum + Number(row.corrections), 0),
      byField: byField.map((row) => ({
        fieldPath: row.field_path,
        corrections: Number(row.corrections),
        averageConfidence: row.average_confidence === null ? null : Number(row.average_confidence),
      })),
      byDocumentType: byDocumentType.map((row) => ({
        documentType: row.document_type,
        corrections: Number(row.corrections),
        averageConfidence: row.average_confidence === null ? null : Number(row.average_confidence),
      })),
    };
  }

  /**
   * REV-002: the training hand-off.
   *
   * Refused unless the organisation has explicitly opted in (and the caller is an admin): using a
   * customer's corrections for training without consent is not a configuration detail.
   */
  async correctionsForTraining(actor: AuthenticatedActor, limit = 500) {
    if (!roleAtLeast(actor.role, 'admin')) {
      throw new AppError('ROLE_REQUIRED', 'Only admins can export correction data.');
    }
    const organisation = await this.organisations.findLearningOptIn(actor.organisationId);
    if (Number(organisation?.learning_opt_in ?? 0) !== 1) {
      throw new AppError(
        'CONFLICT',
        'This organisation has not opted in to using corrections for training.',
      );
    }

    const rows = await this.changes.listForTraining(actor.organisationId, Math.min(limit, 5000));
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'review.corrections_exported',
      targetType: 'organisation',
      targetId: actor.organisationId,
      metadata: { rows: rows.length },
    });

    return {
      organisationId: actor.organisationId,
      exportedAt: nowIso(),
      rows: rows.map((row) => ({
        documentType: row.document_type,
        fieldPath: row.field_path,
        originalValue: row.original_value,
        correctedValue: row.corrected_value,
        originalConfidence: row.original_confidence,
        createdAt: row.created_at,
      })),
    };
  }

  private async requireDocument(actor: AuthenticatedActor, id: string): Promise<DocumentRow> {
    const document = await this.documents.findById(actor.organisationId, id);
    if (!document || document.deleted_at) throw new AppError('NOT_FOUND', 'Document not found.');
    return document;
  }
}
