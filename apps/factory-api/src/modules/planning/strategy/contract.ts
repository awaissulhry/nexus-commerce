import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { PRODUCTION_STRATEGIES, STRATEGY_ITEM_KINDS, STRATEGY_LIMITS } from '@nexus/factory-domain/planning/strategy/rules'

/**
 * The production strategy per item (B-W2b-319; PLN-061; design planning.mps sec:strategy, SCR-202): per site, every finished
 * garment and component a site may plan, with how its demand is met (make to order, make to stock, assemble to order), the reason of
 * the last change and when and by whom. Read with planning.view; changed with planning.strategy.manage over the site's company and
 * the site. A change is ONE command (one item, or up to 200 in one review), audited per row with its reason; the item's
 * ItemPlanning row is made when it has none (the item is planned by its defaults otherwise). No money, no worker.
 */

const ref = output({ id: id(), code: z.string(), name: z.string() })
const strategy = z.enum(PRODUCTION_STRATEGIES)
const lastChange = output({ at: instant(), by: output({ id: id(), name: z.string() }).nullable(), from: strategy, to: strategy, reason: z.string().nullable() }).nullable()

export const strategyRowView = output({
  /** The site's ItemPlanning row for the item and colour (null colour: every colour). */
  itemPlanningId: id(),
  colour: ref.nullable(),
  /** As stored: null = never set (make to order). */
  stored: strategy.nullable(),
  strategy,
  version: z.number().int(),
  lastChange,
})
export type StrategyRowView = z.infer<typeof strategyRowView>

export const strategyItemView = output({
  item: output({ id: id(), code: z.string(), name: z.string(), kind: z.enum(STRATEGY_ITEM_KINDS) }),
  /** A finished garment's SKU: its style, colourway and size. */
  sku: output({ sku: z.string(), style: ref, colourway: ref, size: z.string() }).nullable(),
  /** How the site meets the item's demand: its every-colour row's, else make to order. */
  strategy,
  /** A person set it (the every-colour row has one); false: the default. */
  set: z.boolean(),
  /** The every-colour row, then a row per colour; empty: the item is planned by its defaults. */
  rows: z.array(strategyRowView),
  lastChange,
})
export type StrategyItemView = z.infer<typeof strategyItemView>

const siteView = output({ id: id(), companyId: id(), code: z.string(), name: z.string(), timeZone: z.string() })
const flag = () => z.enum(['true', 'false']).transform((value) => value === 'true')

export const listStrategyContract = defineContract({
  querystring: input({
    siteId: id(),
    /** An item's code or name, or a SKU. */
    q: z.string().trim().min(1).max(100).optional(),
    kind: z.enum(STRATEGY_ITEM_KINDS).optional(),
    /** The effective strategy (make to order includes the items never set). */
    strategy: strategy.optional(),
    /** Only a style's finished garments. */
    styleId: id().optional(),
    /** Comma-separated item ids (the review's re-read before Save), at most 200. */
    itemIds: z.string().max(200 * 37).optional(),
    /** true: only items a person set; false: only those on the default. */
    set: flag().optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(STRATEGY_LIMITS.page.max).optional(),
  }),
  response: {
    200: output({ site: siteView, items: z.array(strategyItemView), nextCursor: id().nullable(), hint: output({ en: z.string(), it: z.string() }) }),
  },
})

const reason = z.string().max(STRATEGY_LIMITS.reason * 2).optional()

export const setStrategyContract = defineContract({
  params: input({ itemId: id() }),
  body: input({
    siteId: id(),
    /** The colour's row; left out or null: the every-colour row. */
    itemColourId: id().nullable().optional(),
    strategy,
    reason,
    /** The row's version as read; left out exactly when the item has no row at the site yet (one is made). */
    version: z.number().int().min(1).optional(),
  }),
  response: {
    /** row null: the item has no row at the site (it is made to order by its defaults, and stays so). */
    200: output({ row: strategyRowView.nullable(), change: z.enum(['CREATED', 'EDITED', 'UNCHANGED']), from: strategy, replayed: z.boolean() }),
  },
})
export type SetStrategyBody = z.infer<typeof setStrategyContract.body>

export const bulkStrategyContract = defineContract({
  body: input({
    siteId: id(),
    reason,
    items: z
      .array(input({ itemId: id(), itemColourId: id().nullable().optional(), strategy, version: z.number().int().min(1).optional() }))
      .min(1)
      .max(STRATEGY_LIMITS.bulk),
  }),
  response: {
    200: output({
      /** One per item asked, in its order: what it was and what it is now (an Undo sends `from` back). */
      changes: z.array(output({ index: z.number().int(), itemId: id(), itemColourId: id().nullable(), change: z.enum(['CREATED', 'EDITED', 'UNCHANGED']), from: strategy, to: strategy, row: strategyRowView.nullable() })),
      changed: z.number().int(),
      replayed: z.boolean(),
    }),
  },
})
export type BulkStrategyBody = z.infer<typeof bulkStrategyContract.body>
