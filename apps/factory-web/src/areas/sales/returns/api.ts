import { z } from 'zod'
import { DDT_FREIGHT, DDT_REASONS, DDT_TRANSPORT_BY } from '@nexus/factory-domain/documents/model'
import { RETURN_CREDIT_SKIPS } from '@nexus/factory-domain/invoicing/credit-note/from-return'
import {
  HAND_MOVES,
  POINT_RESULTS,
  REPAIR_ACTIONS,
  REPAIR_KINDS,
  REPAIR_LIST_VIEWS,
  REPAIR_STAGES,
  REPAIR_STEPS,
  SAFETY_RESULTS,
  SAFETY_STATES,
} from '@nexus/factory-domain/sales/repairs/rules'
import {
  FREIGHT_PAYERS,
  GOODS_OUTCOMES,
  PARCEL_CONDITIONS,
  RETURN_ACTIONS,
  RETURN_CAUSES,
  RETURN_DISPOSITIONS,
  RETURN_FOLLOW_UPS,
  RETURN_GRADES,
  RETURN_LIST_VIEWS,
  RETURN_STATUSES,
  STEP_STATES,
  TRACKING_STEPS,
} from '@nexus/factory-domain/sales/returns/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { completeUpload, requestUpload } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'

/**
 * Every call of Sales › Returns & repairs (SCR-111 list, SCR-112 the RMA and the repair order; apps/factory-api
 * modules/sales/returns (B-W2a-43) and modules/sales/repairs (B-W2a-57)), each answer checked with a zod shape that
 * mirrors the API's contract (the web never imports the API source): unknown fields are dropped, so a new field never
 * breaks the page. Prices, discounts and credit values are the price grain: the API leaves them out for a reader without
 * it (optional here). Beside them: the RMA's credit notes (Finance, B-W2a-61), the DDT of a source (Shipping, B-W2a-17:
 * a repair's way back, a return of unchanged goods), the repair work order (Production, B-W2a-12), the photos (the
 * generic files routes), the customers, the people who own records, and the return reasons (B-W2a-18).
 */

export {
  DDT_FREIGHT,
  DDT_REASONS,
  DDT_TRANSPORT_BY,
  FREIGHT_PAYERS,
  GOODS_OUTCOMES,
  HAND_MOVES,
  PARCEL_CONDITIONS,
  POINT_RESULTS,
  REPAIR_ACTIONS,
  REPAIR_KINDS,
  REPAIR_LIST_VIEWS,
  REPAIR_STAGES,
  REPAIR_STEPS,
  RETURN_ACTIONS,
  RETURN_CAUSES,
  RETURN_CREDIT_SKIPS,
  RETURN_DISPOSITIONS,
  RETURN_FOLLOW_UPS,
  RETURN_GRADES,
  RETURN_LIST_VIEWS,
  RETURN_STATUSES,
  SAFETY_RESULTS,
  SAFETY_STATES,
  STEP_STATES,
  TRACKING_STEPS,
}
export type ReturnStatus = (typeof RETURN_STATUSES)[number]
export type ReturnGrade = (typeof RETURN_GRADES)[number]
export type ReturnCause = (typeof RETURN_CAUSES)[number]
export type ReturnDisposition = (typeof RETURN_DISPOSITIONS)[number]
export type GoodsOutcome = (typeof GOODS_OUTCOMES)[number]
export type ParcelCondition = (typeof PARCEL_CONDITIONS)[number]
export type FreightPayer = (typeof FREIGHT_PAYERS)[number]
export type ReturnAction = (typeof RETURN_ACTIONS)[number]
export type ReturnListView = (typeof RETURN_LIST_VIEWS)[number]
export type FollowUp = (typeof RETURN_FOLLOW_UPS)[number]
export type TrackingStep = (typeof TRACKING_STEPS)[number]
export type StepState = (typeof STEP_STATES)[number]
export type RepairStage = (typeof REPAIR_STAGES)[number]
export type RepairKind = (typeof REPAIR_KINDS)[number]
export type RepairAction = (typeof REPAIR_ACTIONS)[number]
export type RepairListView = (typeof REPAIR_LIST_VIEWS)[number]
export type RepairStep = (typeof REPAIR_STEPS)[number]
export type SafetyState = (typeof SAFETY_STATES)[number]
export type SafetyResult = (typeof SAFETY_RESULTS)[number]
export type PointResult = (typeof POINT_RESULTS)[number]
export type HandMove = (typeof HAND_MOVES)[number]
export type CreditSkip = (typeof RETURN_CREDIT_SKIPS)[number]
export type DdtReason = (typeof DDT_REASONS)[number]
export type DdtTransportBy = (typeof DDT_TRANSPORT_BY)[number]
export type DdtFreight = (typeof DDT_FREIGHT)[number]

const seg = (value: string) => encodeURIComponent(value)
const clean = <T extends Record<string, string | number | boolean | null | undefined>>(query: T) =>
  Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== '')) as Record<string, string | number | boolean>

const issue = z.object({ path: z.string(), message: z.string() })
export type Issue = z.infer<typeof issue>
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
const party = z.object({ id: z.string(), code: z.string(), legalName: z.string() })
const person = z.object({ id: z.string(), name: z.string() })
export type Person = z.infer<typeof person>
const numbered = z.object({ id: z.string(), number: z.string() })
const reasonWords = z.object({ code: z.string(), labelIt: z.string(), labelEn: z.string() })

// ---- returns: the list and its tiles ------------------------------------------------------------------------------------

export const returnRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  site: z.object({ id: z.string(), code: z.string() }).nullable(),
  partyId: z.string(),
  party: party.nullable(),
  customerRef: z.string().nullable(),
  salesOrder: numbered.nullable(),
  invoiceNumbers: z.array(z.string()),
  units: z.number(),
  receivedUnits: z.number(),
  reasonCodes: z.array(z.string()),
  reason: reasonWords.nullable(),
  status: z.enum(RETURN_STATUSES),
  dispositions: z.array(z.enum(RETURN_DISPOSITIONS)),
  receivedAt: z.string().nullable(),
  goodsDueBy: z.string().nullable(),
  late: z.boolean(),
  currency: z.string().nullable(),
  /** Price grain: absent without it. */
  creditTotal: z.number().optional(),
  replacementOrder: numbered.nullable(),
  ownerId: z.string().nullable(),
  requestedAt: z.string(),
  updatedAt: z.string(),
})
export type ReturnRow = z.infer<typeof returnRowSchema>

const returnListSchema = z.object({ returns: z.array(returnRowSchema), truncated: z.boolean() })
export type ReturnList = z.infer<typeof returnListSchema>

export interface ReturnQuery {
  view?: ReturnListView | null
  partyId?: string | null
  salesOrderId?: string | null
  q?: string | null
}

export const listReturns = (api: ApiClient, query: ReturnQuery, signal?: AbortSignal): Promise<ReturnList> =>
  api.get('/sales/returns', { query: clean({ view: query.view, partyId: query.partyId, salesOrderId: query.salesOrderId, q: query.q?.trim() }), schema: returnListSchema, signal })

const returnCountsSchema = z.object({
  counts: z.object({ waiting: z.number(), late: z.number(), toInspect: z.number(), toDecide: z.number(), replacement: z.number(), open: z.number() }),
  asOf: z.string(),
})
export type ReturnCounts = z.infer<typeof returnCountsSchema>['counts']

export const returnCounts = (api: ApiClient, signal?: AbortSignal) => api.get('/sales/returns/counts', { schema: returnCountsSchema, signal })

// ---- returns: the record ------------------------------------------------------------------------------------------------

export const returnLineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  salesOrderLineId: z.string().nullable(),
  size: z.string().nullable(),
  invoiceLineId: z.string().nullable(),
  order: z.object({ id: z.string(), number: z.string(), lineSeq: z.number() }).nullable(),
  invoice: z.object({ id: z.string(), number: z.string().nullable(), issueDate: z.string().nullable(), lineSeq: z.number() }).nullable(),
  style: ref.nullable(),
  colourway: ref.nullable(),
  ppe: z.boolean(),
  safety: z.boolean(),
  description: z.string(),
  serial: z.string().nullable(),
  batchNumber: z.string().nullable(),
  quantity: z.number(),
  reasonCode: z.string(),
  reason: reasonWords.extend({ active: z.boolean() }).nullable(),
  reasonNote: z.string().nullable(),
  currency: z.string().nullable(),
  unitPrice: z.string().nullable().optional(),
  discountPct: z.string().nullable().optional(),
  receivedQuantity: z.number(),
  receivedAt: z.string().nullable(),
  receiptId: z.string().nullable(),
  receivedValue: z.number().nullable().optional(),
  grade: z.enum(RETURN_GRADES).nullable(),
  cause: z.enum(RETURN_CAUSES).nullable(),
  conditionNote: z.string().nullable(),
  inspectedAt: z.string().nullable(),
  photos: z.number(),
  suggestedOutcome: z.enum(GOODS_OUTCOMES).nullable(),
  restockHeld: z.string().nullable(),
  disposition: z.enum(RETURN_DISPOSITIONS).nullable(),
  goodsOutcome: z.enum(GOODS_OUTCOMES).nullable(),
  decidedAt: z.string().nullable(),
  creditAmount: z.number().nullable().optional(),
  followUp: z.enum(RETURN_FOLLOW_UPS).nullable(),
  stock: z.array(z.object({ moveId: z.string(), locationId: z.string().nullable(), locationCode: z.string().nullable(), quantity: z.string() })),
  replacementLineId: z.string().nullable(),
  version: z.number(),
})
export type ReturnLine = z.infer<typeof returnLineSchema>

const policyView = z.object({
  windowDays: z.number().nullable(),
  goodsDueDays: z.number().nullable(),
  freightPaidBy: z.enum(FREIGHT_PAYERS).nullable(),
  restockingFeePct: z.string().nullable(),
  conditions: z.string().nullable(),
})
export type PolicyView = z.infer<typeof policyView>

export const returnSchema = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  company: ref.nullable(),
  siteId: z.string(),
  site: ref.nullable(),
  partyId: z.string(),
  party: party.nullable(),
  contactId: z.string().nullable(),
  customerRef: z.string().nullable(),
  salesOrder: numbered.nullable(),
  status: z.enum(RETURN_STATUSES),
  requestedAt: z.string(),
  authorisedAt: z.string().nullable(),
  goodsDueBy: z.string().nullable(),
  late: z.boolean(),
  receivedAt: z.string().nullable(),
  inspectedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  statusReason: z.string().nullable(),
  ownerId: z.string().nullable(),
  internalNote: z.string().nullable(),
  replacementOrder: z.object({ id: z.string(), number: z.string(), status: z.string() }).nullable(),
  currency: z.string().nullable(),
  creditTotal: z.number().optional(),
  lines: z.array(returnLineSchema),
  receipts: z.array(
    z.object({
      id: z.string(),
      receivedAt: z.string(),
      parcels: z.number(),
      parcelCondition: z.enum(PARCEL_CONDITIONS),
      carrierName: z.string().nullable(),
      trackingNumber: z.string().nullable(),
      customerDdtNumber: z.string().nullable(),
      customerDdtDate: z.string().nullable(),
      note: z.string().nullable(),
      photos: z.number(),
      lineIds: z.array(z.string()),
    }),
  ),
  ddts: z.object({
    live: z.array(z.object({ id: z.string(), number: z.string(), lineIds: z.array(z.string()) })),
    cancelled: z.array(z.object({ id: z.string(), number: z.string(), lineIds: z.array(z.string()) })),
  }),
  tracking: z.array(z.object({ step: z.enum(TRACKING_STEPS), state: z.enum(STEP_STATES), at: z.string().nullable() })),
  actions: z.array(z.object({ action: z.enum(RETURN_ACTIONS), allowed: z.boolean() })),
  policy: policyView.extend({ freightPaidByNow: z.enum(['CUSTOMER', 'COMPANY']).nullable() }),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Rma = z.infer<typeof returnSchema>

const oneReturn = z.object({ return: returnSchema })

export const getReturn = (api: ApiClient, id: string, signal?: AbortSignal): Promise<Rma> => api.get(`/sales/returns/${seg(id)}`, { schema: oneReturn, signal }).then((answer) => answer.return)

// ---- returns: New return (what may come back → preview → create) --------------------------------------------------------

export const returnableLineSchema = z.object({
  kind: z.enum(['INVOICED', 'SHIPPED']),
  invoiceLineId: z.string().nullable(),
  salesOrderLineId: z.string().nullable(),
  size: z.string().nullable(),
  description: z.string(),
  order: z.object({ id: z.string(), number: z.string(), lineSeq: z.number() }).nullable(),
  invoice: z.object({ id: z.string(), number: z.string().nullable(), issueDate: z.string().nullable(), lineSeq: z.number() }).nullable(),
  style: ref.nullable(),
  colourway: ref.nullable(),
  ppe: z.boolean(),
  sold: z.number(),
  taken: z.number(),
  shippedLeft: z.number().nullable(),
  left: z.number(),
  currency: z.string(),
  unitPrice: z.string().nullable().optional(),
  discountPct: z.string().nullable().optional(),
  pieceValue: z.number().nullable().optional(),
  deliveredOn: z.string().nullable(),
  batchNumbers: z.array(z.string()),
  siteId: z.string().nullable(),
  warning: z.string().nullable(),
})
export type ReturnableLine = z.infer<typeof returnableLineSchema>
const returnableSchema = z.object({ lines: z.array(returnableLineSchema), policy: policyView })
export type Returnable = z.infer<typeof returnableSchema>

export const listReturnable = (api: ApiClient, query: { companyId: string; partyId: string; salesOrderId?: string | null }, signal?: AbortSignal): Promise<Returnable> =>
  api.get('/sales/returns/returnable', { query: clean(query), schema: returnableSchema, signal })

export interface NewReturnLine {
  invoiceLineId?: string | null
  salesOrderLineId?: string | null
  size?: string | null
  quantity: number
  reasonCode: string
  reasonNote?: string | null
  serial?: string | null
  batchNumber?: string | null
}

export interface NewReturnBody {
  companyId: string
  partyId: string
  customerRef?: string | null
  salesOrderId?: string | null
  ownerId?: string | null
  internalNote?: string | null
  goodsDueBy?: string | null
  lines: NewReturnLine[]
}

const returnPreviewSchema = z.object({
  ok: z.boolean(),
  problems: z.array(issue),
  warnings: z.array(issue),
  goodsDueBy: z.string().nullable(),
  siteId: z.string().nullable(),
  salesOrderId: z.string().nullable(),
  lines: z.array(z.object({ invoiceLineId: z.string().nullable(), salesOrderLineId: z.string().nullable(), size: z.string().nullable(), quantity: z.number(), left: z.number(), description: z.string(), batchNumber: z.string().nullable(), ppe: z.boolean() })),
})
export type ReturnPreview = z.infer<typeof returnPreviewSchema>

export const previewReturn = (api: ApiClient, body: NewReturnBody, signal?: AbortSignal): Promise<ReturnPreview> => api.post('/sales/returns/preview', { body, schema: returnPreviewSchema, signal })

export const createReturn = (api: ApiClient, body: NewReturnBody, idempotencyKey: string) =>
  api.post('/sales/returns', {
    body,
    schema: z.object({ return: returnSchema, warnings: z.array(issue), registerEntries: z.array(z.object({ lineId: z.string(), entryId: z.string().nullable(), reference: z.string().nullable(), opened: z.boolean() })) }),
    idempotencyKey,
  })

// ---- returns: the record's writes (each at the version read) ------------------------------------------------------------

type Versioned = Pick<Rma, 'id' | 'version'>

export const changeReturn = (api: ApiClient, rma: Versioned, patch: { customerRef?: string | null; ownerId?: string | null; internalNote?: string | null; goodsDueBy?: string | null }) =>
  api.request('PATCH', `/sales/returns/${seg(rma.id)}`, { body: { version: rma.version, ...patch }, schema: oneReturn, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.return)

export interface LinePatch {
  quantity?: number
  reasonCode?: string
  reasonNote?: string | null
  serial?: string | null
  batchNumber?: string | null
}

export const changeReturnLine = (api: ApiClient, rma: Versioned, lineId: string, patch: LinePatch) =>
  api.request('PATCH', `/sales/returns/${seg(rma.id)}/lines/${seg(lineId)}`, { body: { version: rma.version, ...patch }, schema: oneReturn, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.return)

export const removeReturnLine = (api: ApiClient, rma: Versioned, lineId: string) =>
  api.request('DELETE', `/sales/returns/${seg(rma.id)}/lines/${seg(lineId)}`, { query: { version: rma.version }, schema: oneReturn, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.return)

export const cancelReturn = (api: ApiClient, rma: Versioned, reason: string) =>
  api.post(`/sales/returns/${seg(rma.id)}/cancel`, { body: { version: rma.version, reason }, schema: oneReturn, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.return)

export const closeReturn = (api: ApiClient, rma: Versioned, reason: string, idempotencyKey: string) =>
  api.post(`/sales/returns/${seg(rma.id)}/close`, { body: { version: rma.version, reason }, schema: z.object({ return: returnSchema, warnings: z.array(issue) }), idempotencyKey })

export interface ReceiptBody {
  parcels: number
  parcelCondition: ParcelCondition
  carrierName?: string | null
  trackingNumber?: string | null
  customerDdtNumber?: string | null
  customerDdtDate?: string | null
  note?: string | null
  lines: { lineId: string; quantity: number }[]
}

/** The dock receipt from the office (sales.returns.receive): the answer is the dock's view, so the record is read again. */
export const receiveReturn = (api: ApiClient, rma: Versioned, body: ReceiptBody, idempotencyKey: string) =>
  api.post(`/sales/returns/${seg(rma.id)}/receipts`, { body: { version: rma.version, ...body }, schema: z.object({ receiptId: z.string() }), idempotencyKey })

export interface GradeBody {
  lineId: string
  grade: ReturnGrade
  cause?: ReturnCause | null
  conditionNote?: string | null
}

export const gradeReturn = (api: ApiClient, rma: Versioned, lines: GradeBody[]) =>
  api.post(`/sales/returns/${seg(rma.id)}/grades`, { body: { version: rma.version, lines }, schema: z.object({ return: z.object({ id: z.string() }) }), idempotencyKey: newIdempotencyKey() })

export interface DecisionLine {
  lineId: string
  disposition: ReturnDisposition
  goodsOutcome?: GoodsOutcome | null
  /** Minor units (price grain). */
  creditAmount?: number | null
  toLocationId?: string | null
}

const decisionPreviewSchema = z.object({
  ok: z.boolean(),
  problems: z.array(issue),
  lines: z.array(
    z.object({
      lineId: z.string(),
      seq: z.number(),
      disposition: z.enum(RETURN_DISPOSITIONS),
      goodsOutcome: z.enum(GOODS_OUTCOMES),
      creditAmount: z.number().optional(),
      receivedValue: z.number().nullable().optional(),
      currency: z.string().nullable(),
      place: z.object({ id: z.string(), code: z.string() }).nullable(),
      followUp: z.enum(RETURN_FOLLOW_UPS).nullable(),
      options: z.array(z.object({ disposition: z.enum(RETURN_DISPOSITIONS), outcomes: z.array(z.object({ outcome: z.enum(GOODS_OUTCOMES), held: z.string().nullable() })), defaultCredit: z.number().optional() })),
      problems: z.array(issue),
    }),
  ),
})
export type DecisionPreview = z.infer<typeof decisionPreviewSchema>

export const previewDecisions = (api: ApiClient, rma: Versioned, lines: DecisionLine[], signal?: AbortSignal): Promise<DecisionPreview> =>
  api.post(`/sales/returns/${seg(rma.id)}/decisions/preview`, { body: { version: rma.version, lines }, schema: decisionPreviewSchema, signal })

export const decideReturn = (api: ApiClient, rma: Versioned, lines: DecisionLine[], idempotencyKey: string) =>
  api.post(`/sales/returns/${seg(rma.id)}/decisions`, { body: { version: rma.version, lines }, schema: z.object({ return: returnSchema }), idempotencyKey }).then((answer) => answer.return)

export const makeReplacementOrder = (api: ApiClient, rma: Versioned, body: { promiseDate?: string | null; internalNote?: string | null }, idempotencyKey: string) =>
  api.post(`/sales/returns/${seg(rma.id)}/replacement-order`, { body: { version: rma.version, ...body }, schema: z.object({ return: returnSchema, order: numbered }), idempotencyKey })

// ---- the RMA's credit notes (Finance, B-W2a-61) ---------------------------------------------------------------------------

const creditNotesSchema = z.object({
  creditDecidedAmount: z.number().optional(),
  creditNotedAmount: z.number().optional(),
  creditNotes: z.array(
    z.object({
      id: z.string(),
      number: z.string().nullable(),
      status: z.string(),
      issueDate: z.string().nullable(),
      currency: z.string(),
      netTotal: z.number().optional(),
      grossTotal: z.number().optional(),
      creditOfNumber: z.string().nullable(),
      lines: z.array(z.object({ returnLineId: z.string(), seq: z.number(), quantity: z.string() })),
      refunds: z.array(z.object({ id: z.string(), status: z.string(), amount: z.number().optional() })),
    }),
  ),
  toCredit: z.array(z.object({ creditOfId: z.string(), invoiceNumber: z.string(), currency: z.string(), netTotal: z.number().optional(), lines: z.array(z.object({ returnLineId: z.string(), seq: z.number(), pieces: z.number() })) })),
  notCredited: z.array(z.object({ lineId: z.string(), seq: z.number(), code: z.enum(RETURN_CREDIT_SKIPS) })),
})
export type CreditNotes = z.infer<typeof creditNotesSchema>

export const returnCreditNotes = (api: ApiClient, returnId: string, signal?: AbortSignal): Promise<CreditNotes> => api.get(`/invoicing/returns/${seg(returnId)}/credit-notes`, { schema: creditNotesSchema, signal })

export const makeCreditNotes = (api: ApiClient, returnId: string, idempotencyKey: string) =>
  api.post(`/invoicing/returns/${seg(returnId)}/credit-notes`, { body: {}, schema: z.object({ creditNotes: z.array(z.object({ id: z.string() }).passthrough()) }), idempotencyKey })

// ---- repairs: the list and its tiles ------------------------------------------------------------------------------------

export const repairRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  kind: z.enum(REPAIR_KINDS),
  stage: z.enum(REPAIR_STAGES),
  companyId: z.string(),
  siteId: z.string(),
  siteCode: z.string(),
  party,
  serial: z.string().nullable(),
  style: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  size: z.string().nullable(),
  problem: z.string(),
  source: z.enum(['RETURN', 'COMPLAINT', 'HAND']),
  returnNumber: z.string().nullable(),
  complaintNumber: z.string().nullable(),
  receivedAt: z.string().nullable(),
  repairedAt: z.string().nullable(),
  shippedAt: z.string().nullable(),
  safety: z.enum(SAFETY_STATES),
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string() }).nullable(),
  ownerId: z.string().nullable(),
  createdAt: z.string(),
})
export type RepairRow = z.infer<typeof repairRowSchema>

const repairListSchema = z.object({ repairs: z.array(repairRowSchema), truncated: z.boolean(), people: z.array(person), asOf: z.string() })
export type RepairList = z.infer<typeof repairListSchema>

export interface RepairQuery {
  view?: RepairListView | null
  returnId?: string | null
  partyId?: string | null
  q?: string | null
}

export const listRepairs = (api: ApiClient, query: RepairQuery, signal?: AbortSignal): Promise<RepairList> =>
  api.get('/sales/repairs', { query: clean({ view: query.view, returnId: query.returnId, partyId: query.partyId, q: query.q?.trim() }), schema: repairListSchema, signal })

const repairCountsSchema = z.object({
  counts: z.object({ awaiting: z.number(), received: z.number(), inRepair: z.number(), toCheck: z.number(), toShip: z.number(), open: z.number() }),
  asOf: z.string(),
})
export type RepairCounts = z.infer<typeof repairCountsSchema>['counts']

export const repairCounts = (api: ApiClient, signal?: AbortSignal) => api.get('/sales/repairs/counts', { schema: repairCountsSchema, signal })

// ---- repairs: the record ------------------------------------------------------------------------------------------------

const checklistView = z.object({
  seams: z.string(),
  abrasionZones: z.string(),
  closures: z.string(),
  protectors: z.object({ result: z.string(), replaced: z.boolean(), lot: z.string().nullable(), level: z.string().nullable() }),
  certificateCovers: z.boolean(),
  note: z.string().nullable(),
})

export const repairSchema = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  site: ref,
  party,
  kind: z.enum(REPAIR_KINDS),
  stage: z.enum(REPAIR_STAGES),
  problem: z.string(),
  garment: z.object({
    serial: z.string().nullable(),
    style: z.object({ id: z.string(), code: z.string(), name: z.string(), ppeCategory: z.string() }).nullable(),
    colourway: ref.nullable(),
    size: z.string().nullable(),
    found: z.object({ madeOn: z.string(), workOrderNumber: z.string(), batchNumber: z.string().nullable(), forThisCustomer: z.boolean() }).nullable(),
  }),
  source: z.object({
    returnLine: z.object({ id: z.string(), seq: z.number(), returnId: z.string(), returnNumber: z.string() }).nullable(),
    complaint: z.object({ id: z.string(), number: z.string(), status: z.string() }).nullable(),
  }),
  receivedAt: z.string().nullable(),
  inboundDdt: z.object({ number: z.string(), date: z.string().nullable() }).nullable(),
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string() }).nullable(),
  repairedAt: z.string().nullable(),
  safety: z.object({
    required: z.boolean(),
    state: z.enum(SAFETY_STATES),
    result: z.enum(SAFETY_RESULTS).nullable(),
    checklist: checklistView.nullable(),
    failures: z.array(z.string()),
    checkedAt: z.string().nullable(),
    checkedById: z.string().nullable(),
  }),
  shippedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  ownerId: z.string().nullable(),
  internalNote: z.string().nullable(),
  createdAt: z.string(),
  version: z.number(),
  stages: z.array(z.object({ id: z.string(), from: z.enum(REPAIR_STAGES).nullable(), to: z.enum(REPAIR_STAGES), at: z.string(), note: z.string().nullable(), byId: z.string().nullable() })),
  steps: z.array(z.object({ stage: z.enum(REPAIR_STEPS), state: z.enum(STEP_STATES), at: z.string().nullable() })),
  ddts: z.array(z.object({ id: z.string(), number: z.string(), documentDate: z.string(), reason: z.string(), startAt: z.string(), live: z.boolean() })),
  history: z.array(z.object({ id: z.string(), number: z.string(), kind: z.enum(REPAIR_KINDS), stage: z.enum(REPAIR_STAGES), problem: z.string(), createdAt: z.string() })),
  ncrs: z.array(z.object({ id: z.string(), number: z.string(), stage: z.string() })),
  actions: z.array(z.object({ action: z.enum(REPAIR_ACTIONS), allowed: z.boolean() })),
  people: z.array(person),
})
export type Repair = z.infer<typeof repairSchema>

const oneRepair = z.object({ repair: repairSchema })
const repairWithWarnings = z.object({ repair: repairSchema, warnings: z.array(issue) })

export const getRepair = (api: ApiClient, id: string, signal?: AbortSignal): Promise<Repair> => api.get(`/sales/repairs/${seg(id)}`, { schema: oneRepair, signal }).then((answer) => answer.repair)

// ---- repairs: New repair (preview while typing → create) ---------------------------------------------------------------

export interface NewRepairBody {
  returnLineId?: string
  complaintId?: string
  companyId?: string
  partyId?: string
  kind?: RepairKind
  serial?: string | null
  problem?: string
  ownerId?: string | null
  internalNote?: string | null
  received?: { at?: string; inboundDdtNumber?: string | null; inboundDdtDate?: string | null } | null
}

const repairPreviewSchema = z.object({
  ok: z.boolean(),
  problems: z.array(issue),
  warnings: z.array(issue),
  draft: z
    .object({
      partyId: z.string(),
      kind: z.enum(REPAIR_KINDS),
      stage: z.enum(REPAIR_STAGES),
      serial: z.string().nullable(),
      styleId: z.string().nullable(),
      size: z.string().nullable(),
      problem: z.string(),
      safetyCheckRequired: z.boolean(),
    })
    .nullable(),
  garment: z.object({ madeOn: z.string(), workOrderNumber: z.string(), batchNumber: z.string().nullable(), forThisCustomer: z.boolean() }).nullable(),
  history: z.array(z.object({ id: z.string(), number: z.string(), stage: z.enum(REPAIR_STAGES), createdAt: z.string() })),
})
export type RepairPreview = z.infer<typeof repairPreviewSchema>

export const previewRepair = (api: ApiClient, body: NewRepairBody, signal?: AbortSignal): Promise<RepairPreview> => api.post('/sales/repairs/preview', { body, schema: repairPreviewSchema, signal })

export const createRepair = (api: ApiClient, body: NewRepairBody, idempotencyKey: string) => api.post('/sales/repairs', { body, schema: repairWithWarnings, idempotencyKey })

// ---- repairs: the record's writes ---------------------------------------------------------------------------------------

type RepairVersioned = Pick<Repair, 'id' | 'version'>

export interface RepairPatch {
  kind?: RepairKind
  problem?: string
  ownerId?: string | null
  internalNote?: string | null
  inboundDdtNumber?: string | null
  inboundDdtDate?: string | null
}

export const changeRepair = (api: ApiClient, repair: RepairVersioned, patch: RepairPatch) =>
  api.request('PATCH', `/sales/repairs/${seg(repair.id)}`, { body: { version: repair.version, ...patch }, schema: repairWithWarnings, idempotencyKey: newIdempotencyKey() })

export const receiveRepair = (api: ApiClient, repair: RepairVersioned, body: { inboundDdtNumber?: string | null; inboundDdtDate?: string | null; note?: string | null }, idempotencyKey: string) =>
  api.post(`/sales/repairs/${seg(repair.id)}/receive`, { body: { version: repair.version, ...body }, schema: repairWithWarnings, idempotencyKey })

export const moveRepair = (api: ApiClient, repair: RepairVersioned, to: HandMove, note: string | null, idempotencyKey: string) =>
  api.post(`/sales/repairs/${seg(repair.id)}/stage`, { body: { version: repair.version, to, ...(note ? { note } : {}) }, schema: oneRepair, idempotencyKey }).then((answer) => answer.repair)

export interface ChecklistBody {
  seams: PointResult
  abrasionZones: PointResult
  closures: PointResult
  protectors: { result: PointResult; replaced: boolean; lot?: string | null; level?: string | null }
  certificateCovers: boolean
  note?: string | null
}

export const checkRepair = (api: ApiClient, repair: RepairVersioned, checklist: ChecklistBody, idempotencyKey: string) =>
  api.post(`/sales/repairs/${seg(repair.id)}/safety-check`, { body: { version: repair.version, checklist }, schema: z.object({ repair: repairSchema, result: z.enum(SAFETY_RESULTS) }), idempotencyKey })

export interface DdtBody {
  reason?: DdtReason
  transportBy?: DdtTransportBy
  carrier?: { name: string } | null
  packages?: number
  grossWeightKg?: string
  appearance?: string | null
  freight?: DdtFreight | null
  remarks?: string | null
}

export const shipRepair = (api: ApiClient, repair: RepairVersioned, body: { note?: string | null; ddt?: DdtBody }, idempotencyKey: string) =>
  api.post(`/sales/repairs/${seg(repair.id)}/ship`, {
    body: { version: repair.version, ...body },
    schema: z.object({ repair: repairSchema, ddt: z.object({ id: z.string(), number: z.string() }), warnings: z.array(issue) }),
    idempotencyKey,
  })

export const cancelRepair = (api: ApiClient, repair: RepairVersioned, reason: string) =>
  api.post(`/sales/repairs/${seg(repair.id)}/cancel`, { body: { version: repair.version, reason }, schema: repairWithWarnings, idempotencyKey: newIdempotencyKey() })

// ---- a source's DDT (Shipping, B-W2a-17): the repair's way back, a return of unchanged goods ------------------------------

export type DdtSource = 'RepairOrder' | 'ReturnAuthorisation'

const ddtPreviewSchema = z.object({
  draft: z.object({ lines: z.array(z.object({ seq: z.number(), description: z.string(), quantity: z.string(), uom: z.string() })) }).passthrough(),
  problems: z.array(issue),
  expectedNumber: z.string().nullable(),
  reasons: z.array(z.enum(DDT_REASONS)),
})
export type DdtPreview = z.infer<typeof ddtPreviewSchema>

export const previewSourceDdt = (api: ApiClient, source: DdtSource, record: { id: string; version: number }, body: DdtBody & { lineIds?: string[] }, signal?: AbortSignal): Promise<DdtPreview> =>
  api.post(`/shipping/ddt-sources/${source}/${seg(record.id)}/ddt/preview`, { body: { version: record.version, ...body }, schema: ddtPreviewSchema, signal })

export const issueSourceDdt = (api: ApiClient, source: DdtSource, record: { id: string; version: number }, body: DdtBody & { lineIds?: string[] }, idempotencyKey: string) =>
  api.post(`/shipping/ddt-sources/${source}/${seg(record.id)}/ddt`, { body: { version: record.version, ...body }, schema: z.object({ ddt: z.object({ id: z.string(), number: z.string() }) }), idempotencyKey })

// ---- the repair work order (Production, B-W2a-12) -----------------------------------------------------------------------

const repairOptionsSchema = z.object({
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string() }).nullable(),
  garment: z.object({ orderNumber: z.string().nullable(), lineSeq: z.number().nullable(), size: z.string().nullable(), problems: z.array(z.string()) }),
  revision: z.object({ id: z.string(), revision: z.number(), status: z.string() }).nullable(),
  steps: z.array(z.object({ seq: z.number(), code: z.string(), name: z.string(), standardMinutes: z.string(), available: z.boolean() })),
  blockers: z.array(z.string()),
})
export type RepairOptions = z.infer<typeof repairOptionsSchema>

export const repairWorkOrderOptions = (api: ApiClient, repairOrderId: string, signal?: AbortSignal): Promise<RepairOptions> =>
  api.get('/production/work-orders/repair-options', { query: { repairOrderId }, schema: repairOptionsSchema, signal })

export const makeRepairWorkOrder = (api: ApiClient, repair: RepairVersioned, routingSeqs: number[], idempotencyKey: string) =>
  api.post('/production/work-orders/repairs', {
    body: { repairOrderId: repair.id, version: repair.version, routingSeqs },
    schema: z.object({ workOrder: z.object({ id: z.string(), number: z.string() }) }),
    idempotencyKey,
  }).then((answer) => answer.workOrder)

// ---- pickers: customers, people, the return reasons --------------------------------------------------------------------

const partyOption = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable() })
export type PartyOption = z.infer<typeof partyOption>

/** The customers (and brands) a return or a repair may be for (parties.view). */
export async function listCustomers(api: ApiClient, signal?: AbortSignal): Promise<PartyOption[]> {
  const answer = await api.get('/parties', { query: { role: 'CUSTOMER,BRAND', limit: 200 }, schema: z.object({ parties: z.array(partyOption) }), signal })
  return answer.parties
}

/** The office people (tasks.manage: every office role): who owns an RMA or a repair, by name. */
export async function listPeople(api: ApiClient, signal?: AbortSignal): Promise<Person[]> {
  const answer = await api.get('/tasks/assignees', { schema: z.object({ people: z.array(z.object({ id: z.string(), name: z.string() })) }), signal })
  return answer.people
}

const reasonOption = z.object({ code: z.string(), labelIt: z.string(), labelEn: z.string(), needsDetail: z.boolean() })
export type ReasonOption = z.infer<typeof reasonOption>

/** The active return reasons, in tile order (B-W2a-18: signed in, no permission). */
export async function listReturnReasons(api: ApiClient, signal?: AbortSignal): Promise<ReasonOption[]> {
  const answer = await api.get('/reasons', { query: { list: 'RETURN' }, schema: z.object({ reasons: z.array(reasonOption) }), signal })
  return answer.reasons
}

// ---- photos (the repair's intake: the generic files routes, record type RepairOrder) --------------------------------------

const fileRow = z.object({ id: z.string(), kind: z.string(), originalName: z.string(), status: z.string() })

export async function listRepairPhotos(api: ApiClient, repairId: string, signal?: AbortSignal) {
  const answer = await api.get('/files', { query: { recordType: 'RepairOrder', recordId: repairId }, schema: z.object({ files: z.array(fileRow) }), signal })
  return answer.files.filter((file) => file.kind === 'PHOTO' && file.status === 'AVAILABLE')
}

/** A photo's address for an <img> (a presigned GET; a same-origin path goes through this app's /api). */
export async function photoAddress(api: ApiClient, fileId: string): Promise<string> {
  const answer = await api.get(`/files/${seg(fileId)}/download`, { schema: z.object({ download: z.object({ url: z.string() }) }) })
  const url = answer.download.url
  return url.startsWith('/') && !url.startsWith('//') ? `/api${url}` : url
}

/** One intake photo onto the repair (files.upload): announce, send the bytes, confirm. */
export async function uploadRepairPhoto(api: ApiClient, repair: { id: string; companyId: string }, file: File): Promise<void> {
  const bytes = await file.arrayBuffer()
  const { file: stored, upload } = await requestUpload(api, {
    companyId: repair.companyId,
    record: { type: 'RepairOrder', id: repair.id },
    kind: 'PHOTO',
    name: file.name || 'photo.jpg',
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
