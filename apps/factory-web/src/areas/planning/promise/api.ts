import { z } from 'zod'
import { FINISH_SOURCES, PROMISE_TILES, RISK_STATES } from '@nexus/factory-domain/planning/promise-keep/risk'
import { PROPOSAL_DECISIONS, PROPOSAL_STATES } from '@nexus/factory-domain/planning/promise-keep/repromise'
import { MATERIAL_SOURCES, SIZE_STATES } from '@nexus/factory-domain/planning/promise/rules'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Every call of Planning › Promise dates (SCR-109; design planning.promise), the answers checked with zod (unknown fields
 * dropped, so a new API field never breaks the page). The shapes mirror apps/factory-api modules/planning/promise-keep/
 * contract.ts (B-W2b-317: the promise list, one line's history, the re-promise and sales' word) and promise/contract.ts
 * (B-W2b-301: available to promise, the Promise calculator, a quote's suggested date). The enum lists are factory-domain's
 * own. The API's English (`words`, `bridgeWords`, `groupsWords`, a certificate's words) is dropped or read only for WHETHER:
 * the screen says its own words from codes and facts. The one exception: the message to the customer, drawn as the customer
 * will read it (in their language). No money anywhere; an office person only inside one line (its history, a proposal).
 */

/** The certificate states of the promise engine (apps/factory-api modules/planning/promise/certificates.ts; mirrored: a test holds them). */
export const CERTIFICATE_STATES = ['OK', 'EXPIRING', 'MISSING', 'NOT_NEEDED'] as const
export type CertificateState = (typeof CERTIFICATE_STATES)[number]

export type PromiseTile = (typeof PROMISE_TILES)[number]
export type RiskState = (typeof RISK_STATES)[number]
export type FinishSource = (typeof FINISH_SOURCES)[number]
export type SizeState = (typeof SIZE_STATES)[number]
export type ProposalState = (typeof PROPOSAL_STATES)[number]

const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
const person = z.object({ id: z.string(), name: z.string() })
const day = z.string()
const cover = z.object({ state: z.enum(CERTIFICATE_STATES), certificate: z.string().nullable().optional(), validTo: day.nullable() })

// ---- the promise list (B-W2b-317) ------------------------------------------------------------------------------------------

const lineSize = z.object({
  size: z.string().nullable(),
  ordered: z.number(),
  shipped: z.number(),
  open: z.number(),
  first: day.nullable(),
  current: day.nullable(),
  finish: day.nullable(),
  finishSource: z.enum(FINISH_SOURCES),
  slackDays: z.number().nullable(),
  risk: z.enum(RISK_STATES).nullable(),
  certificate: cover.nullable(),
  workOrders: z.array(z.object({ id: z.string(), number: z.string(), status: z.string(), pieces: z.number(), plannedFinish: day.nullable(), materialStart: day.nullable(), delayDays: z.number(), finish: day.nullable() })),
  engine: z.object({ state: z.enum(SIZE_STATES), date: day.nullable() }).nullable(),
})
export type PromiseLineSize = z.infer<typeof lineSize>

const waiting = z.object({ proposalId: z.string(), proposedAt: z.string(), sizes: z.array(z.object({ size: z.string().nullable(), from: day.nullable(), to: day })) })

export const promiseLineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  kind: z.string(),
  order: z.object({ id: z.string(), number: z.string(), status: z.string(), priorityLevel: z.string(), backlogPosition: z.number().nullable() }),
  customer: named,
  style: named,
  colourway: named,
  sizes: z.array(lineSize),
  first: day.nullable(),
  current: day.nullable(),
  finish: day.nullable(),
  finishSource: z.enum(FINISH_SOURCES),
  slackDays: z.number().nullable(),
  risk: z.enum(RISK_STATES).nullable(),
  certificate: cover.nullable(),
  changes: z.object({ count: z.number(), slips: z.number(), lastChangeAt: z.string().nullable() }),
  waiting: waiting.nullable(),
  tiles: z.array(z.enum(PROMISE_TILES)),
  may: z.object({ repromise: z.boolean() }),
})
export type PromiseLine = z.infer<typeof promiseLineSchema>

const tileCounts = z.object({ AT_RISK: z.number(), SLIPPED_THIS_MONTH: z.number(), REPROMISE_WAITING: z.number(), NO_CERTIFICATE: z.number() })

const promiseListSchema = z.object({
  site: z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string() }),
  today: day,
  asOf: z.string(),
  tiles: tileCounts,
  counts: z.object({ LATE: z.number(), AT_RISK: z.number(), NOT_PROMISED: z.number(), ON_TIME: z.number() }),
  complete: z.boolean(),
  lines: z.array(promiseLineSchema),
})
export type PromiseList = z.infer<typeof promiseListSchema>
export type PromiseTiles = z.infer<typeof tileCounts>

export interface PromiseListAsk {
  readonly siteId: string
  readonly tile?: PromiseTile | null
  readonly risk?: RiskState | null
  readonly q?: string | null
}

const clean = (value: string | null | undefined) => (value === null || value === undefined || value.trim() === '' ? undefined : value.trim())
const enc = encodeURIComponent

/** GET /planning/promises: the site's open order lines with their promise against the planned finish, and the tiles. */
export function listPromises(api: ApiClient, ask: PromiseListAsk, signal?: AbortSignal): Promise<PromiseList> {
  return api.get('/planning/promises', { query: { siteId: ask.siteId, tile: ask.tile ?? undefined, risk: ask.risk ?? undefined, q: clean(ask.q), limit: 300 }, schema: promiseListSchema, signal })
}

// ---- one line's promise history ---------------------------------------------------------------------------------------------

const historySchema = z.object({
  today: day,
  order: z.object({ id: z.string(), number: z.string(), status: z.string(), promiseDate: day.nullable(), originalPromiseDate: day.nullable() }),
  line: z.object({ id: z.string(), seq: z.number(), kind: z.string(), style: named, colourway: named, promiseDate: day.nullable() }),
  first: day.nullable(),
  current: day.nullable(),
  changes: z.number(),
  slips: z.number(),
  sizes: z.array(z.object({ size: z.string().nullable(), ordered: z.number(), open: z.number(), changes: z.number(), slips: z.number(), driftDays: z.number().nullable() })),
  rows: z.array(
    z.object({
      id: z.string(),
      size: z.string().nullable(),
      promisedDate: day,
      kind: z.enum(['FIRST', 'RE_PROMISE']),
      reasonCode: z.string().nullable(),
      reasonWords: z.object({ it: z.string(), en: z.string() }).nullable(),
      reason: z.string().nullable(),
      promisedAt: z.string(),
      promisedBy: person.nullable(),
      customerToldAt: z.string().nullable(),
      fromPlan: z.boolean(),
      shiftDays: z.number().nullable(),
    }),
  ),
  proposals: z.array(z.object({ id: z.string(), state: z.enum(PROPOSAL_STATES), sizes: z.array(z.object({ size: z.string().nullable(), from: day.nullable(), to: day })), reasonCode: z.string(), proposedAt: z.string(), proposedBy: person.nullable(), decidedAt: z.string().nullable(), decidedBy: person.nullable(), decisionReason: z.string().nullable(), told: z.boolean() })),
})
export type PromiseHistory = z.infer<typeof historySchema>

export const promiseHistory = (api: ApiClient, orderLineId: string, signal?: AbortSignal): Promise<PromiseHistory> => api.get(`/planning/promises/order-lines/${enc(orderLineId)}/history`, { schema: historySchema, signal })

// ---- the re-promise and sales' word ----------------------------------------------------------------------------------------

const proposalSize = z.object({ size: z.string().nullable(), from: day.nullable(), to: day })
const message = z.object({ language: z.enum(['it', 'en']), subject: z.string(), body: z.string() })

export const proposalSchema = z.object({
  id: z.string(),
  state: z.enum(PROPOSAL_STATES),
  order: z.object({ id: z.string(), number: z.string(), status: z.string() }),
  line: z.object({ id: z.string(), seq: z.number(), style: named, colourway: named }),
  customer: named,
  siteId: z.string(),
  sizes: z.array(proposalSize),
  reasonCode: z.string(),
  reason: z.string().nullable(),
  message,
  recipients: z.array(z.string()),
  proposedAt: z.string(),
  proposedBy: person.nullable(),
  decision: z.object({ decision: z.enum(PROPOSAL_DECISIONS), at: z.string(), by: person.nullable(), reason: z.string().nullable(), told: z.boolean(), outboundId: z.string().nullable() }).nullable(),
  task: z.object({ id: z.string(), status: z.enum(['OPEN', 'DONE', 'CANCELLED']).nullable(), assignee: person.nullable() }),
  may: z.object({ accept: z.boolean(), tell: z.boolean(), decline: z.boolean(), withdraw: z.boolean() }),
})
export type Proposal = z.infer<typeof proposalSchema>

const draftSchema = z.object({
  today: day,
  order: z.object({ id: z.string(), number: z.string(), status: z.string(), customerRef: z.string().nullable() }),
  line: z.object({ id: z.string(), seq: z.number(), kind: z.string(), style: named, colourway: named }),
  customer: named,
  plan: z.array(z.object({ size: z.string().nullable(), open: z.number(), current: day.nullable(), proposed: day.nullable(), state: z.enum(SIZE_STATES), certificate: cover.nullable() })),
  proposed: z.array(proposalSize),
  reasons: z.array(z.object({ code: z.string(), it: z.string(), en: z.string() })),
  reasonCode: z.string().nullable(),
  language: z.enum(['it', 'en']),
  message: message.nullable(),
  recipients: z.array(z.string()),
  waiting: proposalSchema.nullable(),
  may: z.object({ propose: z.boolean() }),
})
export type RepromiseDraft = z.infer<typeof draftSchema>

/** GET …/order-lines/:id/re-promise: the plan's dates per size, the reasons, the message preview, a proposal that waits. */
export const repromiseDraft = (api: ApiClient, orderLineId: string, signal?: AbortSignal): Promise<RepromiseDraft> => api.get(`/planning/promises/order-lines/${enc(orderLineId)}/re-promise`, { schema: draftSchema, signal })

export interface ProposeBody {
  readonly sizes: readonly { size?: string | null; date: string }[]
  readonly reasonCode: string
  readonly reason?: string
  readonly message?: { subject?: string; body?: string }
}

/** POST …/order-lines/:id/re-promise: "Send to sales for acceptance" (one waiting per line; nothing promised yet). */
export async function proposeRepromise(api: ApiClient, orderLineId: string, body: ProposeBody, idempotencyKey: string): Promise<Proposal> {
  return (await api.post(`/planning/promises/order-lines/${enc(orderLineId)}/re-promise`, { body, schema: z.object({ proposal: proposalSchema, replayed: z.boolean() }), idempotencyKey })).proposal
}

/** GET /planning/promises/re-promises/:id: one proposal (a task on the order opens the page with `?proposal=`). */
export const getRepromise = (api: ApiClient, proposalId: string, signal?: AbortSignal): Promise<Proposal> => api.get(`/planning/promises/re-promises/${enc(proposalId)}`, { schema: proposalSchema, signal })

const acceptAnswer = z.object({ told: z.boolean(), outboundId: z.string().nullable(), lineDate: day.nullable(), replayed: z.boolean(), proposal: proposalSchema })
export type AcceptAnswer = z.infer<typeof acceptAnswer>

/** POST …/re-promises/:id/accept: sales gives the word (never the proposer); `tell` sends the message to the customer now. */
export const acceptRepromise = (api: ApiClient, proposalId: string, body: { tell: boolean; subject?: string; body?: string }, idempotencyKey: string): Promise<AcceptAnswer> =>
  api.post(`/planning/promises/re-promises/${enc(proposalId)}/accept`, { body, schema: acceptAnswer, idempotencyKey })

/** POST …/re-promises/:id/decline: with the reason the planner reads; nothing is promised. */
export async function declineRepromise(api: ApiClient, proposalId: string, reason: string, idempotencyKey: string): Promise<Proposal> {
  return (await api.post(`/planning/promises/re-promises/${enc(proposalId)}/decline`, { body: { reason: reason.trim() }, schema: z.object({ replayed: z.boolean(), proposal: proposalSchema }), idempotencyKey })).proposal
}

/** POST …/re-promises/:id/withdraw: only the planner who proposed it. */
export async function withdrawRepromise(api: ApiClient, proposalId: string, idempotencyKey: string): Promise<Proposal> {
  return (await api.post(`/planning/promises/re-promises/${enc(proposalId)}/withdraw`, { body: {}, schema: z.object({ replayed: z.boolean(), proposal: proposalSchema }), idempotencyKey })).proposal
}

// ---- available to promise (B-W2b-301) --------------------------------------------------------------------------------------

const atpCell = z.object({ key: z.string(), from: day, to: day, receipts: z.number(), committed: z.number(), cumulative: z.number(), available: z.number(), short: z.number(), lastReceipt: day.nullable() })
const atpLine = { onHand: z.number(), availableNow: z.number(), later: z.object({ receipts: z.number(), committed: z.number() }), cells: z.array(atpCell) }

const atpSchema = z.object({
  today: day,
  asOf: z.string(),
  style: z.object({ id: z.string(), code: z.string(), name: z.string(), sizes: z.array(z.string()) }),
  stockStyle: z.boolean(),
  weeks: z.array(z.object({ key: z.string(), from: day, to: day })),
  colourways: z.array(
    z.object({
      colourway: named,
      ...atpLine,
      sizes: z.array(z.object({ size: z.string(), sku: z.string().nullable(), strategy: z.string().nullable(), ...atpLine, sources: z.array(z.object({ kind: z.enum(['WORK_ORDER', 'PLANNED_ORDER', 'ORDER_LINE']), id: z.string(), number: z.string(), date: day.nullable(), pieces: z.number() })) })),
    }),
  ),
  empty: z.boolean(),
})
export type Atp = z.infer<typeof atpSchema>
export type AtpCell = z.infer<typeof atpCell>
export type AtpSize = Atp['colourways'][number]['sizes'][number]
export type AtpSource = AtpSize['sources'][number]

export const availableToPromise = (api: ApiClient, siteId: string, styleId: string, weeks: number | null, signal?: AbortSignal): Promise<Atp> =>
  api.get('/planning/promise/atp', { query: { siteId, styleId, weeks: weeks ?? undefined }, schema: atpSchema, signal })

const stockStyle = z.object({ id: z.string(), code: z.string(), name: z.string(), makeToStock: z.boolean(), onHand: z.boolean() })
export type StockStyle = z.infer<typeof stockStyle>

/** The site's stock styles: the "Pick a style and warehouse" Combobox. */
export async function stockStyles(api: ApiClient, siteId: string, signal?: AbortSignal): Promise<StockStyle[]> {
  return (await api.get('/planning/promise/atp/styles', { query: { siteId, limit: 200 }, schema: z.object({ siteId: z.string(), styles: z.array(stockStyle) }), signal })).styles
}

// ---- the Promise calculator ------------------------------------------------------------------------------------------------

const bridge = z.object({ materialDays: z.number(), baseDays: z.number(), queueDays: z.number(), spanDays: z.number(), materialDate: day, finish: day })
export type Bridge = z.infer<typeof bridge>
const arrival = z.object({ itemId: z.string(), label: z.string(), source: z.enum(MATERIAL_SOURCES), date: day, leadTimeDays: z.number().nullable() })
const certificate = z.object({ state: z.enum(CERTIFICATE_STATES), certificate: z.string().nullable(), validTo: day.nullable(), requirementCode: z.string().nullable(), heldAtShipment: z.string().nullable() })

export const sizeAnswerSchema = z.object({
  size: z.string(),
  quantity: z.number(),
  fromStock: z.number(),
  toMake: z.number(),
  state: z.enum(SIZE_STATES),
  date: day.nullable(),
  readyDate: day.nullable(),
  meetsWanted: z.boolean().nullable(),
  daysLate: z.number().nullable(),
  material: z.object({ date: day, setBy: arrival.nullable() }).nullable(),
  bridge: bridge.nullable(),
  certificate: certificate.nullable(),
})
export type SizeAnswer = z.infer<typeof sizeAnswerSchema>

export const askAnswerSchema = z.object({
  style: named,
  colourway: named,
  revision: z.object({ id: z.string(), revision: z.number(), status: z.string() }).nullable(),
  madeToMeasure: z.boolean(),
  wantedDate: day.nullable(),
  date: day.nullable(),
  earliest: day.nullable(),
  complete: z.boolean(),
  meetsWanted: z.boolean().nullable(),
  daysLate: z.number().nullable(),
  sizes: z.array(sizeAnswerSchema),
  groups: z.array(z.object({ sizes: z.array(z.string()), date: day.nullable() })),
  bridge: bridge.nullable(),
  steps: z.array(z.object({ seq: z.number(), name: z.string(), outside: z.boolean(), lane: z.object({ code: z.string(), name: z.string() }).nullable(), start: day, finish: day })),
  warnings: z.array(z.object({ code: z.string() })),
})
export type AskAnswer = z.infer<typeof askAnswerSchema>

const where = { today: day, asOf: z.string(), market: z.object({ code: z.string(), name: z.string() }).nullable() }
const calculateSchema = z.object({ ...where, answer: askAnswerSchema })
export type Calculation = z.infer<typeof calculateSchema>

export interface CalculateBody {
  readonly siteId: string
  readonly styleId: string
  readonly colourwayId: string
  readonly sizes: readonly { size: string; quantity: number }[]
  readonly wantedDate?: string
  readonly country?: string
}

/** POST /planning/promise/calculate: the date and how it is made; writes nothing. */
export const calculatePromise = (api: ApiClient, body: CalculateBody, signal?: AbortSignal): Promise<Calculation> => api.post('/planning/promise/calculate', { body, schema: calculateSchema, signal })

const quoteSchema = z.object({
  ...where,
  quote: z.object({ id: z.string(), number: z.string(), revision: z.number(), status: z.string(), promiseDate: day.nullable(), version: z.number() }),
  promiseDate: day.nullable(),
  lines: z.array(z.object({ lineId: z.string(), seq: z.number(), answer: askAnswerSchema })),
  skipped: z.array(z.object({ lineId: z.string(), seq: z.number() })),
  mayUse: z.boolean(),
})
export type QuoteSuggestion = z.infer<typeof quoteSchema>

/** GET /planning/promise/quotes/:quoteId: a quote's lines asked together ("Suggest date"); `mayUse` holds "Use on quote". */
export const quoteSuggestion = (api: ApiClient, quoteId: string, siteId: string | null, signal?: AbortSignal): Promise<QuoteSuggestion> =>
  api.get(`/planning/promise/quotes/${enc(quoteId)}`, { query: { siteId: siteId ?? undefined }, schema: quoteSchema, signal })

/** "Use on quote" = W1's PATCH /sales/quotes/:quoteId { version, promiseDate } with the suggestion's date. */
export async function promiseOnQuote(api: ApiClient, quote: { id: string; version: number }, promiseDate: string, idempotencyKey: string): Promise<{ id: string; version: number; promiseDate: string | null }> {
  return (await api.request('PATCH', `/sales/quotes/${enc(quote.id)}`, { body: { version: quote.version, promiseDate }, schema: z.object({ quote: z.object({ id: z.string(), version: z.number(), promiseDate: day.nullable() }) }), idempotencyKey })).quote
}

// ---- the styles the calculator asks for (W1's style library) ---------------------------------------------------------------

const styleOption = z.object({ id: z.string(), code: z.string(), name: z.string(), sizes: z.array(z.string()) })
export type StyleOption = z.infer<typeof styleOption>
const styleDetail = styleOption.extend({ colourways: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), status: z.string(), offeredSizes: z.array(z.string()) })) })
export type StyleDetail = z.infer<typeof styleDetail>

export async function findStyles(api: ApiClient, signal?: AbortSignal): Promise<StyleOption[]> {
  return (await api.get('/product/styles', { query: { status: 'OPEN', limit: 200 }, schema: z.object({ styles: z.array(styleOption) }), signal })).styles
}

export async function readStyle(api: ApiClient, styleId: string, signal?: AbortSignal): Promise<StyleDetail> {
  return (await api.get(`/product/styles/${enc(styleId)}`, { schema: z.object({ style: styleDetail }), signal })).style
}
