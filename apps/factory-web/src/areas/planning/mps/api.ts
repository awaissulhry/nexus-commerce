import { z } from 'zod'
import { PRODUCTION_STRATEGIES, STRATEGY_ITEM_KINDS, type ProductionStrategy } from '@nexus/factory-domain/planning/strategy/rules'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'

/**
 * Every call of Planning › Long range › Master schedule & S&OP's production strategy per item (SCR-202; design planning.mps
 * sec:strategy), the answers checked with zod (unknown fields dropped). The shapes mirror apps/factory-api
 * modules/planning/strategy/contract.ts (B-W2b-319): the list (planning.view), one cell's autosave (PUT, version-checked, one
 * command), a bulk change of up to 200 items (POST, one command; its `changes` are the review's results and their `from` the
 * Undo). The API's English hint is dropped: the screen says its own words. No money; the only person is who last changed it.
 */

const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
const strategy = z.enum(PRODUCTION_STRATEGIES)
const lastChange = z.object({ at: z.string(), by: z.object({ id: z.string(), name: z.string() }).nullable(), from: strategy, to: strategy, reason: z.string().nullable() }).nullable()

export const strategyRowSchema = z.object({ itemPlanningId: z.string(), colour: named.nullable(), stored: strategy.nullable(), strategy, version: z.number(), lastChange })
export type StrategyRow = z.infer<typeof strategyRowSchema>

export const strategyItemSchema = z.object({
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.enum(STRATEGY_ITEM_KINDS) }),
  sku: z.object({ sku: z.string(), style: named, colourway: named, size: z.string() }).nullable(),
  strategy,
  set: z.boolean(),
  rows: z.array(strategyRowSchema),
  lastChange,
})
export type StrategyItem = z.infer<typeof strategyItemSchema>

const site = z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string(), timeZone: z.string() })
const listSchema = z.object({ site, items: z.array(strategyItemSchema), nextCursor: z.string().nullable() })
export type StrategyList = z.infer<typeof listSchema>

const changeKind = z.enum(['CREATED', 'EDITED', 'UNCHANGED'])
const setSchema = z.object({ row: strategyRowSchema.nullable(), change: changeKind, from: strategy, replayed: z.boolean() })
export type StrategySet = z.infer<typeof setSchema>
const bulkSchema = z.object({
  changes: z.array(z.object({ index: z.number(), itemId: z.string(), itemColourId: z.string().nullable(), change: changeKind, from: strategy, to: strategy, row: strategyRowSchema.nullable() })),
  changed: z.number(),
  replayed: z.boolean(),
})
export type StrategyBulk = z.infer<typeof bulkSchema>

export interface StrategyQuery {
  readonly siteId: string
  readonly q?: string | null
  readonly kind?: (typeof STRATEGY_ITEM_KINDS)[number] | null
  readonly strategy?: ProductionStrategy | null
  /** true: only the items a person set; false: those on the default. */
  readonly set?: boolean | null
  /** The review's re-read before Save (at most 200). */
  readonly itemIds?: readonly string[]
  readonly cursor?: string | null
  readonly limit?: number
}

const clean = (value: string | null | undefined) => (value === null || value === undefined || value === '' ? undefined : value)

export const listStrategy = (api: ApiClient, query: StrategyQuery, signal?: AbortSignal): Promise<StrategyList> =>
  api.get('/planning/strategy', {
    query: {
      siteId: query.siteId,
      q: clean(query.q),
      kind: clean(query.kind),
      strategy: clean(query.strategy),
      set: query.set === null || query.set === undefined ? undefined : String(query.set),
      itemIds: query.itemIds && query.itemIds.length > 0 ? query.itemIds.join(',') : undefined,
      cursor: clean(query.cursor),
      limit: query.limit,
    },
    schema: listSchema,
    signal,
  })

/** The cell's autosave: the every-colour row's strategy (its version when it exists; none when the item has no row yet). */
export function setStrategy(api: ApiClient, itemId: string, body: { siteId: string; strategy: ProductionStrategy; version?: number; reason?: string }): Promise<StrategySet> {
  return api.request('PUT', `/planning/strategy/items/${encodeURIComponent(itemId)}`, { body, schema: setSchema, idempotencyKey: newIdempotencyKey() })
}

export function bulkStrategy(api: ApiClient, body: { siteId: string; reason?: string; items: { itemId: string; strategy: ProductionStrategy; version?: number }[] }): Promise<StrategyBulk> {
  return api.post('/planning/strategy/bulk', { body, schema: bulkSchema, idempotencyKey: newIdempotencyKey() })
}
