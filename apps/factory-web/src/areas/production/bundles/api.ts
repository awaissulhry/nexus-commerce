import { z } from 'zod'
import { BUNDLE_CODE_MODES } from '@nexus/factory-domain/production/bundles/coupons'
import { FINDING_STATUSES, SCAN_PATTERN_KINDS, WHO_PURPOSES, type WhoPurpose } from '@nexus/factory-domain/production/bundles/patterns'
import { BUNDLE_PLACES, QUALITY_REASONS, type BundlePlace } from '@nexus/factory-domain/production/bundles/where'
import type { LabelInput } from '@nexus/factory-domain/labels/model'
import type { ApiClient } from '../../../lib/api/client'
import { WORK_ORDER_STATUSES } from '../_shared/api'

export { BUNDLE_CODE_MODES }

/**
 * Every call of Production › Bundles (B-W2b-59; SCR-259), with the answer's shape checked (zod; unknown fields are
 * dropped). The shapes mirror apps/factory-api modules/production/bundles (B-W2b-41). No list here carries a person: the
 * ONE answer that names people is "Show who" (one finding, audited), read only inside its dialog and never kept.
 */

const status = z.enum(WORK_ORDER_STATUSES)
const bundleStatus = z.enum(['ACTIVE', 'VOID'])
const opRef = z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string() })
const stationRef = z.object({ id: z.string(), code: z.string(), name: z.string() })
const style = z.object({ id: z.string(), code: z.string(), name: z.string() })
const hideRef = z.object({ hideId: z.string(), code: z.string(), lotId: z.string(), lotCode: z.string() })

/** Where a bundle is now, its last scan (time, operation, station; never who) and its stuck wait. */
const placeFields = {
  place: z.enum(BUNDLE_PLACES),
  qualityReason: z.enum(QUALITY_REASONS).nullable(),
  operation: opRef.nullable(),
  next: opRef.nullable(),
  subcontract: z.object({ orderId: z.string(), number: z.string() }).nullable(),
  since: z.string(),
  lastScan: z.object({ at: z.string(), operation: opRef.nullable(), station: stationRef.nullable() }).nullable(),
  stuck: z.object({ stuck: z.boolean(), workingHours: z.number(), limitHours: z.number() }),
}

export const trackedRowSchema = z.object({
  id: z.string(),
  code: z.string(),
  replacedCodes: z.array(z.string()),
  status: bundleStatus,
  siteId: z.string(),
  workOrder: z.object({ id: z.string(), number: z.string(), status }),
  style,
  workOrderSizeId: z.string(),
  colourwayCode: z.string(),
  colourwayName: z.string(),
  size: z.string(),
  part: z.string().nullable(),
  quantity: z.number(),
  parentBundleId: z.string().nullable(),
  ...placeFields,
  hides: z.array(hideRef),
  voidedAt: z.string().nullable(),
  createdAt: z.string(),
})
export type TrackedBundle = z.infer<typeof trackedRowSchema>
const pageSchema = z.object({ bundles: z.array(trackedRowSchema), nextCursor: z.string().nullable(), asOf: z.string() })
export type BundlesPage = z.infer<typeof pageSchema>

export interface BundlesQuery {
  siteId?: string | null
  status?: 'ACTIVE' | 'VOID'
  place?: readonly BundlePlace[]
  stuck?: boolean
  q?: string
  cursor?: string | null
  limit?: number
}

export function listBundles(api: ApiClient, query: BundlesQuery, signal?: AbortSignal): Promise<BundlesPage> {
  return api.get('/production/bundles', {
    query: {
      siteId: query.siteId ?? undefined,
      status: query.status,
      place: query.place?.length ? query.place.join(',') : undefined,
      stuck: query.stuck ? 'true' : undefined,
      q: query.q?.trim() || undefined,
      cursor: query.cursor ?? undefined,
      limit: query.limit ?? 50,
    },
    schema: pageSchema,
    signal,
  })
}

const tilesSchema = z.object({
  active: z.number(),
  stuck: z.number(),
  stuckLimitHours: z.number().nullable(),
  ticketsReplacedToday: z.number(),
  onHold: z.number(),
  atSubcontractor: z.number(),
  capped: z.boolean(),
  asOf: z.string(),
})
export type BundleTiles = z.infer<typeof tilesSchema>

export const bundleTiles = (api: ApiClient, siteId: string | null, signal?: AbortSignal): Promise<BundleTiles> => api.get('/production/bundles/tiles', { query: { siteId: siteId ?? undefined }, schema: tilesSchema, signal })

// ---- the record ---------------------------------------------------------------------------------------------------------------

const jobSchema = z.object({ jobId: z.string(), printerId: z.string(), scanId: z.string().nullable(), status: z.enum(['QUEUED', 'SENT', 'PRINTED', 'FAILED']), lastError: z.string().nullable(), createdAt: z.string() })
export const couponSchema = z.object({ id: z.string(), code: z.string(), status: bundleStatus, operation: opRef, voidedAt: z.string().nullable(), voidReason: z.string().nullable(), replacesId: z.string().nullable(), postedBy: z.enum(['FLOOR', 'OFFICE']), createdAt: z.string() })

export const bundleRecordSchema = z.object({
  bundle: z.object({
    id: z.string(),
    code: z.string(),
    replacedCodes: z.array(z.string()),
    workOrderId: z.string(),
    colourwayCode: z.string(),
    colourwayName: z.string(),
    size: z.string(),
    part: z.string().nullable(),
    quantity: z.number(),
    status: bundleStatus,
    voidedAt: z.string().nullable(),
    voidReason: z.string().nullable(),
    parentBundleId: z.string().nullable(),
    version: z.number(),
    createdAt: z.string(),
    scans: z.number(),
  }),
  workOrder: z.object({ id: z.string(), number: z.string(), batchNumber: z.string().nullable(), status, siteId: z.string() }),
  style,
  ...placeFields,
  progress: z.array(opRef.extend({ scanRequired: z.boolean(), state: z.enum(['DONE', 'HERE', 'NOT_REACHED']), good: z.number().nullable(), scrap: z.number().nullable(), rework: z.number().nullable() })),
  quality: z.object({
    holds: z.array(z.object({ id: z.string(), subjectType: z.string(), reasonCode: z.string(), placedAt: z.string() })),
    reworks: z.array(z.object({ id: z.string(), status: z.string(), quantity: z.number(), createdAt: z.string() })),
  }),
  genealogy: z.object({
    hides: z.array(hideRef),
    shades: z.array(z.string()),
    parent: z.object({ id: z.string(), code: z.string() }).nullable(),
    children: z.array(z.object({ id: z.string(), code: z.string(), quantity: z.number(), status: bundleStatus })),
    serials: z.array(z.object({ id: z.string(), serial: z.string(), status: z.string() })),
  }),
  ticket: z.object({
    code: z.string(),
    replacedCodes: z.array(z.string()),
    reprints: z.array(z.object({ code: z.string(), replacedCode: z.string(), reason: z.string(), printerId: z.string().nullable(), postedBy: z.enum(['FLOOR', 'OFFICE']), at: z.string() })),
    jobs: z.array(jobSchema).nullable(),
    coupons: z.array(couponSchema),
  }),
  asOf: z.string(),
})
export type BundleRecord = z.infer<typeof bundleRecordSchema>

export const getBundle = (api: ApiClient, id: string, signal?: AbortSignal): Promise<BundleRecord> => api.get(`/production/bundles/${encodeURIComponent(id)}`, { schema: bundleRecordSchema, signal })

/** One scan of the bundle's Scans tab (workorders.view): the worker's name only where the site names workers, inside this one record. */
export const recordScanSchema = z.object({
  id: z.string(),
  kind: z.enum(['REPORT', 'UNDO', 'CORRECTION']),
  bundleId: z.string(),
  operation: z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string() }),
  correctsId: z.string().nullable(),
  goodQuantity: z.number(),
  scrapQuantity: z.number(),
  reworkQuantity: z.number(),
  scrapReason: z.string().nullable(),
  deviceTime: z.string().nullable(),
  serverTime: z.string(),
  worker: z.object({ id: z.string(), name: z.string() }).nullable(),
  workerHidden: z.boolean().optional(),
  station: stationRef.nullable(),
  approvedById: z.string().nullable(),
  voidedById: z.string().nullable(),
})
export type RecordScan = z.infer<typeof recordScanSchema>

export async function bundleScans(api: ApiClient, workOrderId: string, bundleId: string, signal?: AbortSignal): Promise<RecordScan[]> {
  return (await api.get(`/production/scans/work-orders/${encodeURIComponent(workOrderId)}/scans`, { query: { bundleId }, schema: z.object({ scans: z.array(recordScanSchema) }), signal })).scans
}

// ---- writes -----------------------------------------------------------------------------------------------------------------

const reprintSchema = z.object({ bundle: z.object({ id: z.string(), code: z.string() }), replacedCode: z.string(), ticket: z.object({ job: z.object({ id: z.string() }).nullable(), problem: z.string().nullable() }) })

/** A new code for the bundle's ticket; `printerId` null prints nothing here: the ticket PDF is opened in a tab. */
export function reprintTicket(api: ApiClient, bundleId: string, body: { reason: string; printerId: string | null }, idempotencyKey: string): Promise<z.infer<typeof reprintSchema>> {
  return api.post(`/production/bundles/${encodeURIComponent(bundleId)}/reprint`, { body, schema: reprintSchema, idempotencyKey })
}

const voidSchema = z.object({ bundle: z.object({ id: z.string(), code: z.string(), status: bundleStatus }), replayed: z.boolean() })

export function voidBundle(api: ApiClient, bundleId: string, reason: string, idempotencyKey: string): Promise<z.infer<typeof voidSchema>> {
  return api.post(`/production/bundles/${encodeURIComponent(bundleId)}/void`, { body: { reason }, schema: voidSchema, idempotencyKey })
}

/** The ticket as a PDF for the browser (print.labels; made on request, stored nowhere). */
export const ticketPdf = (api: ApiClient, label: LabelInput, signal?: AbortSignal): Promise<Uint8Array> => api.bytes('/print/labels/pdf', { method: 'POST', body: { label, copies: 1 }, signal })

// ---- scan-pattern checks ------------------------------------------------------------------------------------------------------

const kindEnum = z.enum(SCAN_PATTERN_KINDS)

export const findingSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  kind: kindEnum,
  status: z.enum(FINDING_STATUSES),
  bundle: z.object({ id: z.string(), code: z.string(), quantity: z.number(), part: z.string().nullable() }),
  workOrder: z.object({ id: z.string(), number: z.string() }),
  operation: opRef.nullable(),
  line: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  windowStart: z.string(),
  windowEnd: z.string(),
  seen: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
  reviewedAt: z.string().nullable(),
  reviewNote: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
})
export type Finding = z.infer<typeof findingSchema>

const summarySchema = z.object({
  days: z.number(),
  sites: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), checks: z.enum(['ON', 'STATION_SITE', 'NO_BASIS', 'GATE_CLOSED']) })),
  rows: z.array(
    z.object({
      line: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
      operation: z.object({ code: z.string(), name: z.string() }).nullable(),
      kind: kindEnum,
      open: z.number(),
      reviewed: z.number(),
      dismissed: z.number(),
    }),
  ),
  asOf: z.string(),
})
export type FindingsSummary = z.infer<typeof summarySchema>
export type SummaryRow = FindingsSummary['rows'][number]
export type ChecksState = FindingsSummary['sites'][number]['checks']

export const findingsSummary = (api: ApiClient, siteId: string | null, signal?: AbortSignal): Promise<FindingsSummary> => api.get('/production/bundles/findings/summary', { query: { siteId: siteId ?? undefined }, schema: summarySchema, signal })

export interface FindingsQuery {
  siteId?: string | null
  kind?: Finding['kind']
  lineId?: string
  operationCode?: string
  bundleId?: string
  cursor?: string | null
}

const findingsPageSchema = z.object({ findings: z.array(findingSchema), nextCursor: z.string().nullable() })

export const listFindings = (api: ApiClient, query: FindingsQuery, signal?: AbortSignal): Promise<z.infer<typeof findingsPageSchema>> =>
  api.get('/production/bundles/findings', {
    query: { siteId: query.siteId ?? undefined, kind: query.kind, lineId: query.lineId, operationCode: query.operationCode, bundleId: query.bundleId, cursor: query.cursor ?? undefined, limit: 50 },
    schema: findingsPageSchema,
    signal,
  })

export async function reviewFinding(api: ApiClient, id: string, body: { status: 'REVIEWED' | 'DISMISSED'; note?: string; version: number }, idempotencyKey: string): Promise<Finding> {
  return (await api.post(`/production/bundles/findings/${encodeURIComponent(id)}/review`, { body, schema: z.object({ finding: findingSchema }), idempotencyKey })).finding
}

const whoSchema = z.object({
  finding: z.object({ id: z.string(), kind: kindEnum, windowStart: z.string(), windowEnd: z.string() }),
  purpose: z.enum(WHO_PURPOSES),
  logged: z.literal(true),
  scans: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      at: z.string(),
      operation: opRef.nullable(),
      good: z.number(),
      scrap: z.number(),
      rework: z.number(),
      worker: z.object({ id: z.string(), name: z.string() }).nullable(),
      station: stationRef.nullable(),
    }),
  ),
})
export type WhoAnswer = z.infer<typeof whoSchema>

/** "Show who": ONE finding, a purpose, written in the audit log by the API. No Idempotency-Key (a receipt would store the names). */
export const showWho = (api: ApiClient, findingId: string, body: { purpose: WhoPurpose; note?: string }): Promise<WhoAnswer> =>
  api.post(`/production/bundles/findings/${encodeURIComponent(findingId)}/who`, { body, schema: whoSchema })
