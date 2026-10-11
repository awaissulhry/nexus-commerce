/**
 * Negative Targeting page (2026-10-11) — the pure half of the stop-waste rules API (routes/advertising-waste.routes.ts,
 * the RULES block): which rules the page's Rules view shows and of which kind, the two starters (PLAN §2 defaults), a
 * page body as the engine rule it saves, the late-order-safe window, the test's bars, and the rule in one line.
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

// ── the rule's body ─────────────────────────────────────────────────────────────────────────────────────────────────

export type NegateMatch = 'EXACT' | 'PHRASE'
export type NegateLevel = 'AD_GROUP' | 'CAMPAIGN'

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

/** A stop-waste rule as the page (and Claude) sends it. */
export interface WasteRuleBody {
  kind: StopWasteKind
  name?: string
  scope?: WasteScope
  windowDays?: number
  minClicks?: number
  cpaMultiple?: number
  spendFloorCents?: number
  /** NEGATE_TERM: negative exact (default) or phrase (a phrase always asks). */
  match?: NegateMatch
  /** NEGATE_TERM: in the ad group it served in (default) or the whole campaign. */
  level?: NegateLevel
  /** The daily run's time in Rome, "HH:MM" (default 06:00). */
  runAt?: string
}

/** The two starters (PLAN §2 defaults). New rules are born at Watch. */
export const STARTERS: ReadonlyArray<Required<Pick<WasteRuleBody, 'kind' | 'name' | 'windowDays' | 'minClicks' | 'cpaMultiple' | 'spendFloorCents'>> & { id: string; match?: NegateMatch; level?: NegateLevel; says: string }> = [
  {
    id: 'stop-waste-keywords', kind: 'PAUSE_KEYWORD', name: 'Stop waste — keywords',
    windowDays: WASTE_WINDOW_DAYS, minClicks: MIN_CLICKS_FLOOR, cpaMultiple: KEYWORD_CPA_BAR, spendFloorCents: FIXED_KEYWORD_SPEND_BAR_CENTS,
    says: 'Our keyword: 0 orders (to today), clicks ≥ max(20, 3 ÷ conversion), spend ≥ 2 × target cost per order, 60 click-days to 3 days ago, no search under it sold → pause it and keep it paused. May run alone on Auto.',
  },
  {
    id: 'stop-waste-search-terms', kind: 'NEGATE_TERM', name: 'Stop waste — search terms',
    windowDays: WASTE_WINDOW_DAYS, minClicks: MIN_CLICKS_FLOOR, cpaMultiple: TERM_CPA_BAR, spendFloorCents: FIXED_TERM_SPEND_BAR_CENTS, match: 'EXACT', level: 'AD_GROUP',
    says: 'A shopper\'s search: 0 orders (to today), clicks ≥ max(20, 3 ÷ conversion), spend ≥ 1.5 × target cost per order, 60 click-days to 3 days ago → negative exact in the ad group it served in. May run alone on Auto.',
  },
]

/** The account-wide harvest wire a negative exact rides (ads-harvest-wire.ts): the source ad group, row + audit row + undo. */
const SOURCE_WIRE = { blocks: null, filters: { containsAny: [], notContains: [], brandExclude: [], competitorOnly: false }, dedupe: true } as const

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/

/** Problems with a body, in words; empty when it can be saved. Pure. */
export function bodyProblems(b: WasteRuleBody): string[] {
  const out: string[] = []
  if (b.kind !== 'PAUSE_KEYWORD' && b.kind !== 'NEGATE_TERM') out.push('kind: PAUSE_KEYWORD or NEGATE_TERM')
  if (b.name != null && (!b.name.trim() || b.name.length > 120)) out.push('name: at most 120 characters')
  const num = (key: keyof WasteRuleBody, lo: number, hi: number) => {
    const v = b[key]
    if (v != null && (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi)) out.push(`${key}: a number from ${lo} to ${hi}`)
  }
  num('windowDays', 14, 87)
  num('minClicks', 1, 10_000)
  num('cpaMultiple', 0.5, 10)
  num('spendFloorCents', 1, 10_000_000)
  if (b.runAt != null && !HHMM.test(b.runAt)) out.push('runAt: a time "HH:MM" (Rome)')
  if (b.kind === 'PAUSE_KEYWORD' && (b.match != null || b.level != null)) out.push('match and level are for a search-term rule (NEGATE_TERM)')
  if (b.match != null && b.match !== 'EXACT' && b.match !== 'PHRASE') out.push('match: EXACT or PHRASE')
  if (b.level != null && b.level !== 'AD_GROUP' && b.level !== 'CAMPAIGN') out.push('level: AD_GROUP or CAMPAIGN')
  const s = b.scope ?? {}
  const named = !!(s.marketplace || s.portfolioId || s.campaignId || s.adGroupId || s.productId)
  if (!named && s.wholeAccount !== true) out.push('scope: name the market, portfolio, campaign, ad group or product it may act on, or say wholeAccount: true')
  if (named && s.wholeAccount === true) out.push('scope: wholeAccount and a narrower scope at once — say one')
  if (s.portfolioId && (s.campaignId || s.adGroupId)) out.push('scope: a portfolio and a campaign or ad group at once — name one')
  return out
}

/** The engine rule a body saves as (engine-native: flat conditions, one action carrying its stop-waste test). Pure. */
export function ruleOfBody(b: WasteRuleBody): {
  name: string
  trigger: 'TARGET_PERFORMANCE' | 'SEARCH_TERM_WASTING'
  conditions: Array<{ field: string; op: string; value: number }>
  actions: Array<Record<string, unknown>>
  params: StopWasteParams
} {
  const starter = STARTERS.find((s) => s.kind === b.kind)!
  const params = stopWasteParamsOf([{ stopWaste: {
    kind: b.kind,
    windowDays: b.windowDays ?? starter.windowDays,
    minClicks: b.minClicks ?? starter.minClicks,
    cpaMultiple: b.cpaMultiple ?? starter.cpaMultiple,
    spendFloorCents: b.spendFloorCents ?? starter.spendFloorCents,
  } }])!
  const [hh, mm] = (b.runAt && HHMM.test(b.runAt) ? b.runAt : '06:00').split(':')
  const schedule = { frequency: 'Daily', time: `${hh.padStart(2, '0')}:${mm}`, timezone: 'cet' }
  const stopWaste = { ...params }
  if (b.kind === 'PAUSE_KEYWORD') {
    return {
      name: b.name?.trim() || starter.name,
      trigger: 'TARGET_PERFORMANCE',
      conditions: [{ field: 'adTarget.orders', op: 'eq', value: 0 }, { field: 'adTarget.clicks', op: 'gte', value: params.minClicks }],
      actions: [{ type: 'pause_target', keepPaused: true, stopWaste, schedule, reason: 'Stop waste — keyword paused, kept paused' }],
      params,
    }
  }
  const level: NegateLevel = b.level ?? 'AD_GROUP'
  const phrase = b.match === 'PHRASE'
  return {
    name: b.name?.trim() || starter.name,
    trigger: 'SEARCH_TERM_WASTING',
    conditions: [{ field: 'searchTerm.orders', op: 'eq', value: 0 }, { field: 'searchTerm.clicks', op: 'gte', value: params.minClicks }],
    actions: [phrase
      // A phrase negative: the single-scope path (match type from the action).
      ? { type: 'add_negative_phrase', scope: level, stopWaste, schedule, reason: 'Stop waste — search term negated (phrase)' }
      // A negative exact rides the account-wide wire: in the source ad group (or its campaign), mirrored with its audit row.
      : { type: 'add_negative_exact', scope: level, levels: [level], negative: SOURCE_WIRE, stopWaste, schedule, reason: 'Stop waste — search term negated (exact)' }],
    params,
  }
}

/** The body a stored stop-waste rule was saved from (for an edit that changes part of it); null for any other rule. Pure. */
export function bodyOfRule(rule: { name: string; actions: unknown; scope: WasteScope }): WasteRuleBody | null {
  const p = stopWasteParamsOf(rule.actions)
  if (!p) return null
  const a0 = (Array.isArray(rule.actions) ? rule.actions[0] : {}) as { type?: unknown; scope?: unknown; schedule?: { time?: unknown } }
  return {
    kind: p.kind, name: rule.name, scope: rule.scope,
    windowDays: p.windowDays, minClicks: p.minClicks, cpaMultiple: p.cpaMultiple, spendFloorCents: p.spendFloorCents,
    ...(p.kind === 'NEGATE_TERM' ? { match: a0.type === 'add_negative_phrase' ? 'PHRASE' as const : 'EXACT' as const, level: a0.scope === 'CAMPAIGN' ? 'CAMPAIGN' as const : 'AD_GROUP' as const } : {}),
    ...(typeof a0.schedule?.time === 'string' ? { runAt: a0.schedule.time } : {}),
  }
}

// ── the rule in one line ────────────────────────────────────────────────────────────────────────────────────────────

const plainCpa = (m: number) => `${Number.isInteger(m) ? m : m.toFixed(1)} × target cost per order`

/**
 * The rule in one line. A stop-waste rule says its test and its verb ("Keywords: 0 orders, clicks ≥ 20, spend ≥ 2 ×
 * target cost per order, 60 d → pause, keep paused"); any other waste rule says its trigger or conditions and its
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
  const verb = p.kind === 'PAUSE_KEYWORD' ? 'pause, keep paused' : a0.type === 'add_negative_phrase' ? `negative phrase${where}` : `negative exact${where}`
  const who = p.kind === 'PAUSE_KEYWORD' ? 'Keywords' : 'Search terms'
  return `${who}: 0 orders, clicks ≥ ${p.minClicks}, spend ≥ ${plainCpa(p.cpaMultiple)} (else a fixed bar), ${p.windowDays} d → ${verb}`
}
