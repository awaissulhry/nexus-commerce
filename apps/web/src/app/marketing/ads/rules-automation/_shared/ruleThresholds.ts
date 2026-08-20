/**
 * P2 — a rule's IF-side thresholds, read once and rendered two ways.
 *
 * Helium 10's Keyword Harvest grid carries dedicated threshold columns. Its KB describes the view
 * as showing *"the Order and Max ACoS Thresholds configured for each rule and whether the rule is
 * automated"*, and the operator's own study quotes the cells as "Min 3 Orders" and "Max 30% ACoS".
 * That settles a disagreement between the two studies of this section — the 12,285-frame study read
 * one combined `Criteria` cell — **in favour of both**: the thresholds get their own sortable
 * columns AND `Criteria` keeps whatever has no column of its own.
 *
 * 🔴 **This file is the ONE reader.** `RulesGrid` uses it for the Criteria clauses (P1) and for the
 * columns (P2), so a threshold cannot appear in one and not the other, and cannot be formatted two
 * ways on one screen. Two readers of one field is how the Ad Manager came to print a fabricated
 * 30.00% beside the truth ([[reference_shared_rule_column_cells]]).
 *
 * ⚠ **It is an allowlist, and must stay one.** The parameter census behind it
 * (`apps/api/scripts/_hvr-params.mts`, every action type in the account) is mostly THEN-side —
 * `reason`, `message`, `percent`, `target`, `campaignIds`, `floorCents`, `maxPct`. Rendering any of
 * those as a threshold would invent a criterion, which is the defect P1 removed.
 */
import { HARVEST_DEFAULTS } from '@nexus/shared/ads-rule-window'

export type ThresholdKey = 'minOrders' | 'minClicks' | 'minSpendCents' | 'maxAcosPct'

/** Where a threshold's number came from — the three states must never render the same. */
export type ThresholdSource =
  /** the rule stores it */
  | 'rule'
  /** the rule stores nothing and the handler falls back to a documented default */
  | 'default'
  /** nothing stores it and no default exists — the rule has no such ceiling at all */
  | 'none'

export interface ThresholdRead {
  value: number | null
  source: ThresholdSource
}

/**
 * Cents → euros, for every threshold and every condition clause on this grid.
 *
 * 🔴 Both decimals or none — never one. `maximumFractionDigits: 2` alone renders 1550 as **"€15.5"**,
 * which reads as a truncated number rather than a price (caught by this module's test, and the same
 * mistake P1 fixed on the graduation bid, where `0.5` printed as "€0.5"). A whole number of euros
 * keeps no decimals at all, because "€10.00" is noise on a threshold.
 *
 * Exported and re-used by `RulesGrid`'s `money()` so the Criteria clause and the threshold column
 * cannot format the same amount two ways in one row.
 */
export const eur = (cents: number) =>
  `€${(cents / 100).toLocaleString('en-IE', { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`

interface ThresholdSpec {
  /** the grid column header, where this key has a column */
  column: string
  /** the column header's (i) tip */
  columnTip: string
  /** the cell, when a number is known */
  cell: (v: number) => string
  /** the `Criteria` clause, when this key has NO column on the current tab */
  clause: (v: number) => string
  /** the handler fallback for an action that documents one, else null */
  fallback: (actionType: string) => number | null
  /**
   * What "no value" MEANS — never a bare dash. The operator's standing law is that "never ran" and
   * "nothing to do" must not render identically, and an absent ceiling is not a missing reading:
   * it is a rule with no ceiling, which is an operational fact worth a sentence.
   */
  absent: string
}

export const THRESHOLD_SPEC: Record<ThresholdKey, ThresholdSpec> = {
  minOrders: {
    column: 'Order Threshold',
    columnTip: 'How many orders a search term must have produced inside the rule’s lookback window before the rule will act on it.',
    cell: (v) => `Min ${v} order${v === 1 ? '' : 's'}`,
    clause: (v) => `≥ ${v} order${v === 1 ? '' : 's'}`,
    fallback: (t) => (t === 'harvest_and_negate' ? HARVEST_DEFAULTS.minOrders : null),
    absent: 'This rule names no order threshold, and its action has no documented default — whatever its trigger offers, it acts on.',
  },
  maxAcosPct: {
    column: 'Max ACoS',
    columnTip: 'The ACoS ceiling a search term must be under before the rule will promote it. Above this, the term is left alone.',
    cell: (v) => `Max ${v > 1 ? v : v * 100}%`,
    clause: (v) => `ACoS ≤ ${v > 1 ? v : v * 100}%`,
    fallback: () => null,
    /**
     * 🔴 Measured on prod 2026-08-20: **zero rules in the account carry `maxAcosPct`**, so this
     * sentence is what the whole column says today. It is the finding, not a blank: an ACoS
     * ceiling is the only condition standing between harvesting and buying unprofitable traffic,
     * and every harvest rule here is running without one.
     */
    absent: 'No ACoS ceiling. This rule will promote a converting search term however expensive that conversion was — order count is the only bar it has to clear.',
  },
  minSpendCents: {
    column: 'Spend Threshold',
    columnTip: 'How much a search term must have spent before the rule will act on it.',
    cell: (v) => `Min ${eur(v)}`,
    clause: (v) => `spend ≥ ${eur(v)}`,
    fallback: (t) => (t === 'harvest_and_negate' ? HARVEST_DEFAULTS.minSpendCents : null),
    absent: 'This rule names no spend threshold, and its action has no documented default.',
  },
  minClicks: {
    column: 'Click Threshold',
    columnTip: 'How many clicks a search term must have taken before the rule will act on it.',
    cell: (v) => `Min ${v} click${v === 1 ? '' : 's'}`,
    clause: (v) => `≥ ${v} click${v === 1 ? '' : 's'}`,
    fallback: () => null,
    absent: 'This rule names no click threshold, and its action has no documented default.',
  },
}

/** Stable reading order wherever thresholds are listed together. */
export const THRESHOLD_ORDER: ThresholdKey[] = ['minOrders', 'minClicks', 'minSpendCents', 'maxAcosPct']

/**
 * Which tabs promote thresholds out of `Criteria` into columns of their own.
 *
 * 🔴 Deliberately a per-tab **column set**, not a prop on the grid. `RulesGrid` is shared by ten
 * tabs and the house rule is that shared means exactly the same — a `showThresholds` prop would be
 * the first fork. Negative Targeting's own thresholds (H10 offers a Click Threshold and a Spend
 * Threshold there) are a one-line addition here when that page's unit runs; they are NOT declared
 * now, because a column nobody asked for is the decoration this programme keeps removing.
 */
export const RULE_TAB_THRESHOLDS: Record<string, ThresholdKey[]> = {
  'keyword-harvest': ['minOrders', 'maxAcosPct'],
}

/** Read one threshold off the action THIS tab is describing. */
export function readThreshold(action: Record<string, unknown> | null, key: ThresholdKey): ThresholdRead {
  const raw = action?.[key]
  if (typeof raw === 'number' && Number.isFinite(raw)) return { value: raw, source: 'rule' }
  const fallback = THRESHOLD_SPEC[key].fallback(String(action?.type ?? ''))
  return fallback == null ? { value: null, source: 'none' } : { value: fallback, source: 'default' }
}

/** Every threshold, for the row. */
export function readThresholds(action: Record<string, unknown> | null): Record<ThresholdKey, ThresholdRead> {
  return Object.fromEntries(
    THRESHOLD_ORDER.map((k) => [k, readThreshold(action, k)]),
  ) as Record<ThresholdKey, ThresholdRead>
}

/**
 * The `Criteria` clauses for the thresholds that do NOT have a column on this tab.
 *
 * This is what keeps the two renderings from duplicating each other on screen: a threshold is
 * either a column or a clause, never both. On a tab with no threshold columns — Bid, Negative
 * Targeting, Placement — every clause stays, so the same rule reads fully there. That the same
 * rule reads differently on two tabs is the established behaviour of this grid and is correct:
 * each tab describes the half of the rule that belongs to it.
 */
export function thresholdClauses(action: Record<string, unknown> | null, tabKey?: string): string[] {
  const columned = new Set(tabKey ? RULE_TAB_THRESHOLDS[tabKey] ?? [] : [])
  const out: string[] = []
  for (const key of THRESHOLD_ORDER) {
    if (columned.has(key)) continue
    const read = readThreshold(action, key)
    // Only a value the RULE stores becomes a clause. A handler fallback is not a criterion the
    // operator chose, and printing it as one is how "Always" got written in the first place —
    // `noCriteria` in RulesGrid states those separately, labelled as defaults.
    if (read.source === 'rule' && read.value != null) out.push(THRESHOLD_SPEC[key].clause(read.value))
  }
  return out
}

/** The defaults an action falls back to, for the tabs that have no column to show them in. */
export function defaultClauses(action: Record<string, unknown> | null, tabKey?: string): string[] {
  const columned = new Set(tabKey ? RULE_TAB_THRESHOLDS[tabKey] ?? [] : [])
  const out: string[] = []
  for (const key of THRESHOLD_ORDER) {
    if (columned.has(key)) continue
    const read = readThreshold(action, key)
    if (read.source === 'default' && read.value != null) out.push(THRESHOLD_SPEC[key].clause(read.value))
  }
  return out
}
