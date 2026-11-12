import { z } from 'zod'
import { STOCK_MOVE_REASONS } from '@nexus/factory-domain/inventory/ledger/moves'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import type { ApiClient } from '../../../../lib/api/client'
import type { AdjustInput, LedgerQuery, StockKey } from '../../../_shared/stock/api'

/**
 * Stock and moves in depth (B-W2b-327 on B-W2b-314's and B-W2b-326's API; SCM-191, SCM-196, SCM-281): "why is it this
 * number" (the balance bridge of one stock figure), the materials below their minimum, the warehouse rules an adjustment
 * meets (the value above which it waits for a yes, who says yes), a posting date checked before it is sent, an adjustment
 * that may wait (202), the adjustments waiting for a yes, and a move between two places of a site. Shapes mirror
 * apps/factory-api modules/inventory/{why,low-stock,posting,ledger}/contract.ts; unknown fields are dropped. Values are
 * the cost grain: absent (or held) without it. The API's English words are never drawn.
 */

type Query = Readonly<Record<string, string | number | boolean | null | undefined>>
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''))

const uom = z.enum(UOMS)
const reason = z.enum(STOCK_MOVE_REASONS)
const named = z.object({ id: z.string(), code: z.string(), name: z.string() })

// ---- why is it this number (GET /inventory/why) -----------------------------------------------------------------------------

const ledgerLink = z.object({ path: z.string(), query: z.record(z.string(), z.string()) })
const whySchema = z.object({
  site: named,
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: uom, tracking: z.enum(['NONE', 'LOT', 'HIDE', 'SERIAL']) }),
  colour: named.nullable(),
  lot: z.object({ id: z.string(), code: z.string() }).nullable(),
  hide: z.object({ id: z.string(), code: z.string() }).nullable(),
  location: named.nullable(),
  uom,
  basis: z.enum(['POSTING', 'ENTRY']),
  period: z.object({ from: z.string().nullable(), to: z.string() }),
  start: z.string(),
  steps: z.array(z.object({ reason, sign: z.string(), in: z.string(), out: z.string(), net: z.string(), moves: z.number(), before: z.string(), after: z.string(), moveId: z.string().nullable(), link: ledgerLink })),
  sum: z.string(),
  end: z.string(),
  addsUp: z.boolean(),
  gap: z.string(),
  onHandNow: z.string(),
  moves: z.number(),
  last: z.array(
    z.object({
      id: z.string(),
      reason,
      occurredAt: z.string(),
      postingDay: z.string(),
      backDated: z.boolean(),
      delta: z.string(),
      document: z.object({ type: z.enum(['GoodsReceipt', 'WorkOrder']), id: z.string(), number: z.string() }).nullable(),
      reference: z.string().nullable(),
    }),
  ),
  allMoves: ledgerLink,
})
export type Why = z.infer<typeof whySchema>
export type WhyStep = Why['steps'][number]
export type WhyMove = Why['last'][number]

/** One stock figure over a period of days (`from` left out: since its first move), by the days the moves count on. */
export const whyFigure = (api: ApiClient, key: StockKey, period: { from?: string | null; to?: string | null; basis?: 'POSTING' | 'ENTRY' } = {}, signal?: AbortSignal) =>
  api.get('/inventory/why', { query: clean({ ...key, from: period.from, to: period.to, basis: period.basis }), schema: whySchema, signal })

// ---- below the minimum (GET /inventory/low-stock) ---------------------------------------------------------------------------

const lowRowSchema = z.object({
  site: named,
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), baseUom: uom }),
  colour: named.nullable(),
  itemPlanningId: z.string(),
  basis: z.string(),
  minimum: z.string(),
  onHand: z.string(),
  onOrder: z.string(),
  reserved: z.string(),
  position: z.string(),
  below: z.boolean(),
  short: z.string(),
})
export type LowRow = z.infer<typeof lowRowSchema>
const lowSchema = z.object({ count: z.number(), rows: z.array(lowRowSchema), more: z.boolean(), alerts: z.object({ on: z.boolean(), source: z.string() }) })
export type LowStock = z.infer<typeof lowSchema>
/** The materials (and colours) of one site below their minimum: the tile's count and its rows. */
export const lowStock = (api: ApiClient, siteId: string, signal?: AbortSignal) => api.get('/inventory/low-stock', { query: { siteId, limit: 500 }, schema: lowSchema, signal })

// ---- the warehouse rules an adjustment meets (GET /inventory/rules, GET /approvals/rules) --------------------------------

const rulesSchema = z.object({
  companyId: z.string().nullable(),
  postingDates: z.object({ inForce: z.object({ days: z.number().nullable() }), today: z.string(), earliest: z.string().nullable() }).loose(),
  adjustmentApproval: z
    .object({
      inForce: z.object({ amount: z.number().nullable().optional(), set: z.boolean() }).loose(),
      currency: z.string().nullable(),
      approvalRules: z.object({ active: z.number() }).loose(),
      /** Held from a reader without the cost grain (the value is absent then). */
      held: z.string().nullable(),
    })
    .loose(),
})
export type WarehouseRules = z.infer<typeof rulesSchema>
export const warehouseRules = (api: ApiClient, companyId: string | null, signal?: AbortSignal) => api.get('/inventory/rules', { query: clean({ companyId }), schema: rulesSchema, signal })

const approvalRuleSchema = z.object({ id: z.string(), kind: z.string(), active: z.boolean(), approver: z.object({ kind: z.enum(['ROLE', 'PERSON']), id: z.string(), name: z.string() }) })
/** Who says yes to an adjustment: the active STOCK_ADJUSTMENT approval rules' approvers (approvals.view). */
export const adjustmentApprovers = async (api: ApiClient, signal?: AbortSignal): Promise<{ kind: 'ROLE' | 'PERSON'; name: string }[]> => {
  const answer = await api.get('/approvals/rules', { query: { kind: 'STOCK_ADJUSTMENT', active: 'true' }, schema: z.object({ rules: z.array(approvalRuleSchema) }), signal })
  const seen = new Set<string>()
  return answer.rules.flatMap((rule) => (rule.active && !seen.has(rule.approver.id) && seen.add(rule.approver.id) ? [{ kind: rule.approver.kind, name: rule.approver.name }] : []))
}

// ---- a posting date checked before the move is sent (GET /inventory/posting/check) -------------------------------------

const postingCheckSchema = z.object({
  day: z.string(),
  today: z.string(),
  earliest: z.string().nullable(),
  backDatingDays: z.object({ days: z.number().nullable() }).loose(),
  allowed: z.boolean(),
  problem: z.string().nullable(),
  periodLock: z.object({ level: z.enum(['SOFT', 'HARD']), periodStart: z.string(), periodEnd: z.string(), needsReason: z.boolean() }).loose().nullable(),
})
export type PostingCheck = z.infer<typeof postingCheckSchema>
export const postingCheck = (api: ApiClient, siteId: string, day: string, signal?: AbortSignal) => api.get('/inventory/posting/check', { query: { siteId, day }, schema: postingCheckSchema, signal })

// ---- an adjustment that may wait for a yes (POST /inventory/adjustments: 201 posted, 202 waiting) ----------------------

const waitingSchema = z.object({
  requestId: z.string(),
  taskId: z.string(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'STALE']),
  requestedAt: z.string(),
  requestedBy: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  approver: z.object({ kind: z.enum(['ROLE', 'PERSON']), id: z.string(), name: z.string().nullable() }),
  dueAt: z.string().nullable(),
  site: named,
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: uom }),
  colour: named.nullable(),
  lot: z.object({ id: z.string(), code: z.string() }).nullable(),
  hide: z.object({ id: z.string(), code: z.string() }).nullable(),
  location: named,
  direction: z.enum(['IN', 'OUT']),
  quantity: z.string(),
  uom,
  baseQuantity: z.string(),
  onHand: z.object({ from: z.string(), to: z.string() }),
  note: z.string(),
  reasonCode: z.string().nullable(),
  postingDate: z.string().nullable(),
  /** The cost grain only (absent without it). */
  value: z.object({ amount: z.string().nullable(), currency: z.string() }).nullable().optional(),
})
export type WaitingAdjustment = z.infer<typeof waitingSchema>

const adjustAnswer = z.union([z.object({ move: z.object({ id: z.string() }).loose() }), z.object({ waiting: waitingSchema })])
export type AdjustAnswer = { posted: true; moveId: string } | { posted: false; waiting: WaitingAdjustment }

export interface DepthAdjustInput extends AdjustInput {
  /** The day it counts on in the books (YYYY-MM-DD); left out: today. */
  postingDate?: string
  /** Why it goes into a soft-locked month. */
  periodLockOverride?: { reason: string }
}

/** inventory.adjust: posted at once (201), or — worth more than the warehouse rules' value with an approval rule on — waiting (202). */
export async function postAdjustmentOrWait(api: ApiClient, body: DepthAdjustInput, idempotencyKey: string): Promise<AdjustAnswer> {
  const answer = await api.post('/inventory/adjustments', { body: Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined && value !== null && value !== '')), schema: adjustAnswer, idempotencyKey })
  return 'waiting' in answer ? { posted: false, waiting: answer.waiting } : { posted: true, moveId: answer.move.id }
}

/** The adjustments waiting for a yes at the sites the person sees (PENDING; newest first). */
export const waitingAdjustments = (api: ApiClient, query: { siteId?: string | null; itemId?: string | null; locationId?: string | null } = {}, signal?: AbortSignal) =>
  api.get('/inventory/adjustments/waiting', { query: clean({ ...query, limit: 50 }), schema: z.object({ rows: z.array(waitingSchema), count: z.number() }), signal })

// ---- a move between two places of a site (W1 POST /inventory/transfers) ----------------------------------------------------

export interface MoveInput {
  siteId: string
  itemId: string
  itemColourId?: string | null
  lotId?: string | null
  hideId?: string | null
  fromLocationId: string
  toLocationId: string
  quantity: string
  note?: string | null
}
/** inventory.transfer: one move from a place to another of the same site (a hide moves whole). */
export const postMove = (api: ApiClient, body: MoveInput, idempotencyKey: string) =>
  api.post('/inventory/transfers', { body: Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined && value !== null && value !== '')), schema: z.object({ move: z.object({ id: z.string() }).loose() }), idempotencyKey })

// ---- the ledger with its posting days (GET /inventory/ledger, B-W2b-314's fields and filters) ----------------------------

const side = z.object({ kind: z.enum(['LOCATION', 'SUPPLIER', 'WORK_ORDER', 'OPENING', 'COUNT', 'ADJUSTMENT', 'SCRAP', 'OUTSIDE']), location: named.nullable() })
const postedRowSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  siteCode: z.string(),
  reason,
  occurredAt: z.string(),
  createdAt: z.string(),
  /** SCM-196: the day it counts on in the books when it was dated apart (null: the day it happened). */
  postingDate: z.string().nullable(),
  /** The day it counts on: its posting date, else the day it happened (Rome). */
  postingDay: z.string(),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: uom, tracking: z.enum(['NONE', 'LOT', 'HIDE', 'SERIAL']) }),
  colour: named.nullable(),
  lot: z.object({ id: z.string(), code: z.string() }).nullable(),
  hide: z.object({ id: z.string(), code: z.string() }).nullable(),
  from: side,
  to: side,
  quantity: z.string(),
  uom,
  baseQuantity: z.string(),
  delta: z.string(),
  document: z.object({ type: z.enum(['GoodsReceipt', 'WorkOrder']), id: z.string(), number: z.string() }).nullable(),
  reference: z.string().nullable(),
  note: z.string().nullable(),
  reversalOfId: z.string().nullable(),
  reversedById: z.string().nullable(),
  postedBy: z.object({ audience: z.enum(['OFFICE', 'FLOOR', 'SYSTEM']), name: z.string().nullable(), device: z.object({ id: z.string(), name: z.string() }).nullable() }),
  valuation: z.object({ method: z.string(), quantity: z.string(), unitCost: z.string().optional(), valueAmount: z.number().optional(), currency: z.string() }).nullable().optional(),
  writeOff: z.object({ id: z.string(), reasonCode: z.string(), note: z.string().nullable() }).nullable().optional(),
})
const postedLedgerSchema = z.object({ moves: z.array(postedRowSchema), nextCursor: z.string().nullable(), closing: z.string().nullable(), rowCount: z.number().nullable().optional() })
export type PostedLedgerRow = z.infer<typeof postedRowSchema>

export interface PostedLedgerQuery extends LedgerQuery {
  /** SCM-196: the days the moves count on in the books, from … to included (YYYY-MM-DD). */
  postedFrom?: string | null
  postedTo?: string | null
  /** Only the moves dated apart from the day they happened (true), or none of them (false). */
  backDated?: boolean | null
}

/** The Movements grid's ledger with each move's posting day, and the posting-day filters. */
export const readPostedLedger = (api: ApiClient, query: PostedLedgerQuery, signal?: AbortSignal) =>
  api.get('/inventory/ledger', {
    query: clean({
      siteId: query.siteId,
      itemId: query.itemId,
      itemColourId: query.itemColourId,
      lotId: query.lotId,
      hideId: query.hideId,
      locationId: query.locationId,
      reasons: query.reasons && query.reasons.length > 0 ? query.reasons.join(',') : undefined,
      createdById: query.createdById,
      deviceId: query.deviceId,
      documentId: query.documentId,
      hasNote: query.hasNote === null || query.hasNote === undefined ? undefined : String(query.hasNote),
      reversed: query.reversed === null || query.reversed === undefined ? undefined : String(query.reversed),
      from: query.from,
      to: query.to,
      postedFrom: query.postedFrom,
      postedTo: query.postedTo,
      backDated: query.backDated === null || query.backDated === undefined ? undefined : String(query.backDated),
      cursor: query.cursor,
      limit: query.limit,
      q: query.q?.trim() || undefined,
      writeOffs: query.writeOffs === null || query.writeOffs === undefined ? undefined : String(query.writeOffs),
    }),
    schema: postedLedgerSchema,
    signal,
  })
