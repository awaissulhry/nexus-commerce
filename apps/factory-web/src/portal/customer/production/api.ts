import { z } from 'zod'
import { BRAND_HEALTHS, HEALTH_REASON_CODES } from '@nexus/factory-domain/production-brand/health'
import { PRODUCTION_SHARE_LEVELS } from '@nexus/factory-domain/production-brand/levels'
import { APPROVAL_STATES, BRAND_GATE_KINDS, BRAND_GATE_STATES, BRAND_HOLD_READS } from '@nexus/factory-domain/production-brand/portal-read'
import { BRAND_STAGES } from '@nexus/factory-domain/production-brand/stages'
import { BRAND_URGENCIES, URGENCY_BATCH_MAX, URGENCY_OUTCOMES } from '@nexus/factory-domain/production-brand/urgency'
import { BRAND_SIDES } from '@nexus/factory-domain/production-brand/waiting'
import { PROMISE_REASON_CODES } from '@nexus/factory-domain/sales/portal-orders/promise'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { fileNameOf } from '../orders/api'

/**
 * F-PR-11 / F-PR-12a — every call of the customer's own production (production plan §4, §5; the API is B-PR-18 and B-PR-22a,
 * apps/factory-api modules/production/brand-portal), each answer checked against the API's contracts:
 *
 *   GET  /portal/production[?chip&q]            My production: its orders in production in ITS order (Urgent by its own
 *                                               order, then Regular by the day sent), the chips with counts, "2 of 3 urgent
 *                                               used" (its own open orders only), every row (no page, no cut)
 *   GET  /portal/production?format=csv          "Export": the same rows as a file the server writes in its own scope
 *   GET  /portal/production/:orderId            one order's production (order › Status & progress), by its level
 *   POST /portal/production/urgency             Mark urgent / Mark regular (one or many of its own orders)
 *   PUT  /portal/production/urgent-order        its Urgent list in a new order (the Urgent order dialog)
 *   POST /portal/production/urgency/undo        puts one of its own batches back
 *
 * No money, no person of ours, no note, no queue place, no line, no work order and no other customer ever comes in these
 * answers (the API's wall, PW-15); the web reads only what it uses, so a field the API adds never breaks the page. A section
 * the customer's level does not share is null: it is not drawn. Days are calendar days (`YYYY-MM-DD`), times UTC instants.
 * Every write carries an Idempotency-Key.
 */

export { BRAND_STAGES, BRAND_URGENCIES, URGENCY_BATCH_MAX, URGENCY_OUTCOMES }
export type BrandStageCode = (typeof BRAND_STAGES)[number]
export type BrandUrgencyCode = (typeof BRAND_URGENCIES)[number]
export type UrgencyOutcome = (typeof URGENCY_OUTCOMES)[number]

/** The chips of My production (the API's PRODUCTION_CHIPS; URGENT only while the customer's urgency is on). */
export const PRODUCTION_CHIPS = ['ALL', 'URGENT', 'WAITING_ON_YOU', 'AT_RISK', 'LATE', 'ON_HOLD', 'READY'] as const
export type ProductionChip = (typeof PRODUCTION_CHIPS)[number]
export const isProductionChip = (value: unknown): value is ProductionChip => typeof value === 'string' && (PRODUCTION_CHIPS as readonly string[]).includes(value)

const words = z.object({ it: z.string(), en: z.string() })
export type Words = z.infer<typeof words>
const live = z.object({ events: z.array(z.string()) })
/** The customer's own running number of the order ("Your order 12"); the office's series is never drawn (B-TH-303). */
const yourNumber = z.object({ seq: z.number(), words }).nullable()
const named = z.object({ code: z.string(), name: z.string() })

const stage = z.object({
  code: z.enum(BRAND_STAGES),
  words,
  since: z.string().nullable(),
  next: z.object({ code: z.enum(BRAND_STAGES), words }).nullable(),
})

const health = z.object({
  code: z.enum(BRAND_HEALTHS),
  words,
  /** A person's raise to At risk: its curated reason code (never the office's note). */
  reason: z.object({ code: z.enum(HEALTH_REASON_CODES), words }).nullable(),
})
export type ProductionHealth = z.infer<typeof health>

const waiting = z.object({ code: z.enum(BRAND_SIDES), words, since: z.string().nullable() })
export type ProductionWaiting = z.infer<typeof waiting>

const urgency = z.object({
  code: z.enum(BRAND_URGENCIES),
  words,
  /** Its place in the customer's OWN urgent list (1 first); never a place in our plan. */
  urgentRank: z.number().nullable(),
  asked: z.boolean(),
  askedWords: words.nullable(),
  byUs: z.boolean(),
  byUsWords: words.nullable(),
  locked: z.boolean(),
  lockWords: words.nullable(),
})
export type Urgency = z.infer<typeof urgency>

const urgentUse = z.object({ used: z.number(), max: z.number(), agreed: z.number(), left: z.number(), over: z.boolean(), words })
export type UrgentUse = z.infer<typeof urgentUse>

const marks = z.object({ onHold: z.boolean(), paused: z.boolean(), partlyShipped: z.boolean(), changePending: z.boolean(), words: z.array(words) })
export type ProductionStage = z.infer<typeof stage>

const next = z.object({
  kind: z.enum(['STAGE', 'GATE']),
  stage: z.enum(BRAND_STAGES).nullable(),
  gate: z.enum(BRAND_GATE_KINDS).nullable(),
  date: z.string().nullable(),
  words,
})

const count = z.object({ done: z.number(), of: z.number(), words })

export const productionRowSchema = z.object({
  id: z.string(),
  customerRef: z.string().nullable(),
  /** The office's own number: read, never drawn (B-TH-303). */
  number: z.string(),
  yourNumber,
  orderedOn: z.string(),
  styles: z.array(named),
  pieces: z.number(),
  promiseDate: z.string().nullable(),
  originalPromiseDate: z.string().nullable(),
  promiseMoved: z.boolean(),
  stage: stage.nullable(),
  health: health.nullable(),
  waiting,
  marks,
  urgency: urgency.nullable(),
  next: next.nullable(),
  count: count.nullable(),
})
export type ProductionRow = z.infer<typeof productionRowSchema>

const levelFields = {
  level: z.enum(PRODUCTION_SHARE_LEVELS),
  levelWords: words,
  progressShared: z.boolean(),
  urgencyOn: z.boolean(),
  urgentUse: urgentUse.nullable(),
}

export const productionListSchema = z.object({
  asOf: z.string(),
  ...levelFields,
  chip: z.enum(PRODUCTION_CHIPS),
  chips: z.array(z.object({ chip: z.enum(PRODUCTION_CHIPS), count: z.number(), words })),
  count: z.number(),
  items: z.array(productionRowSchema),
  live,
})
export type ProductionList = z.infer<typeof productionListSchema>

export const fetchProduction = (api: ApiClient, query: { chip?: ProductionChip | null; q?: string | null }, signal?: AbortSignal): Promise<ProductionList> =>
  api.get('/portal/production', { query: { chip: query.chip ?? undefined, q: query.q?.trim() ? query.q.trim() : undefined }, schema: productionListSchema, signal })

/** "Export": every own row of the chip and search, as the server writes it (its scope, the person's language). */
export async function downloadProduction(api: ApiClient, query: { chip: ProductionChip | null; q: string | null; locale: 'it' | 'en' }): Promise<{ bytes: Uint8Array; fileName: string | null; contentType: string }> {
  let disposition: string | null = null
  let contentType = 'text/csv;charset=utf-8'
  const bytes = await api.bytes('/portal/production', {
    query: { chip: query.chip ?? undefined, q: query.q?.trim() ? query.q.trim() : undefined, format: 'csv', locale: query.locale },
    onHeaders: (headers) => {
      disposition = headers.get('content-disposition')
      contentType = headers.get('content-type') ?? contentType
    },
  })
  return { bytes, fileName: fileNameOf(disposition), contentType }
}

// ── one order's production (F-PR-12a: order › Status & progress) ─────────────────────────────────────────────────────────
const stageFigures = { ordered: z.number(), cut: z.number().nullable(), sewn: z.number().nullable(), inspected: z.number().nullable(), packed: z.number().nullable() }

// ---- F-PR-12b: the sections of + Progress (per line and size) and + Gates & dates (real gates, swatch answers, the published
// plan's days), as B-PR-18's order read writes them (modules/production/brand-portal/contract.ts `progress`, `gates`).
export { APPROVAL_STATES, BRAND_GATE_KINDS, BRAND_GATE_STATES }
export type BrandGateKind = (typeof BRAND_GATE_KINDS)[number]
export type BrandGateState = (typeof BRAND_GATE_STATES)[number]
export type ApprovalState = (typeof APPROVAL_STATES)[number]

const progressLine = z.object({
  lineId: z.string(),
  seq: z.number(),
  style: named.nullable(),
  colourway: named.nullable(),
  ...stageFigures,
  /** Its sizes in the scale's order; a size-less piece (made to measure) has no size. */
  sizes: z.array(z.object({ size: z.string().nullable(), ...stageFigures })),
})
export type ProductionProgressLine = z.infer<typeof progressLine>

const gatesSection = z.object({
  /** Its real gates (PP sample, size set, sample, leather, trims, lab), in reading order; never one of the office's own. */
  gates: z.array(z.object({ kind: z.enum(BRAND_GATE_KINDS), words, state: z.enum(BRAND_GATE_STATES), targetDate: z.string().nullable(), doneOn: z.string().nullable() })),
  /** Its swatch answers (colour, leather, fabric, trims): approvals, not gates. */
  approvals: z.array(z.object({ kind: z.string(), words, state: z.enum(APPROVAL_STATES), sentOn: z.string().nullable(), answeredOn: z.string().nullable() })),
  /** Its own work's days in the PUBLISHED plan only (never the working plan, a line or a load). */
  planned: z.object({ cutStart: z.string().nullable(), sewStart: z.string().nullable(), finish: z.string().nullable() }),
})
export type ProductionGates = z.infer<typeof gatesSection>
// ---- end F-PR-12b

export const productionOrderSchema = z.object({
  asOf: z.string(),
  ...levelFields,
  order: z.object({
    id: z.string(),
    customerRef: z.string().nullable(),
    number: z.string(),
    yourNumber,
    orderedOn: z.string(),
    promiseDate: z.string().nullable(),
    originalPromiseDate: z.string().nullable(),
    promiseMoved: z.boolean(),
  }),
  inProduction: z.boolean(),
  stage: stage
    .extend({
      ahead: z.number(),
      aheadWords: words.nullable(),
      sewingNotCounted: z.boolean(),
      sewingNotCountedWords: words.nullable(),
    })
    .nullable(),
  health: health.nullable(),
  waiting,
  marks,
  holds: z.array(z.object({ kind: z.enum(BRAND_HOLD_READS), since: z.string(), words })),
  urgency: urgency.nullable(),
  promiseHistory: z.array(z.object({ on: z.string(), from: z.string().nullable(), to: z.string(), lines: z.array(z.number()), reason: z.object({ code: z.enum(PROMISE_REASON_CODES), words }) })),
  /** + Progress: the pieces of its own cells (F-PR-12a writes the stage's count in the "In production" note; F-PR-12b draws them). */
  progress: z
    .object({
      asOf: z.string(),
      refreshSeconds: z.number(),
      lines: z.array(progressLine), // F-PR-12b: per line and size
      whole: z.object(stageFigures),
      percent: z.number().nullable(),
    })
    .nullable(),
  /** + Gates & dates (F-PR-12b); null or absent: its level does not share them (not drawn). The states are drawn in the web's words. */
  gates: gatesSection.nullable().optional(),
  live,
})
export type ProductionOrder = z.infer<typeof productionOrderSchema>

export const fetchProductionOrder = (api: ApiClient, orderId: string, signal?: AbortSignal): Promise<ProductionOrder> =>
  api.get(`/portal/production/${encodeURIComponent(orderId)}`, { schema: productionOrderSchema, signal })

// ── the customer's urgency (B-PR-22a) ────────────────────────────────────────────────────────────────────────────────
export const urgencyResultSchema = z.object({
  orderId: z.string(),
  number: z.string(),
  customerRef: z.string().nullable(),
  outcome: z.enum(URGENCY_OUTCOMES),
  done: z.boolean(),
  words: words.nullable(),
  ask: words.nullable(),
  urgency: z.enum(BRAND_URGENCIES).nullable(),
  urgentRank: z.number().nullable(),
})
export type UrgencyResult = z.infer<typeof urgencyResultSchema>

export const urgencyAnswerSchema = z.object({
  /** The batch this command made: Undo sends it back. */
  batchId: z.string().nullable(),
  results: z.array(urgencyResultSchema),
  /** Ids named that are not its own orders: counted, never named. */
  notFound: z.number(),
  use: urgentUse.nullable(),
  replayed: z.boolean(),
})
export type UrgencyAnswer = z.infer<typeof urgencyAnswerSchema>

export const undoAnswerSchema = urgencyAnswerSchema.extend({
  undone: z.string(),
  skipped: z.array(z.object({ orderId: z.string(), number: z.string(), customerRef: z.string().nullable(), words })),
})
export type UndoAnswer = z.infer<typeof undoAnswerSchema>

/** Mark urgent / Mark regular (1 to 50 of its own orders, each once). */
export const markUrgency = (api: ApiClient, body: { orderIds: readonly string[]; urgency: BrandUrgencyCode }, idempotencyKey: string = newIdempotencyKey()): Promise<UrgencyAnswer> =>
  api.post('/portal/production/urgency', { body, schema: urgencyAnswerSchema, idempotencyKey })

/** Its WHOLE Urgent list in the new order, with the list's `asOf` as read (a change after it is named in the refusal). */
export const saveUrgentOrder = (api: ApiClient, body: { orderIds: readonly string[]; asOf: string | null }, idempotencyKey: string = newIdempotencyKey()): Promise<UrgencyAnswer> =>
  api.request('PUT', '/portal/production/urgent-order', { body: body.asOf ? body : { orderIds: body.orderIds }, schema: urgencyAnswerSchema, idempotencyKey })

export const undoUrgency = (api: ApiClient, batchId: string, idempotencyKey: string = newIdempotencyKey()): Promise<UndoAnswer> =>
  api.post('/portal/production/urgency/undo', { body: { batchId }, schema: undoAnswerSchema, idempotencyKey })
