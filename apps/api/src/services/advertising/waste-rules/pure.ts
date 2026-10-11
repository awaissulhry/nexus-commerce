/**
 * Negative Targeting page (2026-10-11) — the pure half of the stop-waste rules API (routes/advertising-waste.routes.ts,
 * the RULES block): which rules the page's Rules view shows and of which kind, the two starters (PLAN §2 defaults), the
 * evidence a test carries, and the rule in one line.
 * No database and no clock of its own.
 *
 * The two kinds (D1, ads-graduation-stopwaste.ts):
 *   PAUSE_KEYWORD  TARGET_PERFORMANCE → pause_target (the pause keeps the keyword paused: the pause handler's lock)
 *   NEGATE_TERM    SEARCH_TERM_WASTING → add_negative_exact in the ad group (a phrase, or the whole campaign, always asks)
 * The Rules view also lists every other rule that pauses or unpauses a keyword or adds negatives (a Bid rule with THEN
 * Pause, a Negative Targeting builder rule, an engine rule): `kind` then names its family.
 */
import { stopWasteParamsOf, type StopWasteKind, type StopWasteParams } from '../ads-graduation-stopwaste.js'
import {
  FIXED_KEYWORD_SPEND_BAR_CENTS, FIXED_TERM_SPEND_BAR_CENTS, KEYWORD_CPA_BAR, MIN_CLICKS_FLOOR, TERM_CPA_BAR, WASTE_WINDOW_DAYS,
} from '../waste/pure.js'

export type { StopWasteKind, StopWasteParams }

// ── which rules are waste rules ─────────────────────────────────────────────────────────────────────────────────────

/** Produced action types that put a rule in the page's Rules view (a keyword's state, or a search term's negative). */
const PAUSE_FAMILY = new Set(['pause_target', 'enable_target'])
const NEGATE_FAMILY = new Set(['add_negative_exact', 'add_negative_phrase', 'sync_negatives_across_campaigns', 'isolate_product_terms'])

/** The family a rule belongs to on this page, from the action types it produces; null when it is not a waste rule. Pure. */
export function wasteKindOf(producedTypes: readonly string[]): StopWasteKind | null {
  if (producedTypes.some((t) => PAUSE_FAMILY.has(t))) return 'PAUSE_KEYWORD'
  if (producedTypes.some((t) => NEGATE_FAMILY.has(t))) return 'NEGATE_TERM'
  return null
}

// ── the test's evidence ─────────────────────────────────────────────────────────────────────────────────────────────
// ONE test for the page and the rules (review S2): the window (waste/pure.ts wasteWindow: 60 click-days ending today − 3,
// orders through today), the numbers (windowNumbers, out-of-stock days: half or more of the ad group's SKUs out), the
// product's facts (waste/test.ts productFactsOf: conversion and order value pooled product → market, × the target ACoS)
// and the bar and its verdict (barFor, wasteTest). waste-rules/contexts.ts calls them; nothing here re-defines them.

/** The numbers one row's test read (the evidence a context carries as `stopWaste`, stored with its run). */
export interface StopWasteEvidence {
  kind: StopWasteKind
  windowDays: number
  /** First day counted, last day clicks and spend count (today − 3), last day orders count (today): YYYY-MM-DD. */
  from: string
  clicksThrough: string
  ordersThrough: string
  /** Days left out of clicks and spend because the ad group had nothing to sell (orders are never left out). */
  stockOutDays: number
  clicks: number
  orders: number
  spendCents: number
  clicksNeeded: number
  /** Null only for an Owner bar without a spend minimum. */
  spendBarCents: number | null
  /** The CPA multiple of the bar; null for a fixed bar. */
  xCpaBar: number | null
  targetCpaCents: number | null
  /** Spend ÷ the target cost per order; null without one. */
  xCpa: number | null
  /** The pooled conversion rate the clicks bar used; null when nothing is known. */
  cr: number | null
  /** Who set the bar: the rule's own numbers, the ads strategy's negate group, or the page's default. */
  source: 'rule' | 'strategy' | 'default'
  /** The page's sentence for the verdict (no amount in it). */
  sentence: string
  /** Set when the gate sent the change to a person instead of acting alone. */
  asks?: string
}

// ── the scope and the starters ──────────────────────────────────────────────────────────────────────────────────────

/** Where a waste rule acts: channel › market › portfolio › campaign › ad group (the most specific named), or a product. */
export interface WasteScope {
  marketplace?: string | null
  portfolioId?: string | null
  campaignId?: string | null
  adGroupId?: string | null
  productId?: string | null
  /** The whole account, said out loud. */
  wholeAccount?: boolean
}

/**
 * The two starters (PLAN §2 defaults): the numbers the Negative Targeting builder's "Stop waste — may run alone"
 * section opens on (GET /advertising/waste/rules/starters). Wave 4: a rule is made in the builder; nothing here saves one.
 */
export const STARTERS: ReadonlyArray<{ kind: StopWasteKind; windowDays: number; minClicks: number; cpaMultiple: number; spendFloorCents: number }> = [
  { kind: 'PAUSE_KEYWORD', windowDays: WASTE_WINDOW_DAYS, minClicks: MIN_CLICKS_FLOOR, cpaMultiple: KEYWORD_CPA_BAR, spendFloorCents: FIXED_KEYWORD_SPEND_BAR_CENTS },
  { kind: 'NEGATE_TERM', windowDays: WASTE_WINDOW_DAYS, minClicks: MIN_CLICKS_FLOOR, cpaMultiple: TERM_CPA_BAR, spendFloorCents: FIXED_TERM_SPEND_BAR_CENTS },
]

// ── the rule in one line ────────────────────────────────────────────────────────────────────────────────────────────

const plainCpa = (m: number) => `${Number.isInteger(m) ? m : m.toFixed(1)} × target cost per order`

/**
 * The rule in one line. A stop-waste rule says its test and its verb ("Keywords: 0 orders, clicks ≥ 20, spend ≥ 2 ×
 * target cost per order, 60 d → pause keyword, keep it paused"); any other waste rule says its trigger or conditions and its
 * action, through `fallback` (the Bid page's ruleSentence). Pure.
 */
export function wasteSentence(rule: { actions?: unknown; trigger?: string | null; conditions?: unknown }, fallback: (r: { trigger?: string | null; conditions?: unknown; actions?: unknown }) => string): string {
  const p = stopWasteParamsOf(rule.actions)
  if (!p) {
    const a0 = (Array.isArray(rule.actions) ? rule.actions[0] : null) as { type?: unknown } | null
    if (a0?.type === 'negative-targeting') return `Search terms: ${rule.trigger === 'SEARCH_TERM_WASTING' ? 'spend, no sales' : String(rule.trigger ?? '').toLowerCase()} → negative`
    return fallback(rule)
  }
  const a0 = (rule.actions as Array<{ type?: unknown; scope?: unknown }>)[0]
  const where = a0.scope === 'CAMPAIGN' ? ' in the campaign' : ''
  const verb = p.kind === 'PAUSE_KEYWORD' ? 'pause keyword, keep it paused' : a0.type === 'add_negative_phrase' ? `negative phrase${where}` : `negative exact${where}`
  const who = p.kind === 'PAUSE_KEYWORD' ? 'Keywords' : 'Search terms'
  return `${who}: 0 orders, clicks ≥ ${p.minClicks}, spend ≥ ${plainCpa(p.cpaMultiple)} (else a fixed bar), ${p.windowDays} d → ${verb}`
}
