import { z } from 'zod'
import { DEFECT_CLASSES, INSPECTION_RESULTS, INSPECTION_STATUSES } from '@nexus/factory-domain/quality/final/rules'
import { CHECK_STATES, FOUR_EYES_RULES, RELEASE_CHECKS, REVERSAL_REASONS, SECOND_PERSON_REASONS, SERIALS_TO } from '@nexus/factory-domain/quality/release/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Every call of Inspections (SCR-075) and the inspection record (SCR-076), each answer checked against the shape the
 * API's contract gives (apps/factory-api modules/quality/final contract.ts; unknown fields are ignored, so a new field
 * never breaks a page). Writes carry the record's version and an Idempotency-Key; signing a result and releasing
 * garments answer 403 `stepUp` until the session has a fresh code (the caller's useStepUp asks for it).
 */

const status = z.enum(INSPECTION_STATUSES)
const who = z.object({ kind: z.enum(['FLOOR', 'OFFICE']), workerId: z.string().nullable(), userId: z.string().nullable() })
export type Who = z.infer<typeof who>

// ---- the list ------------------------------------------------------------------------------------------------------------------

export const inspectionRowSchema = z.object({
  id: z.string(),
  inspectionNumber: z.string().nullable(),
  label: z.string(),
  workOrderId: z.string(),
  /** The work order's number. */
  number: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  status,
  lotSize: z.number(),
  sampleSize: z.number(),
  computedResult: z.enum(INSPECTION_RESULTS).nullable(),
  overridden: z.boolean(),
  inspector: who,
  released: z.number(),
  reversed: z.number(),
  toRelease: z.number(),
  onHold: z.boolean(),
  holdWords: z.string().nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
})
export type InspectionRow = z.infer<typeof inspectionRowSchema>

export interface InspectionQuery {
  readonly status?: (typeof INSPECTION_STATUSES)[number] | null
  readonly onHold?: boolean
  readonly waitingRelease?: boolean
  readonly workOrderId?: string | null
  readonly limit?: number
}

/** `GET /quality/inspections`: newest first, at most `limit` (200 at most; no cursor). */
export async function listInspections(api: ApiClient, query: InspectionQuery, signal?: AbortSignal): Promise<InspectionRow[]> {
  const answer = await api.get('/quality/inspections', {
    query: {
      ...(query.status ? { status: query.status } : {}),
      ...(query.onHold ? { onHold: 'true' } : {}),
      ...(query.waitingRelease ? { waitingRelease: 'true' } : {}),
      ...(query.workOrderId ? { workOrderId: query.workOrderId } : {}),
      limit: query.limit ?? 50,
    },
    schema: z.object({ inspections: z.array(inspectionRowSchema) }),
    signal,
  })
  return answer.inspections
}

// ---- releases --------------------------------------------------------------------------------------------------------------

const reversalSchema = z.object({
  id: z.string(),
  quantity: z.number(),
  reasonCode: z.enum(REVERSAL_REASONS).nullable(),
  reason: z.string(),
  serialIds: z.array(z.string()),
  serialsTo: z.enum(['MADE', 'RELEASED', 'SHIPPED', 'VOID']).nullable(),
  reversedById: z.string(),
  reversedAt: z.string(),
  onHold: z.boolean(),
})
export type Reversal = z.infer<typeof reversalSchema>

export const releaseSchema = z.object({
  id: z.string(),
  releaseNumber: z.string().nullable(),
  workOrderId: z.string(),
  /** The work order's number. */
  number: z.string(),
  workOrderSizeId: z.string(),
  inspectionId: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  quantity: z.number(),
  reversed: z.number(),
  onHold: z.number(),
  releasedBy: who,
  releasedAt: z.string(),
  signatureSha256: z.string(),
  secondPerson: z.object({ reasons: z.array(z.enum(SECOND_PERSON_REASONS)), words: z.string() }),
  certificates: z.array(z.object({ id: z.string(), number: z.string(), standard: z.string(), ppeClass: z.string().nullable(), statusNow: z.string(), validTo: z.string() })),
  serials: z.array(z.object({ id: z.string(), serial: z.string(), status: z.string(), packed: z.boolean() })),
  reversals: z.array(reversalSchema),
  note: z.string().nullable(),
})
export type Release = z.infer<typeof releaseSchema>

const impactSchema = z.object({ reversible: z.number(), onDraft: z.number(), packed: z.number(), shipped: z.number(), words: z.string() })
export type ReverseImpact = z.infer<typeof impactSchema>

const registerEntrySchema = z.object({ id: z.string(), reference: z.string(), status: z.string(), reversalId: z.string().nullable() })
export type ReleaseRegisterEntry = z.infer<typeof registerEntrySchema>

export interface ReleaseQuery {
  readonly reversed?: boolean
  readonly onHold?: boolean
  readonly workOrderId?: string | null
  readonly limit?: number
}

/** `GET /quality/releases`: the reversed-release view (`reversed`), or a work order's releases. */
export async function listReleases(api: ApiClient, query: ReleaseQuery, signal?: AbortSignal): Promise<Release[]> {
  const answer = await api.get('/quality/releases', {
    query: {
      ...(query.reversed ? { reversed: 'true' } : {}),
      ...(query.onHold ? { onHold: 'true' } : {}),
      ...(query.workOrderId ? { workOrderId: query.workOrderId } : {}),
      limit: query.limit ?? 50,
    },
    schema: z.object({ releases: z.array(releaseSchema) }),
    signal,
  })
  return answer.releases
}

export const releaseDetailSchema = z.object({ release: releaseSchema, reverseImpact: impactSchema, registerEntries: z.array(registerEntrySchema) })
export type ReleaseDetail = z.infer<typeof releaseDetailSchema>

/** `GET /quality/releases/:id`: the release, what a reversal would do now, and its register entries. */
export function getRelease(api: ApiClient, releaseId: string, signal?: AbortSignal): Promise<ReleaseDetail> {
  return api.get(`/quality/releases/${encodeURIComponent(releaseId)}`, { schema: releaseDetailSchema, signal })
}

export interface ReverseBody {
  readonly quantity: number
  readonly serialIds?: readonly string[]
  readonly serialsTo?: (typeof SERIALS_TO)[number] | null
  readonly reasonCode: (typeof REVERSAL_REASONS)[number]
  readonly reason: string
}

const reverseAnswerSchema = z.object({
  reversalId: z.string(),
  impact: impactSchema,
  register: z.object({ opened: z.boolean(), entryId: z.string().nullable(), reference: z.string().nullable(), shippedGoods: z.boolean().nullable(), words: z.string() }),
  release: releaseSchema,
  words: z.string(),
})
export type ReverseAnswer = z.infer<typeof reverseAnswerSchema>

/** `POST /quality/releases/:id/reverse` (no step-up: a reversal only protects). */
export function reverseRelease(api: ApiClient, releaseId: string, body: ReverseBody, key: string = newIdempotencyKey()): Promise<ReverseAnswer> {
  return api.post(`/quality/releases/${encodeURIComponent(releaseId)}/reverse`, { body, schema: reverseAnswerSchema, idempotencyKey: key })
}

// ---- the work order's final state (cells, the gate per cell for the viewer) -------------------------------------------------------

const checkSchema = z.object({ code: z.enum(RELEASE_CHECKS), state: z.enum(CHECK_STATES), message: z.string(), fix: z.string().nullable() })
export type GateCheck = z.infer<typeof checkSchema>

export const finalStateSchema = z.object({
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string(), batchNumber: z.string().nullable(), companyId: z.string(), siteId: z.string() }),
  inspectionId: z.string().nullable(),
  inspections: z.array(z.object({ id: z.string(), inspectionNumber: z.string().nullable(), label: z.string(), status, lotSize: z.number(), released: z.number(), overridden: z.boolean(), decidedAt: z.string().nullable() })),
  cells: z.array(
    z.object({
      workOrderSizeId: z.string(),
      colourwayCode: z.string(),
      size: z.string(),
      pieces: z.number(),
      released: z.number(),
      labelsPrinted: z.number(),
      releasable: z.number(),
      readySerials: z.array(z.object({ id: z.string(), serial: z.string() })),
      summary: z.string(),
      checks: z.array(checkSchema),
      secondPersonReasons: z.array(z.enum(SECOND_PERSON_REASONS)),
    }),
  ),
  maker: z.object({ made: z.boolean(), words: z.string() }),
  documents: z.array(z.object({ code: z.string(), message: z.string() })),
  rule: z.object({ rule: z.enum(FOUR_EYES_RULES), source: z.enum(['COMPANY', 'TENANT', 'DEFAULT']), words: z.string(), customerListed: z.boolean() }),
})
export type FinalState = z.infer<typeof finalStateSchema>
export type FinalCell = FinalState['cells'][number]

/** `GET /quality/final/work-orders/:id`: its cells and the release gate per cell for the viewer. */
export function getFinalState(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<FinalState> {
  return api.get(`/quality/final/work-orders/${encodeURIComponent(workOrderId)}`, { schema: finalStateSchema, signal })
}

export interface ReleaseBody {
  readonly inspectionId: string
  readonly workOrderSizeId: string
  readonly quantity: number
  readonly serialIds?: readonly string[]
  readonly note?: string | null
}

const releaseAnswerSchema = z.object({ release: releaseSchema, words: z.string() })

/** `POST /quality/releases` (signing: 403 `stepUp` until a fresh code; a refused gate is a 409 `checks/<CODE>`). */
export function releaseGarments(api: ApiClient, body: ReleaseBody, key: string): Promise<{ release: Release; words: string }> {
  return api.post('/quality/releases', { body, schema: releaseAnswerSchema, idempotencyKey: key })
}

// ---- one inspection ----------------------------------------------------------------------------------------------------------

const defectSchema = z.object({
  id: z.string(),
  defectClass: z.enum(DEFECT_CLASSES),
  code: z.string(),
  description: z.string().nullable(),
  quantity: z.number(),
  workOrderSizeId: z.string().nullable(),
  note: z.string().nullable(),
})
export type Defect = z.infer<typeof defectSchema>

export const inspectionSchema = z.object({
  id: z.string(),
  inspectionNumber: z.string().nullable(),
  label: z.string(),
  workOrderId: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  status,
  plan: z.object({
    lotSize: z.number(),
    sampleSize: z.number(),
    inspectionLevel: z.string(),
    aqlMajor: z.string(),
    aqlMinor: z.string(),
    acceptMajor: z.number(),
    acceptMinor: z.number(),
    hundredPercent: z.boolean(),
  }),
  checklist: z.array(z.object({ code: z.string(), ok: z.boolean().nullable(), note: z.string().nullable() })),
  defects: z.array(defectSchema),
  counts: z.object({ critical: z.number(), major: z.number(), minor: z.number() }),
  computed: z.object({ result: z.enum(INSPECTION_RESULTS), words: z.string() }),
  overridden: z.boolean(),
  overrideReason: z.string().nullable(),
  inspector: who,
  notMakerStatement: z.boolean(),
  decidedAt: z.string().nullable(),
  signatureSha256: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
})
export type Inspection = z.infer<typeof inspectionSchema>

export const inspectionReadSchema = z.object({
  inspection: inspectionSchema,
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string(), batchNumber: z.string().nullable() }),
  maker: z.object({ made: z.boolean(), words: z.string() }),
  /** Where the site records stations, not workers: the inspector states "I did not make these garments". */
  statementNeeded: z.boolean(),
  /** The viewer is the inspector who opened it. */
  yours: z.boolean(),
})
export type InspectionRead = z.infer<typeof inspectionReadSchema>

export function getInspection(api: ApiClient, inspectionId: string, signal?: AbortSignal): Promise<InspectionRead> {
  return api.get(`/quality/inspections/${encodeURIComponent(inspectionId)}`, { schema: inspectionReadSchema, signal })
}

const inspectionAnswer = z.object({ inspection: inspectionSchema })

export interface PlanBody {
  readonly lotSize: number
  readonly sampleSize: number
  readonly inspectionLevel: string
  readonly aqlMajor: string
  readonly aqlMinor: string
  readonly acceptMajor: number
  readonly acceptMinor: number
}

export interface ChecklistAnswerBody {
  readonly code: string
  readonly ok: boolean | null
  readonly note?: string | null
}

/** `POST /quality/inspections`: opens one on a work order's finished garments (it takes its INSPECTION number). */
export async function openInspection(api: ApiClient, body: PlanBody & { workOrderId: string; note?: string | null }, key: string): Promise<Inspection> {
  return (await api.post('/quality/inspections', { body, schema: inspectionAnswer, idempotencyKey: key })).inspection
}

/** `PATCH /quality/inspections/:id`: the plan, checklist answers, the note or the maker statement while OPEN. */
export async function patchInspection(
  api: ApiClient,
  inspectionId: string,
  body: Partial<PlanBody> & { version: number; checklist?: readonly ChecklistAnswerBody[]; note?: string | null; notMakerStatement?: boolean },
): Promise<Inspection> {
  return (await api.request('PATCH', `/quality/inspections/${encodeURIComponent(inspectionId)}`, { body, schema: inspectionAnswer, idempotencyKey: newIdempotencyKey() })).inspection
}

export interface DefectBody {
  readonly defectClass: (typeof DEFECT_CLASSES)[number]
  readonly code: string
  readonly quantity: number
  readonly workOrderSizeId?: string | null
  readonly description?: string | null
  readonly note?: string | null
}

/** `PUT /quality/inspections/:id/defects`: the whole defect list (one line per class and code). */
export async function putDefects(api: ApiClient, inspectionId: string, body: { version: number; defects: readonly DefectBody[] }): Promise<Inspection> {
  return (await api.request('PUT', `/quality/inspections/${encodeURIComponent(inspectionId)}/defects`, { body, schema: inspectionAnswer, idempotencyKey: newIdempotencyKey() })).inspection
}

export interface DecideBody {
  readonly version: number
  readonly result: (typeof INSPECTION_RESULTS)[number]
  readonly checklist: readonly ChecklistAnswerBody[]
  readonly notMakerStatement?: boolean
  readonly overrideReason?: string | null
  readonly note?: string | null
}

/** `POST /quality/inspections/:id/decide` (signing: 403 `stepUp` until a fresh code). */
export async function decideInspection(api: ApiClient, inspectionId: string, body: DecideBody, key: string): Promise<Inspection> {
  return (await api.post(`/quality/inspections/${encodeURIComponent(inspectionId)}/decide`, { body, schema: inspectionAnswer, idempotencyKey: key })).inspection
}

/** `POST /quality/inspections/:id/cancel` with the reason. */
export async function cancelInspection(api: ApiClient, inspectionId: string, body: { version: number; reason: string }): Promise<Inspection> {
  return (await api.post(`/quality/inspections/${encodeURIComponent(inspectionId)}/cancel`, { body, schema: inspectionAnswer, idempotencyKey: newIdempotencyKey() })).inspection
}

// ---- the four-eyes rule (Owner answer Q1) -----------------------------------------------------------------------------------------

export const ruleSchema = z.object({
  companyId: z.string().nullable(),
  inForce: z.object({ rule: z.enum(FOUR_EYES_RULES), source: z.enum(['COMPANY', 'TENANT', 'DEFAULT']), words: z.string() }),
  own: z.object({ releaseFourEyes: z.enum(FOUR_EYES_RULES).nullable(), secondPersonPartyIds: z.array(z.string()), updatedAt: z.string() }).nullable(),
  version: z.number(),
  customers: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), listedOn: z.enum(['COMPANY', 'TENANT']) })),
})
export type ReleaseRule = z.infer<typeof ruleSchema>

/** `GET /quality/release-rule?companyId`: the rule in force for the company, its own row, the listed customers. */
export function getReleaseRule(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<ReleaseRule> {
  return api.get('/quality/release-rule', { query: companyId ? { companyId } : {}, schema: ruleSchema, signal })
}

export interface RuleBody {
  readonly companyId: string | null
  readonly releaseFourEyes: (typeof FOUR_EYES_RULES)[number] | null
  readonly secondPersonPartyIds: readonly string[]
  readonly version: number
  readonly reason?: string | null
}

/** `PUT /quality/release-rule` (quality.settings.manage; loosening asks a reason and a fresh code). */
export async function saveReleaseRule(api: ApiClient, body: RuleBody, key: string): Promise<{ rule: ReleaseRule; loosened: boolean }> {
  return api.request('PUT', '/quality/release-rule', { body, schema: z.object({ rule: ruleSchema, loosened: z.boolean() }), idempotencyKey: key })
}

// ---- pickers: work orders (New inspection) and customers (the rule's list) ----------------------------------------------------------

export const workOrderPickSchema = z.object({
  id: z.string(),
  number: z.string(),
  batchNumber: z.string().nullable(),
  status: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  siteCode: z.string(),
  styleCode: z.string(),
  styleName: z.string(),
  colourways: z.array(z.string()),
  pieces: z.number(),
  dueDate: z.string().nullable(),
})
export type WorkOrderPick = z.infer<typeof workOrderPickSchema>

/** The work orders whose finished garments can be inspected (released, in progress or completed), newest first. */
export async function listInspectableWorkOrders(api: ApiClient, signal?: AbortSignal): Promise<WorkOrderPick[]> {
  const reads = await Promise.all(
    (['IN_PROGRESS', 'COMPLETED', 'RELEASED'] as const).map((woStatus) =>
      api.get('/production/work-orders', { query: { status: woStatus, limit: 100 }, schema: z.object({ workOrders: z.array(workOrderPickSchema) }), signal }),
    ),
  )
  return reads.flatMap((read) => read.workOrders)
}

const workOrderCellsSchema = z.object({
  workOrder: z.object({
    id: z.string(),
    number: z.string(),
    style: z.object({ id: z.string(), code: z.string(), name: z.string() }),
    cells: z.array(z.object({ id: z.string(), colourwayCode: z.string(), size: z.string(), quantity: z.number(), progress: z.object({ finished: z.number().nullable() }) })),
    pieces: z.number(),
  }),
})
export type WorkOrderCells = z.infer<typeof workOrderCellsSchema>['workOrder']

/** `GET /production/work-orders/:id` (workorders.view): its style and the finished garments per cell. */
export async function getWorkOrderCells(api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<WorkOrderCells> {
  return (await api.get(`/production/work-orders/${encodeURIComponent(workOrderId)}`, { schema: workOrderCellsSchema, signal })).workOrder
}

export const partyPickSchema = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable() })
export type PartyPick = z.infer<typeof partyPickSchema>

/** `GET /parties?role=CUSTOMER,BRAND&q=` (parties.view): customers and brands the release rule may list. */
export async function findCustomers(api: ApiClient, q: string, signal?: AbortSignal): Promise<PartyPick[]> {
  const answer = await api.get('/parties', { query: { q: q.trim() || undefined, role: 'CUSTOMER,BRAND', limit: 20 }, schema: z.object({ parties: z.array(partyPickSchema) }), signal })
  return answer.parties
}
