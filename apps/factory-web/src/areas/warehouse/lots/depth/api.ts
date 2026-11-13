import { z } from 'zod'
import { ATTRIBUTE_KEYS } from '@nexus/factory-domain/inventory/lots-depth/attributes'
import { LIFECYCLE_CAUSES, LOT_LIFECYCLES } from '@nexus/factory-domain/inventory/lots-depth/lifecycle'
import { DOCUMENT_STATES, INCOMING_STATES, SEPARATION_STATES } from '@nexus/factory-domain/inventory/lots-depth/page'
import { TRACE_REPORT_AUDIENCES, TRACE_REPORT_FORMATS, TRACE_REPORT_LANGUAGES } from '@nexus/factory-domain/inventory/lots-depth/trace-report'
import { TRACE_DIRECTIONS, TRACE_START_KINDS } from '@nexus/factory-domain/inventory/trace/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { presignedSchema, type Presigned } from '../../../../record-panels/api'
import { CR_VI_STATUSES, QUALITY_STATUSES, type LotRow } from '../../../_shared/stock/api'

/**
 * B-W2b-320 — every call of the W2b parts of Warehouse › Lots & traceability (SCR-201, SCR-201-record) on B-W2b-313's API
 * (apps/factory-api modules/inventory/lots-depth, trace/report.ts), with the answer's shape checked (zod; unknown fields
 * are dropped). No money; a person only inside one lot (who received it, who decided, who made a report). The API's
 * English sentences (`words`, `splitRefusal`, a hide's `refusal`) are never drawn: the screens say their own words from
 * the codes and facts (model.ts).
 */

export type Lifecycle = (typeof LOT_LIFECYCLES)[number]
export type LifecycleCause = (typeof LIFECYCLE_CAUSES)[number]
export type AttributeKey = (typeof ATTRIBUTE_KEYS)[number]
export type TraceAudience = (typeof TRACE_REPORT_AUDIENCES)[number]
export type TraceFormat = (typeof TRACE_REPORT_FORMATS)[number]
export type TraceDirection = (typeof TRACE_DIRECTIONS)[number]
export type TraceStartKind = (typeof TRACE_START_KINDS)[number]

const uom = z.enum(UOMS)
const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
const lifecycle = z.enum(LOT_LIFECYCLES)
const quality = z.enum(QUALITY_STATUSES)
const person = z.object({ id: z.string(), name: z.string() })
/** A lot's attributes: strings, and the grade mix as grade code → percent. */
const attributes = z.record(z.string(), z.union([z.string(), z.record(z.string(), z.string())]))
export type LotAttributeValues = z.infer<typeof attributes>

// ---- the list (lt-grid: Lifecycle, Depleted; lt-metrics: documents expiring) ---------------------------------------------

/** W1's lot row (the same fields as `_shared/stock` LotRow) with B-W2b-313's columns. */
const depthRowSchema = z.object({
  id: z.string(),
  code: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  siteCode: z.string(),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: uom, tracking: z.enum(['NONE', 'LOT', 'HIDE', 'SERIAL']) }),
  colour: named.nullable(),
  supplier: named.nullable(),
  supplierLotRef: z.string().nullable(),
  dyeBatch: z.string().nullable(),
  shade: z.string().nullable(),
  receivedAt: z.string().nullable(),
  receipt: z.object({ id: z.string(), number: z.string() }).nullable(),
  opening: z.boolean(),
  qualityStatus: quality,
  qualityNote: z.string().nullable(),
  qualityDecidedAt: z.string().nullable(),
  crVi: z.object({ required: z.boolean(), status: z.enum(CR_VI_STATUSES), valueMgKg: z.string().nullable(), limitMgKg: z.string().nullable(), evidence: z.enum(['LOT_REPORT', 'SUPPLIER_REPORT']).nullable(), testedOn: z.string().nullable() }),
  documents: z.number(),
  onHand: z.string(),
  hides: z.number(),
  issuedTo: z.number(),
  lifecycle,
  parentLot: z.object({ id: z.string(), code: z.string() }).nullable(),
  childLots: z.number(),
  attributes,
  documentsExpiring: z.number(),
})
export type DepthRow = z.infer<typeof depthRowSchema>
/** A depth row is a W1 lot row (the list's columns draw both). */
export const asLotRow = (row: DepthRow): LotRow => row satisfies LotRow

/** What the W2b columns add to a W1 row, by lot id. */
export type DepthFacts = Pick<DepthRow, 'lifecycle' | 'parentLot' | 'childLots' | 'documentsExpiring'>
export const factsOf = (row: DepthRow): DepthFacts => ({ lifecycle: row.lifecycle, parentLot: row.parentLot, childLots: row.childLots, documentsExpiring: row.documentsExpiring })

const depthCountsSchema = z.object({ lifecycle: z.record(z.string(), z.number()), documentsExpiring: z.number() })
export type DepthCounts = z.infer<typeof depthCountsSchema>
const depthPageSchema = z.object({ lots: z.array(depthRowSchema), nextCursor: z.string().nullable(), counts: depthCountsSchema })
export type DepthPage = z.infer<typeof depthPageSchema>

export interface DepthQuery {
  siteId?: string | null
  view?: 'ACTIVE' | 'DEPLETED' | 'ALL'
  lifecycle?: Lifecycle | null
  documentsExpiring?: boolean
  parentLotId?: string | null
  /** The rows of a W1 page (B-W2b-320's read: the W2b facts of the lots a W1 view shows). */
  ids?: readonly string[] | null
  q?: string | null
  cursor?: string | null
  limit?: number
}

type Query = Readonly<Record<string, string | number | boolean | null | undefined>>
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''))
const seg = (value: string) => encodeURIComponent(value)
const lotPath = (lotId: string) => `/inventory/lots/${seg(lotId)}`

export const listLotsDepth = (api: ApiClient, query: DepthQuery, signal?: AbortSignal) =>
  api.get('/inventory/lots-depth', {
    query: clean({
      siteId: query.siteId,
      view: query.view,
      lifecycle: query.lifecycle,
      documentsExpiring: query.documentsExpiring ? 'true' : undefined,
      parentLotId: query.parentLotId,
      ids: query.ids && query.ids.length > 0 ? query.ids.join(',') : undefined,
      q: query.q?.trim(),
      cursor: query.cursor,
      limit: query.limit,
    }),
    schema: depthPageSchema,
    signal,
  })

// ---- the lot page's W2b facts ----------------------------------------------------------------------------------------------

const historySchema = z.object({
  at: z.string(),
  kind: z.enum(['LIFECYCLE', 'QUALITY', 'SPLIT']),
  from: lifecycle.nullable(),
  to: lifecycle.nullable(),
  cause: z.enum(LIFECYCLE_CAUSES).nullable(),
  action: z.string(),
})
export type HistoryRow = z.infer<typeof historySchema>
const lotRefSchema = z.object({ id: z.string(), code: z.string(), qualityStatus: quality, lifecycle, shade: z.string().nullable() })
export type LotRef = z.infer<typeof lotRefSchema>
const documentSchema = z.object({ id: z.string(), kind: z.string(), fileId: z.string(), validTo: z.string().nullable(), state: z.enum(DOCUMENT_STATES), daysLeft: z.number().nullable(), from: z.enum(['LOT', 'PARENT']) })
export type LotDocument = z.infer<typeof documentSchema>
const inspectionSchema = z.object({ id: z.string(), number: z.string(), status: z.enum(['OPEN', 'DECIDED', 'CANCELLED']), result: z.enum(['PASS', 'FAIL']).nullable(), decidedAt: z.string().nullable(), from: z.enum(['LOT', 'PARENT']) })
export type IncomingRow = z.infer<typeof inspectionSchema>

const lotViewSchema = z.object({
  lot: z.object({
    id: z.string(),
    code: z.string(),
    companyId: z.string(),
    siteId: z.string(),
    version: z.number(),
    item: z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), tracking: z.string(), baseUom: uom }),
    colour: named.nullable(),
    shade: z.string().nullable(),
    qualityStatus: quality,
    lifecycle,
    onHand: z.string(),
    hidesInStock: z.number(),
  }),
  lifecycle: z.object({ state: lifecycle, since: z.string(), depletedAt: z.string().nullable(), expected: lifecycle, history: z.array(historySchema) }),
  attributes: z.object({ kind: z.string(), keys: z.array(z.enum(ATTRIBUTE_KEYS)), values: attributes, canEdit: z.boolean() }),
  family: z.object({ parent: lotRefSchema.nullable(), children: z.array(lotRefSchema.extend({ onHand: z.string(), hidesInStock: z.number() })) }),
  incoming: z.object({ state: z.enum(INCOMING_STATES), number: z.string().nullable(), inspections: z.array(inspectionSchema) }),
  separation: z.object({ state: z.enum(SEPARATION_STATES), viewerReceived: z.boolean(), receivedBy: person.nullable(), decidedBy: person.nullable() }),
  documents: z.object({ rows: z.array(documentSchema), expiring: z.number(), expired: z.number() }),
  may: z.object({ manage: z.boolean(), split: z.boolean(), report: z.boolean() }),
})
export type LotDepth = z.infer<typeof lotViewSchema>

export const lotDepth = (api: ApiClient, lotId: string, signal?: AbortSignal) => api.get(`${lotPath(lotId)}/depth`, { schema: lotViewSchema, signal })

/** "Check": the lifecycle against the ledger now (a move the handler has not handled yet). */
export const checkLifecycle = (api: ApiClient, lotId: string) =>
  api.post(`${lotPath(lotId)}/lifecycle/check`, { body: {}, schema: z.object({ changed: z.boolean(), from: lifecycle, to: lifecycle, lot: lotViewSchema }), idempotencyKey: newIdempotencyKey() })

/** A key with a value sets it, a key with null removes it (the API checks each per the material's kind). */
export const saveAttributes = (api: ApiClient, lotId: string, version: number, values: Readonly<Record<string, string | Readonly<Record<string, string>> | null>>) =>
  api.request('PATCH', `${lotPath(lotId)}/attributes`, { body: { version, attributes: values }, schema: lotViewSchema, idempotencyKey: newIdempotencyKey() })

// ---- split into shade groups and regroup (lt-split) -------------------------------------------------------------------------

const splitHideSchema = z.object({
  id: z.string(),
  code: z.string(),
  supplierCode: z.string().nullable(),
  lot: z.object({ id: z.string(), code: z.string() }),
  state: z.string(),
  onHand: z.string(),
  area: z.string(),
  areaUom: uom,
  location: named.nullable(),
  grade: z.string().nullable(),
  shade: z.string().nullable(),
  shadeGroupId: z.string().nullable(),
  marks: z.number(),
  inspection: z.object({ number: z.string(), decision: z.string().nullable(), shadeGroupId: z.string().nullable(), shade: z.string().nullable() }).nullable(),
  /** Why it cannot move now, in the API's English (said in our words by model.ts hideRefusalKey). */
  refusal: z.string().nullable(),
})
export type SplitHide = z.infer<typeof splitHideSchema>
const shadeChoiceSchema = z.object({ id: z.string(), label: z.string(), outOfShade: z.boolean(), lotId: z.string().nullable(), active: z.boolean() })
export type ShadeChoice = z.infer<typeof shadeChoiceSchema>
const splitReadSchema = z.object({
  parent: lotRefSchema.extend({ version: z.number() }),
  lots: z.array(lotRefSchema.extend({ hidesInStock: z.number() })),
  hides: z.array(splitHideSchema),
  shadeGroups: z.array(shadeChoiceSchema),
  proposal: z.object({ inspection: z.object({ id: z.string(), number: z.string(), status: z.string() }).nullable(), groups: z.array(z.object({ shadeGroupId: z.string().nullable(), label: z.string(), hideIds: z.array(z.string()) })) }),
  may: z.boolean(),
})
export type SplitRead = z.infer<typeof splitReadSchema>
const movedSchema = z.object({ fromHideId: z.string(), fromCode: z.string(), hideId: z.string(), code: z.string(), lot: z.object({ id: z.string(), code: z.string() }), area: z.string(), areaUom: uom, grade: z.string().nullable(), shade: z.string().nullable(), marks: z.number() })
export type MovedHide = z.infer<typeof movedSchema>
const splitAnswerSchema = z.object({ parent: z.object({ id: z.string(), code: z.string(), version: z.number() }), lots: z.array(lotRefSchema.extend({ made: z.boolean() })), hides: z.array(movedSchema) })
export type SplitAnswer = z.infer<typeof splitAnswerSchema>

export const splitRead = (api: ApiClient, lotId: string, signal?: AbortSignal) => api.get(`${lotPath(lotId)}/split`, { schema: splitReadSchema, signal })

export interface SplitBody {
  version: number
  groups: { shadeGroupId?: string | null; label?: string | null; hideIds: string[] }[]
  inspectionId?: string | null
  note?: string | null
}
export const splitLot = (api: ApiClient, lotId: string, body: SplitBody) => api.post(`${lotPath(lotId)}/split`, { body, schema: splitAnswerSchema, idempotencyKey: newIdempotencyKey() })

export interface RegroupBody {
  version: number
  moves: { hideId: string; toLotId: string }[]
  note?: string | null
}
export const regroupLot = (api: ApiClient, lotId: string, body: RegroupBody) => api.post(`${lotPath(lotId)}/regroup`, { body, schema: splitAnswerSchema, idempotencyKey: newIdempotencyKey() })

// ---- the dated trace report (lt-report, tab lt-tab-report) ------------------------------------------------------------------

export interface TraceReportBody {
  kind: TraceStartKind
  id: string
  direction: TraceDirection
  audience: TraceAudience
  recipient: string
  reference?: string | null
  requestedOn: string
  asOf?: string | null
  format: TraceFormat
  language: (typeof TRACE_REPORT_LANGUAGES)[number]
  note?: string | null
}
const reportAnswerSchema = z.object({
  report: z.object({
    recordType: z.string(),
    recordId: z.string(),
    start: z.object({ kind: z.enum(TRACE_START_KINDS), id: z.string(), code: z.string() }),
    madeAt: z.string(),
    asOf: z.string(),
    format: z.enum(TRACE_REPORT_FORMATS),
    includes: z.array(z.object({ kind: z.enum(TRACE_START_KINDS), id: z.string(), code: z.string() })),
    counts: z.object({ nodes: z.number(), customersExact: z.number(), customersPossible: z.number(), customersByAsOfExact: z.number(), customersByAsOfPossible: z.number(), gaps: z.number() }),
  }),
  file: z.object({ id: z.string(), name: z.string(), contentType: z.string(), sizeBytes: z.number() }),
})
export type TraceReportAnswer = z.infer<typeof reportAnswerSchema>
export const makeTraceReport = (api: ApiClient, body: TraceReportBody) => api.post('/inventory/trace/report', { body, schema: reportAnswerSchema, idempotencyKey: newIdempotencyKey() })

const reportRowSchema = z.object({
  at: z.string(),
  madeBy: person.nullable(),
  fileId: z.string().nullable(),
  audience: z.enum(TRACE_REPORT_AUDIENCES),
  recipient: z.string(),
  reference: z.string().nullable(),
  requestedOn: z.string(),
  asOf: z.string(),
  direction: z.enum(TRACE_DIRECTIONS),
  format: z.enum(TRACE_REPORT_FORMATS),
})
export type TraceReportRow = z.infer<typeof reportRowSchema>
export const traceReports = (api: ApiClient, kind: TraceStartKind, id: string, signal?: AbortSignal) =>
  api.get('/inventory/trace/reports', { query: { kind, id }, schema: z.object({ reports: z.array(reportRowSchema) }), signal }).then((answer) => answer.reports)

/** A stored file (the report, a lot document): its presigned link, opened in a new tab (files.read). */
export const fileLink = (api: ApiClient, fileId: string): Promise<Presigned> =>
  api.get(`/files/${seg(fileId)}/download`, { schema: z.object({ download: presignedSchema }) }).then((answer) => answer.download)
