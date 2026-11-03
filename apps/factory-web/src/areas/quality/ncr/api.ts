import { z } from 'zod'
import { DEFECT_CLASSES, DISPOSITION_FOLLOW_UPS, DISPOSITION_MOVES, DISPOSITION_OUTCOMES, QUALITY_STAGES } from '@nexus/factory-domain/quality/defects/rules'
import { HOLD_SUBJECT_TYPES } from '@nexus/factory-domain/quality/holds/rules'
import { BOARD_LANES, CONTAINMENT_KINDS, CONTAINMENT_STATUSES, DECISION_STATES, NCR_FROM_TYPES, NCR_LINK_TYPES, NCR_SOURCES, NCR_STAGES, NCR_TITLE_KEYS, STAGE_CHECKS } from '@nexus/factory-domain/quality/ncr/rules'
import { CAPA_PRIORITIES, CAPA_STATUSES, CAPA_TYPES, ESCALATION_REASONS } from '@nexus/factory-domain/quality/capa/rules'
import { CONCESSION_ANSWERS, CONCESSION_STATUSES } from '@nexus/factory-domain/quality/ncr/concession'
import { COST_KINDS, COST_SOURCES } from '@nexus/factory-domain/quality/ncr/cost'
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
 * code). No price, no worker's name in a list. B-W2b-113: the NCR's cost by the cost grain (the API leaves every amount out
 * for a reader without it: optional here), its concessions, its report, its cause and its CAPA (the CAPA module's routes
 * for Escalate to CAPA, B-W2b-108).
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
export type NcrTitleKey = (typeof NCR_TITLE_KEYS)[number]
export type CostKind = (typeof COST_KINDS)[number]
export type CostSource = (typeof COST_SOURCES)[number]
export type ConcessionStatus = (typeof CONCESSION_STATUSES)[number]
export type ConcessionAnswer = (typeof CONCESSION_ANSWERS)[number]
export type CapaStatus = (typeof CAPA_STATUSES)[number]
export type CapaType = (typeof CAPA_TYPES)[number]
export type EscalationReason = (typeof ESCALATION_REASONS)[number]
export { CAPA_PRIORITIES, CAPA_TYPES, CONCESSION_ANSWERS, COST_KINDS, ESCALATION_REASONS }

export { BOARD_LANES, CONTAINMENT_KINDS, DEFECT_CLASSES, HOLD_SUBJECT_TYPES, NCR_FROM_TYPES, NCR_LINK_TYPES, NCR_SOURCES, NCR_STAGES, NCR_TITLE_KEYS, QUALITY_STAGES, UOMS }

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
  /** B-W2b-113: the CAPA it is escalated to (when the reader may see it). */
  capa: z.object({ id: z.string(), number: z.string(), status: z.enum(CAPA_STATUSES) }).nullable().optional(),
  /** B-W2b-113: the sum of its cost lines (minor units; null: none) — only for a reader with the cost grain. */
  cost: z.number().nullable().optional(),
  /** B-W2b-113: its company's currency (the Cost column's). */
  currency: z.string().optional(),
})
export type NcrSummary = z.infer<typeof summarySchema>

const ncrSchema = summarySchema.extend({
  description: z.string().nullable(),
  /** B-W2b-113: the cause code (read-only once decided). */
  cause: z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string() }).nullable().optional(),
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
  /** B-W2b-17: why it was cancelled (its own column; older actions: read from "Cancelled: …" by the API). */
  cancelReason: z.string().nullable(),
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

/** B-W2b-113 (QHS-085): a concession asked of the customer and, once recorded, their answer. */
const concessionSchema = z.object({
  id: z.string(),
  seq: z.number(),
  party: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  contact: z.object({ id: z.string(), name: z.string(), email: z.string().nullable() }).nullable(),
  ask: z.string(),
  proposal: z.string(),
  status: z.enum(CONCESSION_STATUSES),
  askedAt: z.string(),
  askedById: z.string().nullable(),
  answer: z.string().nullable(),
  answeredAt: z.string().nullable(),
  answeredBy: z.string().nullable(),
  answerFile: z.object({ id: z.string(), originalName: z.string(), status: z.string() }).nullable(),
  recordedById: z.string().nullable(),
  version: z.number(),
})
export type Concession = z.infer<typeof concessionSchema>
const capaRecordSchema = z.object({ id: z.string(), number: z.string(), title: z.string(), type: z.enum(CAPA_TYPES), status: z.enum(CAPA_STATUSES) })
const reportVersionSchema = z.object({ id: z.string(), version: z.number(), language: z.string(), fileId: z.string(), createdAt: z.string(), createdById: z.string().nullable() })
export type ReportVersion = z.infer<typeof reportVersionSchema>

export const recordSchema = z.object({
  ncr: ncrSchema,
  containment: z.array(actionSchema),
  decisions: z.array(decisionSchema),
  links: z.array(linkSchema),
  holds: z.array(holdSchema),
  register: z.object({ id: z.string(), reference: z.string(), status: z.string() }).nullable(),
  /** B-W2b-113: the CAPA it is escalated to (null: none, or one the reader may not see: `capaElsewhere`). */
  capaRecord: capaRecordSchema.nullable().default(null),
  capaElsewhere: z.boolean().default(false),
  concessions: z.array(concessionSchema).default([]),
  reports: z.array(reportVersionSchema).default([]),
  next: z.object({ stage: z.enum(NCR_STAGES).nullable(), checks: z.array(check), ready: z.boolean() }),
  closing: z.object({ checks: z.array(check), ready: z.boolean() }),
  actions: z.object({ edit: z.string().nullable(), contain: z.string().nullable(), decide: z.string().nullable(), close: z.string().nullable(), cancel: z.string().nullable(), concession: z.string().nullable().optional() }),
  may: z.object({ manage: z.boolean(), approve: z.boolean(), close: z.boolean(), raise: z.boolean(), cost: z.boolean().default(false), escalate: z.boolean().default(false) }),
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
  /** B-W2b-17: the title in parts — the screen words it in the reader's language (`title` is the API's English). */
  titleParts: z.object({ key: z.enum(NCR_TITLE_KEYS), values: z.record(z.string(), z.string()) }).nullable(),
  /** B-W2b-17: the inspection's defect lines it took ("Create NCR from N defects"; empty: all of them). */
  defectIds: z.array(z.string()),
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
  /** B-W2b-17: the company's containment time in hours (null: the record names no company — read the settings). */
  containmentHours: z.number().nullable(),
})
export type NcrPrefill = z.infer<typeof prefillSchema>

/** ncr-new's prefill from the record it is raised from (quality.ncr.raise); B-W2b-17: an inspection's picked defect lines. */
export const ncrPrefill = (api: ApiClient, from: { recordType: NcrFromType; recordId: string; defectIds?: readonly string[] }, signal?: AbortSignal) =>
  api
    .get('/quality/ncr/prefill', { query: clean({ recordType: from.recordType, recordId: from.recordId, defectIds: from.defectIds?.length ? from.defectIds.join(',') : undefined }), schema: z.object({ prefill: prefillSchema }), signal })
    .then((answer) => answer.prefill)

export const getNcr = (api: ApiClient, ncrId: string, signal?: AbortSignal) => api.get(`/quality/ncr/${seg(ncrId)}`, { schema: one, signal }).then((answer) => answer.record)

// ---- raise and change ---------------------------------------------------------------------------------------------------

/** The NCR's content (QHS-081): what a new one says (`from` prefills what is left out) and what an edit changes. */
export interface NcrContent {
  title?: string
  /** B-W2b-113: the cause code; null clears it. */
  causeCodeId?: string | null
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
  /** B-W2b-17: `defectIds` = the inspection's defect lines it is raised from. */
  from?: { recordType: NcrFromType; recordId: string; defectIds?: string[] }
  siteId?: string
}

export const raiseNcr = (api: ApiClient, body: RaiseBody, idempotencyKey: string) => api.post('/quality/ncr', { body, schema: one, idempotencyKey }).then((answer) => answer.record)

export const editNcr = (api: ApiClient, ncrId: string, body: NcrContent & { version: number }) =>
  api.request('PATCH', `/quality/ncr/${seg(ncrId)}`, { body, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record)

/**
 * B-W2b-17 (design ncr-grid "Assign owner N"): ONE command gives the picked NCRs (≤ 50) one owner, or none: every NCR or
 * none — a 409 names each refused one at `ncrs/<i>` (its index in `ncrs`).
 */
export const assignNcrs = (api: ApiClient, body: { ncrs: { id: string; version: number }[]; ownerId: string | null }, idempotencyKey: string) =>
  api.post('/quality/ncr/assign', { body, schema: z.object({ ncrs: z.array(summarySchema), changed: z.array(z.string()) }), idempotencyKey })

const settingsSchema = z.object({
  companyId: z.string().nullable(),
  inForce: z.object({ hours: z.number(), source: z.enum(['COMPANY', 'TENANT', 'DEFAULT']) }),
  own: z.object({ defaultContainmentHours: z.number().nullable(), updatedAt: z.string() }).nullable(),
  version: z.number(),
})
export type NcrSettings = z.infer<typeof settingsSchema>
const settingsAnswer = z.object({ settings: settingsSchema, mayChange: z.boolean() })
export type NcrSettingsAnswer = z.infer<typeof settingsAnswer>

/** B-W2b-17: the company's containment time for new NCRs (the company's row, else the tenant's, else 24 hours). */
export const getNcrSettings = (api: ApiClient, companyId: string | null, signal?: AbortSignal) => api.get('/quality/ncr/settings', { query: clean({ companyId }), schema: settingsAnswer, signal })

/** B-W2b-17: change it (quality.settings.manage): 1 to 720 hours, or null (follow the tenant's row / the default). */
export const saveNcrSettings = (api: ApiClient, body: { companyId: string | null; defaultContainmentHours: number | null; version: number }) =>
  api.request('PUT', '/quality/ncr/settings', { body, schema: settingsAnswer, idempotencyKey: newIdempotencyKey() })

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
export const reworkFromDecision = (api: ApiClient, ncrId: string, decisionId: string, body: { version: number; reworkAtOperationId: string; description?: string; scrapAll?: boolean }, idempotencyKey: string) =>
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

// ---- B-W2b-113: the cost (QHS-086, the cost grain) ----------------------------------------------------------------------

const costLineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  kind: z.enum(COST_KINDS),
  source: z.enum(COST_SOURCES),
  description: z.string().nullable(),
  /** Minor units (the cost grain: present only for a reader with it). */
  amount: z.number().optional(),
  record: z.object({ type: z.string(), id: z.string(), label: z.string().nullable() }).nullable(),
  version: z.number(),
  createdAt: z.string(),
  createdById: z.string().nullable(),
  updatedAt: z.string(),
})
export type CostLine = z.infer<typeof costLineSchema>
const costSheetSchema = z.object({
  ncrId: z.string(),
  number: z.string(),
  currency: z.string(),
  lines: z.array(costLineSchema),
  total: z.number().optional(),
  computed: z.object({
    upToDate: z.boolean(),
    add: z.number(),
    change: z.number(),
    remove: z.number(),
    waiting: z.array(z.object({ recordType: z.string(), recordId: z.string(), label: z.string().nullable(), words: z.string() })),
  }),
  held: z.string().nullable(),
  version: z.number(),
})
export type CostSheet = z.infer<typeof costSheetSchema>
const sheetAnswer = z.object({ sheet: costSheetSchema })
const costPath = (ncrId: string) => `/quality/ncr/${seg(ncrId)}/cost`

export const getCost = (api: ApiClient, ncrId: string, signal?: AbortSignal) => api.get(costPath(ncrId), { schema: sheetAnswer, signal }).then((answer) => answer.sheet)
export const addCostLine = (api: ApiClient, ncrId: string, body: { kind: CostKind; description?: string | null; amount: number }) =>
  api.post(`${costPath(ncrId)}/lines`, { body, schema: sheetAnswer, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.sheet)
export const editCostLine = (api: ApiClient, ncrId: string, lineId: string, body: { version: number; kind?: CostKind; description?: string | null; amount?: number }) =>
  api.request('PATCH', `${costPath(ncrId)}/lines/${seg(lineId)}`, { body, schema: sheetAnswer, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.sheet)
export const removeCostLine = (api: ApiClient, ncrId: string, lineId: string, version: number) =>
  api.request('DELETE', `${costPath(ncrId)}/lines/${seg(lineId)}`, { query: { version }, schema: sheetAnswer, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.sheet)
export const computeCost = (api: ApiClient, ncrId: string) =>
  api.post(`${costPath(ncrId)}/compute`, { body: {}, schema: z.object({ sheet: costSheetSchema, added: z.number(), changed: z.number(), removed: z.number() }), idempotencyKey: newIdempotencyKey() })

// ---- B-W2b-113: concessions asked of the customer (QHS-085) --------------------------------------------------------------

const concessionPath = (ncrId: string, concessionId: string) => `/quality/ncr/${seg(ncrId)}/concessions/${seg(concessionId)}`
export const askConcession = (api: ApiClient, ncrId: string, body: { partyId: string; contactId?: string | null; ask: string; proposal: string }) =>
  api.post(`/quality/ncr/${seg(ncrId)}/concessions`, { body, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record)
export const editConcession = (api: ApiClient, ncrId: string, concessionId: string, body: { version: number; contactId?: string | null; ask?: string; proposal?: string }) =>
  api.request('PATCH', concessionPath(ncrId, concessionId), { body, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record)
export const answerConcession = (api: ApiClient, ncrId: string, concessionId: string, body: { version: number; status: ConcessionAnswer; answer?: string | null; answeredBy: string; answeredAt: string; answerFileId?: string | null }) =>
  api.post(`${concessionPath(ncrId, concessionId)}/answer`, { body, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record)

const customerSchema = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable().optional() })
export type CustomerChoice = { id: string; code: string; name: string }
/** The company's customers and brands (parties.view): whom a concession is asked of. */
export const listCustomers = (api: ApiClient, q: string, signal?: AbortSignal): Promise<CustomerChoice[]> =>
  api
    .get('/parties', { query: clean({ role: 'CUSTOMER,BRAND', q: q.trim() || undefined, limit: 100 }), schema: z.object({ parties: z.array(customerSchema) }), signal })
    .then((answer) => answer.parties.map((party) => ({ id: party.id, code: party.code, name: party.tradeName ?? party.legalName })))
const contactSchema = z.object({ id: z.string(), name: z.string(), email: z.string().nullable(), status: z.string().optional() })
export type ContactChoice = z.infer<typeof contactSchema>
/** A customer's active contacts (the person asked; the party's own read). */
export const listContacts = (api: ApiClient, partyId: string, signal?: AbortSignal) =>
  api.get(`/parties/${seg(partyId)}`, { schema: z.object({ party: z.object({ contacts: z.array(contactSchema) }) }), signal }).then((answer) => answer.party.contacts.filter((contact) => !contact.status || contact.status === 'ACTIVE'))

/** The customer's written answer: a file of the concession (record type NcrConcession) — announce → the bytes → complete. */
export async function uploadConcessionFile(api: ApiClient, target: { companyId: string; concessionId: string }, file: Blob, name: string): Promise<string> {
  const bytes = await file.arrayBuffer()
  const { file: stored, upload } = await requestUpload(api, {
    companyId: target.companyId,
    record: { type: 'NcrConcession', id: target.concessionId },
    kind: 'DOCUMENT',
    name,
    contentType: file.type || 'application/pdf',
    sizeBytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    visibility: ['OFFICE'],
    floorSiteId: null,
    partyId: null,
  })
  await putToStore(upload, bytes)
  await completeUpload(api, stored.id)
  return stored.id
}

// ---- B-W2b-113: the report (ncr-pdf) and the cause list -----------------------------------------------------------------

/** The report's preview (the PDF's bytes, "preview" banner); a new tab opens `reportHref`. */
export const reportPreview = (api: ApiClient, ncrId: string, language: 'it' | 'en' | null, signal?: AbortSignal) => api.bytes(`/quality/ncr/${seg(ncrId)}/report`, { query: language ? { language } : {}, signal })
export const reportHref = (ncrId: string, language?: 'it' | 'en' | null): string => `/api/quality/ncr/${seg(ncrId)}/report${language ? `?language=${language}` : ''}`
export const keepReport = (api: ApiClient, ncrId: string, language: 'it' | 'en' | null) =>
  api.post(`/quality/ncr/${seg(ncrId)}/report`, { body: language ? { language } : {}, schema: z.object({ report: reportVersionSchema.extend({ number: z.string().nullable() }), made: z.boolean() }), idempotencyKey: newIdempotencyKey() })

const causeSchema = z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string(), active: z.boolean().optional(), process: z.string().optional() })
export type CauseChoice = z.infer<typeof causeSchema>
/** The cause list (quality.defects.view; B-W2b-90): active causes only. */
export const listCauses = (api: ApiClient, signal?: AbortSignal) => api.get('/quality/causes', { query: { active: 'true' }, schema: z.object({ causes: z.array(causeSchema) }), signal }).then((answer) => answer.causes.filter((cause) => cause.active !== false))

// ---- B-W2b-113: Escalate to CAPA (pop:ncr-capa, on B-W2b-108's routes) ---------------------------------------------------

const escalateSchema = z.object({
  records: z.array(
    z.object({
      recordType: z.string(),
      recordId: z.string(),
      number: z.string(),
      title: z.string().nullable(),
      companyId: z.string(),
      state: z.string(),
      reasons: z.array(z.enum(ESCALATION_REASONS)),
      escalatedTo: z.object({ capaId: z.string(), number: z.string(), status: z.enum(CAPA_STATUSES) }).nullable(),
      problem: z.object({ path: z.string(), message: z.string() }).nullable(),
    }),
  ),
  companyId: z.string().nullable(),
  sameCompany: z.boolean(),
  ready: z.boolean(),
  capas: z.array(z.object({ id: z.string(), number: z.string(), title: z.string(), type: z.enum(CAPA_TYPES), status: z.enum(CAPA_STATUSES), customer: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(), version: z.number() })),
  mayOpen: z.boolean(),
  mayView: z.boolean(),
  asOf: z.string(),
})
export type EscalatePreview = z.infer<typeof escalateSchema>
/** What escalating these NCRs would do: the rule that suggests it, where each one is already, the open CAPAs to link to. */
export const escalatePreview = (api: ApiClient, ncrIds: readonly string[], signal?: AbortSignal) =>
  api.get('/quality/capa/escalate', { query: { recordType: 'Nonconformance', ids: ncrIds.join(',') }, schema: escalateSchema, signal })
const capaAnswer = z.object({ record: z.object({ capa: z.object({ id: z.string(), number: z.string() }).passthrough() }).passthrough() })
/** Start a new CAPA from the NCRs (one command: the CAPA numbered, the NCRs name it). */
export const openCapaFrom = (api: ApiClient, body: { type: CapaType; title: string; dueOn: string; priority?: (typeof CAPA_PRIORITIES)[number]; sources: { recordType: 'Nonconformance'; recordId: string }[] }) =>
  api.post('/quality/capa', { body, schema: capaAnswer, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record.capa)
/** Link the NCRs to an open CAPA. */
export const addToCapa = (api: ApiClient, capaId: string, body: { version?: number; sources: { recordType: 'Nonconformance'; recordId: string }[] }) =>
  api.post(`/quality/capa/${seg(capaId)}/sources`, { body, schema: z.object({ record: capaAnswer.shape.record, added: z.number() }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.record.capa)

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
