import { z } from 'zod'
import { BRIDGE_STEPS } from '@nexus/factory-domain/planning/explain'
import { DECISIONS, RUN_STATUSES, SET_ASIDE_REASONS } from '@nexus/factory-domain/planning/decisions'
import { REQUIREMENT_ACTIONS, WARNING_CODES } from '@nexus/factory-domain/planning/explode'
import { CR_VI_STATUSES, NOT_COUNTED_REASONS } from '@nexus/factory-domain/planning/usable'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'

/**
 * Every call of What to buy & make (SCR-055), with the answer's shape checked (zod; unknown fields are dropped, so a new
 * API field never breaks the page). The shapes mirror apps/factory-api modules/planning/contract.ts and purchasing's
 * from-plan; the enum lists are factory-domain's own. The API's English (`why`, the sentence, warning messages, stock
 * words) is never drawn: the screen says its own words from the numbers and codes. Money only with the cost grain
 * (`unitCost`, `expectedAmount` are absent without it).
 */

const uom = z.enum(UOMS)
export type Uom = z.infer<typeof uom>
const named = z.object({ id: z.string(), code: z.string(), name: z.string() })

const runSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  trigger: z.enum(['MANUAL', 'ORDER', 'SCHEDULED']),
  status: z.enum(RUN_STATUSES),
  orderLines: z.number(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  note: z.string().nullable(),
  warnings: z.array(z.object({ code: z.enum(WARNING_CODES), orderId: z.string().optional(), orderLineId: z.string().optional(), itemId: z.string().optional(), size: z.string().optional() })),
  createdById: z.string().nullable(),
  requirements: z.number(),
  short: z.number(),
  version: z.number(),
})
export type PlanRun = z.infer<typeof runSchema>

const sourceSchema = z.object({
  orderId: z.string(),
  orderNumber: z.string(),
  orderLineId: z.string(),
  lineSeq: z.number(),
  size: z.string(),
  pieces: z.number(),
  made: z.number(),
  quantity: z.string(),
  issued: z.string(),
  dueDate: z.string().nullable(),
  workOrders: z.array(z.string()),
})

export const lineSchema = z.object({
  id: z.string(),
  runId: z.string(),
  seq: z.number(),
  version: z.number(),
  action: z.enum(REQUIREMENT_ACTIONS),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), baseUom: uom, purchaseUom: uom, requiresCrViTest: z.boolean() }),
  colour: named.nullable(),
  uom,
  grossQuantity: z.string(),
  usableStock: z.string(),
  heldStock: z.string(),
  onOrder: z.string(),
  netQuantity: z.string(),
  suggestedQuantity: z.string(),
  suggestedUom: uom,
  suggestedBaseQuantity: z.string(),
  estimatedHides: z.number().nullable(),
  needDate: z.string(),
  orderBy: z.object({ date: z.string(), leadTimeDays: z.number().nullable(), passed: z.boolean() }).nullable(),
  supplier: named.nullable(),
  orders: z.array(z.object({ id: z.string(), number: z.string() })),
  sources: z.array(sourceSchema),
  decision: z.enum(DECISIONS),
  decisionReason: z.enum(SET_ASIDE_REASONS).nullable(),
  decisionNote: z.string().nullable(),
  purchaseOrderLineId: z.string().nullable(),
  purchaseOrder: z.object({ id: z.string(), number: z.string(), status: z.enum(PURCHASE_ORDER_STATUSES) }).nullable(),
  decidedAt: z.string().nullable(),
  unitCost: z.string().nullable().optional(),
  expectedAmount: z.number().nullable().optional(),
  currency: z.string(),
})
export type PlanLine = z.infer<typeof lineSchema>

const summarySchema = z.object({
  toBuy: z.number(),
  orderByPassed: z.number(),
  toMake: z.number(),
  inDraftPurchaseOrder: z.number(),
  ordered: z.number(),
  setAside: z.number(),
  shortWithHeldStock: z.number(),
})
export type PlanSummary = z.infer<typeof summarySchema>

const planSchema = z.object({ run: runSchema.nullable(), latestAttempt: runSchema.nullable(), summary: summarySchema, lines: z.array(lineSchema) })
export type Plan = z.infer<typeof planSchema>

export function getLatestPlan(api: ApiClient, siteId: string, signal?: AbortSignal): Promise<Plan> {
  return api.get('/planning/runs/latest', { query: { siteId }, schema: planSchema, signal })
}

export async function runPlan(api: ApiClient, siteId: string): Promise<PlanRun> {
  return (await api.post('/planning/runs', { body: { siteId }, schema: z.object({ run: runSchema, replayed: z.boolean() }), idempotencyKey: newIdempotencyKey() })).run
}

export async function listRuns(api: ApiClient, siteId: string, signal?: AbortSignal): Promise<PlanRun[]> {
  return (await api.get('/planning/runs', { query: { siteId, limit: 30 }, schema: z.object({ runs: z.array(runSchema) }), signal })).runs
}

const stockLineSchema = z.object({
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: uom }),
  colour: named.nullable(),
  lot: z
    .object({
      id: z.string(),
      code: z.string(),
      qualityStatus: z.enum(['QUARANTINE', 'RELEASED', 'REJECTED', 'BLOCKED']),
      crViStatus: z.enum(CR_VI_STATUSES),
      qualityNote: z.string().nullable(),
      receivedAt: z.string().nullable(),
      qualityDecidedAt: z.string().nullable(),
    })
    .nullable(),
  quantity: z.string(),
  hides: z.number(),
  reason: z.enum(NOT_COUNTED_REASONS).nullable(),
  held: z.boolean(),
})
export type StockLine = z.infer<typeof stockLineSchema>

const explainSchema = z.object({
  run: runSchema,
  line: lineSchema,
  bridge: z.array(z.object({ step: z.enum(BRIDGE_STEPS), quantity: z.string(), uom })),
  rounding: z.array(z.object({ rule: z.enum(['WHOLE_UNITS', 'MINIMUM', 'MULTIPLE']), quantity: z.string() })),
  now: z.object({
    usableStock: z.string(),
    heldStock: z.string(),
    onOrder: z.string(),
    netQuantity: z.string(),
    changedSinceRun: z.boolean(),
    stock: z.array(stockLineSchema),
    purchases: z.array(
      z.object({
        purchaseOrderId: z.string(),
        purchaseOrderNumber: z.string(),
        purchaseOrderStatus: z.string(),
        purchaseOrderLineId: z.string(),
        seq: z.number(),
        openQuantity: z.string(),
        dueDate: z.string(),
        confirmed: z.boolean(),
        counted: z.string(),
        notCounted: z.string(),
        why: z.enum(['TOO_LATE', 'NOT_NEEDED']).nullable(),
      }),
    ),
  }),
})
export type Explain = z.infer<typeof explainSchema>

export function explainLine(api: ApiClient, id: string, signal?: AbortSignal): Promise<Explain> {
  return api.get(`/planning/requirements/${encodeURIComponent(id)}`, { schema: explainSchema, signal })
}

export async function unusableStock(api: ApiClient, siteId: string, signal?: AbortSignal): Promise<StockLine[]> {
  return (await api.get('/planning/unusable-stock', { query: { siteId }, schema: z.object({ lines: z.array(stockLineSchema) }), signal })).lines
}

export type SetAsideReason = (typeof SET_ASIDE_REASONS)[number]
export const SET_ASIDE = SET_ASIDE_REASONS

const decidedSchema = z.object({ runId: z.string(), decision: z.enum(DECISIONS), lines: z.array(z.object({ id: z.string(), version: z.number() })) })

export function setAside(api: ApiClient, lines: readonly { id: string; version: number }[], reason: SetAsideReason, note: string | null) {
  return api.post('/planning/requirements/set-aside', { body: { lines, reason, ...(note?.trim() ? { note: note.trim() } : {}) }, schema: decidedSchema, idempotencyKey: newIdempotencyKey() })
}

export function reopen(api: ApiClient, lines: readonly { id: string; version: number }[]) {
  return api.post('/planning/requirements/reopen', { body: { lines }, schema: decidedSchema, idempotencyKey: newIdempotencyKey() })
}

// ---- Draft PO (purchasing's from-plan) -------------------------------------------------------------------------------------

const draftedSchema = z.object({
  orders: z.array(z.object({ id: z.string(), number: z.string(), created: z.boolean(), lineIds: z.array(z.string()), lineCount: z.number() })),
  lines: z.array(z.object({ requirementId: z.string(), purchaseOrderId: z.string(), purchaseOrderLineId: z.string() })),
})
export type Drafted = z.infer<typeof draftedSchema>

export interface DraftBody {
  lines: { id: string; version: number; supplierId?: string }[]
  into?: { supplierId: string; purchaseOrderId: string | null }[]
}

export function draftFromPlan(api: ApiClient, body: DraftBody): Promise<Drafted> {
  return api.post('/purchasing/from-plan', { body, schema: draftedSchema, idempotencyKey: newIdempotencyKey() })
}

export function undoDraft(api: ApiClient, purchaseOrderLineIds: readonly string[], cancelOrderIds: readonly string[]) {
  return api.post('/purchasing/from-plan/undo', {
    body: { lines: purchaseOrderLineIds, ...(cancelOrderIds.length > 0 ? { cancelOrderIds } : {}) },
    schema: z.object({ orders: z.array(z.object({ id: z.string(), number: z.string(), lineCount: z.number(), cancelled: z.boolean() })), reopenedRequirementIds: z.array(z.string()) }),
    idempotencyKey: newIdempotencyKey(),
  })
}

const draftRowSchema = z.object({ id: z.string(), number: z.string(), partyId: z.string(), supplierName: z.string(), lineCount: z.number(), siteId: z.string(), currency: z.string() })
export type OpenDraft = z.infer<typeof draftRowSchema>

/** The open drafts at the site (a supplier's newest one takes the plan's lines unless the person asks for a new one). */
export async function openDrafts(api: ApiClient, siteId: string, signal?: AbortSignal): Promise<OpenDraft[]> {
  return (await api.get('/purchasing/orders', { query: { status: 'DRAFT', siteId, limit: 200 }, schema: z.object({ orders: z.array(draftRowSchema) }), signal })).orders
}
