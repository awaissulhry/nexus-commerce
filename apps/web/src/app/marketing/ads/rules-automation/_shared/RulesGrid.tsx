'use client'

/**
 * U0 — THE rules grid, in Helium 10's shape. One implementation for every rule-type tab.
 *
 * Study: `docs/2026-08-16-ra-h10-reference-study.md` §2/§3 (measured frame-by-frame from the
 * operator's recording) and §5.2 (the same columns, read out of H10's own JS bundle). A rule-type
 * tab in H10 is ONE card and nothing else:
 *
 *   "Showing 0 Bid Rules" 🔍                                                        [+ Rule]
 *   ☐ · Bid Rule ⇅ · Criteria · Frequency · Automation · Actions
 *   (empty) illustration · "Create a Bid Rule to generate suggestions for a campaign!" · Create Rule
 *   ‹ 1 ›                                                                Rows per page: 100
 *
 * 🔴 **B1 (2026-08-20) — the column set is the UNION of two studies that disagree, deliberately.**
 * The operator's 2026-08-20 study of H10's Bid tab reads the grid as *Rule Name · Lookback Period ·
 * Frequency · Automate · Actions(🗑)*. The frame-by-frame study of the operator's own recording
 * (`docs/2026-08-16-ra-h10-reference-study.md` §3.2 · §5.2, 12,285 frames) reads it as *☐ · ⋮ ·
 * Rule ⇅ · Automation · Criteria · Frequency*, with Lookback living inside the builder's criteria
 * card. Rather than pick a winner, the grid carries both: Criteria stays (it is the most useful
 * cell here), and the study's Actions column lands in B1 with Lookback following in B2 — where it
 * has to be DERIVED, because no rule stores a lookback (see the Frequency cell's note below for
 * the same class of problem, already solved this way once).
 *
 * This is a PROMOTION, not a rewrite: the body is `tabs/RuleListTab.tsx` — the grid this section
 * already had and mounted nowhere — with its seed/placeholder half removed (every row is live now),
 * `onAddRule` replaced by the builder href H10 links to, and the two states RuleListTab silently
 * conflated split apart (see below). `HistoryDrawer` stays where it is and is imported: Automations
 * imports it from there too, and moving a file two sessions read is churn this unit does not need.
 *
 * 🔴 Three properties worth keeping when you touch this:
 * ① **Membership is `ruleBelongsToTab`** — the SAME predicate the tab badge counts with. Sharing a
 *    predicate is not sharing a fetch, though: the badges are one per-session fetch refreshed by
 *    `ads.rule.changed`, so every write here emits it (U3 — measured: a delete left the grid at 0
 *    and the badge at 1). `keyword-tracker`, `dayparting` and `budget-schedules` still have NO
 *    entry in `RULE_TAB_ACTION_TYPES`, so this grid is empty-by-construction on them until their
 *    unit adds one, the way U3 added `share-of-voice`. Check before mounting it there.
 * ② **A failed read never renders as an empty list.** RuleListTab caught its fetch and set `[]`,
 *    so a 500 looked exactly like "no rules yet" — the operator's standing law that "never ran"
 *    and "nothing to do" must never render the same. The error is now its own state, and the
 *    skeleton (`loading`) covers the fetch so the empty state is only ever the truth.
 * ③ **The Automation toggle WRITES THE LEVEL, for BOTH rule shapes** (BP.P1, 2026-08-21). The
 *    mode is `autonomyLevel` + `enabled` — `resolveAutonomy` reads nothing else — so both shapes
 *    go through `PATCH /advertising/autonomy/rules/:id`, the same route the Automations page's
 *    mode dial uses. A builder rule ADDITIONALLY keeps its `actions[0].control` belt in step
 *    (belt first when arming, rolled back on a 409), because control='manual' forces the propose
 *    path at any level. The pre-P1 builder branch wrote `control` alone — a field the engine's
 *    mode never consults — so on the shape every rule now takes (post-W7, all rules are
 *    builder-authored) the toggle rendered On and armed nothing. Optimistic, reverts on failure.
 *
 *    🔴 Until 2026-08-19 the engine branch did not exist: the toggle rendered `disabled` and
 *    called that honesty. It was not — **zero builder rules exist in this account** (measured on
 *    prod: 51 of 51 rules are engine rules), so the column was inert on every row of all eleven
 *    tabs, and the operator's read was simply "the toggle is broken". A control that is dead for
 *    100% of the data is not a careful refusal, it is a missing feature.
 *
 *    On = `AUTO` (acts on its own, inside its daily cap and the write gate). Off = `PROPOSE`
 *    (queues suggestions; nothing reaches Amazon until accepted) — the same two words the builder
 *    branch means by automate/manual, so one column means one thing.
 *
 *    ⚠ Two properties of that route, both deliberate and neither ours to override: it keeps
 *    `enabled` and `dryRun` in step with the level (so `level !== 'OFF'` ENABLES a disabled rule —
 *    the toggle says so before you click), and it refuses a level above the rule's graduation
 *    ceiling with a 409. Structural actions — creating keywords, negatives, pausing — are capped
 *    below AUTO by policy, so those toggles render disabled carrying the ceiling's own sentence
 *    rather than failing on click. 14 of 51 rules are capped that way today.
 *
 * 🔴 ⑤ **A control that carries a REASON must never use the `disabled` attribute.** U13,
 *    2026-08-19, reported from Keyword Harvest — where all five rules are capped, so all five
 *    toggles were `disabled`. A disabled control **cannot deliver an explanation**: it takes no
 *    focus (so it is unreachable by keyboard), takes no click, and Chrome renders no `title`
 *    tooltip on one. Measured, coordinate-free — `b.disabled = true; b.focus()` leaves
 *    `document.activeElement` elsewhere, while the held form below focuses normally and a real
 *    Enter produced the ceiling's sentence with zero writes. The reason was written onto the one
 *    element in the DOM that cannot deliver it, so U12 fixed "the toggle does nothing" into
 *    "the toggle does nothing and won't say why" for 14 of 44 rows.
 *
 *    The shape to copy: `aria-disabled` + a `held` class for the look, the handler refusing and
 *    **answering** (`setNotice`) instead of writing, and `disabled` reserved for states that need
 *    no explanation. Hover explains, click explains, keyboard focus explains. `scripts/check-silent-disabled.mjs`
 *    ratchets the count under `rules-automation` so this cannot creep back — the same sweep found
 *    the Automations mode dial had been silently refusing 14 notches the whole time.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Toggle, ToolbarButton } from '@/design-system/primitives'
import { Modal } from '@/design-system/components'
import dynamic from 'next/dynamic'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, Clock, ExternalLink, Plus, Trash2 } from 'lucide-react'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'
import { ruleLookback, ACTION_WINDOW, HARVEST_DEFAULTS, type RuleLookback } from '@nexus/shared/ads-rule-window'
import {
  RULE_TAB_THRESHOLDS, THRESHOLD_SPEC, readThreshold, readThresholds, thresholdClauses, defaultClauses, eur,
  columnedConditionIndexes, type ThresholdKey, type ThresholdRead, type RuleCondition,
} from './ruleThresholds'
import { PC_METRIC_UNIT } from './PerformanceCriteria'
import { getBackendUrl } from '@/lib/backend-url'
import { ruleBelongsToTab, RULE_TAB_ACTION_TYPES } from './tabs'
import { placementThenSentence } from './placementLanes'
import { RULE_TYPES } from './ruleTypes'
import { RuleTypeModal } from './RuleTypeModal'
import { NoDataIllus } from './NoDataIllus'
import { HistoryDrawer } from '../tabs/RuleListTab'
import { emitAdsChange, useAdsSync } from './adsBus'

/**
 * B5 — the rule builder, mounted OVER this grid rather than navigated to.
 *
 * Lazy on purpose. `RuleBuilder.tsx` is ~94 KB of source and was previously only in the
 * `/builder/<slug>` route's chunk; importing it eagerly here would put it in the first-load bundle
 * of all seven rule-type tabs to serve a panel most visits never open.
 *
 * `ssr: false` because it reads `useSearchParams` and paints a fixed overlay — there is nothing
 * useful to render on the server for a panel that is closed on arrival.
 */
const RuleBuilder = dynamic(() => import('./RuleBuilder').then((m) => m.RuleBuilder), { ssr: false })

const BUILDER_SLUGS = new Set(RULE_TYPES.map((r) => r.slug))

/** A builder rule carries its builder slug as `actions[0].type`; an engine rule carries a real action type. */
const isBuilderRule = (rule: Record<string, unknown> | undefined): boolean => {
  const a0 = (Array.isArray(rule?.actions) ? rule!.actions[0] : null) as { type?: string } | null
  return !!a0?.type && BUILDER_SLUGS.has(a0.type)
}

interface RuleRow {
  id: string
  name: string
  automation: boolean
  /** engine rules only — the autonomy level the toggle is reporting */
  level: string
  enabled: boolean
  criteria: string
  /** P1 — the Criteria cell's tooltip. The cell used to be its own title, so "Always" was unexplainable. */
  criteriaWhy: string
  /** P2 — every IF-side threshold on the action this tab describes, with where each number came from. */
  thresholds: Record<ThresholdKey, ThresholdRead>
  freqDay: string
  freqTime: string
  /** B2 — the window this rule actually reads, derived; see `@nexus/shared/ads-rule-window`. */
  look: RuleLookback
}

/**
 * 🔴 TWO rule shapes live behind one grid, and rendering either as the other invents facts.
 * Measured on prod 2026-08-16 (all 18 bid rules are engine rules; zero builder rules exist yet):
 *
 * · **Builder rule** (made in `/builder/<slug>`): `conditions` is a list of GROUPS
 *   `{conditions:[{metric,op,value}], action:{op,value}}`; `actions[0]` carries `control`
 *   ('manual'|'automate') and `schedule` {frequency,time}. Frequency is a real, stored fact.
 * · **Engine rule** (the fleet's own rows): `conditions` is FLAT — `{field,op,value}` — `actions[0]`
 *   is a real action type with its own parameters, there is **no `control` and no `schedule`**, and
 *   the mode is `autonomyLevel`. Its cadence is the engine's cron, named by `trigger`.
 *
 * The first cut of this grid read only the builder shape, so on prod it printed "—" as the Criteria
 * of all 18 rows and a fabricated "Daily · 12:00 AM" as the Frequency of rules that have no
 * schedule at all — [[reference_fleet_stale_constant_class]] exactly. Both cells now read what the
 * row actually stores, and say so when it stores nothing.
 */
const OP_SYM: Record<string, string> = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' }
const ACTION_VERB: Record<string, string> = { set: 'Set', incPct: '+', decPct: '−', incAbs: '+€', decAbs: '−€' }

/** `campaign.acos` → `ACoS`; `adTarget.spendCents` → `spend`. The stored field, made readable. */
const FIELD_LABEL: Record<string, string> = {
  'campaign.acos': 'ACoS', 'campaign.roas': 'ROAS', 'campaign.spendCents': 'campaign spend',
  'campaign.budgetUtilization': 'budget used', 'adTarget.spendCents': 'spend',
  'adTarget.salesCents': 'sales', 'adTarget.impressions': 'impressions', 'adTarget.ctr': 'CTR',
  'adTarget.clicks': 'clicks', 'adTarget.ordersCount': 'orders', 'searchTerm.orders': 'search-term orders',
  'profit.netCents': 'net profit', 'budget.monthlySpendCents': 'monthly spend',
  'fbaAge.daysToLtsThreshold': 'days to LTS',
}
/** The action type, as the sentence H10 puts in the Criteria cell after the arrow. */
const ACTION_LABEL: Record<string, string> = {
  bid_to_target_acos: 'bid to target ACoS', bid_up: 'raise bid', bid_down: 'lower bid',
  lower_bid_to_floor: 'lower bid to floor', raise_bids_for_rank_defense: 'raise bids to defend rank',
  adjust_ad_budget: 'adjust budget', set_placement_multiplier: 'set placement modifier',
  defend_top_of_search: 'defend top of search', promote_to_exact: 'promote to exact',
  harvest_and_negate: 'harvest and negate', add_negative_exact: 'add negative exact',
  add_negative_phrase: 'add negative phrase', sync_negatives_across_campaigns: 'sync negatives',
  archive_keyword: 'archive keyword', pause_campaign: 'pause campaign', pause_ad_group: 'pause ad group',
  // C2 — the Bid tab's status verbs.
  pause_target: 'pause the target', enable_target: 'unpause the target', bid_apply: 'adjust bid',
  pause_all_campaigns: 'pause every campaign', refresh_dayparting: 'refresh dayparting',
  create_amazon_promotion: 'create promotion', retail_guard: 'retail guard',
  notify: 'notify', alert_operator: 'alert the operator',
}
/** An engine rule's cadence is its trigger, not a schedule. */
const TRIGGER_LABEL: Record<string, string> = {
  SCHEDULE: 'On schedule', CAC_SPIKE: 'On CAC spike', CVR_DROP: 'On CVR drop',
  AD_TARGET_UNDERPERFORMING: 'On underperformance', KEYWORD_LOW_CTR: 'On low CTR',
  KEYWORD_WASTED_SPEND: 'On wasted spend', KEYWORD_ZERO_IMPRESSIONS: 'On zero impressions',
  AD_SPEND_PROFITABILITY_BREACH: 'On profit breach', CAMPAIGN_PERFORMANCE_BUDGET: 'On budget pressure',
  // U5 — the last three the account actually uses. Measured on prod: the enum has twelve values and
  // this map had nine, so `SEARCH_TERM_CONVERTING` rendered as a bare lower-case "search term
  // converting" beside neighbours reading "On wasted spend".
  SEARCH_TERM_CONVERTING: 'On a converting term', KEYWORD_HIGH_ACOS: 'On high ACoS',
  FBA_AGE_THRESHOLD_REACHED: 'On stock ageing',
}
/** An unmapped trigger still reads like its neighbours rather than shouting its enum. */
const humanTrigger = (t: string) => TRIGGER_LABEL[t] ?? (t ? `On ${t.toLowerCase().replace(/_/g, ' ')}` : 'No trigger')

/**
 * P2 — one money formatter for this grid, in `./ruleThresholds`.
 *
 * 🔴 It had `maximumFractionDigits: 2` and no minimum, so €15.50 rendered as **"€15.5"**. Latent
 * only because no rule in the account stores a non-round cent amount today; a Criteria clause and a
 * threshold column formatting the same €15.50 two different ways in one row is what the shared
 * reader exists to prevent.
 */
const money = eur

/**
 * 🔴 A ratio field is stored BOTH ways and the grid must not pick one.
 * Measured on prod 2026-08-16: `bid_to_target_acos.targetAcos` is `0.3` on most rules and **`30`**
 * on "AIREON — Target ACoS bidding" — the same 30-as-a-whole-number that
 * `PUT /campaigns/:id/goal` already refuses ([[project_bid_page_bid_series]]). Multiplying blindly
 * printed "3000%". `> 1` therefore means "already a percentage"; `<= 1` means a fraction.
 * Small fractions keep their decimals: a CTR floor of 0.002 is 0.2%, not the "0%" a round() gives.
 */
const asPercent = (n: number): string => {
  const p = n > 1 ? n : n * 100
  const s = p >= 10 ? p.toFixed(0) : p.toFixed(2).replace(/\.?0+$/, '')
  return `${s}%`
}
const isRatioField = (raw: string) => /acos|ctr|cvr|utilization|roas/i.test(raw)

/**
 * One stored condition → one readable clause, in the units the field is stored in.
 *
 * 🔴 A BUILDER leaf names its metric ("Spend"), not a field path ("adTarget.spendCents"), so the
 * path-shaped tests below cannot read its unit: `/Cents$/` misses, `isRatioField` misses, and the
 * clause printed a bare number — measured on prod 2026-08-21 as **"Spend ≥ 5"** on the armed budget
 * pilot, beside a correctly-suffixed "Budget Utilization ≤ 10%" (that one only works because
 * `isRatioField` happens to match the word "utilization"). Sales, CPC and Current Bid were wrong
 * the same way. A number on screen in no unit is exactly what the operator has ruled out.
 *
 * `PC_METRIC_UNIT` is the builder's OWN map (metric → 'eur' | 'pct' | ''), so the cell and the input
 * the operator typed into cannot disagree.
 *
 * ⚠ Builder values are stored in DISPLAY units — "5" means €5, "10" means 10% — while `money()` is
 * the grid's ONE euro formatter and takes CENTS. So a builder euro is multiplied by 100 on the way
 * in rather than formatted separately: the first cut of this fix printed **"Spend ≥ €0.05"**, which
 * is a different wrong answer from the missing "€" it replaced. `asPercent` needs no conversion —
 * it already reads a number above 1 as a whole percent.
 */
function clause(c: { field?: string; metric?: string; op?: string; value?: unknown }): string {
  const raw = String(c.field ?? c.metric ?? '')
  if (!raw) return ''
  const label = FIELD_LABEL[raw] ?? raw.split('.').pop() ?? raw
  const n = typeof c.value === 'number' ? c.value : Number(c.value)
  const builderUnit = c.metric != null && c.field == null ? PC_METRIC_UNIT[String(c.metric)] : undefined
  const v = Number.isFinite(n)
    ? (builderUnit !== undefined
      ? (builderUnit === 'eur' ? money(Math.round(n * 100)) : builderUnit === 'pct' ? asPercent(n) : String(n))
      : /Cents$/i.test(raw) ? money(n)
      : /roas/i.test(raw) ? String(n)
      : isRatioField(raw) ? asPercent(n)
      : String(n))
    : String(c.value ?? '')
  return `${label} ${OP_SYM[String(c.op)] ?? String(c.op ?? '')} ${v}`.trim()
}

/**
 * 🔴 PLC-P3 — `placeTarget`, not `target`. The declared field name did not exist on the stored
 * shape (the builder writes `conditions[].action.placeTarget`), so it was unreadable by
 * construction — a typed field that can never hold anything is worse than an absent one, because
 * it reads as "already handled".
 */
interface BuilderGroup { conditions?: Array<{ metric?: string; op?: string; value?: string }>; action?: { op?: string; value?: string; placeTarget?: string } }

/**
 * The Criteria cell — one line for either shape, the way H10 truncates it ("PPC Orders>=1, S…").
 *
 * 🔴 `tabKey` decides WHICH action is summarised, and it matters on a multi-action rule. Membership
 * is "any action belongs to this tab", so "Daily automation digest" — actions `[bid_to_target_acos,
 * harvest_and_negate, alert_operator]` — lists on Negative Targeting because of its SECOND action,
 * and summarising `actions[0]` had it explaining a bid change on the negatives tab (measured on
 * prod, U5). The line now describes the action that put the rule on the tab you are looking at;
 * the same rule therefore reads differently on Bid and on Negative Targeting, which is correct —
 * it does both.
 */
/**
 * 🔴 P1 — an engine rule's thresholds do not have to be in `conditions`.
 *
 * Measured on prod 2026-08-20: **24 of 51 advertising rules store `conditions: []`**, and on the
 * Keyword Harvest tab four of five do — while keeping `minOrders`, `minSpendCents` and
 * `windowDays` on the ACTION. `summariseRule` read only `conditions`, fell through to its
 * `if (!ifs)` branch, and printed **"Always → harvest and negate"** on a rule that fires at ≥2
 * orders and ≥€10 over 60 days. "Always" is not a vaguer way of saying that; it is the opposite
 * of it, and it is the fabricated-cell class this section has now shipped three times
 * ([[reference_fleet_stale_constant_class]]).
 *
 * The allowlist, its formatting and its handler fallbacks all live in `./ruleThresholds` — P2
 * moved them there so the Criteria clauses and the threshold COLUMNS read one table. Two readers
 * of one field is how the Ad Manager came to print a fabricated 30.00% beside the truth
 * ([[reference_shared_rule_column_cells]]).
 *
 * 🔴 `thresholdClauses` omits whatever has a column on the current tab, so a threshold is a column
 * **or** a clause and never both. On Keyword Harvest the order threshold is a column and drops out
 * of this sentence; on Negative Targeting, where it has no column, it stays in it.
 */

/**
 * What an engine rule with NO criteria of its own is actually bound by — never "Always".
 *
 * Three genuinely different answers, and collapsing them was what made the old cell wrong:
 * · the action has documented defaults (`harvest_and_negate`) — name them, and say nobody chose them;
 * · the trigger selects the rows (`KEYWORD_WASTED_SPEND`, `CAC_SPIKE`, …) — so the criterion is the
 *   trigger's own query, which the Frequency and Lookback cells already describe;
 * · `SCHEDULE` selects nothing at all — marketplace and month-to-date spend, no campaign, no
 *   keyword. That rule really does act without reading anything, and it is the only case where
 *   the honest word is close to "always".
 */
function noCriteria(action: Record<string, unknown> | null, trigger: string, tabKey?: string): { text: string; why: string } {
  const actionType = String(action?.type ?? '')
  if (actionType === 'harvest_and_negate') {
    const d = HARVEST_DEFAULTS
    // Only the defaults with no column of their own — the columned ones say "default" themselves.
    const shown = defaultClauses(action, tabKey)
    return {
      text: shown.length ? `Defaults: ${shown.join(' · ')}` : 'Defaults — nothing set on this rule',
      why: `This rule sets no thresholds of its own, so the harvest handler's defaults decide: at least ${d.minOrders} orders to graduate a term, and at least ${money(d.minSpendCents)} of spend with no orders to negate one, over ${d.windowDays} days. Those are fallbacks in automation-action-handlers.ts, not values anyone chose here — open the rule to set your own.`,
    }
  }
  if (trigger === 'SCHEDULE') {
    return {
      text: 'No criteria — runs on the clock',
      why: 'This rule states no conditions and its trigger selects nothing: a SCHEDULE context carries the marketplace and month-to-date spend, with no campaign, keyword or window. It acts every time it fires, on whatever its action decides for itself.',
    }
  }
  return {
    text: 'Any row its trigger selects',
    why: `This rule states no conditions of its own, so every row its trigger offers is acted on. What the trigger selects — and over what window — is in the Frequency and Lookback cells beside this one. That is a rule with one filter, not a rule with none.`,
  }
}

/**
 * The Criteria cell, and the sentence behind it.
 *
 * P1 split these apart. The cell used to be its own `title`, so a row reading "Always" could not
 * explain itself at all — and the rows that most needed explaining were exactly the ones whose
 * criterion was not in `conditions`.
 */
interface RuleCriteria { text: string; why: string }

/**
 * The action a given tab is describing — the one whose type put the rule on that tab, falling back
 * to `actions[0]`.
 *
 * Extracted in P2 because a second cell now needs it. It was inline in `summariseRule`, and the
 * Criteria cell and the threshold columns reading the action by two different rules is exactly how
 * one rule comes to describe two different halves of itself in one row.
 */
function tabActionOf(rule: Record<string, unknown>, tabKey?: string): Record<string, unknown> | null {
  const actions = (Array.isArray(rule.actions) ? rule.actions : []) as Array<Record<string, unknown>>
  const want = tabKey ? RULE_TAB_ACTION_TYPES[tabKey] : undefined
  return (want ? actions.find((a) => want.includes(String(a?.type ?? ''))) ?? actions[0] : actions[0]) ?? null
}

function summariseRule(rule: Record<string, unknown>, tabKey?: string): RuleCriteria {
  const conds = Array.isArray(rule.conditions) ? rule.conditions : []
  const a0 = tabActionOf(rule, tabKey)
  const nested = conds.length > 0 && !!conds[0] && typeof conds[0] === 'object' && 'conditions' in (conds[0] as object)

  if (nested) {
    const g = conds[0] as BuilderGroup
    const ifs = (g.conditions ?? []).map((c) => clause(c)).filter(Boolean).join(', ')
    const a = g.action
    if (!a?.op) return { text: ifs || 'No conditions', why: ifs ? `This rule fires when ${ifs}. It carries no action value to describe.` : 'This rule was saved from the builder with no conditions and no action value.' }
    // The THEN value's unit comes from the rule TYPE, not the operator: a placement rule sets a
    // percentage where every other builder type sets money. "Set 0.30" (no unit) is the kind of
    // number an operator has to guess at, so the unit is always printed.
    const pctOp = a.op === 'incPct' || a.op === 'decPct'
    const pctType = String(a0?.type ?? '') === 'placement'
    const v = String(a.value ?? '')
    /**
     * C1 — the two COMPUTED ops read as sentences, not as arithmetic. `setCpc` carries no value
     * at all, so falling through to the generic branch would have printed a bare "setCpc" beside
     * an empty string — the raw-enum cell this file has fixed twice before.
     */
    /**
     * 🔴 PLC-P3 — a placement THEN NAMES ITS LANE, and reads as a sentence.
     *
     * `Set 50%` was rendered for all three lanes, so "Top of Search Set to 50%", "Product Pages
     * Set to 50%" and "Rest of Search Set to 50%" were one indistinguishable cell. The lane is not
     * a detail of a placement rule — it IS the rule. (The API's own `describeAction` had been
     * printing it all along; the two disagreed.)
     */
    const then = a.op === 'pauseTarget' ? 'Pause the target'
      : a.op === 'enableTarget' ? 'Unpause the target'
      : a.op === 'setCpc' ? 'Set bid to measured CPC'
      : a.op === 'targetAcos' ? `Set bid to CPC × (${v}% ÷ actual ACoS)`
      // BP.P4 — the two computed ops that joined H10's grammar; both read as sentences, never enums.
      : a.op === 'revPerClick' ? 'Set bid to revenue per click'
      : a.op === 'curBidTargetAcos' ? `Set bid to current bid × (${v}% ÷ actual ACoS)`
      : pctType
      ? placementThenSentence(a.op, v, a.placeTarget)
      : a.op === 'set'
      ? `Set €${v}`
      : pctOp ? `${ACTION_VERB[a.op]}${v}%`
      : `${ACTION_VERB[a.op] ?? a.op}${v}`
    /**
     * BP.P4b — a multi-block rule says so. The cell summarises the FIRST block (the one the
     * engine checks first); pretending it is the whole rule hid every later block's IF→THEN.
     */
    const extra = conds.length > 1 ? ` · +${conds.length - 1} more` : ''
    const blocksWhy = conds.length > 1
      ? ` This rule has ${conds.length} criteria blocks, checked in order — the first block whose conditions match acts. Open the rule to see the others.`
      : ''
    return {
      text: (ifs ? `${ifs} → ${then}` : then) + extra,
      why: (ifs ? `This rule fires when ${ifs}, and then: ${then}.` : `This rule states no conditions, so it applies "${then}" to everything in its scope every time it runs.`) + blocksWhy,
    }
  }

  // engine shape: flat conditions + a real action type with its own parameters
  /**
   * 🔴 Drop the conditions this tab has promoted into threshold COLUMNS — a threshold is a column
   * or a clause, never both, and it holds for conditions exactly as it holds for action parameters.
   *
   * The first cut of P2 read parameters only, so "Auto match-type migration" — which keeps its bar
   * as `{searchTerm.orders gte 2}` rather than as `minOrders` — rendered an Order Threshold of "—"
   * with the tooltip "This rule names no order threshold" **directly beside** a Criteria cell
   * reading "search-term orders ≥ 2". Measured on prod, 1 of 5 rows.
   */
  const flat = conds as RuleCondition[]
  const skip = columnedConditionIndexes(flat, tabKey)
  const hadConditions = flat.length > 0
  const ifs = flat.map((c, i) => (skip.has(i) ? '' : clause(c))).filter(Boolean).join(', ')
  const type = String(a0?.type ?? '')
  let then = ACTION_LABEL[type] ?? type.replace(/_/g, ' ')
  if (type === 'bid_to_target_acos' && typeof a0?.targetAcos === 'number') then += ` ${asPercent(a0.targetAcos as number)}`
  if (type === 'bid_up' && a0?.bidUpPct != null) then += ` +${a0.bidUpPct}%`
  if (type === 'bid_down' && a0?.bidDownPct != null) then += ` −${a0.bidDownPct}%`
  /**
   * 🔴 The bid a harvest rule graduates at is part of what it DOES, and it was rendered nowhere.
   * `graduationBidEur` is 0.50 on two rules and 0.65 on a third — three constants for one decision,
   * on a page whose whole subject is what a harvested keyword costs.
   */
  const bidEur = a0?.graduationBidEur ?? a0?.bidEur
  // `0.5` must print as €0.50 — a bid is money, and money with one decimal reads as a typo.
  if ((type === 'harvest_and_negate' || type === 'promote_to_exact') && typeof bidEur === 'number') then += ` @ €${bidEur.toFixed(2)}`

  if (ifs) return { text: then ? `${ifs} → ${then}` : ifs, why: `This rule fires when ${ifs}${then ? `, and then: ${then}` : ''}.` }

  // No `conditions` — but that is not the same as no criteria. Read the action's own parameters
  // first, and only when THOSE are empty say what really binds the rule.
  const params = thresholdClauses(a0, tabKey)
  /**
   * The thresholds this tab shows as COLUMNS, named in the tooltip so the sentence stays complete
   * even though the cell no longer carries them. Without this, "spend ≥ €10 → harvest and negate"
   * reads as the rule's whole criterion when there are two more conditions one column to the left.
   */
  const columned = (tabKey ? RULE_TAB_THRESHOLDS[tabKey] ?? [] : [])
    .map((k) => { const r = readThreshold(a0, k, flat); return r.value == null ? null : THRESHOLD_SPEC[k].clause(r.value) })
    .filter(Boolean) as string[]
  const alsoText = columned.length ? ` It also requires ${columned.join(' and ')}, shown in its own column${columned.length === 1 ? '' : 's'}.` : ''
  /**
   * Every condition this rule had went into a column. That is NOT "no criteria" — saying so would
   * reintroduce the exact fabrication P1 removed, one column to the right of the evidence.
   */
  if (!ifs && hadConditions && skip.size === flat.length) {
    return {
      text: then || 'No conditions',
      why: `This rule's criteria are shown in their own columns on this tab${then ? `, and then: ${then}` : ''}.${alsoText}`,
    }
  }
  if (params.length) {
    const ps = params.join(' · ')
    return {
      text: then ? `${ps} → ${then}` : ps,
      why: `This rule fires when ${ps}${then ? `, and then: ${then}` : ''}. Those thresholds are stored on the action rather than in the rule's conditions, which is how an engine rule carries them — it is the same criterion either way.${alsoText}`,
    }
  }
  const bare = noCriteria(a0, String(rule.trigger ?? ''), tabKey)
  return { text: then ? `${bare.text} → ${then}` : bare.text, why: bare.why + alsoText }
}

function ruleToRow(rule: Record<string, unknown>, tabKey: string): RuleRow {
  const a = (Array.isArray(rule.actions) ? rule.actions[0] : null) as
    { type?: string; control?: string; schedule?: { frequency?: string; time?: string } } | null
  const crit = summariseRule(rule, tabKey)
  /**
   * 🔴 P2 reads the thresholds off the action THIS TAB describes, not `actions[0]`, for the same
   * measured reason the Criteria cell does (U5): "Daily automation digest" lists on three tabs and
   * `actions[0]` is `bid_to_target_acos`, which carries no thresholds at all — reading position 0
   * would have printed an empty Order Threshold on a rule that harvests at ≥2 orders.
   */
  const tabAction = tabActionOf(rule, tabKey)
  const s = a?.schedule
  let freqDay = ''
  let freqTime = ''
  if (s) {
    const t = s.time ?? '00:00'
    const h = Number(t.split(':')[0]) || 0
    freqDay = s.frequency ?? 'Daily'
    freqTime = h === 0 ? '12:00 AM'
      : h < 12 ? `${String(h).padStart(2, '0')}:00 AM`
      : h === 12 ? '12:00 PM'
      : `${String(h - 12).padStart(2, '0')}:00 PM`
  } else {
    // No stored schedule. An engine rule runs when its trigger fires; printing "Daily · 12:00 AM"
    // here would be a constant nobody reads.
    freqDay = humanTrigger(String(rule.trigger ?? ''))
    freqTime = 'engine cadence'
  }
  return {
    id: String(rule.id),
    name: String(rule.name ?? 'Untitled'),
    /**
     * BP.P1 — ONE truth for both shapes: "on" means the rule will actually WRITE — enabled, at
     * AUTO, and (for a builder rule) not belted to Manual. The old builder read was
     * `actions[0].control === 'automate'` alone, and `control` is a field the engine's mode
     * derivation never consults (`resolveAutonomy` reads `enabled` + `autonomyLevel`): a rule
     * created with "Automate" rendered On while stored disabled at PROPOSE — it armed nothing.
     * `control === 'manual'` still belts a rule at any level (the evaluator forces the propose
     * path), so it keeps a say in the OFF direction only.
     */
    automation: rule.enabled !== false && rule.autonomyLevel === 'AUTO'
      && (a as { control?: string } | null)?.control !== 'manual',
    level: String(rule.autonomyLevel ?? ''),
    enabled: rule.enabled !== false,
    criteria: crit.text,
    criteriaWhy: crit.why,
    thresholds: readThresholds(tabAction, (Array.isArray(rule.conditions) ? rule.conditions : []) as RuleCondition[]),
    freqDay,
    freqTime,
    /**
     * B2 — the Lookback, derived from the same two facts the engine decides on: the rule's
     * TRIGGER and its actions. Deliberately scoped to THIS tab's action, exactly as the Criteria
     * cell is: "Daily automation digest" carries `bid_to_target_acos` AND `harvest_and_negate`, so
     * on Bid it must describe the bid half and on Keyword Harvest the harvest half. Passing every
     * action in tab order lets `ruleLookback` pick the first that carries a window.
     *
     * 🔴 P1: that only works if every re-querying action HAS an entry. `harvest_and_negate` had
     * none, so tab order was honoured and then discarded — the digest rule skipped its harvest
     * action and reported the bid optimiser's 30 unsettled days **on the Keyword Harvest tab**.
     * Measured on prod 2026-08-20, 1 of 5 rows. The fix is the map entry, not this call site.
     */
    look: ruleLookback(String(rule.trigger ?? ''), orderedActionTypes(rule, tabKey), tunableWindowDays(rule, tabKey)),
  }
}

/**
 * The `windowDays` of whichever action `ruleLookback` is about to describe — or null.
 *
 * Two actions let a rule set its own window: `defend_top_of_search` (clamped 7–90 by its handler)
 * and, since P1, `harvest_and_negate` (unclamped, 60 or 30 on this account). Both are marked
 * `tunable` in `ACTION_WINDOW`, and this walks the actions in the SAME tab order `ruleLookback`
 * walks, stopping at the first one that has a window at all.
 *
 * 🔴 Why it stops rather than searching on. The predecessor (`tosWindowDays`) searched the whole
 * action list for `defend_top_of_search` while `ruleLookback` independently picked the first
 * windowed action in tab order. On a rule carrying both, the two could disagree about which action
 * they were describing — one action's days rendered under another action's label. Nothing in the
 * account triggered it, which is exactly why it was worth removing rather than leaving armed:
 * "Rank control" carries a hundred actions and only needs one more to line up wrong.
 */
function tunableWindowDays(rule: Record<string, unknown>, tabKey: string): number | null {
  const acts = (Array.isArray(rule.actions) ? rule.actions : []) as Array<Record<string, unknown>>
  const want = RULE_TAB_ACTION_TYPES[tabKey] ?? []
  const ordered = [
    ...acts.filter((x) => want.includes(String(x?.type ?? ''))),
    ...acts.filter((x) => !want.includes(String(x?.type ?? ''))),
  ]
  for (const x of ordered) {
    const spec = ACTION_WINDOW[String(x?.type ?? '')]
    if (!spec) continue
    // The first action WITH a window is the one being described; if it is not tunable, or carries
    // no number, the table's own default stands.
    return spec.tunable && typeof x?.windowDays === 'number' ? (x.windowDays as number) : null
  }
  return null
}

/**
 * The rule's action types, with THIS tab's actions first.
 *
 * `ruleLookback` takes the first action that carries its own window, so the order decides which
 * half of a multi-action rule the Lookback cell describes. Same principle as `summariseRule`'s
 * `tabKey` argument, and for the same measured reason: a rule that both bids and negates reads
 * differently on the two tabs it lists on, which is correct — it does both.
 */
function orderedActionTypes(rule: Record<string, unknown>, tabKey: string): string[] {
  const types = (Array.isArray(rule.actions) ? rule.actions : [])
    .map((x) => String((x as { type?: unknown })?.type ?? ''))
    .filter(Boolean)
  const want = RULE_TAB_ACTION_TYPES[tabKey] ?? []
  return [...types.filter((t) => want.includes(t)), ...types.filter((t) => !want.includes(t))]
}

/**
 * What Automation OFF means for an ENGINE rule.
 *
 * PROPOSE, not OFF. OFF would disable the rule outright — a different switch, the one the row's
 * "off" chip reports — and would throw away the suggestions the operator still wants to see.
 * PROPOSE is the exact counterpart of a builder rule's `manual`: the rule keeps running and
 * queues its actions, and nothing reaches Amazon until someone accepts them.
 *
 * ⚠ Asymmetry worth knowing before you change this: because the route ties `enabled` to
 * `level !== 'OFF'`, turning a DISABLED rule on and then off again leaves it enabled at PROPOSE
 * rather than disabled. That is the route's contract, the toggle's tooltip says so before the
 * first click, and re-disabling is one control away on Automations.
 */
const ENGINE_OFF_LEVEL = 'PROPOSE'

/** The four levels, as the words an operator reads rather than the enum. */
const LEVEL_WORD: Record<string, string> = { OFF: 'Off', OBSERVE: 'Observe', PROPOSE: 'Propose', AUTO: 'Auto' }

type BulkKind = 'automation' | 'delete'

/** B4 — one rule's real output, from `GET /advertising/automation-rules/activity`. */
export interface RuleActivity {
  /** AdsRuleSuggestion rows awaiting a human decision — the PROPOSE half's output */
  pending: number
  /** newest AdvertisingActionLog row written by `automation:<ruleId>`; null = never wrote */
  lastWroteAt: string | null
  writes7d: number
}

/** "4h", "3d", "just now" — short enough for a cell, exact enough in the tooltip beside it. */
function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return d < 30 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago`
}

export interface RulesGridProps {
  /** the `RULE_TAB_ACTION_TYPES` key — membership and the tab badge share it */
  tabKey: string
  /** singular, Title Case: "Bid Rule" → "Showing 0 Bid Rules" / "Viewing 1-2 of 2 Bid Rules" */
  noun: string
  /** the builder route for this type; the name links here with `?ruleId=` */
  builderHref: string
  /** H10's empty-state sentence, verbatim per type */
  emptyLine: string
}

export function RulesGrid({ tabKey, noun, builderHref, emptyLine }: RulesGridProps) {
  const [rows, setRows] = useState<RuleRow[]>([])
  const [raw, setRaw] = useState<Map<string, Record<string, unknown>>>(new Map())
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [bulk, setBulk] = useState<{ kind: BulkKind; ids: string[] } | null>(null)
  const [historyRule, setHistoryRule] = useState<{ id: string; name: string } | null>(null)
  /** B1 — "+ Rule" opens H10's "Select a Rule Type" modal rather than jumping to the builder. */
  const [picker, setPicker] = useState(false)
  /**
   * B5 — WHICH rule the builder overlay is open on, held in the URL rather than in state.
   *
   * The operator study: hovering a rule name reveals "Open", and clicking it "triggers a modal
   * overlay containing the exact configuration of that rule… without navigating away from the
   * page". Until now Open was an `<a href>` to `/builder/<slug>?ruleId=…`, which loses the grid,
   * the scroll position, the search box and the selection.
   *
   * 🔴 The overlay needs NO changes to `RuleBuilder` at all, and that is the point — it is the
   * same component the `/builder/<slug>` route mounts, with the same props and the same
   * interactions, not a second copy behaving slightly differently. Three facts make it fit:
   *   · `.h10-rb` is already `position: fixed; inset: 0; z-index: 130` — the builder has always
   *     BEEN a full-screen overlay; only the route ever mounted it.
   *   · it reads its target from `useSearchParams().get('ruleId')`, so putting `?ruleId=` on THIS
   *     route is all it takes to aim it.
   *   · its Cancel and both save paths `router.push('/rules-automation/<ownTab>')` — from a tab
   *     route that is the same page minus the query, so the overlay closes itself and the grid is
   *     still underneath, already scrolled where it was.
   *
   * The `/builder/<slug>?ruleId=` route stays exactly as it was: deep links, bookmarks and the
   * empty state's "Create Rule" all still work, and that page is unchanged by this.
   */
  const router = useRouter()
  const params = useSearchParams()
  const openRuleId = params.get('ruleId')
  /**
   * B5 — bumped to re-run the reads below. The builder emits `ads.rule.changed` on both of its
   * save paths, and before this the grid only ever fetched on mount: saving in the overlay closed
   * it onto a row still showing the OLD criteria, which reads as "the save did not work". The
   * badge counts already refreshed on this signal; the grid under them did not.
   */
  const [reloadNonce, setReloadNonce] = useState(0)
  useAdsSync(['ads.rule.changed'], useCallback(() => setReloadNonce((n) => n + 1), []))
  /**
   * How far each rule is ALLOWED to be trusted, by rule id. Second, parallel, non-blocking read —
   * the grid renders from `/automation-rules` and this only refines the Automation toggle when it
   * lands. If it never lands the toggle still works: the same policy is enforced server-side and
   * arrives as the 409 below, so a failed ceiling read costs a pre-emptive tooltip, not a control.
   */
  const [ceilings, setCeilings] = useState<Map<string, { ceiling: string; reason: string }>>(new Map())
  /**
   * B4 — what each rule has actually DONE, from `/automation-rules/activity`. Third parallel,
   * non-blocking read, same contract as `ceilings`: the grid paints without it and the Activity
   * cell fills in when it lands. A failed read leaves the cell saying it could not be checked,
   * which is not the same as saying the rule did nothing.
   */
  const [activity, setActivity] = useState<Map<string, RuleActivity> | null>(null)
  const [activityFailed, setActivityFailed] = useState(false)
  /** Rows with a mode write in flight — a second click must not race the first. */
  const [pending, setPending] = useState<Set<string>>(new Set())
  /** The last refusal, in the server's own words. Cleared when the next write is attempted. */
  const [notice, setNotice] = useState<string | null>(null)
  /**
   * An explanation the operator has to scroll to find is the defect this file just fixed, one step
   * removed: the toggle they clicked can be row 40, and the banner renders above the grid.
   */
  const noticeRef = useRef<HTMLDivElement | null>(null)
  const nounLower = noun.toLowerCase()
  /**
   * B1 — the builder slug for this tab, taken from the href the caller already passes rather than
   * from a new prop. The last segment of `builderHref` IS the slug on all seven call sites
   * (`/builder/keyword-harvesting`, `/builder/sov`, …), so the two can never disagree; a href that
   * ever stops matching a `RULE_TYPES.slug` falls the modal back to its first option, which is
   * exactly what it did before this existed.
   */
  const builderSlug = builderHref.split('?')[0].split('/').filter(Boolean).pop() ?? ''

  useEffect(() => {
    let alive = true
    setLoading(true)
    fetch(`${getBackendUrl()}/api/advertising/automation-rules`, { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(`(${r.status})`); return r.json() })
      .then((j) => {
        if (!alive) return
        const all = (Array.isArray(j?.rules) ? j.rules : Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : []) as Array<Record<string, unknown>>
        const mine = all.filter((r) => ruleBelongsToTab(r.actions, tabKey))
        setRows(mine.map((r) => ruleToRow(r, tabKey)))
        setRaw(new Map(mine.map((r) => [String(r.id), r])))
        setErr(null)
      })
      .catch((e) => { if (alive) setErr((e as Error).message || 'failed') })
      .finally(() => { if (alive) setLoading(false) })

    // The graduation ceiling, from the board the Automations page already reads. Deliberately NOT
    // awaited with the read above: it groups a week of executions and measured 1.0-2.9s on prod,
    // and the grid must not wait on it to paint.
    fetch(`${getBackendUrl()}/api/advertising/autonomy/rules`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { items?: Array<Record<string, unknown>>; rules?: Array<Record<string, unknown>> } | null) => {
        if (!alive || !j) return
        const items = j.items ?? j.rules ?? []
        setCeilings(new Map(items.map((r) => [String(r.id), {
          ceiling: String(r.ceiling ?? 'AUTO'),
          reason: String(r.ceilingReason ?? ''),
        }])))
      })
      .catch(() => { /* the 409 carries the same sentence; see `setAutomation` */ })

    // B4 — what each rule has done. Also parallel: three groupBys, ~200ms on prod, and the grid
    // must not wait on it to paint.
    fetch(`${getBackendUrl()}/api/advertising/automation-rules/activity`, { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
      .then((j: { items?: Record<string, RuleActivity> }) => {
        if (!alive) return
        setActivity(new Map(Object.entries(j.items ?? {})))
        setActivityFailed(false)
      })
      .catch(() => { if (alive) setActivityFailed(true) })
    return () => { alive = false }
  }, [tabKey, reloadNonce])

  useEffect(() => { noticeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [notice])

  /**
   * Set a rule's Automation mode. ONE entry point, TWO write paths — which one is used is decided
   * by the rule's own shape, never by the caller, so nothing upstream has to know the difference.
   *
   * · **Builder rule** — PATCH `actions[0].control` on `/automation-rules/:id`.
   * · **Engine rule** — PATCH `{ level }` on `/advertising/autonomy/rules/:id`, the Automations
   *   page's own route. AUTO for on, PROPOSE for off; that route keeps `enabled` and `dryRun` in
   *   step with the level, and returns the stored row, so the grid re-derives from what LANDED
   *   rather than from what it hoped for — the "off" chip beside the name moves with it.
   *
   * Optimistic, reverted on failure, and a failure is never silent: a 409 is the graduation
   * ceiling refusing, which is policy rather than breakage, so it is shown in the policy's own
   * words ([[reference_ads_delivery_model]] — a refusal is never a failure).
   *
   * `silent` suppresses the bus emit so the bulk path can emit once after its loop instead of
   * once per row (adsBus rule 1 — 40 rows × 11 open tabs is 440 refetches for one click).
   */
  const setAutomation = useCallback(async (id: string, on: boolean, silent = false): Promise<boolean> => {
    const rule = raw.get(id)
    if (!rule) return false
    const builder = isBuilderRule(rule)
    if (builder && !Array.isArray(rule.actions)) return false
    setNotice(null)
    setPending((s) => new Set(s).add(id))
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, automation: on } : r)))
    /** BP.P1 — a builder rule's Manual/Automate belt, kept in step with the level below. */
    const patchControl = async (control: 'manual' | 'automate'): Promise<Array<Record<string, unknown>>> => {
      const actions = (rule.actions as Array<Record<string, unknown>>).map((a, i) =>
        (i === 0 ? { ...a, control } : a))
      const res = await fetch(`${getBackendUrl()}/api/advertising/automation-rules/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actions }),
      })
      if (!res.ok) throw new Error(`Could not change Automation (${res.status}).`)
      return actions
    }
    try {
      /**
       * BP.P1 — ONE write path for BOTH shapes: the level IS the mode.
       *
       * The old builder branch PATCHed `actions[0].control` and stopped — a field
       * `resolveAutonomy` never reads — so on the shape every rule now takes (post-W7, all rules
       * are builder-authored) the toggle rendered On and armed nothing. Both shapes now write
       * `PATCH /advertising/autonomy/rules/:id { level }` — the ONE mode route, which also keeps
       * `enabled`/`dryRun` in step and enforces the graduation ceiling with a 409.
       *
       * A builder rule additionally keeps its `control` belt in step: belt FIRST when arming
       * (AUTO must never coexist with a manual belt — the evaluator would silently propose while
       * the toggle says On), and rolled back if the level write is refused. On the OFF path the
       * belt write is best-effort: once the level is PROPOSE the rule already only proposes.
       */
      let nextActions = rule.actions as Array<Record<string, unknown>>
      if (builder && on) nextActions = await patchControl('automate')
      const level = on ? 'AUTO' : ENGINE_OFF_LEVEL
      const res = await fetch(`${getBackendUrl()}/api/advertising/autonomy/rules/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level }),
      })
      const j = (await res.json().catch(() => ({}))) as
        { ok?: boolean; error?: string; message?: string; rule?: Record<string, unknown> }
      if (!res.ok || j.ok === false) {
        if (builder && on) await patchControl('manual').catch(() => { /* belt rollback is best-effort */ })
        // 409 is the ceiling, and the route puts its reason on `message`. Reading `error` first
        // would have printed the enum `above_ceiling` at an operator forever.
        throw new Error(res.status === 409
          ? (j.message ?? `“${rule.name ?? id}” cannot be set to Auto — it is above this rule’s ceiling.`)
          : (j.error ?? `Could not change Automation (${res.status}).`))
      }
      if (builder && !on) nextActions = await patchControl('manual').catch(() => nextActions)
      const next: Record<string, unknown> = {
        ...rule,
        actions: nextActions,
        autonomyLevel: j.rule?.autonomyLevel ?? level,
        enabled: j.rule?.enabled ?? true,
        dryRun: j.rule?.dryRun ?? level !== 'AUTO',
      }
      setRaw((m) => { const n = new Map(m); n.set(id, next); return n })
      // Re-derive the whole row from what was stored, not just the switch: an engine rule that
      // was disabled is enabled by this write, and the row carries that as its "off" chip.
      setRows((rs) => rs.map((r) => (r.id === id ? ruleToRow(next, tabKey) : r)))
      /**
       * 🔴 Emit AFTER the write settles, so the tab badges (and any other open tab) refetch.
       * Measured on prod 2026-08-18: deleting the only SOV rule left the grid at 0 and the badge
       * at 1 — the counts provider refreshes on `ads.rule.changed`, the builder emits it on save,
       * and this grid did not. Badge and grid share the membership predicate, but sharing a
       * predicate is not sharing a fetch.
       *
       * A single-row toggle emits here; the bulk path emits once after its loop, never per row.
       */
      if (!silent) emitAdsChange('ads.rule.changed')
      return true
    } catch (e) {
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, automation: !on } : r)))
      setNotice((e as Error).message)
      return false
    } finally {
      setPending((s) => { const n = new Set(s); n.delete(id); return n })
    }
  }, [raw, tabKey])

  /**
   * Held below AUTO by the graduation ceiling — so Automation can be turned off, never on.
   * BP.P1 — applies to BOTH shapes now: builder rules live in the same table, the ceiling board
   * covers them, and since the ceiling went op-aware a pausing Bid rule is capped while a
   * value-moving one is not. The old `!isBuilderRule` exclusion predates the unified toggle.
   */
  const isCapped = useCallback((id: string): boolean =>
    (ceilings.get(id)?.ceiling ?? 'AUTO') !== 'AUTO', [ceilings])

  const applyBulk = async (kind: BulkKind, ids: string[], payload?: { on?: boolean }) => {
    setBulk(null)
    if (kind === 'delete') {
      setNotice(null)
      const deleted: string[] = []
      for (const id of ids) {
        try {
          const res = await fetch(`${getBackendUrl()}/api/advertising/automation-rules/${id}`, { method: 'DELETE' })
          if (res.ok) deleted.push(id)
        } catch { /* the row stays — visibly not deleted, rather than vanishing locally */ }
      }
      setRows((rs) => rs.filter((r) => !deleted.includes(r.id)))
      setRaw((m) => { const n = new Map(m); for (const id of deleted) n.delete(id); return n })
      setSel(new Set())
      // Once per logical operation, after the loop settled — never once per row (adsBus rule 1).
      if (deleted.length) emitAdsChange('ads.rule.changed')
      /**
       * 🔴 B1 — a delete that did not happen has to SAY so. The row staying put was the whole of
       * the old feedback, and on a one-row delete from the trash icon that is indistinguishable
       * from "nothing was clicked". Same law as the Automation toggle above: a refusal is never
       * a failure, but neither is ever silent.
       */
      const lost = ids.length - deleted.length
      if (lost) {
        setNotice(lost === ids.length
          ? `Nothing was deleted — the ${ids.length === 1 ? nounLower : `${lost} ${nounLower}s`} could not be removed. ${ids.length === 1 ? 'It is' : 'They are'} still listed below.`
          : `${deleted.length} of ${ids.length} ${nounLower}s deleted. ${lost} could not be removed and ${lost === 1 ? 'is' : 'are'} still listed below.`)
      }
      return
    }
    const on = !!payload?.on
    // Turning ON a rule above its ceiling is a 409 per row. The modal said how many, and they are
    // left exactly as they were rather than each producing its own failure. Turning OFF is never
    // capped, so nothing is skipped on that side.
    const targets = on ? ids.filter((id) => !isCapped(id)) : ids
    let failed = 0
    for (const id of targets) if (!(await setAutomation(id, on, true))) failed += 1
    setSel(new Set())
    emitAdsChange('ads.rule.changed')
    const skipped = ids.length - targets.length
    // \U0001f534 A bulk verb that silently does less than it was asked is the defect this whole page
    // was rebuilt to stop. The count that did NOT move is stated, always.
    if (skipped || failed) {
      setNotice([
        `${targets.length - failed} of ${ids.length} ${ids.length === 1 ? nounLower : `${nounLower}s`} set to Automation ${on ? 'On' : 'Off'}.`,
        skipped ? `${skipped} left unchanged — above the graduation ceiling, which only Automations can raise.` : '',
        failed ? `${failed} failed to write.` : '',
      ].filter(Boolean).join(' '))
    }
  }

  const columns: GridColumn<RuleRow>[] = useMemo(() => [
    /**
     * 🔴 P2 — H10's threshold columns, for the tabs that declare them in `RULE_TAB_THRESHOLDS`.
     *
     * H10's KB describes the Keyword Harvest view as showing *"the Order and Max ACoS Thresholds
     * configured for each rule and whether the rule is automated"*, and the operator's study quotes
     * the cells as "Min 3 Orders" / "Max 30% ACoS". They sit immediately after the rule name,
     * before Lookback, which is where both studies put them.
     *
     * Three states per cell, and rendering any two of them the same is the whole failure mode:
     * · the RULE stores the number            → plain
     * · the rule stores nothing and the HANDLER has a documented default → muted, labelled "default"
     * · nothing stores it and no default exists → an em dash whose tooltip says what that MEANS
     *
     * That third state is not a blank. Measured on prod 2026-08-20, **no rule in this account
     * carries `maxAcosPct`**, so the Max ACoS column is an em dash on every row — and its tooltip
     * says a harvest rule with no ACoS ceiling will promote a converting term however expensive
     * the conversion was. A column that is empty for all of the data is only decoration if it
     * declines to say why it is empty.
     */
    ...(RULE_TAB_THRESHOLDS[tabKey] ?? []).map((key): GridColumn<RuleRow> => {
      const spec = THRESHOLD_SPEC[key]
      return {
        key: `threshold-${key}`, label: spec.column, tip: spec.columnTip, metric: false, sortable: true,
        // Rows with no threshold sink in both sort directions, so ascending surfaces the LOWEST
        // real bar rather than a row that has none — the same rule the Lookback column follows.
        sortValue: (r) => r.thresholds[key].value,
        render: (r) => {
          const t = r.thresholds[key]
          if (t.value == null) return <span className="h10-rg-thr none" title={spec.absent}>—</span>
          if (t.source === 'default') {
            return (
              <span
                className="h10-rg-thr default"
                title={`${spec.cell(t.value)} — but this rule sets no threshold of its own, so that is the handler's fallback rather than a value anyone chose. Open the rule to set your own.`}
              >{spec.cell(t.value)} <i>default</i></span>
            )
          }
          return <span className="h10-rg-thr" title={`Set on this rule: ${spec.cell(t.value)}.`}>{spec.cell(t.value)}</span>
        },
      }
    }),
    /**
     * B2 — Lookback Period. The operator study's column, and the one that had no field behind it.
     *
     * 🔴 What makes this cell honest is that it can decline to be a number. Measured on prod
     * 2026-08-20, the eighteen bid rules split four ways and only one of those is "N days":
     *   · a settled window   — 14 · 7 · 30 days, dropping Amazon's 2 still-settling days
     *   · an UNSETTLED one   — `bid_to_target_acos`'s 30, which counts today's half-written day
     *   · "Unlabelled"       — CAC_SPIKE reads `Campaign.spend/.acos`, columns whose window the
     *                          sync never records, so how far back the rule looks is not a number
     *                          this system knows
     *   · "None"             — a SCHEDULE rule whose action re-reads nothing: `raise_bids_for_
     *                          rank_defense` raises every enabled target 20% on no evidence at all
     *
     * Printing "30 days" on all eighteen would have been the easy column and a fabricated one
     * ([[reference_fleet_stale_constant_class]]). Sortable by days, with the non-numeric rows
     * sinking in both directions (`sortValue` → null), so ascending surfaces the SHORTEST real
     * window rather than a row that has none.
     */
    {
      key: 'lookback', label: 'Lookback', metric: false, sortable: true,
      sortValue: (r) => r.look.days,
      render: (r) => {
        /**
         * 🔴 The styling keys on whether the cell STATES A WINDOW, never on `days`.
         *
         * `days` is populated on some non-window rows — `AD_SPEND_PROFITABILITY_BREACH` carries a
         * 30-day profit aggregate behind a label of "Unlabelled" — so keying on `days == null`
         * painted that row amber while the two `CAC_SPIKE` rows, labelled identically, were grey.
         * Measured on prod: the word "Unlabelled" appeared in two different colours on one screen,
         * decided by a property with no representation in the cell. Same mistake as the ⚠ icon a
         * commit earlier, one level down: gate on the KIND, which is what the label is derived from.
         */
        const statesAWindow = r.look.kind === 'window' || r.look.kind === 'compare'
        return (
        <span className={`h10-rg-look${statesAWindow ? '' : ' none'}${r.look.settled ? '' : ' unsettled'}`} title={r.look.why}>
          {r.look.label}
          {/* The warning is the difference between a window and a window you should not trust.
              It carries its own accessible text — an icon that only means something on hover is
              a fact delivered to nobody.

              🔴 Only on a cell that STATES a window. `AD_SPEND_PROFITABILITY_BREACH` carries an
              unsettled 30-day profit aggregate behind a label of "Unlabelled", and rendering
              "Unlabelled ⚠" put a caveat about a number on a cell whose whole point is that
              there is no number — the two halves contradicted each other. Measured on prod:
              1 of 18 bid rows read that way. The caveat still reaches the tooltip. */}
          {!r.look.settled && statesAWindow && (
            <AlertTriangle size={11} aria-label="includes days Amazon is still attributing" />
          )}
        </span>
        )
      },
    },
    /**
     * P1 — the tooltip is `criteriaWhy`, not the cell's own text. A cell whose title repeats itself
     * can explain nothing, and the rows that needed explaining most were the ones that used to read
     * "Always": a rule whose thresholds sit on the action, and a rule that genuinely has none and
     * is bound by its trigger instead. Those are different facts and now read differently.
     */
    { key: 'criteria', label: 'Criteria', metric: false, sortable: false, render: (r) => <span className="h10-nt-crit" title={r.criteriaWhy}>{r.criteria}</span> },
    {
      key: 'frequency', label: 'Frequency', metric: false, sortable: false,
      render: (r) => (
        <span
          className="h10-nt-freq"
          title={r.freqTime === 'engine cadence'
            ? 'This rule stores no schedule — it is an engine rule and runs when its trigger fires, on the engine’s own cron.'
            : undefined}
        ><b>{r.freqDay}</b><span>{r.freqTime}</span></span>
      ),
    },
    {
      key: 'automation', label: 'Automation', metric: false, sortable: false,
      render: (r) => {
        const cap = ceilings.get(r.id)
        // BP.P1 — the ceiling binds both shapes (op-aware server-side); no builder exclusion.
        const capped = !!cap && cap.ceiling !== 'AUTO'
        // HELD, not disabled. A capped rule can still be turned OFF — the ceiling refuses reaching
        // AUTO, not leaving it — so only the ON direction is held.
        const held = capped && !r.automation
        const busy = pending.has(r.id)
        // BP.P1 — one sentence for both shapes, because the toggle now means one thing.
        const why = held
          ? `${cap!.reason} Its ceiling is ${LEVEL_WORD[cap!.ceiling] ?? cap!.ceiling}, so Automation cannot be turned on here. That is policy about what this rule DOES, not a setting — it is raised in the engine's graduation rules, not on this page.`
          : `On = Auto (it acts on its own, inside its daily cap and the write gate). Off = Propose (it queues its actions on the Suggestions page; nothing reaches Amazon until you accept them). Currently ${LEVEL_WORD[r.level] ?? (r.level || 'unset')}.${r.enabled ? '' : ' This rule is disabled — turning Automation on will also enable it.'}`
        return (
          <Toggle
            checked={r.automation}
            className={`${held ? 'held' : ''}${busy ? ' busy' : ''}`.trim() || undefined}
            /**
             * 🔴 `aria-disabled`, NEVER the `disabled` attribute — see ⑤ at the top of this file.
             * A disabled control takes no focus, no click and shows no tooltip, so the `title`
             * explaining the refusal could never be read. The operator's report was "the toggle
             * button is still not working", and from where they sat that is exactly what it was.
             */
            aria-disabled={held || busy}
            aria-label={`Automation for ${r.name}`}
            title={why}
            onClick={() => {
              if (busy) return
              // A held toggle ANSWERS instead of writing: no doomed request, and the reason lands
              // where the operator is looking rather than in a tooltip they have to discover.
              if (held) { setNotice(`“${r.name}” — ${why}`); return }
              void setAutomation(r.id, !r.automation)
            }}
          />
        )
      },
    },
    /**
     * B4 — Activity. WHERE THIS RULE'S OUTPUT WENT, and whether anything arrived.
     *
     * The operator study describes the Automation toggle as "a physical fork in the road": Off
     * routes the output to the Suggestions page to wait for a human; On fires at Amazon and drops
     * a receipt in the Change Log. Both halves are wired and neither could be seen from here — so
     * this column reports the half the row's own mode uses.
     *
     * 🔴 **An AUTO rule reports what it WROTE, never that it ran.** `lastExecutedAt` moves on
     * every evaluation whatever came of it; only an `AdvertisingActionLog` row proves a bid moved.
     * Measured on prod 2026-08-20: four Bid rules are enabled at AUTO, evaluated within the hour,
     * and have written **nothing, ever** — they run, they report SUCCESS, and no bid moves
     * ([[reference_four_inert_ads_rules]]). A green tick that means "the evaluation completed" is
     * exactly the reassurance that let that sit for months, so "never written" is a warning here,
     * not a blank.
     *
     * A PROPOSE rule reports its queue, linked. 306 suggestions are pending account-wide against
     * ONE ever applied, and one Bid rule is holding 125 of them; a number nobody can reach is how
     * that happens. The link deep-links the Suggestions page's existing Rule filter.
     */
    {
      key: 'activity', label: 'Activity', metric: false, sortable: true,
      // Sorts by what the row is REPORTING: waiting count for a proposer, recency for an actor.
      // A rule that has never written sinks in both directions rather than sorting as "0 seconds
      // ago", which is what a 0 sentinel would have done.
      sortValue: (r) => {
        const a = activity?.get(r.id)
        if (!a) return null
        return r.automation ? (a.lastWroteAt ? Date.parse(a.lastWroteAt) : null) : a.pending
      },
      render: (r) => {
        // ③ A failed read is its own state. "We could not check" must never render as "nothing".
        if (activityFailed) return <span className="h10-rg-act unknown" title="The activity read failed, so this cell cannot say what this rule has done. It is not a claim that the rule did nothing — reload the page.">not checked</span>
        if (!activity) return <span className="h10-rg-act pendingread" aria-hidden>·</span>
        const a = activity.get(r.id) ?? { pending: 0, lastWroteAt: null, writes7d: 0 }

        if (r.automation) {
          if (!a.lastWroteAt) {
            return (
              <span className="h10-rg-act never" title={`Automation is on, so this rule writes straight to Amazon — but it has never written anything. Nothing in the action log was ever recorded by this rule.\n\nThat is not the same as “it has not run”: a rule can evaluate, match, report SUCCESS and still apply nothing. Open History to see what its executions actually returned.`}>
                <AlertTriangle size={11} aria-hidden /> never written
              </span>
            )
          }
          return (
            <a
              className="h10-rg-act wrote"
              href="/marketing/ads/changelog"
              onClick={(e) => e.stopPropagation()}
              title={`Last wrote ${new Date(a.lastWroteAt).toLocaleString('en-IE')} · ${a.writes7d} write${a.writes7d === 1 ? '' : 's'} in the last 7 days. Automation is on, so its changes go straight to Amazon and a receipt lands in the Change Log.`}
            >
              wrote {ago(a.lastWroteAt)}
              {a.writes7d === 0 && <em> · none this week</em>}
            </a>
          )
        }

        if (a.pending === 0) {
          return <span className="h10-rg-act quiet" title="Automation is off, so this rule queues its actions as suggestions for approval instead of writing them. Nothing is waiting.">0 waiting</span>
        }
        return (
          <a
            className="h10-rg-act waiting"
            href={`/marketing/ads/suggestions?rule=${encodeURIComponent(r.id)}`}
            onClick={(e) => e.stopPropagation()}
            title={`${a.pending} suggestion${a.pending === 1 ? '' : 's'} from this rule are waiting for a decision. Automation is off, so nothing reaches Amazon until someone accepts them. Opens the Suggestions page filtered to this rule.`}
          >
            {a.pending} waiting
          </a>
        )
      },
    },
    /**
     * B1 — Actions. One verb: delete, the operator study's trash can ("the kill switch").
     *
     * Deliberately NOT hover-revealed, unlike Open/History on the name cell. Those two are
     * shortcuts to things reachable another way (the rule's own page, the History drawer);
     * delete is not reachable another way except by selecting the row first, and a control you
     * have to discover by hovering is one a keyboard never finds. It is always painted, always
     * tabbable, and it opens the SAME confirmation the bulk verb opens — one delete path, one
     * sentence about what it costs, whether one row or forty.
     */
    {
      key: 'actions', label: 'Actions', metric: false, sortable: false,
      render: (r) => (
        <ToolbarButton
          tone="danger"
          icon={<Trash2 size={14} aria-hidden />}
          label={`Delete ${r.name}`}
          description="This deletes the rule, its execution history and any campaign assignments, and cannot be undone."
          onClick={(e) => { e.stopPropagation(); setBulk({ kind: 'delete', ids: [r.id] }) }}
        />
      ),
    },
  ], [raw, ceilings, pending, setAutomation, activity, activityFailed, tabKey])

  /**
   * B5 — open the builder OVER the grid: same page, `?ruleId=` added.
   *
   * `router.push` rather than `replace`, so Back closes the overlay — which is what a modal's
   * Escape-equivalent should do and what a browser user will try first. `scroll: false` keeps the
   * grid exactly where it was for when the overlay closes again.
   */
  const openRule = useCallback((id: string) => {
    const next = new URLSearchParams(params.toString())
    next.set('ruleId', id)
    router.push(`?${next.toString()}`, { scroll: false })
  }, [params, router])

  const renderFirst = (r: RuleRow): ReactNode => {
    /**
     * Still a real `href`, and still the BUILDER route's URL, even though the click is
     * intercepted. Middle-click, cmd-click and "Copy link address" therefore keep working and
     * land somewhere that renders the same rule — a button would have thrown all three away, and
     * an `href` pointing at the current page would make "open in new tab" produce a grid instead
     * of the rule the operator asked for.
     */
    const href = `${builderHref}?ruleId=${r.id}`
    // A plain left-click, with no modifier, is the one case that becomes the overlay.
    const overlay = (e: React.MouseEvent) => {
      e.stopPropagation()
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
      e.preventDefault()
      openRule(r.id)
    }
    // `h10-rg-namew` scopes the truncation cap added at the end of rules-automation.css to THIS
    // grid: the class it sits beside, `h10-nt-namew`, is also used by the Budget Pacing page's
    // schedules section, and capping a neighbour's column is not this unit's business.
    return (
      <span className="h10-nt-namew h10-rg-namew">
        {/* title: the cap above truncates long names (rank rules carry the whole ASIN title), so
            the full name has to stay readable without opening the rule. */}
        <a className="h10-nt-name" href={href} title={r.name} onClick={overlay}>{r.name}</a>
        {/* 🔴 `enabled` and the Automation mode are two different switches, and a row that shows
            "Automate" while the rule is disabled reads as armed when it can do nothing. Measured on
            prod 2026-08-16: a rule created in the builder is stored `enabled: false`, so it never
            runs until it is enabled on Automations. The row says so rather than implying it acts. */}
        {!r.enabled && (
          <span className="h10-bd7-posture off" title="This rule is disabled — it is never evaluated, whatever its Automation mode says. Enable it on the Automations page.">off</span>
        )}
        <span className="h10-nt-acts">
          <a className="h10-nt-open" href={href} onClick={overlay}><ExternalLink size={11} /> Open</a>
          <Button size="xs" className="h10-nt-open hist" onClick={(e) => { e.stopPropagation(); setHistoryRule({ id: r.id, name: r.name }) }}>
            <Clock size={11} /> History
          </Button>
        </span>
      </span>
    )
  }

  // ② a failed read is its own state — never the empty state.
  const emptyNode = err != null ? (
    <span className="h10-rr-empty">
      <b><AlertTriangle size={14} aria-hidden /> The rule list failed to load {err}</b>
      <span className="sub">This is a failed read, not an empty list. Reload the page; if it persists the rules API is down.</span>
    </span>
  ) : (
    <span className="h10-rr-empty">
      <NoDataIllus size={104} />
      <b>{emptyLine}</b>
      <a className="nds-btn" href={builderHref}>Create Rule</a>
    </span>
  )

  return (
    <>
      {/* A refused or failed mode write, in the server's own words. Amber, not red: the common
          case is the graduation ceiling declining to trust a rule that creates or destroys
          things, which is policy working rather than anything breaking. Same lifecycle as the
          Automations page's banner — it is replaced by the next write and never dismissed by
          hand, so there is no state that can outlive what it describes. */}
      {notice && (
        <div className="h10-au-banner warn" role="alert" ref={noticeRef}>
          <AlertTriangle size={15} aria-hidden />
          <span>{notice}</span>
        </div>
      )}
      <AdsDataGrid<RuleRow>
        rows={rows}
        loading={loading}
        rowId={(r) => r.id}
        enabledFirst={(r) => r.automation}
        noun={noun}
        firstColLabel={noun}
        renderFirst={renderFirst}
        firstSortValue={(r) => r.name}
        columns={columns}
        selectable
        selected={sel}
        onSelectedChange={setSel}
        customizable={false}
        searchable
        searchPlaceholder="Search rules…"
        searchValue={(r) => r.name}
        pagerCentered
        defaultSort={{ key: '__first', dir: 'asc' }}
        emptyNode={emptyNode}
        /**
         * B1 — H10's "+ Rule" opens the Rule Creation Modal and you pick the type there; it does
         * not jump straight into a builder. `_shared/RuleTypeModal` has been that modal since the
         * section was built and was mounted on exactly one route (`/builder` with no slug), so
         * every tab's "+ Rule" bypassed it. It now opens here, seeded to this tab's own type — so
         * the common path is one click longer by design, and creating a rule of a DIFFERENT type
         * without leaving the tab stops being impossible.
         *
         * A button, not a link: it opens a dialog rather than navigating, and a `<a href>` that
         * calls preventDefault is a middle-click that silently does the wrong thing. The empty
         * state's "Create Rule" keeps its plain href — there is no grid to stay on there.
         */
    toolbarRight={<Button variant="primary" onClick={() => setPicker(true)}><Plus size={13} aria-hidden /> Rule</Button>}
        selectionActions={(ids) => (
          <span className="h10-bulkrow">
            <Button variant="ghost" onClick={() => setBulk({ kind: 'automation', ids })}>Automation</Button>
            <Button variant="ghost" onClick={() => setBulk({ kind: 'delete', ids })}><Trash2 size={13} /> Delete</Button>
          </span>
        )}
      />
      {bulk && (
        <BulkModal
          kind={bulk.kind}
          count={bulk.ids.length}
          nounLower={nounLower}
          cappedCount={bulk.ids.filter(isCapped).length}
          onApply={(p) => void applyBulk(bulk.kind, bulk.ids, p)}
          onClose={() => setBulk(null)}
        />
      )}
      {historyRule && <HistoryDrawer rule={historyRule} onClose={() => setHistoryRule(null)} />}
      {picker && <RuleTypeModal initial={builderSlug} onClose={() => setPicker(false)} />}
      {/**
        * B5 — the builder, over the grid. `?ruleId=` is both the trigger and the argument: this
        * mounts on it, and RuleBuilder reads the same param to know which rule to load. No
        * `onClose` is passed because it does not take one — Cancel and both save paths already
        * push back to this tab's route, which drops the query and unmounts this.
        */}
      {openRuleId && <RuleBuilder slug={builderSlug} />}
    </>
  )
}

function BulkModal({ kind, count, nounLower, cappedCount, onApply, onClose }: {
  kind: BulkKind; count: number; nounLower: string
  /** selected rows held below AUTO by the graduation ceiling — they can be turned off, never on */
  cappedCount: number
  onApply: (p?: { on?: boolean }) => void
  onClose: () => void
}) {
  const [on, setOn] = useState(true)
  /**
   * 🔴 B1 — the title counts. Opened from the row's trash icon this dialog is always about ONE
   * rule, and it greeted that with "Delete Rules" as both its heading and its `aria-label` —
   * measured on prod, deleting "ACoS convergence (proportional correction)" announced itself in
   * the plural. A confirmation that misstates how much it is about to destroy is the one piece of
   * copy on the page that has to be exact.
   */
  const TITLE: Record<BulkKind, string> = {
    automation: 'Set Automation',
    delete: count === 1 ? 'Delete Rule' : 'Delete Rules',
  }
  const ruleNoun = count === 1 ? nounLower : `${nounLower}s`
  return (
    <Modal
      open
      onClose={onClose}
      title={TITLE[kind]}
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button
          variant={kind === 'delete' ? 'danger' : 'primary'} size="sm"
          onClick={() => onApply(kind === 'automation' ? { on } : undefined)}
        >
          {kind === 'delete' ? 'Delete' : 'Apply'}
        </Button>
      </>}
    >
      <p className="h10-ntm-say">
        {kind === 'delete'
          /**
           * The warning says the whole cost. Two tables cascade with an `AutomationRule`:
           * `AutomationRuleExecution` — its history, the evidence of what it did — and, since
           * D1 landed on 2026-08-20, `CampaignRuleAssignment`, which is the tether the operator
           * study describes ("it completely untethers the rule from any campaigns it was
           * attached to"). Both are named, because a warning that lists one of two costs is
           * read as the complete list.
           */
          ? `Delete ${count} ${ruleNoun}? This deletes the rule, its execution history and any campaign assignments it holds, and cannot be undone.`
          : `Apply to ${count} selected ${ruleNoun}.`}
        {kind === 'automation' && on && cappedCount > 0 && ` ${cappedCount} of them ${cappedCount === 1 ? 'creates or destroys something and is held below Auto' : 'create or destroy something and are held below Auto'} by the graduation ceiling — ${cappedCount === 1 ? 'it' : 'they'} will be left unchanged.`}
      </p>
      {kind === 'automation' && (
        <label className="h10-ntm-tog">
          <Toggle checked={on} onChange={setOn} aria-label="Automation" />
          {' '}Automation {on ? 'On' : 'Off'}
        </label>
      )}
    </Modal>
  )
}
