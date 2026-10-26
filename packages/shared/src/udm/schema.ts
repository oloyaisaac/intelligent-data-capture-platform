import { z } from 'zod';
import { DOCUMENT_TYPES, FIELD_TYPES, LIMITS, UDM_VERSION } from '../constants';

/**
 * The Universal Data Model (UDM).
 *
 * Every AI result is normalised into this shape *before* it reaches review, export or a
 * connector. Providers are never allowed to leak their own structure past the adapter layer.
 * See DEC-004 in DECISIONS.md.
 */

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Dotted/array path such as `invoice.number` or `line_items[0].description`. */
export const FIELD_PATH_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+|\[\d+\])*$/;

export const BBoxSchema = z
  .object({
    x: z.number().min(0),
    y: z.number().min(0),
    width: z.number().min(0),
    height: z.number().min(0),
  })
  .strict();

const CellSchema = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);

export const FieldValueSchema = z
  .object({
    /** Human label shown in the review UI. */
    label: z.string().min(1).max(120).optional(),
    /** The extracted value. Numbers are preferred for currency/number fields. */
    value: z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]),
    type: z.enum(FIELD_TYPES).default('string'),
    /** ISO-4217 code, required when `type` is `currency`. */
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'currency must be an ISO-4217 code')
      .optional(),
    /** Provider confidence, 0–1. */
    confidence: z.number().min(0).max(1),
    /** 1-based page number the value came from. */
    page: z.number().int().positive().optional(),
    bbox: BBoxSchema.optional(),
    /** True when a human must confirm the value before it is written anywhere. */
    needsReview: z.boolean().optional(),
    /** True when the value was replaced by a human (audit/learning signal). */
    corrected: z.boolean().optional(),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (field.type === 'currency' && !field.currency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'currency is required for currency fields',
      });
    }
    if (field.type === 'currency' && typeof field.value === 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'currency values must be numbers in minor units of the stated currency',
      });
    }
  });

export const TableColumnSchema = z
  .object({
    key: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    type: z.enum(FIELD_TYPES).default('string'),
  })
  .strict();

export const TableSchema = z
  .object({
    name: z.string().min(1).max(80),
    columns: z.array(TableColumnSchema).min(1).max(64),
    rows: z.array(z.array(CellSchema).max(64)).max(10_000),
  })
  .strict()
  .superRefine((table, ctx) => {
    table.rows.forEach((row, index) => {
      if (row.length !== table.columns.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `row ${index} has ${row.length} cells but the table has ${table.columns.length} columns`,
        });
      }
    });
  });

export const ProvenanceSchema = z
  .object({
    provider: z.string().min(1).max(80),
    modelVersion: z.string().max(80).optional(),
    latencyMs: z.number().int().min(0).optional(),
    costMicros: z.number().int().min(0).optional(),
  })
  .strict();

export const SourceSchema = z
  .object({
    documentId: z.string().min(1).max(64),
    pageCount: z.number().int().min(1).max(500),
    provider: z.string().min(1).max(80),
  })
  .strict();

export const UdmSchema = z
  .object({
    udmVersion: z.string().regex(/^\d+\.\d+$/, 'udmVersion must look like "1.0"'),
    documentType: z.enum(DOCUMENT_TYPES),
    documentTypeConfidence: z.number().min(0).max(1),
    source: SourceSchema,
    /** Keyed by field path, e.g. `invoice.number`. */
    fields: z
      .record(z.string().regex(FIELD_PATH_PATTERN, 'invalid field path'), FieldValueSchema)
      .refine(
        (fields) => Object.keys(fields).length <= 500,
        'a record may contain at most 500 fields',
      )
      .refine(
        (fields) => Object.keys(fields).every((key) => !RESERVED_KEYS.has(key)),
        'reserved key in fields',
      ),
    tables: z.array(TableSchema).max(50).default([]),
    /** True when at least one field (or the classification) needs a human decision. */
    needsReview: z.boolean(),
    /** Non-fatal problems worth showing to the reviewer. */
    warnings: z.array(z.string().max(500)).max(50).default([]),
    provenance: ProvenanceSchema,
    extractedAt: z.string().datetime().optional(),
  })
  .strict();

export type BBox = z.infer<typeof BBoxSchema>;
export type FieldValue = z.infer<typeof FieldValueSchema>;
export type TableColumn = z.infer<typeof TableColumnSchema>;
export type UdmTable = z.infer<typeof TableSchema>;
export type Udm = z.infer<typeof UdmSchema>;

export interface UdmValidationResult {
  ok: boolean;
  udm?: Udm;
  issues: Array<{ path: string; message: string }>;
}

/** Validate an unknown payload against the UDM. Returns field-level issues, never throws. */
export function validateUdm(input: unknown): UdmValidationResult {
  const result = UdmSchema.safeParse(input);
  if (result.success) return { ok: true, udm: result.data, issues: [] };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

/**
 * Parse and normalise provider output into a UDM record.
 * Throws a plain Error with a readable message when the shape is unusable — callers convert
 * this into a job failure, never a 500 with provider details.
 */
export function parseUdm(input: unknown): Udm {
  const result = UdmSchema.safeParse(input);
  if (!result.success) {
    const summary = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid UDM payload: ${summary}`);
  }
  return result.data;
}

/**
 * Decide whether a record needs human review.
 * A record needs review when any field is below the threshold, the classification is
 * uncertain, or a field is explicitly flagged.
 */
export function requiresReview(
  udm: Pick<Udm, 'fields' | 'documentTypeConfidence'>,
  threshold: number = LIMITS.reviewConfidenceThreshold,
): boolean {
  if (udm.documentTypeConfidence < LIMITS.documentTypeConfidenceThreshold) return true;
  return Object.values(udm.fields).some(
    (field) => field.needsReview === true || field.confidence < threshold,
  );
}

/** List the field paths a reviewer must look at first. */
export function lowConfidenceFields(
  udm: Pick<Udm, 'fields'>,
  threshold: number = LIMITS.reviewConfidenceThreshold,
): string[] {
  return Object.entries(udm.fields)
    .filter(([, field]) => field.needsReview === true || field.confidence < threshold)
    .sort(([, a], [, b]) => a.confidence - b.confidence)
    .map(([path]) => path);
}

/** Safe summary for logs and job records: counts only, never values. */
export function summariseUdm(udm: Udm): {
  documentType: Udm['documentType'];
  fieldCount: number;
  tableCount: number;
  needsReview: boolean;
  averageConfidence: number;
} {
  const confidences = Object.values(udm.fields).map((field) => field.confidence);
  const averageConfidence =
    confidences.length === 0
      ? 0
      : Math.round(
          (confidences.reduce((sum, value) => sum + value, 0) / confidences.length) * 1000,
        ) / 1000;
  return {
    documentType: udm.documentType,
    fieldCount: confidences.length,
    tableCount: udm.tables.length,
    needsReview: udm.needsReview,
    averageConfidence,
  };
}

/**
 * The published JSON Schema lives in `docs/udm-1.0.schema.json` and is generated from this
 * file when the developer API ships (see PRD.json DEVAPI-001). Keeping generation out of the
 * runtime avoids shipping a schema compiler to the mobile app.
 */

export { UDM_VERSION };
