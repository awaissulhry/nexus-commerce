import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { inspectionSchema, releaseSchema } from '../inspections/api'

/**
 * The evidence trail (`GET /quality/evidence?serial=|batch=`, Owner answer Q2 (a): read only in W1), as the API's
 * contract gives it (apps/factory-api modules/quality/final contract `evidenceContract`). The lot's issued value (cost
 * grain) is NOT read: the design says costs, prices and wages never appear in the evidence trail.
 */

export const EVIDENCE_KINDS = ['batch', 'serial'] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

const lotSchema = z.object({
  id: z.string(),
  code: z.string(),
  item: z.object({ code: z.string(), name: z.string(), isPpeComponent: z.boolean() }).nullable(),
  qualityStatus: z.string(),
  crVi: z.object({ required: z.boolean(), status: z.string(), valueMgKg: z.string().nullable(), limitMgKg: z.string().nullable(), evidence: z.string().nullable(), testedOn: z.string().nullable() }),
  results: z.array(
    z.object({
      id: z.string(),
      test: z.string(),
      method: z.string(),
      valueMgKg: z.string().nullable(),
      belowDetectionLimit: z.boolean(),
      limitMgKg: z.string(),
      verdict: z.string(),
      lab: z.string(),
      reportNumber: z.string().nullable(),
      testedOn: z.string(),
      evidence: z.string(),
      fileId: z.string(),
      supersedesId: z.string().nullable(),
    }),
  ),
  documents: z.array(z.object({ id: z.string(), kind: z.string(), fileId: z.string(), validTo: z.string().nullable(), status: z.string() })),
})

export const evidenceSchema = z.object({
  subject: z.object({
    kind: z.enum(['SERIAL', 'BATCH']),
    serial: z.object({ id: z.string(), serial: z.string(), status: z.string(), bundleId: z.string().nullable(), releaseId: z.string().nullable() }).nullable(),
    batchNumber: z.string().nullable(),
    workOrder: z.object({ id: z.string(), number: z.string(), status: z.string(), companyId: z.string(), siteId: z.string(), releasedAt: z.string().nullable() }),
    cells: z.array(z.object({ workOrderSizeId: z.string(), colourwayCode: z.string(), size: z.string(), pieces: z.number() })),
  }),
  style: z.object({ id: z.string(), code: z.string(), name: z.string(), ppeCategory: z.string(), ppeStandard: z.string().nullable(), ppeClass: z.string().nullable(), tracking: z.string() }).nullable(),
  revision: z.object({ id: z.string(), revision: z.number(), status: z.string(), releasedAt: z.string().nullable() }).nullable(),
  labelTemplate: z.object({ id: z.string(), code: z.string(), revision: z.number(), status: z.string(), languages: z.array(z.string()) }).nullable(),
  documents: z.array(
    z.object({ id: z.string(), kind: z.string(), language: z.string(), revision: z.number(), status: z.string(), number: z.string().nullable(), issuedAt: z.string().nullable(), file: z.object({ id: z.string(), sha256: z.string() }).nullable() }),
  ),
  certificates: z.object({ today: z.array(z.object({ workOrderSizeId: z.string(), cell: z.string(), words: z.string() })), date: z.string() }),
  lots: z.array(lotSchema),
  cutting: z.array(z.object({ id: z.string(), hideCode: z.string().nullable(), lotId: z.string(), areaUsed: z.string(), uom: z.string(), reversal: z.boolean(), at: z.string() })),
  bundles: z.array(z.object({ id: z.string(), code: z.string(), workOrderSizeId: z.string(), quantity: z.number(), part: z.string().nullable(), status: z.string(), madeOn: z.enum(['FLOOR', 'OFFICE']), at: z.string() })),
  scans: z.array(
    z.object({
      id: z.string(),
      operation: z.object({ seq: z.number(), code: z.string(), name: z.string() }).nullable(),
      kind: z.string(),
      good: z.number(),
      scrap: z.number(),
      rework: z.number(),
      corrects: z.string().nullable(),
      at: z.string(),
    }),
  ),
  inspections: z.array(inspectionSchema.extend({ checklistAnswered: z.number() })),
  releases: z.array(releaseSchema),
  labelPrints: z.array(z.object({ id: z.string(), kind: z.string(), tracking: z.string(), workOrderSizeId: z.string(), quantity: z.number(), batchNumber: z.string(), reason: z.string().nullable(), postedBy: z.enum(['FLOOR', 'OFFICE']), at: z.string() })),
  shipments: z.array(z.object({ id: z.string(), number: z.string(), status: z.string(), shippedAt: z.string().nullable(), garments: z.number(), ddtNumbers: z.array(z.string()) })),
  registerEntries: z.array(z.object({ id: z.string(), reference: z.string(), kind: z.string(), status: z.string(), risk: z.string(), reportedAt: z.string() })),
})
export type Evidence = z.infer<typeof evidenceSchema>

/** `GET /quality/evidence`: the read-only trail of one garment serial or one batch. */
export function getEvidence(api: ApiClient, kind: EvidenceKind, subject: string, signal?: AbortSignal): Promise<Evidence> {
  return api.get('/quality/evidence', { query: kind === 'serial' ? { serial: subject } : { batch: subject }, schema: evidenceSchema, signal })
}
