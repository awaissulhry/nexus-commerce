import { z } from 'zod'
import { DEFECT_CLASSES, DISPOSITION_FOLLOW_UPS, DISPOSITION_MOVES, DISPOSITION_OUTCOMES, QUALITY_STAGES } from '@nexus/factory-domain/quality/defects/rules'
import { HOLD_SUBJECT_TYPES } from '@nexus/factory-domain/quality/holds/rules'
import { BOARD_LANES, CONTAINMENT_KINDS, CONTAINMENT_STATUSES, DECISION_STATES, NCR_FROM_TYPES, NCR_LINK_TYPES, NCR_SOURCES, NCR_STAGES, STAGE_CHECKS } from '@nexus/factory-domain/quality/ncr/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { completeUpload, listFiles, requestUpload } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'

/**
 * Every call of Quality › Nonconformances (B-W2a-68: SCR-144 list and board, SCR-145 the NCR record) on the API of
 * B-W2a-47 (apps/factory-api modules/quality/ncr), with the answer's shape checked (zod; unknown fields are dropped). The
 * shapes mirror the API's contract.ts. Every write is one command with an Idempotency-Key per attempt and the version the
 * screen read (the NCR's; a containment action's or a decision's for theirs). The API's English is never drawn as our
 * words: the screens say their own from codes and facts (a refusal's sentence is kept only as a detail line, like a lot
 * code). No cost, no price, no worker's name in a list.
 */

export type NcrStage = (typeof NCR_STAGES)[number]
export type BoardLaneId = (typeof BOARD_LANES)[number]
export type NcrSource = (typeof NCR_SOURCES)[number]
export type Severity = (typeof DEFECT_CLASSES)[number]
export type FoundAt = (typeof QUALITY_STAGES)[number]
export type Uom = (typeof UOMS)[number]
export type ContainmentKind = (typeof CONTAINMENT_KINDS)[number]
export type ContainmentStatus = (typeof CONTAINMENT_STATUSES)[number]
export type DecisionState = (typeof DECISION_STATES)[number]
export type StageCheckKey = (typeof STAGE_CHECKS)[number]
export type NcrFromType = (typeof NCR_FROM_TYPES)[number]
export type NcrLinkType = (typeof NCR_LINK_TYPES)[number]
export type DispositionOutcome = (typeof DISPOSITION_OUTCOMES)[number]
export type DispositionMove = (typeof DISPOSITION_MOVES)[number]
export type DispositionFollowUp = (typeof DISPOSITION_FOLLOW_UPS)[number]
export type HoldSubjectType = (typeof HOLD_SUBJECT_TYPES)[number]

export { BOARD_LANES, CONTAINMENT_KINDS, DEFECT_CLASSES, HOLD_SUBJECT_TYPES, NCR_FROM_TYPES, NCR_LINK_TYPES, NCR_SOURCES, NCR_STAGES, QUALITY_STAGES, UOMS }

const seg = (value: string) => encodeURIComponent(value)
type Query = Record<string, string | number | boolean | null | undefined>
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''))

const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
const check = z.object({ key: z.enum(STAGE_CHECKS), ok: z.boolean(), words: z.string() })
export type StageCheck = z.infer<typeof check>

export const summarySchema = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  title: z.string(),
  source: z.enum(NCR_SOURCES),
  sourceType: z.string().nullable(),
  sourceId: z.string().nullable(),
  stage: z.enum(NCR_STAGES),
  severity: z.enum(DEFECT_CLASSES),
  defect: z.object({ id: z.string(), code: z.string(), labelEn: z.string(), labelIt: z.string(), icon: z.string().nullable(), colour: z.string().nullable() }).nullable(),
  zone: z.string().nullable(),
  foundAt: z.enum(QUALITY_STAGES),
  foundOn: z.string(),
  quantityAffected: z.string(),
  quantitySuspect: z.string().nullable(),
  uom: z.enum(UOMS),
  decided: z.object({ decided: z.string(), left: z.string(), words: z.string() }),
  style: z.object({ id: z.string(), code: z.string(), name: z.string(), ppe: z.boolean() }).nullable(),
  colourway: ref.nullable(),
  size: z.string().nullable(),
  serial: z.string().nullable(),
  workOrder: z.object({ id: z.string(), number: z.string() }).nullable(),
  item: ref.nullable(),
  lot: z.object({ id: z.string(), code: z.string() }).nullable(),
  supplier: ref.nullable(),
  ownerId: z.string().nullable(),
  containmentDueAt: z.string().nullable(),
  containmentOverdue: z.boolean(),
  actions: z.object({ open: z.number(), done: z.number() }),
  /** Decisions not carried out yet (waiting approval or to carry out). */
  decisionsWaiting: z.number(),
  ageDays: z.number(),
  containedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type NcrSummary = z.infer<typeof summarySchema>

const ncrSchema = summarySchema.extend({
  description: z.string().nullable(),
  foundBy: z.object({ kind: z.enum(['USER', 'WORKER', 'NONE']), userId: z.string().nullable(), workerId: z.string().nullable() }),
  closedById: z.string().nullable(),
  closeNote: z.string().nullable(),
  closeSignatureSha256: z.string().nullable(),
  cancelReason: z.string().nullable(),
  createdById: z.string().nullable(),
})
export type Ncr = z.infer<typeof ncrSchema>

const actionSchema = z.object({
  id: z.string(),
  seq: z.number(),
  kind: z.enum(CONTAINMENT_KINDS),
  description: z.string().nullable(),
  ownerId: z.string().nullable(),
  dueAt: z.string().nullable(),
  overdue: z.boolean(),
  status: z.enum(CONTAINMENT_STATUSES),
  doneAt: z.string().nullable(),
  doneById: z.string().nullable(),
  evidenceNote: z.string().nullable(),
  files: z.number(),
  record: z.object({ type: z.string(), id: z.string() }).nullable(),
  hold: z.object({ id: z.string(), status: z.string(), subjectType: z.string(), count: z.number() }).nullable(),
  version: z.number(),
})
export type ContainmentAction = z.infer<typeof actionSchema>

const dispositionRef = z.object({
  id: z.string(),
  code: z.string(),
  labelEn: z.string(),
  labelIt: z.string(),
  icon: z.string().nullable(),
  colour: z.string().nullable(),
  outcome: z.enum(DISPOSITION_OUTCOMES),
  stockMoveReason: z.enum(DISPOSITION_MOVES).nullable(),
  followUp: z.enum(DISPOSITION_FOLLOW_UPS).nullable(),
  reinspection: z.boolean(),
  words: z.string(),
})

const decisionSchema = z.object({
  id: z.string(),
  seq: z.number(),
  disposition: dispositionRef.nullable(),
  quantity: z.string(),
  note: z.string().nullable(),
  decidedAt: z.string(),
  decidedById: z.string().nullable(),
  approvalRequired: z.boolean(),
  approvedAt: z.string().nullable(),
  approvedById: z.string().nullable(),
  state: z.enum(DECISION_STATES),
  mayApprove: z.boolean(),
  doneAt: z.string().nullable(),
  stockMove: z.object({ id: z.string(), reason: z.string().nullable(), quantity: z.string().nullable(), uom: z.string().nullable(), from: z.string().nullable(), to: z.string().nullable() }).nullable(),
  followUp: z.object({ type: z.string(), id: z.string(), label: z.string().nullable(), state: z.string().nullable() }).nullable(),
  version: z.number(),
})
export type Decision = z.infer<typeof decisionSchema>

const linkSchema = z.object({ id: z.string(), recordType: z.string(), recordId: z.string(), label: z.string().nullable(), note: z.string().nullable(), createdAt: z.string(), createdById: z.string().nullable() })
export type NcrLink = z.infer<typeof linkSchema>
const holdSchema = z.object({ id: z.string(), status: z.string(), subjectType: z.string(), subjectIds: z.array(z.string()), reasonCode: z.string(), reasonNote: z.string().nullable(), placedAt: z.string(), decidedHere: z.boolean() })
export type NcrHold = z.infer<typeof holdSchema>

export const recordSchema = z.object({
  ncr: ncrSchema,
  containment: z.array(actionSchema),
  decisions: z.array(decisionSchema),
  links: z.array(linkSchema),
  holds: z.array(holdSchema),
  register: z.object({ id: z.string(), reference: z.string(), status: z.string() }).nullable(),
  next: z.object({ stage: z.enum(NCR_STAGES).nullable(), checks: z.array(check), ready: z.boolean() }),
  closing: z.object({ checks: z.array(check), ready: z.boolean() }),
  actions: z.object({ edit: z.string().nullable(), contain: z.string().nullable(), decide: z.string().nullable(), close: z.string().nullable(), cancel: z.string().nullable() }),
  may: z.object({ manage: z.boolean(), approve: z.boolean(), close: z.boolean(), raise: z.boolean() }),
})
export type NcrRecord = z.infer<typeof recordSchema>
const one = z.object({ record: recordSchema })

// ---- reads --------------------------------------------------------------------------------------------------------------

/** The list's filters: the API's own (`GET /quality/ncr`). */
export interface NcrQuery {
  stage?: readonly NcrStage[] | null
  open?: boolean | null
  severity?: Severity | null
  source?: NcrSource | null
  siteId?: string | null
  ownerId?: string | null
  overdue?: boolean
  waiting?: boolean
  recordType?: string | null
  recordId?: string | null
  supplier?: boolean
  q?: string | null
}

const queryOf = (query: NcrQuery): Query =>
  clean({
    stage: query.stage?.length ? query.stage.join(',') : undefined,
    open: query.open === null || query.open === undefined ? undefined : String(query.open),
    severity: query.severity,
    source: query.source,
    siteId: query.siteId,
    ownerId: query.ownerId,
    overdue: query.overdue ? 'true' : undefined,
    waiting: query.waiting ? 'true' : undefined,
    recordType: query.recordType,
    recordId: query.recordId,
    q: query.q?.trim() || undefined,
  })

export const listNcrs = (api: ApiClient, query: NcrQuery, signal?: AbortSignal) =>
  api.get('/quality/ncr', { query: queryOf(query), schema: z.object({ items: z.array(summarySchema), truncated: z.boolean() }), signal })

const countsSchema = z.object({ open: z.number(), containmentOverdue: z.number(), waitingDisposition: z.number(), criticalOpen: z.number(), closedThisMonth: z.number(), mine: z.number() })
export type NcrCounts = z.infer<typeof countsSchema>
export const ncrCounts = (api: ApiClient, siteId: string | null, signal?: AbortSignal) => api.get('/quality/ncr/counts', { query: clean({ siteId }), schema: z.object({ counts: countsSchema }), signal }).then((answer) => answer.counts)

const cardSchema = summarySchema.extend({ next: z.object({ stage: z.enum(NCR_STAGES).nullable(), ready: z.boolean(), words: z.string().nullable() }) })
export type NcrCard = z.infer<typeof cardSchema>
const laneSchema = z.object({ stage: z.enum(BOARD_LANES), count: z.number(), truncated: z.boolean(), cards: z.array(cardSchema) })
export type NcrLane = z.infer<typeof laneSchema>
/** The board: the list's filters but the stage (each lane is one; Closed = the last 30 days). */
export const ncrBoard = (api: ApiClient, query: NcrQuery, signal?: AbortSignal) => {
  const { stage: _stage, open: _open, ...rest } = queryOf(query)
  return api.get('/quality/ncr/board', { query: rest, schema: z.object({ lanes: z.array(laneSchema) }), signal }).then((answer) => answer.lanes)
}

export const prefillSchema = z.object({
  fromType: z.enum(NCR_FROM_TYPES),
  fromId: z.string(),
  label: z.string(),
  companyId: z.string().nullable(),
  siteId: z.string().nullable(),
  source: z.enum(NCR_SOURCES),
  foundAt: z.enum(QUALITY_STAGES),
  title: z.string().nullable(),
  description: z.string().nullable(),
  foundOn: z.string().nullable(),
  foundById: z.string().nullable(),
  foundByWorkerId: z.string().nullable(),
  quantityAffected: z.string().nullable(),
  uom: z.enum(UOMS).nullable(),
  severity: z.enum(DEFECT_CLASSES).nullable(),
  defectCodeId: z.string().nullable(),
  zone: z.string().nullable(),
  styleId: z.string().nullable(),
  colourwayId: z.string().nullable(),
  size: z.string().nullable(),
  serial: z.string().nullable(),
  workOrderId: z.string().nullable(),
  itemId: z.string().nullable(),
  lotId: z.string().nullable(),
  supplierId: z.string().nullable(),
  links: z.array(z.object({ recordType: z.string(), recordId: z.string(), note: z.string().nullable() })),
  holdIds: z.array(z.string()),
  problem: z.string().nullable(),
  files: z.array(z.object({ id: z.string(), kind: z.string(), originalName: z.string() })),
  existing: z.array(z.object({ id: z.string(), number: z.string(), stage: z.enum(NCR_STAGES) })),
})
export type NcrPrefill = z.infer<typeof prefillSchema>

/** ncr-new's prefill from the record it is raised from (quality.ncr.raise). */
export const ncrPrefill = (api: ApiClient, from: { recordType: NcrFromType; recordId: string }, signal?: AbortSignal) =>
  api.get('/quality/ncr/prefill', { query: { recordType: from.recordType, recordId: from.recordId }, schema: z.object({ prefill: prefillSchema }), signal }).then((answer) => answer.prefill)

export const getNcr = (api: ApiClient, ncrId: string, signal?: AbortSignal) => api.get(`/quality/ncr/${seg(ncrId)}`, { schema: one, signal }).then((answer) => answer.record)

// ---- raise and change ---------------------------------------------------------------------------------------------------

/** The NCR's content (QHS-081): what a new one says (`from` prefills what is left out) and what an edit changes. */
export interface NcrContent {
  title?: string
  description?: string | null
  source?: NcrSource
  foundAt?: FoundAt
  foundOn?: string
  quantityAffected?: string
  quantitySuspect?: string | null
  uom?: Uom
  defectCodeId?: string | null
  severity?: Severity
  zone?: string | null
  size?: string | null
  serial?: string | null
  ownerId?: string | null
  containmentDueAt?: string | null
}

export interface RaiseBody extends NcrContent {
  from?: { recordType: NcrFromType; recordId: string }
  siteId?: string
}

export const raiseNcr = (api: ApiClient, body: RaiseBody, idempotencyKey: string) => api.post('/quality/ncr', { body, schema: one, idempotencyKey }).then((answer) => answer.record)

export const editNcr = (api: ApiClient, ncrId: string, body: NcrContent & { version: number }) =>
  api.request('PATCH', `/quality/ncr/${seg(ncrId)}`, { body, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record)

/** The board's drag (one stage at a time): 409 `stage/<CHECK>` when a check is not met. */
export const moveNcr = (api: ApiClient, ncrId: string, body: { version: number; to: 'CONTAINED' | 'DECIDED' }) =>
  api.post(`/quality/ncr/${seg(ncrId)}/stage`, { body, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record)

/** The closing e-signature: the office's step-up first (403 `stepUp` → the code → this again, the same key). */
export const closeNcr = (api: ApiClient, ncrId: string, body: { version: number; note: string }, idempotencyKey: string) =>
  api.post(`/quality/ncr/${seg(ncrId)}/close`, { body, schema: z.object({ record: recordSchema, holdsClosed: z.array(z.string()), signature: z.string() }), idempotencyKey })

export const cancelNcr = (api: ApiClient, ncrId: string, body: { version: number; reason: string }) =>
  api.post(`/quality/ncr/${seg(ncrId)}/cancel`, { body, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record)

export const linkRecord = (api: ApiClient, ncrId: string, body: { version: number; recordType: NcrLinkType; recordId: string; note?: string | null }) =>
  api.post(`/quality/ncr/${seg(ncrId)}/links`, { body, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record)

export const unlinkRecord = (api: ApiClient, ncrId: string, linkId: string, version: number) =>
  api.request('DELETE', `/quality/ncr/${seg(ncrId)}/links/${seg(linkId)}`, { query: { version }, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record)

export const openRegisterEntry = (api: ApiClient, ncrId: string, body: { version: number; description?: string | null }) =>
  api.post(`/quality/ncr/${seg(ncrId)}/register`, { body, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record)

export const closeNcrHold = (api: ApiClient, ncrId: string, holdId: string, body: { version: number; note: string }) =>
  api.post(`/quality/ncr/${seg(ncrId)}/holds/${seg(holdId)}/close`, { body, schema: z.object({ record: recordSchema, workOrdersLifted: z.array(z.string()) }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record)

// ---- containment --------------------------------------------------------------------------------------------------------

/** "Hold stock": the Place hold dialog's fields (the NCR is the hold's source and decides it). */
export interface PlaceHoldBody {
  subjectType: HoldSubjectType
  subjectIds: string[]
  reasonCode: string
  reasonNote?: string | null
  ownerId?: string | null
}

export interface AddActionBody {
  version: number
  kind: ContainmentKind
  description?: string | null
  ownerId?: string | null
  dueAt?: string | null
  hold?: PlaceHoldBody
  holdId?: string
  evidenceNote?: string | null
}

const actionPath = (ncrId: string, actionId: string) => `/quality/ncr/${seg(ncrId)}/containment/${seg(actionId)}`

export const addAction = (api: ApiClient, ncrId: string, body: AddActionBody) => api.post(`/quality/ncr/${seg(ncrId)}/containment`, { body, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record)
export const editAction = (api: ApiClient, ncrId: string, actionId: string, body: { version: number; description?: string | null; ownerId?: string | null; dueAt?: string | null }) =>
  api.request('PATCH', actionPath(ncrId, actionId), { body, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record)
export const doneAction = (api: ApiClient, ncrId: string, actionId: string, body: { version: number; evidenceNote?: string | null; hold?: PlaceHoldBody; holdId?: string }) =>
  api.post(`${actionPath(ncrId, actionId)}/done`, { body, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record)
export const cancelAction = (api: ApiClient, ncrId: string, actionId: string, body: { version: number; reason: string }) =>
  api.post(`${actionPath(ncrId, actionId)}/cancel`, { body, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record)

// ---- decisions ----------------------------------------------------------------------------------------------------------

const decisionPath = (ncrId: string, decisionId: string) => `/quality/ncr/${seg(ncrId)}/decisions/${seg(decisionId)}`

export const addDecision = (api: ApiClient, ncrId: string, body: { version: number; dispositionCodeId: string; quantity: string; note?: string | null }) =>
  api.post(`/quality/ncr/${seg(ncrId)}/decisions`, { body, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record)
export const editDecision = (api: ApiClient, ncrId: string, decisionId: string, body: { version: number; dispositionCodeId?: string; quantity?: string; note?: string | null }) =>
  api.request('PATCH', decisionPath(ncrId, decisionId), { body, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record)
export const removeDecision = (api: ApiClient, ncrId: string, decisionId: string, version: number) =>
  api.request('DELETE', decisionPath(ncrId, decisionId), { query: { version }, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record)
export const approveDecision = (api: ApiClient, ncrId: string, decisionId: string, body: { version: number; note?: string | null }) =>
  api.post(`${decisionPath(ncrId, decisionId)}/approve`, { body, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record)

export interface StockLineBody {
  itemId?: string
  itemColourId?: string | null
  lotId?: string | null
  hideId?: string | null
  fromLocationId?: string
  quantity?: string
  uom?: Uom
}

export interface CarryOutBody {
  version: number
  note?: string | null
  stock?: { lines: StockLineBody[]; toLocationId?: string | null; workOrderId?: string | null }
  followUp?: { type: 'ReworkOrder' | 'RepairOrder' | 'SupplierClaim'; id: string }
  claim?: { kind: 'RETURN' | 'CLAIM'; reasonCode: string; reasonNote?: string | null; remedy?: 'CREDIT' | 'REPLACEMENT' | null }
}

export const carryOut = (api: ApiClient, ncrId: string, decisionId: string, body: CarryOutBody, idempotencyKey: string) =>
  api.post(`${decisionPath(ncrId, decisionId)}/carry-out`, { body, schema: z.object({ record: recordSchema, stockMoveIds: z.array(z.string()), followUp: z.object({ type: z.string(), id: z.string() }).nullable() }), idempotencyKey })

/** QHS-091 "Create rework order": the rework of this NCR's garments at an operation of its work order, then carried out. */
export const reworkFromDecision = (api: ApiClient, ncrId: string, decisionId: string, body: { version: number; reworkAtOperationId: string; description?: string }, idempotencyKey: string) =>
  api.post(`${decisionPath(ncrId, decisionId)}/rework`, { body, schema: z.object({ record: recordSchema, reworkId: z.string() }), idempotencyKey })

// ---- what the record's dialogs pick from (other modules' reads) -------------------------------------------------------

const defectSchema = z.object({
  id: z.string(),
  code: z.string(),
  category: z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string() }),
  labelIt: z.string(),
  labelEn: z.string(),
  icon: z.string().nullable(),
  severity: z.enum(DEFECT_CLASSES),
  zone: z.string().nullable(),
})
export type DefectChoice = z.infer<typeof defectSchema>
/** The defect library's picker (any office session; B-W2a-26). */
export const defectPicker = (api: ApiClient, signal?: AbortSignal) => api.get('/quality/defects/picker', { schema: z.object({ defects: z.array(defectSchema) }), signal }).then((answer) => answer.defects)

const dispositionSchema = dispositionRef.omit({ words: true }).extend({ stockAction: z.string(), approvalSeverity: z.enum(DEFECT_CLASSES).nullable(), active: z.boolean(), sortOrder: z.number() })
export type DispositionChoice = z.infer<typeof dispositionSchema>
/** The disposition codes (quality.defects.view; B-W2a-26). */
export const dispositionCodes = (api: ApiClient, signal?: AbortSignal) => api.get('/quality/dispositions', { schema: z.object({ dispositions: z.array(dispositionSchema) }), signal }).then((answer) => answer.dispositions.filter((code) => code.active).sort((a, b) => a.sortOrder - b.sortOrder))

const personSchema = z.object({ id: z.string(), name: z.string(), me: z.boolean() })
export type Person = z.infer<typeof personSchema>
/**
 * Office people by name (`GET /tasks/assignees`, tasks.manage): with a record, who may be given work on it (the NCR's
 * owner picker); without, the people one may name at all (the list's owner column and its Assign).
 */
export const listPeople = (api: ApiClient, record: { type: string; id: string } | null, signal?: AbortSignal) =>
  api.get('/tasks/assignees', { query: clean({ recordType: record?.type, recordId: record?.id }), schema: z.object({ people: z.array(personSchema) }), signal }).then((answer) => answer.people)

const pickerReasonSchema = z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string(), needsDetail: z.boolean() })
export type ReasonChoice = z.infer<typeof pickerReasonSchema>
/** The active reasons of a list (`HOLD` for a hold, `CLAIM` for a supplier claim). */
export const reasonsOf = (api: ApiClient, list: 'HOLD' | 'CLAIM', signal?: AbortSignal) => api.get('/reasons', { query: { list }, schema: z.object({ reasons: z.array(pickerReasonSchema) }), signal }).then((answer) => answer.reasons)

const stockRowSchema = z.object({
  siteId: z.string(),
  location: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: z.enum(UOMS).optional() }),
  colour: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  lot: z.object({ id: z.string(), code: z.string() }).nullable(),
  hide: z.object({ id: z.string(), code: z.string() }).nullable(),
  onHand: z.string(),
  held: z.string(),
  available: z.string(),
})
export type StockPlace = z.infer<typeof stockRowSchema>
/** Where the NCR's goods lie (inventory.stock.view): the carry-out's lines are prefilled from it. */
export const stockOf = (api: ApiClient, query: { siteId: string; lotId?: string | null; itemId?: string | null }, signal?: AbortSignal) =>
  api.get('/inventory/stock', { query: clean(query), schema: z.object({ rows: z.array(stockRowSchema) }), signal }).then((answer) => answer.rows)

const locationSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), status: z.string() })
const siteSchema = z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string(), locations: z.array(locationSchema) })
export type SiteChoice = z.infer<typeof siteSchema>
/** The company's sites and their places (inventory.locations.view): a new NCR by hand names its site; a transfer its place. */
export const listSites = (api: ApiClient, companyId: string | null, signal?: AbortSignal) =>
  api.get('/inventory/locations', { schema: z.object({ sites: z.array(siteSchema) }), signal }).then((answer) => answer.sites.filter((site) => !companyId || site.companyId === companyId).sort((a, b) => a.code.localeCompare(b.code)))

const operationSchema = z.object({ id: z.string().nullable(), seq: z.number(), code: z.string(), name: z.string() })
export type OperationChoice = { id: string; seq: number; code: string; name: string }
/** A work order's operations (workorders.view): where a rework is done. */
export const workOrderOperations = (api: ApiClient, workOrderId: string, signal?: AbortSignal) =>
  api
    .get(`/production/work-orders/${seg(workOrderId)}`, { schema: z.object({ workOrder: z.object({ spec: z.object({ operations: z.array(operationSchema) }) }) }), signal })
    .then((answer) => answer.workOrder.spec.operations.filter((operation): operation is OperationChoice => operation.id !== null))

const repairSchema = z.object({ id: z.string(), number: z.string(), stage: z.string(), serial: z.string().nullable(), problem: z.string() })
export type RepairChoice = z.infer<typeof repairSchema>
/** Open repairs (sales.repairs.view; B-W2a-57): a REPAIR decision is carried out by naming its repair. */
export const findRepairs = (api: ApiClient, q: string, signal?: AbortSignal) =>
  api.get('/sales/repairs', { query: clean({ view: 'open', q: q.trim() || undefined }), schema: z.object({ repairs: z.array(repairSchema) }), signal }).then((answer) => answer.repairs)

const claimSchema = z.object({ id: z.string(), number: z.string(), status: z.string(), kind: z.string() })
export type ClaimChoice = z.infer<typeof claimSchema>
/** Open supplier claims of the NCR's supplier (purchasing.claims.manage reads them): a return is carried out by naming one. */
export const findClaims = (api: ApiClient, query: { partyId: string; lotId?: string | null }, signal?: AbortSignal) =>
  api.get('/purchasing/claims', { query: clean({ partyId: query.partyId, lotId: query.lotId, limit: 50 }), schema: z.object({ items: z.array(claimSchema) }), signal }).then((answer) => answer.items)

const searchResultSchema = z.object({ recordType: z.string(), recordId: z.string(), number: z.string().nullable(), title: z.string(), subtitle: z.string().nullable() })
export type SearchHit = z.infer<typeof searchResultSchema>
/** Records by number for "Link…" (global search; only the kinds an NCR links). */
export const searchLinkable = (api: ApiClient, q: string, signal?: AbortSignal) =>
  api.get('/search', { query: { q, limit: 20 }, schema: z.object({ results: z.array(searchResultSchema) }), signal }).then((answer) => answer.results.filter((hit) => (NCR_LINK_TYPES as readonly string[]).includes(hit.recordType)))

// ---- photos ---------------------------------------------------------------------------------------------------------------

export interface NcrPhoto {
  id: string
  name: string
  contentType: string
}

/** The NCR's own photos (files of recordType "Nonconformance", kind PHOTO). */
export const ncrPhotos = (api: ApiClient, ncrId: string, signal?: AbortSignal): Promise<NcrPhoto[]> =>
  listFiles(api, { type: 'Nonconformance', id: ncrId }, signal).then((answer) =>
    answer.files.filter((file) => file.status === 'AVAILABLE' && file.contentType.startsWith('image/')).map((file) => ({ id: file.id, name: file.originalName, contentType: file.contentType })),
  )

/** A photo of the NCR or of one containment action (its evidence): announce → the bytes to the store → complete. */
export async function uploadPhoto(api: ApiClient, target: { companyId: string; siteId: string; record: { type: 'Nonconformance' | 'NcrContainmentAction'; id: string } }, file: Blob, name: string): Promise<void> {
  const bytes = await file.arrayBuffer()
  const { file: stored, upload } = await requestUpload(api, {
    companyId: target.companyId,
    record: target.record,
    kind: 'PHOTO',
    name,
    contentType: file.type || 'image/jpeg',
    sizeBytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    visibility: ['OFFICE'],
    floorSiteId: null,
    partyId: null,
  })
  await putToStore(upload, bytes)
  await completeUpload(api, stored.id)
}

export { newIdempotencyKey }
