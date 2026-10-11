/**
 * Negative Targeting page (NREAD) — the waste test of one row (PLAN §2), pure. read.ts gives it the row's numbers over
 * the late-order-safe window (pure.ts windowNumbers) and the product's facts; it answers whether the test is met, the
 * bar, and one sentence with no money in it (the money sits under its keys and is stripped by key).
 *
 *   search term   0 orders; clicks ≥ max(20, ⌈ln 0.05 ÷ ln(1 − CR̂)⌉ ≈ 3 ÷ CR̂); spend ≥ 1.5 × the product's target cost
 *                 per order (CR̂ the product's pooled conversion rate, product → market, bid-brain/estimator.ts; the CPA =
 *                 the pooled order value × the target ACoS). The ads strategy's "Negate a search term when" group wins
 *                 whole where it is set (its clicks, spend, orders and window), as the brain reads it.
 *   our keyword   on its own totals: 0 orders; clicks ≥ the same floor; spend ≥ 2 × the target CPA; and no search term
 *                 under it sold in the window (otherwise the bad terms are negated, not the keyword paused).
 *   no target     no target ACoS anywhere (strategy, account): a fixed bar per row kind, said in the sentence.
 *   no data       a keyword Amazon reported nothing for: never met ("no data" is not "0 orders").
 * NRULES' evaluator calls `wasteTest` too (waste-rules/contexts.ts), with the rule's own settings (`RuleTune`: its clicks
 * floor, its CPA multiple, its fixed bar, its window) on the same formula, and the product's facts from `productFactsOf`
 * (the same pooling, estimator and target as the page), so the page and the rule judge alike: one test.
 */
import { estimate } from '../bid-brain/estimator.js'
import { negateClicksNeeded } from '../brain/terms.js'
import {
  FIXED_KEYWORD_SPEND_BAR_CENTS, FIXED_TERM_SPEND_BAR_CENTS, KEYWORD_CPA_BAR, MIN_CLICKS_FLOOR, TERM_CPA_BAR,
  type Ref, type RowNumbers, type RowTest,
} from './pure.js'

/** The product's facts the bar is built from. */
export interface ProductFacts {
  /** The pooled conversion rate (product → market); null when nothing at all is known. */
  cr: number | null
  /** The pooled order value × the target ACoS; null without a target or an order value. */
  targetCpaCents: number | null
  /** Where the target came from, in words ("the ads strategy: …", "the account's default target ACoS"); null without one. */
  targetSource: string | null
}

/** An Owner-set bar that wins whole: the ads strategy's negate group, or a rule (NRULES). */
export interface OwnerBar {
  source: 'strategy' | 'rule'
  by: Ref
  minClicks: number
  minSpendCents: number
  maxOrders: number
  windowDays: number
}

export interface Bar {
  source: 'rule' | 'strategy' | 'default'
  by: Ref | null
  windowDays: number
  clicksNeeded: number
  spendBarCents: number | null
  xCpaBar: number | null
  maxOrders: number
  /** Why the bar is what it is, in words. */
  basis: string
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 2 : 1)} %`

/** The clicks a 0-order row needs: the brain's 95 % call at the product's rate, never under the floor (20 by default). */
export function clicksNeededFor(cr: number | null, floor: number = MIN_CLICKS_FLOOR): number {
  return Math.max(floor, cr != null && cr > 0 ? negateClicksNeeded(cr) : floor)
}

/** One pooled evidence node: clicks and spend to today − 3, orders and sales to today, over the page's default window. */
export interface PoolEvidence { clicks: number; orders: number; salesCents: number; costCents: number }

/**
 * The product's facts — one definition for the page (read.ts) and the stop-waste rules (waste-rules/contexts.ts): the
 * pooled conversion rate and order value, product → market (bid-brain/estimator.ts, the product's list price as the order
 * value's prior), × its target ACoS. `product` null: a place no single product owns (market facts only). Pure.
 */
export function productFactsOf(a: { product: PoolEvidence | null; market: PoolEvidence; listPriceCents: number | null; target: { value: number; source: string } | null }): ProductFacts {
  const chain = [...(a.product ? [{ level: 'product' as const, evidence: a.product }] : []), { level: 'market' as const, evidence: a.market }]
  const est = estimate(chain, { listPriceCents: a.product ? a.listPriceCents : null }).node
  const cr = a.market.clicks > 0 || (a.product?.clicks ?? 0) > 0 ? est.cr : null
  const cpa = a.target && est.aovCents != null && est.aovCents > 0 ? Math.round(est.aovCents * a.target.value) : null
  return { cr, targetCpaCents: cpa, targetSource: a.target?.source ?? null }
}

/** The target ACoS a product's bar reads: the ads strategy's, else the account's default; null without one. Pure. */
export function targetFrom(strategyPct: number | null | undefined, strategyWords: string, accountPct: number | null): { value: number; source: string } | null {
  if (strategyPct != null && strategyPct > 0) return { value: strategyPct / 100, source: strategyWords }
  return accountPct != null && accountPct > 0 ? { value: accountPct / 100, source: 'the account\'s default target ACoS' } : null
}

/** A stop-waste rule's own settings on the page's formula (NRULES): the same test, its numbers. */
export interface RuleTune { by: Ref; windowDays: number; minClicks: number; cpaMultiple: number; fixedSpendCents: number }

/**
 * The bar for one row: the Owner's group (a rule's fixed bar, the ads strategy's negate group) whole where one is set, else
 * the page's default — or, with `tune`, the default formula with a stop-waste rule's own numbers (`source: 'rule'`).
 */
export function barFor(kind: 'TERM' | 'KEYWORD', facts: ProductFacts, windowDays: number, owner: OwnerBar | null = null, tune: RuleTune | null = null): Bar {
  if (owner && (kind === 'TERM' || owner.source === 'rule')) {
    return {
      source: owner.source, by: owner.by, windowDays: owner.windowDays, clicksNeeded: owner.minClicks, spendBarCents: owner.minSpendCents,
      xCpaBar: null, maxOrders: owner.maxOrders,
      basis: `${owner.source === 'rule' ? `the rule "${owner.by.name}"` : 'the ads strategy\'s "Negate a search term when"'}: ${plural(owner.minClicks, 'click')} or more, spend at its minimum, at most ${plural(owner.maxOrders, 'order')}, ${owner.windowDays} days`,
    }
  }
  const multiple = tune?.cpaMultiple ?? (kind === 'TERM' ? TERM_CPA_BAR : KEYWORD_CPA_BAR)
  const floor = tune?.minClicks ?? MIN_CLICKS_FLOOR
  const days = tune?.windowDays ?? windowDays
  const head = tune ? { source: 'rule' as const, by: tune.by } : { source: 'default' as const, by: null }
  const who = tune ? `the rule "${tune.by.name}": ` : ''
  const clicksNeeded = clicksNeededFor(facts.cr, floor)
  const rate = facts.cr != null && facts.cr > 0 ? `at the product's pooled ${pct(facts.cr)} conversion` : 'no conversion rate known'
  if (facts.targetCpaCents != null && facts.targetCpaCents > 0) {
    return {
      ...head, windowDays: days, clicksNeeded, spendBarCents: Math.round(multiple * facts.targetCpaCents), xCpaBar: multiple, maxOrders: 0,
      basis: `${who}0 orders, ${clicksNeeded} clicks or more (${rate}, never under ${floor}), spend ${multiple} × the target cost per order (${facts.targetSource ?? 'the target ACoS'})`,
    }
  }
  return {
    ...head, windowDays: days, clicksNeeded, spendBarCents: tune?.fixedSpendCents ?? (kind === 'TERM' ? FIXED_TERM_SPEND_BAR_CENTS : FIXED_KEYWORD_SPEND_BAR_CENTS), xCpaBar: null, maxOrders: 0,
    basis: `${who}0 orders, ${clicksNeeded} clicks or more (${rate}, never under ${floor}), spend past a fixed bar: no target ACoS is set for this product anywhere`,
  }
}

/**
 * Is the bar met by these numbers? `termsSold` (our keyword only): how many of its search terms sold in the window —
 * any, and the keyword is not paused (its bad terms are negated instead). `n` null: no data, never met.
 */
export function wasteTest(kind: 'TERM' | 'KEYWORD', n: Pick<RowNumbers, 'clicks' | 'orders' | 'spendCents'> | null, bar: Bar, opts: { termsSold?: number; stockOutDays?: number } = {}): RowTest {
  const base = { by: bar.by, windowDays: bar.windowDays, clicksNeeded: bar.clicksNeeded, spendBarCents: bar.spendBarCents, xCpaBar: bar.xCpaBar }
  const stock = opts.stockOutDays ? `; ${plural(opts.stockOutDays, 'day')} out of stock left out` : ''
  if (!n) return { ...base, met: false, sentence: `No data: Amazon reported nothing for this ${kind === 'TERM' ? 'term' : 'keyword'} in ${bar.windowDays} days, so it is not judged.` }
  const ordersOk = n.orders <= bar.maxOrders
  const clicksOk = n.clicks >= bar.clicksNeeded
  const spendOk = bar.spendBarCents == null || n.spendCents >= bar.spendBarCents
  const termsSold = kind === 'KEYWORD' ? opts.termsSold ?? 0 : 0
  const met = ordersOk && clicksOk && spendOk && termsSold === 0
  const parts = [
    `${plural(n.orders, 'order')}${ordersOk ? '' : ` (more than ${bar.maxOrders})`}`,
    `${plural(n.clicks, 'click')} of ${bar.clicksNeeded}${clicksOk ? '' : ` — ${bar.clicksNeeded - n.clicks} more needed`}`,
    `spend ${spendOk ? 'past' : 'under'} the bar`,
    ...(kind === 'KEYWORD' && termsSold > 0 ? [`${plural(termsSold, 'search term')} under it sold: negate the wasting terms instead`] : []),
  ]
  return { ...base, met, sentence: `${met ? 'Wastes' : 'Not wasting'}: ${parts.join(', ')} in ${bar.windowDays} days${stock}. Bar: ${bar.basis}.` }
}

/** Spend as a multiple of the target cost per order, to 2 decimals; null without a target. */
export function xCpaOf(spendCents: number, targetCpaCents: number | null): number | null {
  if (targetCpaCents == null || !(targetCpaCents > 0)) return null
  return Math.round((spendCents / targetCpaCents) * 100) / 100
}
