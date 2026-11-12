import type { Issue } from '../../core/errors'

/**
 * The production strategy per item (B-W2b-319; PLN-061; design planning.mps sec:strategy "Production strategy per item": item,
 * strategy (an inline Listbox that saves on its own), reason, last changed; a bulk change with the review of every change), pure.
 * factory-db ItemPlanning.strategy (B-W2b-286) keeps it per site, item and colour (a null colour: every colour); null means MAKE_TO_ORDER,
 * as W1 plans everything. The …_planning_depth_w2b_guards trigger refuses a strategy on an item that is not FINISHED or COMPONENT; this
 * file says it first, in words.
 *
 *   MAKE_TO_ORDER       waits for a customer order (W1: every item)
 *   MAKE_TO_STOCK       builds ahead from a forecast, into finished stock (the master schedule plans it: W3)
 *   ASSEMBLE_TO_ORDER   keeps its parts (components) ready, and assembles when the order comes
 *
 * Today the setting is recorded, listed and shown beside the demand view's rows; the run (B-W2b-293, -306) and the master schedule
 * (W3) are the ones that plan by it. The reason of a change is the audit row's, never a column.
 */

export const PRODUCTION_STRATEGIES = ['MAKE_TO_ORDER', 'MAKE_TO_STOCK', 'ASSEMBLE_TO_ORDER'] as const
export type ProductionStrategy = (typeof PRODUCTION_STRATEGIES)[number]
/** What a missing row, or a row without a strategy, means. */
export const DEFAULT_STRATEGY: ProductionStrategy = 'MAKE_TO_ORDER'
/** The item kinds that take a strategy (the database's rule). */
export const STRATEGY_ITEM_KINDS = ['FINISHED', 'COMPONENT'] as const

export const STRATEGY_LIMITS = Object.freeze({ reason: 500, bulk: 200, page: { default: 100, max: 500 } })

/** The audit action every strategy change writes (one row per site, item and colour), read back as "last changed". */
export const STRATEGY_AUDIT_ACTION = 'planning.setProductionStrategy'

export const STRATEGY_WORDS: Readonly<Record<ProductionStrategy, { readonly en: string; readonly it: string }>> = Object.freeze({
  MAKE_TO_ORDER: { en: 'Make to order', it: 'Su ordine' },
  MAKE_TO_STOCK: { en: 'Make to stock', it: 'Per magazzino' },
  ASSEMBLE_TO_ORDER: { en: 'Assemble to order', it: 'Assemblaggio su ordine' },
})

/** The design's line under the grid ("Says on screen"). */
export const STRATEGY_HINT = Object.freeze({
  en: 'Make to order waits for a customer order; make to stock builds ahead from a forecast.',
  it: 'Su ordine aspetta l’ordine del cliente; per magazzino produce in anticipo da una previsione.',
})

export const isStrategy = (value: unknown): value is ProductionStrategy => typeof value === 'string' && (PRODUCTION_STRATEGIES as readonly string[]).includes(value)
export const effectiveStrategy = (stored: string | null | undefined): ProductionStrategy => (isStrategy(stored) ? stored : DEFAULT_STRATEGY)
export const takesStrategy = (kind: string): boolean => (STRATEGY_ITEM_KINDS as readonly string[]).includes(kind)

/** Why an item cannot take a strategy (null: it can), in words, at `path`. */
export function strategyItemProblem(item: { readonly code: string; readonly kind: string; readonly status: string }, path = 'body/itemId'): Issue | null {
  if (!takesStrategy(item.kind)) return { path, message: `${item.code} is a ${item.kind.toLowerCase().replace(/_/g, ' ')} material: only finished garments and components we make have a production strategy.` }
  if (item.status !== 'ACTIVE') return { path, message: `${item.code} is archived: archived items are not planned.` }
  return null
}

/** The reason's rule: optional, 1 to 500 characters once trimmed. */
export function reasonProblem(reason: string | null | undefined, path = 'body/reason'): Issue | null {
  if (reason === undefined || reason === null) return null
  const trimmed = reason.trim()
  if (trimmed.length === 0) return { path, message: 'Leave the reason out, or say why in a few words.' }
  if (trimmed.length > STRATEGY_LIMITS.reason) return { path, message: `Keep the reason within ${STRATEGY_LIMITS.reason} characters.` }
  return null
}

/** The strategies of a style-colour's SKUs as one word for the demand view: one of them, or MIXED. */
export function strategySummary(strategies: readonly ProductionStrategy[]): ProductionStrategy | 'MIXED' {
  const distinct = [...new Set(strategies.length === 0 ? [DEFAULT_STRATEGY] : strategies)]
  return distinct.length === 1 ? distinct[0]! : 'MIXED'
}
