import { z } from 'zod'
// B-W2b-288 (FU2:02): where a style stands in a market.
import { MARKET_STANDINGS } from '@nexus/factory-domain/product/markets/rules'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Every call of Compliance › Status board (SCR-119, B-W2b-266), with the answer's shape checked (zod; unknown fields are
 * dropped). The shapes mirror apps/factory-api modules/compliance/status/contract.ts (the board's reads, B-W2b-254) and
 * modules/compliance/gates/contract.ts (the refusals feed and the override); the lists mirror factory-domain compliance/
 * requirements, gates, status and reports rules (status.vitest.test.ts holds them equal). Codes, states, counts of things and
 * words; an override names its office person, a refusal nobody. No price, no cost.
 */

export const GATES = ['WORK_ORDER_RELEASE', 'LABEL_PRINT', 'FINAL_RELEASE', 'SHIPMENT'] as const
export type Gate = (typeof GATES)[number]
// B-W2b-288 (FU2:02): NOT_SOLD — a market the style is not sold in (Style.marketCodes): "Not sold there", not a gap.
export const CELL_STATES = ['READY', 'MISSING', 'BLOCKED', 'EXPIRING', 'NOT_SOLD'] as const
export type CellState = (typeof CELL_STATES)[number]
export const LINE_STATES = ['OK', 'MISSING', 'EXPIRING', 'NOT_NEEDED', 'MANUAL', 'OVERRIDDEN'] as const
export type LineState = (typeof LINE_STATES)[number]
export const WHO = ['COMPLIANCE', 'QUALITY', 'PRODUCTION', 'SALES'] as const
export type Who = (typeof WHO)[number]
export const FIX_PLACES = ['certificates', 'declarations', 'labels', 'operators', 'tests', 'markets', 'requirements'] as const
export type FixPlace = (typeof FIX_PLACES)[number]
export const GAP_TYPES = ['certificate', 'docLanguage', 'label', 'crVi', 'operator', 'other'] as const
export type GapType = (typeof GAP_TYPES)[number]
export const SEVERITIES = ['BLOCKED', 'MISSING', 'EXPIRING'] as const
export const FEED_STATES = ['BLOCKED', 'CLEARED', 'OVERRIDDEN', 'OVERRIDE'] as const
export type FeedState = (typeof FEED_STATES)[number]

const gate = z.enum(GATES)
const first = z.object({ code: z.string(), message: z.string(), fix: z.string().nullable(), who: z.enum(WHO), fixPlace: z.enum(FIX_PLACES), legalReference: z.string() }).nullable()
const cell = z.object({
  marketCode: z.string(),
  state: z.enum(CELL_STATES),
  words: z.string(),
  missing: z.number(),
  blocking: z.number(),
  expiring: z.number(),
  manual: z.number(),
  blockedGates: z.array(gate),
  first,
})
export type Cell = z.infer<typeof cell>
const market = z.object({ code: z.string(), name: z.string(), switchedOn: z.boolean() })
export type Market = z.infer<typeof market>
const action = z.object({ styleId: z.string(), styleCode: z.string(), marketCode: z.string(), requirementCode: z.string(), words: z.string(), who: z.enum(WHO), fixPlace: z.enum(FIX_PLACES), severity: z.enum(SEVERITIES) })
export type ActionLine = z.infer<typeof action>
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
export type Ref = z.infer<typeof ref>
const row = z.object({
  // B-W2b-288 (FU2:02): marketCodes — the markets the style is sold in ([]: every market).
  style: z.object({ id: z.string(), code: z.string(), name: z.string(), companyId: z.string().nullable(), ppeCategory: z.string(), productType: z.string(), brand: ref.nullable(), soldUnderOurName: z.boolean(), marketCodes: z.array(z.string()).default([]) }),
  cells: z.array(cell),
  ready: z.boolean(),
  blocked: z.boolean(),
})
export type BoardRow = z.infer<typeof row>

const boardSchema = z.object({
  markets: z.array(market),
  tiles: z.object({
    stylesReady: z.number(),
    stylesBlocked: z.number(),
    certificatesExpiring90: z.number(),
    lotsWithoutCrVi: z.number().nullable(),
    missingLanguages: z.number(),
    shipmentsHeld: z.number(),
  }),
  rows: z.array(row),
  more: z.boolean(),
  needsAction: z.object({ lines: z.array(action), count: z.number() }),
  asOf: z.string(),
})
export type Board = z.infer<typeof boardSchema>
export type Tiles = Board['tiles']

const actionsSchema = z.object({ lines: z.array(action), count: z.number(), asOf: z.string() })
export type Actions = z.infer<typeof actionsSchema>

const item = z.object({
  requirement: z.object({
    id: z.string().nullable(),
    code: z.string(),
    name: z.string(),
    nameI18n: z.record(z.string(), z.string()),
    legalReference: z.string(),
    explanationI18n: z.record(z.string(), z.string()),
    blocks: z.array(gate),
    lockedBlocks: z.array(gate),
  }),
  check: z.string(),
  state: z.enum(LINE_STATES),
  message: z.string(),
  fix: z.string().nullable(),
  evidence: z.object({ recordType: z.string(), recordId: z.string(), label: z.string() }).nullable(),
  who: z.enum(WHO),
  fixPlace: z.enum(FIX_PLACES),
})
export type CellItem = z.infer<typeof item>
const cellSchema = z.object({
  // B-W2b-288 (FU2:02): the markets it is sold in and where it stands in this one.
  style: z.object({ id: z.string(), code: z.string(), name: z.string(), ppeCategory: z.string(), productType: z.string(), marketCodes: z.array(z.string()).default([]) }),
  market,
  standing: z.enum(MARKET_STANDINGS).default('EVERY_MARKET'),
  cell,
  items: z.array(item),
  asOf: z.string(),
})
export type CellDetail = z.infer<typeof cellSchema>

const expiryItem = z.object({
  recordType: z.string(),
  recordId: z.string(),
  label: z.string(),
  validTo: z.string(),
  validFrom: z.string().nullable(),
  status: z.string(),
  detail: z.string().nullable(),
  party: z.string().nullable(),
  endsWithBase: z.boolean(),
})
export type ExpiryItem = z.infer<typeof expiryItem>
const expiriesSchema = z.object({ months: z.array(z.object({ month: z.string(), count: z.number(), items: z.array(expiryItem) })), count: z.number(), from: z.string(), to: z.string(), asOf: z.string() })
export type Expiries = z.infer<typeof expiriesSchema>

const person = z.object({ id: z.string(), name: z.string() }).nullable()
const event = z.object({
  id: z.string(),
  at: z.string(),
  gate,
  place: z.string(),
  outcome: z.enum(['REFUSED', 'OVERRIDDEN']),
  subject: z.object({ type: z.string(), id: z.string(), number: z.string().nullable(), status: z.string().nullable() }),
  site: z.object({ id: z.string(), code: z.string().nullable() }).nullable(),
  style: z.object({ id: z.string(), code: z.string().nullable() }).nullable(),
  colourway: z.string().nullable(),
  size: z.string().nullable(),
  marketCode: z.string().nullable(),
  requirement: z.object({ id: z.string(), code: z.string(), name: z.string(), legalReference: z.string(), locked: z.boolean(), overrideRoleKeys: z.array(z.string()), overrideMaxDays: z.number() }),
  reason: z.string(),
  state: z.enum(FEED_STATES),
  refusedEventId: z.string().nullable(),
  overrideUntil: z.string().nullable(),
  by: person,
  overrides: z.array(z.object({ id: z.string(), at: z.string(), until: z.string().nullable(), reason: z.string(), by: person, inForce: z.boolean() })),
  mayOverride: z.boolean(),
})
export type GateEvent = z.infer<typeof event>
const feedSchema = z.object({ events: z.array(event), days: z.number(), asOf: z.string() })
export type Feed = z.infer<typeof feedSchema>

const overrideSchema = z.object({ override: z.object({ id: z.string(), refusedEventId: z.string(), gate, subjectType: z.string(), subjectId: z.string(), requirementCode: z.string(), until: z.string(), reason: z.string() }) })
export type OverrideAnswer = z.infer<typeof overrideSchema>

export interface BoardQuery {
  readonly markets?: readonly string[]
  readonly brandId?: string | null
  readonly gap?: GapType | null
  readonly q?: string | null
}

const boardTerms = (query: BoardQuery) => ({
  markets: query.markets && query.markets.length > 0 ? query.markets.join(',') : undefined,
  brandId: query.brandId ?? undefined,
  gap: query.gap ?? undefined,
  q: query.q ? query.q : undefined,
  limit: 200,
})

/** GET /compliance/status/board — tiles, the style × market matrix (at most 200 styles), the top five of "Needs action". */
export const getBoard = (api: ApiClient, query: BoardQuery, signal?: AbortSignal): Promise<Board> => api.get('/compliance/status/board', { query: boardTerms(query), schema: boardSchema, signal })

/** GET /compliance/status/actions — every "Needs action" line (at most 200; "See all N"). */
export const getActions = (api: ApiClient, query: BoardQuery, signal?: AbortSignal): Promise<Actions> => api.get('/compliance/status/actions', { query: boardTerms(query), schema: actionsSchema, signal })

/** GET /compliance/status/cell — one style × market's requirement checklist (cs-cell). */
export const getCell = (api: ApiClient, styleId: string, market: string, signal?: AbortSignal): Promise<CellDetail> => api.get('/compliance/status/cell', { query: { styleId, market }, schema: cellSchema, signal })

/** GET /compliance/status/expiries — what stops in the next 12 months, per month (cs-expiry). */
export const getExpiries = (api: ApiClient, months = 12, signal?: AbortSignal): Promise<Expiries> => api.get('/compliance/status/expiries', { query: { months }, schema: expiriesSchema, signal })

/** GET /compliance/gates/events — the gate refusals and overrides of the last days (cs-gates; 7 by default). */
export const getFeed = (api: ApiClient, query: { readonly days: number; readonly gate?: Gate | null }, signal?: AbortSignal): Promise<Feed> =>
  api.get('/compliance/gates/events', { query: { days: query.days, gate: query.gate ?? undefined, limit: 200 }, schema: feedSchema, signal })

/** POST /compliance/gates/events/:id/override — one refusal lifted for its subject until a time (a fresh step-up first). */
export const postOverride = (api: ApiClient, eventId: string, body: { readonly reason: string; readonly until: string }, idempotencyKey: string): Promise<OverrideAnswer> =>
  api.post(`/compliance/gates/events/${encodeURIComponent(eventId)}/override`, { body, schema: overrideSchema, idempotencyKey })
