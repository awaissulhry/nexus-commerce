import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { workOrderSchema, type WorkOrder } from '../../_shared/api'
import { DOCUMENT_TYPES, WAITING_CODES } from '../../../finance/costing/api'

/**
 * B-W2b-424 — the work order close on screen (design production.workorders pop:wo-close; MES-012, MES-013) on B-W2b-411's
 * API: GET /production/work-orders/:id/close-check (workorders.view: what the dialog shows), POST …/close (workorders.manage;
 * a reason code exactly when a figure is beyond the tolerance), POST …/close/undo (the closer, within the API's 60 s), POST
 * …/reopen (workorders.reopen and a reason). The answers are checked with zod (unknown fields dropped). The enum lists mirror
 * factory-domain costing/close and costing/variances (close.vitest.test.ts holds them equal). Material cost, unit costs and
 * every amount are the cost grain in minor units: the API drops them for a person without money.cost, so each is optional
 * (absent, never zero) and the screen draws no amount then. The API's English words are never drawn: the screen says its
 * own from the codes. The office user who closed, undid or reopened is named inside the one record only.
 */

export const CLOSE_REASONS = ['SHORT_PRODUCED', 'OVER_PRODUCED', 'LEATHER_YIELD', 'MATERIAL_PRICE', 'SCRAP_ABOVE_ALLOWANCE', 'REWORK', 'METHOD_CHANGED', 'STANDARD_OUT_OF_DATE', 'NO_STANDARD', 'OTHER'] as const
export type CloseReason = (typeof CLOSE_REASONS)[number]
export const CLOSE_REFUSALS = ['NOT_COMPLETED', 'REASON_NEEDED', 'REASON_NOT_NEEDED', 'NOTE_NEEDED', 'COSTS_WAITING', 'LOCKED', 'NOT_CLOSED', 'NO_CLOSE_RECORD', 'UNDO_TOO_LATE', 'NOT_THE_CLOSER', 'DATABASE'] as const
export const VARIANCE_CATEGORIES = ['MATERIAL_PRICE', 'MATERIAL_USAGE', 'LABOUR_EFFICIENCY', 'LABOUR_RATE', 'SCRAP', 'REWORK', 'SUBCONTRACT_PRICE', 'LOT_SIZE', 'OVERHEAD'] as const
export const NOT_SPLIT_CODES = ['NOT_ON_LEDGER', 'NO_SET_UP', 'NO_BASIS'] as const

/** A cost-grain figure: absent for a person without money.cost. */
const cost = <T extends z.ZodTypeAny>(schema: T) => schema.optional()

const figuresSchema = z.object({
  plannedQuantity: z.number(),
  actualQuantity: z.number(),
  plannedScrapQuantity: z.number(),
  scrapQuantity: z.number(),
  plannedMaterialCost: cost(z.number()),
  actualMaterialCost: cost(z.number()),
  plannedMinutes: z.string(),
  actualMinutes: z.string(),
  currency: z.string(),
})
export type CloseFigures = z.infer<typeof figuresSchema>

const beyondSchema = z.object({ quantity: z.boolean(), material: z.boolean(), minutes: z.boolean(), scrap: z.boolean(), any: z.boolean() })

const itemRef = z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: z.string() })
const person = z.object({ id: z.string(), name: z.string() })

export const varianceLineSchema = z.object({
  id: z.string().nullable(),
  category: z.enum(VARIANCE_CATEGORIES),
  item: itemRef.nullable(),
  standardQuantity: z.string().nullable(),
  actualQuantity: z.string().nullable(),
  standardUnitCost: cost(z.string().nullable()),
  actualUnitCost: cost(z.string().nullable()),
  amount: cost(z.number()),
  note: z.string().nullable(),
})
export type VarianceLine = z.infer<typeof varianceLineSchema>

const splitSchema = z.object({
  basis: z.enum(['STANDARD', 'ESTIMATE']).nullable(),
  lines: z.array(varianceLineSchema),
  balance: cost(z.number()),
  explained: cost(z.number()),
  closing: cost(z.number()),
  notSplit: z.array(z.object({ category: z.enum(VARIANCE_CATEGORIES).nullable(), code: z.enum(NOT_SPLIT_CODES) })),
})
export type Split = z.infer<typeof splitSchema>

export const closeRecordSchema = z.object({
  id: z.string(),
  workOrderId: z.string(),
  figures: figuresSchema,
  tolerancePct: z.string(),
  beyond: beyondSchema,
  reasonCode: z.string().nullable(),
  reasonNote: z.string().nullable(),
  closedAt: z.string(),
  closedBy: person,
  undoneAt: z.string().nullable(),
  undoneBy: person.nullable(),
  reopenReason: z.string().nullable(),
  live: z.boolean(),
  settled: z.boolean(),
  undoUntil: z.string().nullable(),
  can: z.object({ undo: z.boolean(), reopen: z.boolean() }),
})
export type CloseRecord = z.infer<typeof closeRecordSchema>

const waitingSchema = z.object({ code: z.enum(WAITING_CODES), sourceType: z.enum(DOCUMENT_TYPES), sourceId: z.string() })

const closeCheckSchema = z.object({
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string(), version: z.number(), companyId: z.string(), siteId: z.string() }),
  closable: z.boolean(),
  refusal: z.object({ code: z.enum(CLOSE_REFUSALS) }).nullable(),
  figures: figuresSchema,
  tolerancePct: z.string(),
  beyond: beyondSchema,
  reasonNeeded: z.boolean(),
  reasons: z.array(z.object({ code: z.enum(CLOSE_REASONS), noteNeeded: z.boolean() })),
  settles: z.boolean(),
  /** The API's words while the company's figures for the accountant are off (the screen says its own); null while on. */
  waits: z.string().nullable(),
  toPost: z.number(),
  waiting: z.array(waitingSchema),
  split: splitSchema.nullable(),
  undoSeconds: z.number(),
  live: closeRecordSchema.nullable(),
})
export type CloseCheck = z.infer<typeof closeCheckSchema>

const closeAnswerSchema = z.object({ workOrder: workOrderSchema, close: closeRecordSchema, split: splitSchema.nullable(), waits: z.string().nullable() })
export type CloseAnswer = z.infer<typeof closeAnswerSchema>
const takenBackSchema = z.object({ workOrder: workOrderSchema, close: closeRecordSchema })
export type TakenBack = { workOrder: WorkOrder; close: CloseRecord }

const path = (workOrderId: string, tail: string) => `/production/work-orders/${encodeURIComponent(workOrderId)}/${tail}`

/** GET …/close-check: planned against actual, the tolerance, which figures are beyond it, the reasons, what the close settles. */
export const getCloseCheck = (api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<CloseCheck> => api.get(path(workOrderId, 'close-check'), { schema: closeCheckSchema, signal })

export interface CloseInput {
  readonly version: number
  readonly reasonCode: CloseReason | null
  readonly reasonNote: string | null
}

/** POST …/close: the reason code only when the check asks for one; one Idempotency-Key per attempt. */
export function closeWorkOrder(api: ApiClient, workOrderId: string, input: CloseInput, idempotencyKey: string = newIdempotencyKey()): Promise<CloseAnswer> {
  const body = { version: input.version, ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}), ...(input.reasonNote?.trim() ? { reasonNote: input.reasonNote.trim() } : {}) }
  return api.post(path(workOrderId, 'close'), { body, schema: closeAnswerSchema, idempotencyKey })
}

/** POST …/close/undo: the person who closed it, within the API's limit, without a reason. */
export const undoClose = (api: ApiClient, workOrderId: string, version: number, idempotencyKey: string = newIdempotencyKey()): Promise<TakenBack> =>
  api.post(path(workOrderId, 'close/undo'), { body: { version }, schema: takenBackSchema, idempotencyKey })

/** POST …/reopen: workorders.reopen and a reason (3 to 1,000 characters). */
export const reopenWorkOrder = (api: ApiClient, workOrderId: string, input: { version: number; reason: string }, idempotencyKey: string = newIdempotencyKey()): Promise<TakenBack> =>
  api.post(path(workOrderId, 'reopen'), { body: { version: input.version, reason: input.reason.trim() }, schema: takenBackSchema, idempotencyKey })
