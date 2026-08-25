'use client'

/**
 * Shared full-screen "Create Rule" builder, pixel-matched to Helium 10 Ads / Adtomic.
 *
 * One component drives every rule type (Negative Targeting · Keyword Harvesting · Budget ·
 * Bid · …) — the Keyword-Harvest session plugs its type in via `slug` + the section config.
 * Layout mirrors the AiGoalBuilder takeover: a fixed top bar (✕ · type title · Learn ·
 * Create Rule) + a left scroll-spy step nav + a single scrolling content pane whose sections
 * are the steps (Rule Name · {Setup} · Criteria · Search Terms · Advanced Settings · Control).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { X, Plus, Trash2, Copy, MousePointerClick, Check, Search, Info, ChevronDown, Package, Eye, LayoutTemplate, Lock, AlertTriangle} from 'lucide-react'
import { HoverCard } from '../../campaigns/FilterDropdown'
import { ruleTypeBySlug } from './ruleTypes'
import { getBackendUrl } from '@/lib/backend-url'
// Single-sourced criteria config (also used by the SP Super Wizard's Step-3 rules).
import { CampaignSection, type SchedCampaign } from '../_schedule/CampaignSection'
import { type Condition, PC_OPERATORS, PC_METRIC_UNIT, PC_METRICS, PC_METRICS_BID, PC_METRICS_BUDGET, PC_METRICS_SOV, PC_METRICS_RANK, PC_METRICS_PLACEMENT, pcDefaultCondition, pcDefaultGroup, pcWindowLabel, PC_TRUTH_EXCLUDE, PcWindowNote } from './PerformanceCriteria'
import { PLACEMENT_LANES } from './placementLanes'
import { emitAdsChange } from './adsBus'
import { Listbox } from '@/design-system/components'
import { Checkbox, Input, Textarea } from '@/design-system/primitives'

// ── option catalogs (verbatim H10 copy where captured) ──
const METRICS = PC_METRICS
// BUD-P1 — single-sourced from PerformanceCriteria (a local copy of this list once drifted).
const METRICS_BUDGET = PC_METRICS_BUDGET
// SOV / Keyword-Tracker / operator / lookback / exclude catalogs — single-sourced from PerformanceCriteria.
const METRICS_SOV = PC_METRICS_SOV
const METRICS_RANK = PC_METRICS_RANK
const OPERATORS = PC_OPERATORS
// P2.1 — the Lookback/Exclude selects are gone: nothing ever read their value (each trigger
// evaluates over its own fixed window). `PcWindowNote` states the real window instead.
const FREQUENCY = ['Custom', 'Daily', 'Weekly', 'Monthly', 'Hourly'].map((f) => ({ value: f, label: f }))
// BP.P4 — the Bid rule's lookback options (H10 offers Previous Day…90; ours start at 7 because
// the two settling days are always excluded and a sub-week window over settled data is noise).
const LOOKBACK_DAYS = ['7', '14', '30', '60', '90'].map((d) => ({ value: d, label: `Last ${d} Days` }))

/**
 * BP.P5 — STARTER templates, shipped in code (H10 ships "Helium 10 Ads Default"; the research's
 * Tier-2 finding: named archetypes get adopted, blank builders don't). They apply through the
 * SAME `applyTemplate` path as saved templates — ordinary criteria the operator edits before
 * creating — and every one carries a noise guard so a thin-data keyword cannot trip it.
 * Bid only for now; other slugs add their own lists when their sessions take them up.
 */
const STARTER_TEMPLATES: Record<string, Array<{ name: string; desc: string; payload: { windowDays?: number; conditions: Array<{ conditions: Condition[]; action: { op: string; value: string; placeTarget?: string } }> } }>> = {
  'keyword-harvesting': [
    {
      name: 'Harvest proven winners',
      desc: '≥2 orders with ACoS ≤ 30% → promote (the Max-ACoS guard no legacy rule ever carried)',
      payload: { conditions: [{ conditions: [{ metric: 'PPC Orders', op: 'gte', value: '2' }, { metric: 'ACOS', op: 'lte', value: '30' }], action: { op: 'set', value: '' } }] },
    },
    {
      name: 'Strict performance ladder',
      desc: '≥3 orders with ACoS ≤ 20% — H10’s performance-tier bar',
      payload: { conditions: [{ conditions: [{ metric: 'PPC Orders', op: 'gte', value: '3' }, { metric: 'ACOS', op: 'lte', value: '20' }], action: { op: 'set', value: '' } }] },
    },
    {
      name: 'Volume harvest, noise-guarded',
      desc: '≥2 orders with ≥10 clicks — enough evidence before a new target spends',
      payload: { conditions: [{ conditions: [{ metric: 'PPC Orders', op: 'gte', value: '2' }, { metric: 'Clicks', op: 'gte', value: '10' }], action: { op: 'set', value: '' } }] },
    },
  ],
  /**
   * SOV-P4 — Share of Voice starters, sized to the REAL distribution rather than to round numbers.
   *
   * Measured on prod 2026-08-22 across the 793 enabled keywords that carry a share: median 2.40 %,
   * 178 under 1 %, and the strongest position on any target 4.28 %. So "< 1 %" is the genuine tail
   * (about a quarter of the measured population) and "≥ 3 %" is the top of it — thresholds picked
   * from the data the tab's census strip prints, not invented.
   *
   * 🔴 These could not have existed before SOV-P1. On the old metric every one of these bars
   * matched ~100 % of rows, so a starter would have shipped a rule that acted on everything.
   *
   * Every starter carries a spend floor: a share computed from a handful of impressions is noise,
   * and a bid change is a real write.
   */
  sov: [
    {
      name: 'Claim the tail',
      desc: 'Under 1% of the market with real spend behind it — where we are barely present and already paying',
      payload: { conditions: [{ conditions: [{ metric: 'Share of Voice', op: 'lt', value: '1' }, { metric: 'Spend', op: 'gte', value: '5' }], action: { op: 'incPct', value: '15' } }] },
    },
    {
      name: 'Stop overpaying where we already lead',
      desc: 'At or above 3% of the market on ≥€10 spend — take the bid down and keep the position',
      payload: { conditions: [{ conditions: [{ metric: 'Share of Voice', op: 'gte', value: '3' }, { metric: 'Spend', op: 'gte', value: '10' }], action: { op: 'decPct', value: '10' } }] },
    },
    /**
     * 🔴 A third starter, "Stop bidding against yourself" (`Campaign Concentration < 60%`), was
     * shipped in `0e7e59996` and PULLED the same night. `topSharePct` is null wherever we ran no
     * ads on that query in the window — 86 of 793 contexts — and the engine's comparator answers
     * `null < 0.6` with **true** (measured, `_sovp-p4-nullcheck.mts`). So the starter matched 4
     * targets carrying real spend whose concentration is not measurable at all, and cut their bids
     * on the stated reasoning that several of our campaigns compete for the term — which is the
     * opposite of what a null means there.
     *
     * The metric itself stays offered: an operator choosing it deliberately is a different thing
     * from a one-click starter that mis-fires silently. The real fix is cross-cutting — a
     * not-measurable value must fail EVERY operator, not just `gte` — and it moves every rule in
     * the account, so it belongs to that unit and not to this list. Caught by KT-P, who spotted
     * that a spend guard cannot exclude a null share.
     */
  ],
  // NEG-P3 — every negative starter pairs its zero with an evidence floor, and none ships a
  // bare contains-list: a "blacklist" starter with an empty terms box would negate everything
  // the emitter surfaces. The blacklist RECIPE is: add your terms under Search Terms (contains)
  // and keep any starter's criteria — the wire honours the list end-to-end since NEG-P1.
  'negative-targeting': [
    {
      name: 'Wasted spend',
      desc: 'Zero orders on ≥5 clicks and ≥€3 spend — the floor at which terms surface, negated as they appear',
      payload: { conditions: [{ conditions: [{ metric: 'Sales', op: 'eq', value: '0' }, { metric: 'Clicks', op: 'gte', value: '5' }, { metric: 'Spend', op: 'gte', value: '3' }], action: { op: 'set', value: '' } }] },
    },
    {
      name: 'High-evidence bleeders',
      desc: 'Zero orders on ≥10 clicks and ≥€10 spend — proven waste before any block',
      payload: { conditions: [{ conditions: [{ metric: 'Sales', op: 'eq', value: '0' }, { metric: 'Clicks', op: 'gte', value: '10' }, { metric: 'Spend', op: 'gte', value: '10' }], action: { op: 'set', value: '' } }] },
    },
    {
      name: 'Click sink, no sales',
      desc: 'Zero orders on ≥20 clicks — H10’s own default bar (Sales = 0, Clicks ≥ 20)',
      payload: { conditions: [{ conditions: [{ metric: 'Sales', op: 'eq', value: '0' }, { metric: 'Clicks', op: 'gte', value: '20' }], action: { op: 'set', value: '' } }] },
    },
  ],
  /**
   * BUD-P4 — budget starters. Two constraints shape all three, and both come from the census:
   *
   *   · **55 of 86 enabled campaigns sit at the €1 floor**, where the guardrail makes any Decrease
   *     a no-op. So every cut starter carries a SPEND floor that a €1/day campaign cannot clear
   *     (€1/day × 7 settled days = €7 maximum) — the starter excludes them by arithmetic rather
   *     than promising a cut it cannot deliver.
   *   · **a raise moves real money**, so both raise conditions demand evidence: not ACoS alone,
   *     which is noise on one order, but ACoS with orders behind it and a budget actually being
   *     consumed.
   *
   * Budget Utilization is the campaign's average daily spend ÷ its daily budget over the rule's
   * own lookback — H10's signature budget metric, and the only one that can tell "this winner is
   * capped" from "this winner has room".
   */
  budget: [
    {
      name: 'Feed capped winners',
      desc: 'ACoS ≤ 20% with ≥2 orders and budget ≥90% consumed → raise the daily budget 20%',
      payload: { conditions: [{ conditions: [{ metric: 'ACOS', op: 'lte', value: '20' }, { metric: 'Orders', op: 'gte', value: '2' }, { metric: 'Budget Utilization', op: 'gte', value: '90' }], action: { op: 'incPct', value: '20' } }] },
    },
    {
      name: 'Trim high-ACoS spend',
      desc: 'ACoS ≥ 40% on ≥€50 spend → cut the daily budget 15% (the spend floor clears the €1-floor campaigns, where a cut would do nothing)',
      payload: { conditions: [{ conditions: [{ metric: 'ACOS', op: 'gte', value: '40' }, { metric: 'Spend', op: 'gte', value: '50' }], action: { op: 'decPct', value: '15' } }] },
    },
    {
      name: 'Reclaim idle budget',
      desc: 'Under 10% of budget consumed on ≥€5 spend → cut the daily budget 25%, freeing headroom for the capped winners above',
      payload: { conditions: [{ conditions: [{ metric: 'Budget Utilization', op: 'lte', value: '10' }, { metric: 'Spend', op: 'gte', value: '5' }], action: { op: 'decPct', value: '25' } }] },
    },
  ],
  /**
   * PLC-P6 — placement starters, and every one of the three is shaped by a measurement rather than
   * by what sounds sensible. Measured on prod 2026-08-22 across the reachable set (enabled ∧ spend
   * in the settled window ∧ past the write gate):
   *
   *   · 🔴 **`ACoS ≥ 40%` matches ZERO campaigns** over 7 settled days, and two over 30. The
   *     obvious "trim the bleeders" starter every other tab ships would be inert here, so none of
   *     these uses a high-ACoS bar. What this account actually has is spend with NO sales at all,
   *     where ACoS is `null` rather than large — and a null fails every comparison, which is why
   *     the zero-sale starters test `Sales = 0` instead.
   *   · **The lane has to have something to cut.** Of the 12 campaigns matching
   *     `Sales = 0 AND Clicks ≥ 20`, Rest of Search already carries a multiplier on **9** and Top
   *     of Search on **2** — so the cut starters name Rest of Search. A decrease on a lane sitting
   *     at 0 clamps to 0 and does nothing; honest, but useless as a starting point.
   *   · 🔴 **Product Pages is the one lane no engine contests.** `ad-rank-defend` wrote
   *     `PLACEMENT_TOP` 12,197 times and `PLACEMENT_REST_OF_SEARCH` 11,075 times in 30 days, and
   *     `PLACEMENT_PRODUCT_PAGE` **twice**. On the 25 of 43 reachable campaigns a schedule governs,
   *     a Top-of-Search rule is undone within the hour and a Product Pages rule holds. That is why
   *     the one starter that RAISES a bid raises Product Pages.
   *   · **The window is part of the starter.** `ACoS ≤ 25% AND Orders ≥ 2` matches 3 campaigns
   *     over 7 settled days and 11 over 30, so the raise starter ships `windowDays: 30` (PLC-P5)
   *     rather than looking broken on the default.
   */
  placement: [
    {
      name: 'Stop overpaying Rest of Search on zero-sale clicks',
      desc: 'No sales at all on ≥20 clicks → cut the Rest of Search modifier 30%. A cut only bites where the lane carries a value, and the rank engine moves the bias between lanes through the day — preview it to see which campaigns it would reach right now',
      payload: { conditions: [{ conditions: [{ metric: 'Sales', op: 'eq', value: '0' }, { metric: 'Clicks', op: 'gte', value: '20' }], action: { op: 'decPct', value: '30', placeTarget: 'ros' } }] },
    },
    {
      name: 'Back proven converters where the rank engine won’t undo it',
      desc: 'ACoS ≤ 25% with ≥2 orders over 30 days → set Product Pages to 25% — the only lane the rank engine leaves alone (2 writes in 30 days, against 12,197 on Top of Search)',
      /**
       * 🔴 `set`, not `incPct`, and the preview is why. Of the 11 campaigns this matches, Product
       * Pages sits at **0 on 8 of them** — and increasing 0 by 25% is 0. Shipped as a raise, the
       * starter moved 3 rows and reported "sits at a guardrail" on the other 8: arithmetically
       * honest, useless as a starting point. `Set to` works from the cold start most matches are
       * actually in. It can lower a lane an operator had put higher, which is why this rule
       * proposes rather than writes — every row is shown current → proposed before anyone accepts.
       */
      payload: { windowDays: 30, conditions: [{ conditions: [{ metric: 'ACOS', op: 'lte', value: '25' }, { metric: 'Orders', op: 'gte', value: '2' }], action: { op: 'set', value: '25', placeTarget: 'pdp' } }] },
    },
    {
      name: 'Stop paying for a placement that is seen and ignored',
      desc: 'CTR ≤ 0.3% on ≥500 impressions → set Rest of Search to 0%. Impressions without clicks are a placement problem, not a bid problem. On a campaign the rank engine governs it will be undone within the hour — the preview marks those rows',
      payload: { conditions: [{ conditions: [{ metric: 'CTR', op: 'lte', value: '0.3' }, { metric: 'Impressions', op: 'gte', value: '500' }], action: { op: 'set', value: '0', placeTarget: 'ros' } }] },
    },
  ],
  bid: [
    {
      name: 'Cut bids on high ACoS',
      desc: 'ACoS > 35% with ≥10 clicks → lower the bid 15%',
      payload: { conditions: [{ conditions: [{ metric: 'ACOS', op: 'gt', value: '35' }, { metric: 'Clicks', op: 'gte', value: '10' }], action: { op: 'decPct', value: '15' } }] },
    },
    {
      name: 'Scale winners',
      desc: 'ACoS < 20% with ≥2 orders → raise the bid 10%',
      payload: { conditions: [{ conditions: [{ metric: 'ACOS', op: 'lt', value: '20' }, { metric: 'Orders', op: 'gte', value: '2' }], action: { op: 'incPct', value: '10' } }] },
    },
    {
      name: 'Floor zero-sale spenders',
      desc: '≥€5 spend, ≥10 clicks, no sales → set the bid to €0.05',
      payload: { conditions: [{ conditions: [{ metric: 'Spend', op: 'gte', value: '5' }, { metric: 'Clicks', op: 'gte', value: '10' }, { metric: 'Sales', op: 'eq', value: '0' }], action: { op: 'set', value: '0.05' } }] },
    },
    {
      name: 'Converge to 25% ACoS',
      desc: '≥10 clicks → bid = CPC × (25% ÷ actual ACoS)',
      payload: { conditions: [{ conditions: [{ metric: 'Clicks', op: 'gte', value: '10' }], action: { op: 'targetAcos', value: '25' } }] },
    },
    {
      name: 'Bid break-even',
      desc: 'ACoS > 30% with ≥10 clicks → bid = revenue per click',
      payload: { conditions: [{ conditions: [{ metric: 'ACOS', op: 'gt', value: '30' }, { metric: 'Clicks', op: 'gte', value: '10' }], action: { op: 'revPerClick', value: '' } }] },
    },
  ],
}
// Budget rule marketplace scope (best-in-class) — limit a rule to one EU market.
const MARKETS = [{ value: 'all', label: 'All markets' }, ...([['DE', 'Germany'], ['IT', 'Italy'], ['FR', 'France'], ['ES', 'Spain'], ['NL', 'Netherlands'], ['BE', 'Belgium'], ['SE', 'Sweden'], ['PL', 'Poland']] as const).map(([v, n]) => ({ value: v, label: `${n} (${v})` }))]
const INTERVAL = ['Days', 'Weeks', 'Months'].map((i) => ({ value: i, label: i }))
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d) => ({ value: d, label: d }))
const METRIC_UNIT = PC_METRIC_UNIT
// Campaign-scoped "THEN" actions. Budget rules adjust the daily budget; Bid rules adjust the
// keyword/target bid. `unit` drives the value input (€ vs %). H10's recording shows "Set Bid
// to($)" with the marketplace currency in the input; we keep our app's € convention (matching
// the Budget builder) in both the label and the input prefix.
const BUDGET_ACTIONS: Array<{ value: string; label: string; unit: ActionUnit }> = [
  { value: 'set', label: 'Set Daily Budget to(€)', unit: 'eur' },
  { value: 'incPct', label: 'Increase Daily Budget by(%)', unit: 'pct' },
  { value: 'decPct', label: 'Decrease Daily Budget by(%)', unit: 'pct' },
  { value: 'incAbs', label: 'Increase Daily Budget by(€)', unit: 'eur' },
  { value: 'decAbs', label: 'Decrease Daily Budget by(€)', unit: 'eur' },
]
const BID_ACTIONS: Array<{ value: string; label: string; unit: ActionUnit }> = [
  { value: 'set', label: 'Set Bid to(€)', unit: 'eur' },
  { value: 'incPct', label: 'Increase Bid by(%)', unit: 'pct' },
  { value: 'decPct', label: 'Decrease Bid by(%)', unit: 'pct' },
  { value: 'incAbs', label: 'Increase Bid by(€)', unit: 'eur' },
  { value: 'decAbs', label: 'Decrease Bid by(€)', unit: 'eur' },
  /**
   * C1 (2026-08-20) — the two COMPUTED bid actions from the operator's study. Unlike the five
   * above, these do not take the bid as arithmetic on its current value: the engine reads the
   * target's own measured CPC (and ACoS) over the rule's window and derives the number.
   *
   * 🔴 `targetAcos` is NOT the `bid_to_target_acos` handler despite the name. That one is
   * campaign-grain, runs over the whole account from `ads-bid-optimizer`, and on the default
   * metric source reads columns nothing has written since H.2e — B2/B4 measured it applying
   * zero bids across every rule that carries it. This op is per-target, computed inside
   * `bid_apply` from the same daily table the Lookback column describes.
   */
  { value: 'targetAcos', label: 'Set Bid to CPC × (Target ACoS / Actual ACoS)', unit: 'pct' },
  { value: 'setCpc', label: 'Set Bid to CPC', unit: 'none' },
  /**
   * BP.P4 (2026-08-21) — the last two of H10's computed Bid actions (§5.3 of the reference
   * study). `revPerClick` bids what a click has actually been worth (attributed sales ÷ clicks
   * — the break-even bid at 100% ACoS); `curBidTargetAcos` is the CURRENT-BID variant of the
   * ratio action above. Both compute in `bid_apply` from the same measured window and refuse,
   * named, when the signal is missing.
   */
  { value: 'revPerClick', label: 'Set Bid to Revenue per Click', unit: 'none' },
  { value: 'curBidTargetAcos', label: 'Set Bid to Current Bid × (Target ACoS / Actual ACoS)', unit: 'pct' },
  /**
   * C2 (2026-08-20) — the status verbs. These do NOT move a bid: the adapter emits
   * `pause_target` / `enable_target` instead of `bid_apply`, so one handler keeps one job.
   *
   * 🔴 A deliberate exception to the account's no-pause policy, granted by the operator after the
   * trade-off was put to them: pausing makes Amazon re-learn the target when it is unpaused.
   * `Decrease Bid by(%)` and the bid floor remain the gentler tools, and the graduation ceiling
   * holds a pausing rule below Auto so it proposes rather than acts.
   */
  { value: 'pauseTarget', label: 'Pause Target', unit: 'none' },
  { value: 'enableTarget', label: 'Unpause Target', unit: 'none' },
  /**
   * 🔴 C3 (2026-08-20) — "Increase to Top of Search / First Page" is ABSENT ON PURPOSE.
   *
   * It is in the operator's H10 study and it was considered and declined, so this is a decision
   * and not a gap. Do not add it here without new data.
   *
   * There is no per-keyword top-of-search signal to compute it from. `topOfSearchIS` is
   * CAMPAIGN-DAY grain (`AmazonAdsPlacementReport`), which can say a campaign wins 12% of
   * top-of-search impressions but cannot say what THIS target would have to bid; and Amazon's
   * theme-based bid recommendation — the only per-keyword suggestion endpoint we call
   * (`ads-api-client.ts`, POST /sp/targets/bid/recommendations) — returns
   * CONVERSION_OPPORTUNITIES and SPECIAL_DAYS, with no top-of-search theme. A keyword-level
   * version would therefore pick a multiplier out of the air and label it with a placement
   * guarantee it cannot make, in the one cell on the page that moves money.
   *
   * The capability is real and already lives where Amazon actually exposes it: the PLACEMENT tab's
   * Top of Search multiplier (`set_placement_multiplier`, plus `defend_top_of_search`). The intent
   * — push a keyword hard enough to win premium placement — is served on this tab by
   * `targetAcos` with an aggressive target, or by `incPct`.
   *
   * The honest version, if it is ever wanted, is "Set Bid to Amazon's suggested bid (high end of
   * range)" from `ads-bid-suggest.service.ts` — a published number, labelled as what it is. It
   * needs batching/caching (one Amazon call per keyword per tick otherwise) and a coverage check
   * first: that service falls back to an account-wide median when it cannot match a keyword, and a
   * rule silently bidding the median on half its targets would be its own quiet defect.
   */
]
// Placement rule THEN — set/raise/lower a placement bid modifier (% only). H10 labels are bare
// ("Set to", not "Set to(%)") — the % is shown as the value-field suffix (frame 02:58–03:17).
const PLACEMENT_ACTIONS: Array<{ value: string; label: string; unit: ActionUnit }> = [
  { value: 'set', label: 'Set to', unit: 'pct' },
  { value: 'incPct', label: 'Increase by', unit: 'pct' },
  { value: 'decPct', label: 'Decrease by', unit: 'pct' },
]
// SP placement targets (Amazon: Top of Search / Product Pages / Rest of Search).
// PLC-P3 — imported, not retyped: the rules grid's Criteria cell names the same three lanes, and
// two label lists for one lane is how a grid and a builder start describing different rules.
const PLACEMENTS = PLACEMENT_LANES.map((l) => ({ value: l.value as string, label: l.label }))
// IF placement-scope (which placement's metric to evaluate) — Campaign-wide or a single placement.
const PLACEMENT_SCOPES = [{ value: 'campaign', label: 'Campaign' }, ...PLACEMENTS]
const METRICS_PLACEMENT = PC_METRICS_PLACEMENT
/**
 * C1 — `'none'` joins the unit vocabulary for an action that takes NO value.
 *
 * "Set Bid to CPC" computes its own number, so a value box beside it would be a control with
 * nothing to control — and `criteriaValid` would then refuse to save a rule that is complete.
 * Both the input and the validation key off this.
 */
type ActionUnit = 'eur' | 'pct' | 'none'
const actionUnit = (actions: Array<{ value: string; unit: ActionUnit }>, op?: string): ActionUnit => actions.find((a) => a.value === op)?.unit ?? 'eur'
// builder slug → backend automation-rule trigger (the create payload)
const TRIGGER_BY_SLUG: Record<string, string> = {
  'negative-targeting': 'SEARCH_TERM_WASTING',
  'keyword-harvesting': 'SEARCH_TERM_CONVERTING',
  bid: 'KEYWORD_HIGH_ACOS',
  budget: 'CAMPAIGN_PERFORMANCE_BUDGET',
  'dayparting-schedule': 'SCHEDULE',
  'budget-schedule': 'SCHEDULE',
  placement: 'CAMPAIGN_PERFORMANCE_BUDGET',
  // SOV + Keyword Tracker are keyword-bid-adjustment rules driven by Share-of-Voice / rank data
  // (their own context-builders); the THEN clause reuses the Bid action + bid_apply handler.
  sov: 'SOV_BID',
  'keyword-tracker': 'KEYWORD_RANK_BID',
}
// friendly match-type label for the negative preview (raw API gives EXACT/PHRASE/BROAD or TARGETING_EXPRESSION*)
const matchLabel = (m?: string): string => {
  if (!m) return '—'
  if (m === 'EXACT') return 'Exact'
  if (m === 'PHRASE') return 'Phrase'
  if (m === 'BROAD') return 'Broad'
  if (/TARGETING_EXPRESSION/.test(m)) return 'Auto'
  return m
}
const TIMES = Array.from({ length: 24 }, (_, h) => {
  const hh = String(h).padStart(2, '0')
  const ampm = h === 0 ? '12:00 AM' : h < 12 ? `${h}:00 AM` : h === 12 ? '12:00 PM' : `${h - 12}:00 PM`
  return { value: `${hh}:00`, label: `${ampm} (${hh}:00)` }
})
const TIMEZONES = [
  { value: 'pst', label: 'PST/PDT - Pacific Standard/Daylight Time, Los Angeles' },
  { value: 'est', label: 'EST/EDT - Eastern Standard/Daylight Time, New York' },
  { value: 'utc', label: 'UTC - Coordinated Universal Time' },
  { value: 'cet', label: 'CET/CEST - Central European Time, Rome' },
]
// target match types — the maroon P / E / 📦 circles in the "What targets" header.
// Glyphs are identical for both rule types (the 3rd is a package/Product-ASIN icon, not "M");
// only the hover copy differs (negative vs positive).
interface MatchType { key: string; product?: boolean; tip: string }
// a campaign row for the Budget rule's inline picker (B1 fills the panel)
/**
 * 🔴 The campaign object this builder holds IS the shared picker's (`SchedCampaign`), aliased so the
 * ~30 references below read unchanged. It was a separate, near-identical interface until
 * 2026-08-18; two shapes for one thing is how the two pickers drifted apart in the first place.
 */
type BudgetCampaign = SchedCampaign
const MATCH_TYPES_NEG: MatchType[] = [
  { key: 'P', tip: 'Negative Phrase' },
  { key: 'E', tip: 'Negative Exact' },
  { key: 'product', product: true, tip: 'Negative Product (ASIN)' },
]
const MATCH_TYPES_POS: MatchType[] = [
  { key: 'P', tip: 'Phrase' },
  { key: 'E', tip: 'Exact' },
  // HP1 — honest while it waits: the engine has no product-target create path yet, so a ticked
  // ASIN type is refused BY NAME in the run's outcome; the keyword types on the mapping still land.
  { key: 'product', product: true, tip: 'Product (ASIN) — creation not supported yet; the engine names the refusal in the run outcome. Phrase/Exact on this mapping still land.' },
]

// Ad-group selection (H2): the "Add Ad Group" popover → the populated left/right two-panel.
interface AdGroupItem { id: string; name: string; campaignId: string; campaignName: string | null; status: string; campaignStatus: string | null; adProduct: string | null; portfolioId: string | null }
interface SelGroup extends AdGroupItem {
  look: boolean
  types: { P: boolean; E: boolean; product: boolean }
  /** HP2 — set by the Ad Group View's per-pathway pause; the builder PRESERVES it through an
   *  edit-save (it is not rendered here — the Ad Group View is the pause surface). */
  paused?: boolean
}
// H3 — a rule can hold multiple source→target "Ad Group Mapping" blocks (Harvest; Negative uses one).
interface MapBlock { id: number; groups: SelGroup[] }
let _bid = 1

// Condition is imported from PerformanceCriteria (single source); CriteriaGroup adds RuleBuilder-only
// fields (id + the per-group THEN action), so it stays local.
interface CriteriaGroup { id: number; conditions: Condition[]; lookback: string; exclude: string; budgetOp?: string; budgetValue?: string; placeTarget?: string } // placeTarget = placement THEN target
let _cid = 1
const defaultCondition = pcDefaultCondition
// NEG-P2 — the default rows come from pcDefaultGroup (one source): negative-targeting starts as
// the PAIR "Sales = 0 AND Clicks ≥ 5" (H10's default is a pair too; ours pairs the emitter floor).
const newGroup = (slug: string): CriteriaGroup => ({ id: _cid++, ...pcDefaultGroup(slug), budgetOp: 'set', budgetValue: '', placeTarget: 'tos' })

// per-type Rule Setup config — Negative vs Positive/Harvest differ in heading, copy,
// targets-panel title, and whether Harvest's "Ad Group Mapping" button + info banner show.
const SETUP: Record<string, { nav: string; desc: string; targetsTitle: string; matchTypes: MatchType[]; mapping?: boolean; banner?: string; surface?: 'search-terms' | 'campaign-budget' | 'campaign-bid' | 'campaign-placement' | 'campaign-sov' | 'campaign-rank'; sectionTitle?: string }> = {
  'negative-targeting': {
    nav: 'Negative Rule Setup',
    desc: 'Add related Ad Groups in any order and select which ones you’d like Nexus Ads to use to find non-converting search terms/ASINs. For each Ad Group, you can then decide which type of target you want to create when it finds a non-converting search term/ASIN.',
    targetsTitle: 'Create New Negative Targets',
    matchTypes: MATCH_TYPES_NEG,
  },
  'keyword-harvesting': {
    nav: 'Positive Rule Setup',
    desc: 'Add related Ad Groups in any order and select which ones you’d like Nexus Ads to use to find converting search terms/ASINs. For each Ad Group, you can then decide which type of target you want to create when it finds a converting search term/ASIN.',
    targetsTitle: 'Create New Targets',
    matchTypes: MATCH_TYPES_POS,
    mapping: true,
    banner: 'Nexus Ads is checking for search terms that hit the specified criteria per ad group, and not aggregating performance metrics across all selected ad groups',
  },
  budget: {
    nav: 'Budget Rule Setup',
    desc: 'Select the Campaigns you want to include',
    targetsTitle: '',
    matchTypes: [],
    surface: 'campaign-budget',
    sectionTitle: 'Campaigns', // H10 section heading (≠ left-nav label) — frame-verified
  },
  bid: {
    nav: 'Bid Rule Setup',
    desc: 'Select the Campaigns you want to include',
    targetsTitle: '',
    matchTypes: [],
    surface: 'campaign-bid',
    sectionTitle: 'Campaigns',
  },
  placement: {
    nav: 'Placement Rule Setup',
    desc: 'Select the Campaigns you want to include',
    targetsTitle: '',
    matchTypes: [],
    surface: 'campaign-placement',
    sectionTitle: 'Campaigns Section', // frame-verified (02:58–03:17) — note: differs from budget's "Campaigns"
  },
  // SOV + Keyword Tracker — keyword-bid-adjustment rules (Bid-builder pattern) keyed off the SOV
  // report / keyword-tracker rank data. Same campaign picker + Set/Adjust Bid THEN as the Bid rule.
  sov: {
    nav: 'SOV Rule Setup',
    desc: 'Select the Campaigns whose keyword bids this rule should adjust based on Share-of-Voice data',
    targetsTitle: '',
    matchTypes: [],
    surface: 'campaign-sov',
    sectionTitle: 'Campaigns',
  },
  'keyword-tracker': {
    nav: 'Keyword Tracker Rule Setup',
    desc: 'Select the Campaigns whose keyword bids this rule should adjust based on organic & paid rank',
    targetsTitle: '',
    matchTypes: [],
    surface: 'campaign-rank',
    sectionTitle: 'Campaigns',
  },
}
const setupFor = (slug: string) => SETUP[slug] ?? SETUP['negative-targeting']

// Adtomic-style atom mark (two crossing orbits + nucleus) — our own SVG that matches the
// builder top-bar glyph in the recording more closely than lucide's 3-orbit Atom.
function AtomMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className="ic">
      <g transform="rotate(45 12 12)"><ellipse cx="12" cy="12" rx="10.4" ry="4.3" stroke="#1f6fde" strokeWidth="1.7" /></g>
      <g transform="rotate(-45 12 12)"><ellipse cx="12" cy="12" rx="10.4" ry="4.3" stroke="#1f6fde" strokeWidth="1.7" /></g>
      <circle cx="12" cy="12" r="2.5" fill="#0b1f44" />
    </svg>
  )
}

const STEPS_FOR = (slug: string): Array<{ id: string; label: string }> => {
  const setupLabel = SETUP[slug]?.nav ?? 'Rule Setup'
  const head = [
    { id: 'rule-name', label: 'Rule Name' },
    { id: 'setup', label: setupLabel },
    { id: 'criteria', label: 'Criteria' },
  ]
  const tail = [
    { id: 'advanced', label: 'Advanced Settings' },
    { id: 'control', label: 'Control' },
  ]
  // Campaign-scoped rules (Budget · Bid · Placement) have no Search Terms step — their action is
  // a THEN clause inside Criteria, applied to the selected campaigns.
  const sf = SETUP[slug]?.surface
  if (sf === 'campaign-budget' || sf === 'campaign-bid' || sf === 'campaign-placement' || sf === 'campaign-sov' || sf === 'campaign-rank') return [...head, ...tail]
  return [...head, { id: 'search-terms', label: 'Search Terms' }, ...tail]
}

export function RuleBuilder({ slug }: { slug: string }) {
  const router = useRouter()
  const ruleId = useSearchParams().get('ruleId')
  const isEdit = !!ruleId
  /**
   * EA5 — set when the rule being edited is ENGINE-NATIVE, with HOW MUCH of it may be written
   * back. Non-null does NOT mean read-only:
   *
   *   'criteria' — every stored condition round-trips, so name · criteria · caps · scope save
   *                normally. `actions` is simply not sent, so the engine keeps the action it runs.
   *   'meta'     — a condition the builder cannot draw, so criteria are read-only: saving them
   *                would DELETE the one not shown. Name · caps · scope still save.
   *
   * The first version of this locked the whole rule whenever any part could not round-trip. That
   * was over-correction: the PATCH route applies only the fields present in the body, so an
   * unrepresentable ACTION is no reason to refuse an edit to the CRITERIA.
   *
   * 🔴 This is the guard that stops a live automation being destroyed. Before it, opening any of
   * the 51 stored rules showed a blank form (their keys are not the ones this builder reads) and
   * pressing Save would have written hard-coded default criteria over the real ones. It was
   * unreachable only by accident — `valid` happened to fail with 0 campaigns selected.
   */
  const [locked, setLocked] = useState<{ level: 'criteria' | 'meta'; blockers: string[]; actionSummary: string[] } | null>(null)
  const rt = ruleTypeBySlug(slug)
  /**
   * BP.P3 — memoised. `STEPS_FOR(slug)` returned a NEW array every render, so the scroll-spy
   * effect below (deps `[steps]`) detached and re-attached its scroll listener on every
   * keystroke and every `setActive` — churn that also kept cancelling the nav's smooth scroll
   * mid-animation (measured on prod: `scrollTo({behavior:'smooth'})` moved ~6px and died, so
   * the left nav was inert).
   */
  const steps = useMemo(() => STEPS_FOR(slug), [slug])
  const setup = setupFor(slug)
  const isHarvest = slug === 'keyword-harvesting' // harvest-only features (bid · negate-in-source · Preview) gate on this
  const surface = setup.surface ?? 'search-terms'
  const isBudget = surface === 'campaign-budget'
  const isBid = surface === 'campaign-bid' // Bid rule: campaign-picker setup + a "Set/Adjust Bid" THEN action, with lookback per-criteria
  const isSov = surface === 'campaign-sov' // SOV rule: keyword bid adjustment driven by Share-of-Voice criteria
  const isRank = surface === 'campaign-rank' // Keyword Tracker rule: keyword bid adjustment driven by organic/paid rank criteria
  const isBidLike = isBid || isSov || isRank // Bid · SOV · Keyword Tracker — same campaign picker + per-criteria lookback + Set/Adjust Bid THEN
  const isPlacement = surface === 'campaign-placement' // Placement rule: campaign picker + IF placement-scope + THEN placement-target adjustment (%)
  const isCampaign = isBudget || isBidLike || isPlacement // all campaign-scoped surfaces share the CampaignSection picker + THEN-action + templates
  const advLookback = isBudget || isPlacement // Budget + Placement put Lookback in Advanced (one window for the rule); Bid/SOV/Rank keep it per-criteria
  const isNegative = slug === 'negative-targeting' // N2 features (Negation Level · protect-converting) are negative-only, NOT "everything that isn't harvest"
  // P2.2 — the bare index is a redirect now (landing decision 2026-08-15); close/save land on the
  // rule's OWN tab, where the rule the operator just made is actually visible. `tab: 'rules'`
  // routes at /apply-rules (the one key≠path pair in tabs.tsx).
  const ownTab = rt?.tab && rt.tab !== 'rules' ? rt.tab : 'apply-rules'
  const close = useCallback(() => router.push(`/marketing/ads/rules-automation/${ownTab}`), [router, ownTab])

  const [ruleName, setRuleName] = useState('')
  const [groups, setGroups] = useState<CriteriaGroup[]>(() => [newGroup(slug)])
  const [searchMode, setSearchMode] = useState<'contains' | 'not'>('contains')
  const [searchText, setSearchText] = useState('')
  const [searchTerms, setSearchTerms] = useState<Array<{ term: string; op: 'contains' | 'not' }>>([])
  const addSearchTerms = () => {
    const terms = searchText.split(/[\n,]/).map((t) => t.trim()).filter(Boolean)
    if (!terms.length) return
    setSearchTerms((cur) => { const have = new Set(cur.map((x) => `${x.op}::${x.term.toLowerCase()}`)); return [...cur, ...terms.filter((t) => !have.has(`${searchMode}::${t.toLowerCase()}`)).map((t) => ({ term: t, op: searchMode }))] })
    setSearchText('')
  }
  const [frequency, setFrequency] = useState('Daily')
  const [everyN, setEveryN] = useState('')
  const [interval, setInterval] = useState('Weeks')
  const [onDay, setOnDay] = useState('Monday')
  const [time, setTime] = useState('00:00')
  // BP.P2 — Europe/Rome, not H10's PST: the schedule is honoured by the engine now, so the
  // default timezone must be the one the account trades in.
  const [timezone, setTimezone] = useState('cet')
  const [dedupe, setDedupe] = useState(true)
  const [control, setControl] = useState<'manual' | 'automate'>('manual')
  /**
   * BP.P1 — what the Control radio said when an EDIT opened. Saving re-arms the rule's level only
   * when the operator CHANGED the radio this session: a name edit on a rule someone deliberately
   * disabled on Automations must not silently re-enable it, while a changed radio is an explicit
   * instruction and applies on save. Null until an edit hydrates (create mode always arms).
   */
  const initialControl = useRef<'manual' | 'automate' | null>(null)
  // ── ad-group mapping blocks (H3): Harvest can hold multiple source→target mappings; Negative
  //    always has one. Each block carries its own selected ad groups + per-group target types. ──
  const [blocks, setBlocks] = useState<MapBlock[]>([{ id: 1, groups: [] }])
  const [openPop, setOpenPop] = useState<number | null>(null)
  const [setupCollapsed, setSetupCollapsed] = useState(false)
  const updateBlock = (bid: number, fn: (b: MapBlock) => MapBlock) => setBlocks((bs) => bs.map((b) => (b.id === bid ? fn(b) : b)))
  const addBlock = () => setBlocks((bs) => [...bs, { id: ++_bid, groups: [] }])
  const removeBlock = (bid: number) => setBlocks((bs) => (bs.length > 1 ? bs.filter((b) => b.id !== bid) : bs))
  const addGroups = (bid: number, items: AdGroupItem[]) => updateBlock(bid, (b) => { const have = new Set(b.groups.map((g) => g.id)); return { ...b, groups: [...b.groups, ...items.filter((i) => !have.has(i.id)).map((i) => ({ ...i, look: true, types: { P: true, E: true, product: false } }))] } })
  const removeGroup = (bid: number, id: string) => updateBlock(bid, (b) => ({ ...b, groups: b.groups.filter((g) => g.id !== id) }))
  const toggleLook = (bid: number, id: string) => updateBlock(bid, (b) => ({ ...b, groups: b.groups.map((g) => (g.id === id ? { ...g, look: !g.look } : g)) }))
  const toggleType = (bid: number, id: string, t: 'P' | 'E' | 'product') => updateBlock(bid, (b) => ({ ...b, groups: b.groups.map((g) => (g.id === id ? { ...g, types: { ...g.types, [t]: !g.types[t] } } : g)) }))
  const [creating, setCreating] = useState(false)
  // ── H7 best-in-class (beyond the recording) ──
  const [negateInSource, setNegateInSource] = useState(false)
  /**
   * HP1 — H10's four bid modes, all REAL now (`resolveHarvestBidEur` in the engine): the term's
   * own CPC (default — the going rate, Scale Insights' model), CPC + %, the destination ad
   * group's default bid, or a custom figure. The old 'suggested' mode was a €0.75 constant
   * behind a computed-sounding label; stored rules carrying it hydrate as 'cpc'.
   */
  const [bidMode, setBidMode] = useState<'cpc' | 'cpcPlus' | 'adGroupDefault' | 'fixed'>('cpc')
  const [bidValue, setBidValue] = useState('')
  const [brandExclude, setBrandExclude] = useState('')
  const [competitorOnly, setCompetitorOnly] = useState(false)
  // ── N2 negative-targeting best-in-class (negative-only) ──
  const [protectConverting, setProtectConverting] = useState(true)
  const [protectDays, setProtectDays] = useState('30')
  const [negationLevel, setNegationLevel] = useState<'adgroup' | 'campaign' | 'both'>('adgroup')
  // ── Budget rule (campaign-budget surface) — inline picker + global lookback (B1/B3 fill) ──
  const [selCampaigns, setSelCampaigns] = useState<BudgetCampaign[]>([])
  // ── B5 guardrails (budget) ──
  const [budgetFloor, setBudgetFloor] = useState('1') // Amazon €1 daily-budget minimum
  const [budgetCeiling, setBudgetCeiling] = useState('')
  /**
   * BP.P2 — prefilled with the REAL server defaults, because they apply whether or not this form
   * mentions them: a blank spend ceiling used to render the placeholder "No cap" while the create
   * route stored €100/day (`maxDailyAdSpendCentsEur ?? 10000`), and `maxExecutionsPerDay` (10)
   * was surfaced nowhere at all. What the input shows is now what the rule stores.
   */
  const [maxAdSpend, setMaxAdSpend] = useState('100')
  const [maxWrites, setMaxWrites] = useState('')
  const [maxExecs, setMaxExecs] = useState('10')
  const [scopeMarket, setScopeMarket] = useState('all')
  // ── Placement guardrails (P4) — % modifier caps (Amazon allows 0–900%) ──
  const [placeFloor, setPlaceFloor] = useState('0')
  const [placeCeiling, setPlaceCeiling] = useState('900')
  // ── Bid guardrails (SK1) — hard €min/max on the keyword bid (Bid · SOV · Keyword Tracker).
  //    Floor defaults to the bid_apply execution floor (€0.05); Amazon's hard minimum is €0.02. ──
  const [bidFloor, setBidFloor] = useState('0.05')
  const [bidCeiling, setBidCeiling] = useState('')
  /**
   * BP.P4 — the Bid rule's own lookback (H10 carries one per criteria card; ours is per RULE —
   * one evaluation window — and says so). Stored as `actions[0].windowDays`, clamped 7–90 by
   * both engine readers (the context emitter and targetPerformance).
   */
  // BUD-P3 — the default is each trigger's own fixed window (bid 14 · budget 7), so an untouched
  // select stores the same number the engine would have used anyway.
  // PLC-P5 — placement joins budget at the trigger's 7 settled days; bid-like keep 14.
  const [lookbackDays, setLookbackDays] = useState(slug === 'budget' || slug === 'placement' ? '7' : '14')
  // ── B3: rule templates (Budget) ──
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; payload?: unknown }>>([])
  const [tmpl, setTmpl] = useState<{ mode: 'save' | 'apply' } | null>(null)
  const [tmplName, setTmplName] = useState('')
  const addCampaign = (c: BudgetCampaign) => setSelCampaigns((cur) => (cur.some((x) => x.id === c.id) ? cur : [...cur, c]))
  const addCampaigns = (cs: BudgetCampaign[]) => setSelCampaigns((cur) => { const have = new Set(cur.map((x) => x.id)); return [...cur, ...cs.filter((c) => !have.has(c.id))] })
  const removeCampaign = (id: string) => setSelCampaigns((cur) => cur.filter((c) => c.id !== id))
  const clearCampaigns = () => setSelCampaigns([])
  // load saved templates for this rule type (backend may not be live yet — fail soft)
  useEffect(() => {
    if (!isCampaign && !isHarvest && !isNegative) return
    let alive = true
    ;(async () => {
      try { const j = await fetch(`${getBackendUrl()}/api/advertising/rule-templates?type=${slug}`).then((r) => r.json())
        if (alive && Array.isArray(j?.items)) setTemplates(j.items) } catch { /* templates backend not live yet */ }
    })()
    return () => { alive = false }
  }, [isCampaign, isHarvest, isNegative, slug])
  // Bid keeps lookback per-criteria (group[0] is canonical for the template); Budget keeps its global lookback.
  const tmplPayload = () => ({ conditions: groups.map((g) => ({ conditions: g.conditions, action: { op: g.budgetOp ?? 'set', value: g.budgetValue ?? '' } })), lookback: pcWindowLabel(slug), exclude: PC_TRUTH_EXCLUDE, schedule: { frequency, everyN, interval, onDay, time, timezone } })
  const saveTemplate = async () => {
    const name = tmplName.trim(); if (!name) return
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/rule-templates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, type: slug, payload: tmplPayload() }) })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j?.template) setTemplates((cur) => [j.template, ...cur])
    } finally { setTmpl(null); setTmplName('') }
  }
  const applyTemplate = (t: { payload?: unknown }) => {
    const p = (t.payload ?? {}) as { conditions?: Array<{ conditions?: Condition[]; action?: { op?: string; value?: string; placeTarget?: string } }>; lookback?: string; exclude?: string; windowDays?: number; schedule?: Record<string, string> }
    /**
     * 🔴 PLC-P6 — `placeTarget` is carried. It was dropped here, and on a Placement rule the lane
     * IS the rule: every template would have silently landed on Top of Search whatever it said,
     * so a starter named "…Product Pages" would have configured something else. Nothing caught it
     * because no placement template existed until this unit.
     */
    if (Array.isArray(p.conditions) && p.conditions.length) setGroups(p.conditions.map((c) => ({ id: _cid++, conditions: Array.isArray(c.conditions) && c.conditions.length ? c.conditions : [defaultCondition(slug)], lookback: pcWindowLabel(slug), exclude: PC_TRUTH_EXCLUDE, budgetOp: c.action?.op ?? 'set', budgetValue: c.action?.value ?? '', ...(isPlacement ? { placeTarget: c.action?.placeTarget ?? 'tos' } : {}) })))
    /**
     * PLC-P5/P6 — a template may now choose the rule's LOOKBACK, on the slugs that have one. The
     * note this replaces read "a template's stored lookback/exclude are ignored: the trigger's
     * window is fixed" (P2.1) — true then, not now. It matters for the starters: `ACoS ≤ 25% AND
     * Orders ≥ 2` matches 3 reachable campaigns over 7 settled days and 11 over 30, so a raise
     * starter on the default window would look broken. `lookback`/`exclude` stay ignored: those
     * are display strings, not the engine's window.
     */
    if (advLookback && typeof p.windowDays === 'number' && Number.isFinite(p.windowDays)) {
      setLookbackDays(String(Math.max(7, Math.min(90, Math.round(p.windowDays)))))
    }
    const s = p.schedule ?? {}
    if (s.frequency) setFrequency(s.frequency)
    if (s.time) setTime(s.time)
    if (s.timezone) setTimezone(s.timezone)
    setTmpl(null)
  }
  // Esc closes the template modal
  useEffect(() => {
    if (!tmpl) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setTmpl(null) }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [tmpl])
  /**
   * BUD-PP — ONE builder for what leaves this form. `submit` and the Preview both call these, so
   * the preview cannot describe a rule different from the one Save would create. They were
   * inlined in `submit` before; the preview then had to guess the payload, which is how a preview
   * drifts from its rule.
   */
  const previewConditions = useCallback(() => (
    groups.map((g) => ({ match: 'all', lookback: pcWindowLabel(slug), exclude: PC_TRUTH_EXCLUDE, conditions: g.conditions, ...(isCampaign ? { action: { op: g.budgetOp ?? 'set', value: g.budgetValue ?? '', ...(isPlacement ? { placeTarget: g.placeTarget ?? 'tos' } : {}) } } : {}) }))
  ), [groups, slug, isCampaign, isPlacement])
  const previewActions = useCallback(() => (
    [{
          type: slug, control, dedupe, negateInSource, bid: { mode: bidMode, value: bidValue }, filters: { brandExclude: brandExclude.split(/[\n,]/).map((t) => t.trim()).filter(Boolean), competitorOnly }, searchTerms, schedule: { frequency, everyN, interval, onDay, time, timezone },
          ...(isNegative ? { protectConverting, protectDays: Math.max(0, Math.round(Number(protectDays) || 30)), negationLevel } : {}),
          ...(isCampaign ? { campaigns: selCampaigns.map((c) => ({ id: c.id, name: c.name, marketplace: c.marketplace, adProduct: c.adProduct, targetingType: c.targetingType, dailyBudget: c.dailyBudget })) } : {}),
          ...(isBudget ? { budgetFloor: Math.max(1, Number(budgetFloor) || 1), budgetCeiling: budgetCeiling.trim() ? Number(budgetCeiling) : null } : {}),
          ...(isPlacement ? { placeFloor: Math.max(0, Number(placeFloor) || 0), placeCeiling: placeCeiling.trim() ? Number(placeCeiling) : 900 } : {}),
          ...(isBidLike ? { bidFloor: Math.max(0.02, Number(bidFloor) || 0.05), bidCeiling: bidCeiling.trim() ? Number(bidCeiling) : null } : {}),
          ...(isBid ? { windowDays: Math.max(7, Math.min(90, Math.round(Number(lookbackDays)) || 14)) } : {}),
          ...((isBudget || isPlacement) ? { windowDays: Math.max(7, Math.min(90, Math.round(Number(lookbackDays)) || 7)) } : {}),
          mappings: blocks.map((b) => ({ groups: b.groups.map((g) => ({ id: g.id, name: g.name, campaignId: g.campaignId, campaignName: g.campaignName, status: g.status, adProduct: g.adProduct, portfolioId: g.portfolioId, look: g.look, types: g.types, ...(g.paused ? { paused: true } : {}) })) })),
        }]
  ), [slug, control, dedupe, negateInSource, bidMode, bidValue, brandExclude, competitorOnly, searchTerms, frequency, everyN, interval, onDay, time, timezone, isNegative, protectConverting, protectDays, negationLevel, isCampaign, selCampaigns, isBudget, budgetFloor, budgetCeiling, isPlacement, placeFloor, placeCeiling, isBidLike, bidFloor, bidCeiling, isBid, lookbackDays, blocks])
  /**
   * ── KT-P1 (2026-08-22) — the rank feed's own state, because a Keyword Tracker rule is inert
   * without it ───────────────────────────────────────────────────────────────────────────────
   *
   * `KeywordRank` is EMPTY on production (0 rows; its only writer is a manual import route that
   * nothing calls), so `buildKeywordRankBidContexts` returns `[]` on every tick and this rule type
   * has produced 0 contexts and 0 executions in the account's history. The builder nonetheless
   * opened on `IF Organic Rank > __` and stated a settling window over the number.
   *
   * This is a live reading, not a constant: the moment a feed lands, the banner disappears and the
   * rule becomes creatable with no code change. `null` = not asked yet, and the banner does not
   * render until the answer is in — an empty feed and an unanswered fetch must not look alike.
   */
  const [rankFeed, setRankFeed] = useState<{ rows: number; keywords: number; markets: number; newestCapturedAt: string | null; coveredTargets: number; totalTargets: number } | null>(null)
  /** Set when the held Create button is clicked, so a control that refuses can say why. */
  const [rankHeldNote, setRankHeldNote] = useState(false)
  const rankNoteRef = useRef<HTMLParagraphElement>(null)
  /**
   * 🔴 KT-P1 — scroll to the ANSWER, and only once it exists.
   *
   * The first cut called `scrollIntoView` on the Control section inside the click handler. Measured
   * on the rig: the note rendered at y=2491 in a 962px viewport and the scroller moved 41px, so
   * clicking the top Create button looked like it did NOTHING — the button greyed, nothing moved,
   * and the explanation sat 2,500px below the fold. Two reasons, and both had to go: the handler
   * runs BEFORE React has rendered the note, and the target was a different element from the one
   * the operator needs to read.
   *
   * An effect keyed on the flag runs after commit, so the node is guaranteed to exist, and it
   * targets the note itself. `block: 'center'` rather than `end` because the footer button is
   * already beside it — a refusal must never be a control that appears to do nothing.
   *
   * 🔴 `behavior: 'auto'`, deliberately, and do not "improve" it back to `'smooth'`. Measured on
   * the rig against this exact node: inside `.h10-rb-body` (the builder's own `overflow: auto`
   * scroller) a SMOOTH `scrollIntoView` is a silent no-op — `scrollTop` stayed at 0 across a
   * 1.2s wait, while the same call with the default behaviour moved it to 1735.5 immediately.
   * `prefers-reduced-motion` is off and `scroll-behavior` computes to `auto`, so nothing on the
   * page explains it; it simply does not happen here. A refusal that depends on an animation
   * which silently declines to run is a control that appears to do nothing — the defect this
   * effect exists to fix.
   */
  useEffect(() => {
    if (!rankHeldNote) return
    rankNoteRef.current?.scrollIntoView({ behavior: 'auto', block: 'center' })
  }, [rankHeldNote])
  useEffect(() => {
    if (!isRank) return
    let live = true
    fetch(`${getBackendUrl()}/api/advertising/keyword-tracker/feed-health`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j && typeof j.rows === 'number') setRankFeed(j) })
      .catch(() => { /* leave null — silence is not "empty" */ })
    return () => { live = false }
  }, [isRank])
  /** 🔴 No rank has ever been ingested ⇒ any rule built here would match nothing, forever. */
  const rankBlocked = isRank && rankFeed != null && rankFeed.rows === 0
  /** PLC-P3 — which criteria block's locked scope control has been clicked, so it can answer. */
  const [scopeNote, setScopeNote] = useState<number | null>(null)
  const [preview, setPreview] = useState<{
    open: boolean; loading: boolean
    terms: Array<{ term: string; orders?: number; spend?: number; clicks?: number; matchType?: string; current?: number; proposed?: number; organicRank?: number | null; sponsoredRank?: number | null; marketplace?: string | null; utilPct?: number | null; clamped?: boolean
      /** BID-P — the numbers that decided a bid row: a pair with the deciding metric off-screen is uncheckable. */
      acosPct?: number | null
      /** SOV-P2 — the number that decided the row, and our own cannibalisation beside it. */
      sovPct?: number
      concentrationPct?: number | null
      /** The handler REFUSED this one, naming the signal it lacked. A refusal is a row, not an omission. */
      refused?: string
      /** PLC-P2 — placement rows only. The lane IS the rule's identity, so it is a column. */
      lane?: string
      /** 🔴 The rank engine governs this campaign: `current` is a clock reading, not a setting. */
      governed?: boolean
      lastEngineWriteAt?: string | null
      /** KT-P2 — rank rows. null = never observed; NEVER rendered as 0. */
      rankDelta?: number | null
      /**
       * 'flag' = carries `suppressedFromBidCents`; 'bid' = ≤3¢ with no flag. Both are off-switches.
       *
       * Declared for EVERY keyword-bid preview, not just this one: `bid_apply`'s floor is
       * `max(0.05, minEur)`, so it cannot write ≤3¢ — every op on a suppressed target switches
       * delivery back on for traffic somebody deliberately switched off
       * ([[reference_ads_suppression_by_low_bid]]). The rank preview renders the same two fields
       * when its client half lands; this is the shared declaration, not a SOV-only one.
       */
      suppressed?: 'flag' | 'bid' | null
      campaignSuppressed?: boolean
      }>
    /** BUD-PP — the server's own census of this draft: what it considered and what survived. */
    budget?: { windowDays: number; selected: number; measurable: number; inScope: number; matched: number; noChange: number } | null
    /** PLC-P2 — the same census for a placement draft, plus the two facts Budget does not need. */
    place?: { windowDays: number; selected: number; measurable: number; inScope: number; matched: number; noChange: number; governedMatched: number; readAt: string } | null
    /**
     * SOV-P2 — the SOV draft's census. `eligible` / `notEnabled` / `selectedTargets` exist because a
     * SOV rule can only see ENABLED keyword targets whose query Amazon reported a market total for:
     * without them "23 of 135" reads as "112 were considered and rejected", when most were never
     * offered at all.
     */
    /**
     * BID-P — the Bid draft's census. `floor` is the bar the KEYWORD_HIGH_ACOS trigger applies
     * before any rule sees a keyword; without it "3 of 240" reads as "237 were considered and
     * rejected" when almost none were ever offered.
     */
    bid?: {
      windowDays: number; selected: number; selectedTargets: number
      measurable: number; inScope: number; matched: number; noChange: number
      refusedNoSignal: number
      suppressedMatched: number; suppressedUnflaggedMatched: number; campaignSuppressedMatched: number
      floor: { minOrders: number; minSpendEur: number; minAcosPct: number; topPerTick: number }
    } | null
    sov?: {
      windowDays: number; selected: number; measurable: number; inScope: number; matched: number; noChange: number
      eligible: number; notEnabled: number; selectedTargets: number
      suppressedMatched: number; suppressedUnflaggedMatched: number; campaignSuppressedMatched: number
      periods: Array<{ marketplace: string; week: string | null; ageDays: number | null; refused: boolean; reason: string }>
    } | null
    /**
     * KT-P2 — the rank census, plus the two facts only this tab has to state: the state of the
     * FEED (so "nothing matched" and "nothing was measured" can be told apart) and how many of the
     * matched keywords are deliberately suppressed (`bid_apply` has no suppression guard).
     */
    rank?: {
      windowDays: number; selected: number; measurable: number; inScope: number; matched: number; noChange: number
      suppressedMatched: number; suppressedUnflaggedMatched: number; campaignSuppressedMatched: number
      refusedSuppressed: number
      feed: { rows: number; keywords: number; markets: number; newestCapturedAt: string | null; coveredTargets: number; totalTargets: number }
      readAt: string
    } | null
    error?: string
  } | null>(null)
  // Live, read-only preview — budget shows current→proposed daily budgets, harvest converting terms, negative wasting terms.
  const runPreview = useCallback(async () => {
    setPreview({ open: true, loading: true, terms: [] })
    if (isBudget) {
      /**
       * 🔴 BUD-PP — this used to be arithmetic in the browser: every picked campaign, `groups[0]`'s
       * op applied to its CURRENT budget. It ignored the criteria, the marketplace scope, multi-block
       * selection and the context floor — and it used the wrong anchor, because `budget_apply`
       * anchors relative ops to `budgetBaselineCents` (BUD.2), not to the current budget.
       *
       * A second implementation of "what will this rule do" is the two-formatters trap. The server
       * now runs the ENGINE against this draft — real contexts, real scope, real conditions, the
       * real handler in dryRun — and returns only the campaigns that actually match.
       */
      try {
        const r = await fetch(`${getBackendUrl()}/api/advertising/automation-rules/preview`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
          // 'all' is this form's word for UNSCOPED — `submit` omits the field entirely in that case,
          // and sending the literal string makes the matcher compare 'all' to 'DE' and drop every row.
          body: JSON.stringify({ actions: previewActions(), conditions: previewConditions(), scopeMarketplace: scopeMarket && scopeMarket !== 'all' ? scopeMarket : null }),
        })
        const j = await r.json().catch(() => null)
        if (!r.ok || !j?.ok) {
          setPreview({ open: true, loading: false, terms: [], budget: null, error: j?.untranslatable?.length
            ? `No engine signal exists for: ${j.untranslatable.join(', ')}. Remove those conditions — the rule could not evaluate as written.`
            : 'Preview is unavailable right now.' })
          return
        }
        setPreview({
          open: true, loading: false,
          terms: (j.rows ?? []).map((x: { campaign: string; currentEur: number; proposedEur: number; marketplace: string | null; budgetUtilizationPct: number | null; clamped: boolean }) => ({
            term: x.campaign, current: x.currentEur, proposed: x.proposedEur,
            marketplace: x.marketplace, utilPct: x.budgetUtilizationPct, clamped: x.clamped,
          })),
          budget: { windowDays: j.windowDays, selected: j.selected, measurable: j.measurable, inScope: j.inScope, matched: j.matched, noChange: j.noChange },
        })
      } catch {
        setPreview({ open: true, loading: false, terms: [], budget: null, error: 'Preview is unavailable right now.' })
      }
      return
    }
    if (isPlacement) {
      /**
       * 🔴 PLC-P2 — this used to be arithmetic in the browser, and it was wrong in the same five
       * ways BUD-PP had just fixed for Budget. Measured on prod before the change: a draft reading
       * `IF Campaign ACOS > 9999%` listed 70 of 70 campaigns as changing to 50%, and the same
       * draft scoped to Germany still listed every Italian and French campaign.
       *
       * The server now runs the ENGINE against this draft — real contexts, real scope, real
       * conditions, `placement_apply` in dryRun — and returns only the campaigns that match.
       * Nothing in this branch computes a multiplier.
       */
      try {
        const r = await fetch(`${getBackendUrl()}/api/advertising/automation-rules/preview`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
          // 'all' is this form's word for UNSCOPED — see the Budget branch above; sending the
          // literal makes the matcher compare 'all' to 'DE' and drop every row.
          body: JSON.stringify({ actions: previewActions(), conditions: previewConditions(), scopeMarketplace: scopeMarket && scopeMarket !== 'all' ? scopeMarket : null }),
        })
        const j = await r.json().catch(() => null)
        if (!r.ok || !j?.ok) {
          setPreview({ open: true, loading: false, terms: [], place: null, error: j?.untranslatable?.length
            ? `No engine signal exists for: ${j.untranslatable.join(', ')}. Remove those conditions — the rule could not evaluate as written.`
            : 'Preview is unavailable right now.' })
          return
        }
        setPreview({
          open: true, loading: false,
          terms: (j.rows ?? []).map((x: { campaign: string; placementLabel: string; currentPct: number; proposedPct: number; marketplace: string | null; clamped: boolean; governed: boolean; lastEngineWriteAt: string | null }) => ({
            term: x.campaign, lane: x.placementLabel, current: x.currentPct, proposed: x.proposedPct,
            marketplace: x.marketplace, clamped: x.clamped, governed: x.governed, lastEngineWriteAt: x.lastEngineWriteAt,
          })),
          place: { windowDays: j.windowDays, selected: j.selected, measurable: j.measurable, inScope: j.inScope, matched: j.matched, noChange: j.noChange, governedMatched: j.governedMatched, readAt: j.readAt },
        })
      } catch {
        setPreview({ open: true, loading: false, terms: [], place: null, error: 'Preview is unavailable right now.' })
      }
      return
    }
    /**
     * 🔴 SOV-P2 — Share of Voice leaves the browser-arithmetic path below, for reasons measured on
     * prod rather than reasoned about.
     *
     * Clicked on `DE_Auto_Close` with `IF Share of Voice < 5% → Set Bid €0.75`, the old path showed
     * FOUR rows — SEARCH_CLOSE_MATCH, SEARCH_LOOSE_MATCH, PRODUCT_COMPLEMENTS, PRODUCT_SUBSTITUTES —
     * every one `kind: 'AUTO'`, which `buildSovBidContexts` can never select, three of them PAUSED;
     * and it omitted both of the campaign's real KEYWORD targets, because `/advertising/targets` has
     * no `orderBy` and 1,655 of the account's 3,155 positive targets fall outside its 1,500-row page.
     * It applied no criteria at all and read only `groups[0]`.
     *
     * `/automation-rules/preview` runs the real contexts, scope, translation, first-matching-block
     * selection and `bid_apply` in dryRun ([[reference_preview_must_run_the_engine]]).
     */
    if (isSov) {
      try {
        const r = await fetch(`${getBackendUrl()}/api/advertising/automation-rules/preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ actions: previewActions(), conditions: previewConditions(), scopeMarketplace: scopeMarket && scopeMarket !== 'all' ? scopeMarket : null }),
        })
        const j = await r.json().catch(() => null)
        if (!r.ok || !j?.ok) {
          setPreview({ open: true, loading: false, terms: [], sov: null, error: j?.untranslatable?.length
            ? `No engine signal exists for: ${j.untranslatable.join(', ')}. Remove those conditions — the rule could not evaluate as written.`
            : 'Preview is unavailable right now.' })
          return
        }
        setPreview({
          open: true, loading: false,
          terms: (j.rows ?? []).map((x: { keyword: string; matchType: string | null; marketplace: string | null; sovPct: number; concentrationPct: number | null; currentEur: number; proposedEur: number; clamped: boolean; refused?: string; suppressed: 'flag' | 'bid' | null; campaignSuppressed: boolean }) => ({
            term: x.keyword, matchType: x.matchType ?? undefined, marketplace: x.marketplace,
            current: x.currentEur, proposed: x.proposedEur, clamped: x.clamped,
            sovPct: x.sovPct, concentrationPct: x.concentrationPct, refused: x.refused,
            suppressed: x.suppressed, campaignSuppressed: x.campaignSuppressed,
          })),
          sov: {
            windowDays: j.windowDays, selected: j.selected, measurable: j.measurable, inScope: j.inScope,
            matched: j.matched, noChange: j.noChange, eligible: j.eligible, notEnabled: j.notEnabled,
            selectedTargets: j.selectedTargets,
            suppressedMatched: j.suppressedMatched, suppressedUnflaggedMatched: j.suppressedUnflaggedMatched,
            campaignSuppressedMatched: j.campaignSuppressedMatched,
            periods: j.periods ?? [],
          },
        })
      } catch {
        setPreview({ open: true, loading: false, terms: [], sov: null, error: 'Preview is unavailable right now.' })
      }
      return
    }
    /**
     * 🔴 KT-P2 (2026-08-22) — Keyword Tracker previews by RUNNING THE ENGINE, not by arithmetic.
     *
     * What the browser-side branch below rendered for `IF Organic Rank > 50 THEN Set Bid €0.80`
     * over 70 campaigns, measured on prod: **100 rows, every one a green €0.80**, against a true
     * match count of **zero**. It applied no criteria; 90 of those 100 rows were entity kinds a
     * rank rule can never touch (65 ASIN product targets, 15 auto-targeting expressions, audiences
     * and categories — the context selects `kind: 'KEYWORD'`); deliberately suppressed €0.02
     * targets were shown being raised 40× with no warning; and its feed truncated at 1,500 of
     * 5,218 targets while reporting `count` as the page size.
     *
     * `/automation-rules/preview` runs the real contexts, the real scope, the real translation, the
     * real first-matching-block selection and `bid_apply` itself in dryRun — the same five stages
     * Budget, Placement and SOV go through ([[reference_preview_must_run_the_engine]]).
     */
    if (isRank) {
      try {
        const r = await fetch(`${getBackendUrl()}/api/advertising/automation-rules/preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ actions: previewActions(), conditions: previewConditions(), scopeMarketplace: scopeMarket && scopeMarket !== 'all' ? scopeMarket : null }),
        })
        const j = await r.json().catch(() => null)
        if (!r.ok || !j?.ok) {
          setPreview({ open: true, loading: false, terms: [], rank: null, error: j?.untranslatable?.length
            ? `No engine signal exists for: ${j.untranslatable.join(', ')}. Remove those conditions — the rule could not evaluate as written.`
            : 'Preview is unavailable right now.' })
          return
        }
        setPreview({
          open: true, loading: false,
          terms: (j.rows ?? []).map((x: { keyword: string; marketplace: string | null; organicRank: number | null; sponsoredRank: number | null; rankDelta: number | null; currentEur: number; proposedEur: number; suppressed: 'flag' | 'bid' | null; campaignSuppressed: boolean; refused?: string }) => ({
            term: x.keyword, marketplace: x.marketplace,
            organicRank: x.organicRank, sponsoredRank: x.sponsoredRank, rankDelta: x.rankDelta,
            current: x.currentEur, proposed: x.proposedEur,
            suppressed: x.suppressed, campaignSuppressed: x.campaignSuppressed, refused: x.refused,
          })),
          rank: {
            windowDays: j.windowDays, selected: j.selected, measurable: j.measurable, inScope: j.inScope,
            matched: j.matched, noChange: j.noChange, suppressedMatched: j.suppressedMatched,
            suppressedUnflaggedMatched: j.suppressedUnflaggedMatched,
            campaignSuppressedMatched: j.campaignSuppressedMatched, refusedSuppressed: j.refusedSuppressed,
            feed: j.feed, readAt: j.readAt,
          },
        })
      } catch {
        setPreview({ open: true, loading: false, terms: [], rank: null, error: 'Preview is unavailable right now.' })
      }
      return
    }
    /**
     * 🔴 SOV-P2 — Share of Voice joins Budget, Placement and Keyword Tracker on the server preview,
     * and leaves the browser-arithmetic path below for the same reasons KT-P1 documents above.
     *
     * Clicked on prod before this change, on `DE_Auto_Close` with `IF Share of Voice < 5% → Set Bid
     * €0.75`, the old path showed FOUR rows — SEARCH_CLOSE_MATCH, SEARCH_LOOSE_MATCH,
     * PRODUCT_COMPLEMENTS, PRODUCT_SUBSTITUTES — every one of them `kind: 'AUTO'`, which
     * `buildSovBidContexts` can never select, three of them PAUSED; and it omitted both of the
     * campaign's real KEYWORD targets because `/advertising/targets` has no `orderBy` and 1,655 of
     * the account's 3,155 positive targets fall outside its 1,500-row page. It applied no criteria
     * and read only `groups[0]`.
     *
     * `/automation-rules/preview` runs the real contexts, scope, translation, first-matching-block
     * selection and `bid_apply` in dryRun ([[reference_preview_must_run_the_engine]]).
     */
    /**
     * 🔴 BID-P (2026-08-22) — the LAST client-side preview, replaced rather than patched.
     *
     * What stood here was browser arithmetic over `/advertising/targets?limit=1500`, and it was
     * wrong in five ways at once — the four its Budget/Placement/SOV siblings each documented, plus
     * one that was Bid's alone: `apply()` handled five of the ELEVEN THEN actions and fell through
     * to `: cur` for the rest, so the four COMPUTED actions BP.P4 shipped as headline features
     * (`setCpc`, `targetAcos`, `revPerClick`, `curBidTargetAcos`) and the two status verbs all
     * rendered "no change" on every row. An operator building
     * `Set Bid to CPC × (Target ACoS / Actual ACoS)` saw a table of unchanged bids and concluded
     * their thresholds were too tight.
     *
     * It also never showed the trigger's floor: `KEYWORD_HIGH_ACOS` emits only keywords with
     * orders, sales, ≥€2 spend and ≥20% ACoS, which is **8 of the account's 3,155 positive ad
     * targets**. The panel listed up to 1,500.
     *
     * `isSov` and `isRank` already returned above, so `bid` was this branch's last consumer —
     * which is why this is a DELETION and not a fourth special case. Every draft preview on every
     * tab now runs the real engine ([[reference_preview_must_run_the_engine]]).
     */
    if (isBid) {
      try {
        const r = await fetch(`${getBackendUrl()}/api/advertising/automation-rules/preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ actions: previewActions(), conditions: previewConditions(), scopeMarketplace: scopeMarket && scopeMarket !== 'all' ? scopeMarket : null }),
        })
        const j = await r.json().catch(() => null)
        if (!r.ok || !j?.ok) {
          setPreview({ open: true, loading: false, terms: [], bid: null, error: j?.untranslatable?.length
            ? `No engine signal exists for: ${j.untranslatable.join(', ')}. Remove those conditions — the rule could not evaluate as written.`
            : 'Preview is unavailable right now.' })
          return
        }
        setPreview({
          open: true, loading: false,
          terms: (j.rows ?? []).map((x: { keyword: string; matchType: string | null; marketplace: string | null; acosPct: number | null; spendEur: number; currentEur: number; proposedEur: number; clamped: boolean; refused?: string; suppressed: 'flag' | 'bid' | null; campaignSuppressed: boolean }) => ({
            term: x.keyword, matchType: x.matchType ?? undefined, marketplace: x.marketplace,
            current: x.currentEur, proposed: x.proposedEur, clamped: x.clamped,
            acosPct: x.acosPct, spend: x.spendEur, refused: x.refused,
            suppressed: x.suppressed, campaignSuppressed: x.campaignSuppressed,
          })),
          bid: {
            windowDays: j.windowDays, selected: j.selected, selectedTargets: j.selectedTargets,
            measurable: j.measurable, inScope: j.inScope, matched: j.matched, noChange: j.noChange,
            refusedNoSignal: j.refusedNoSignal,
            suppressedMatched: j.suppressedMatched, suppressedUnflaggedMatched: j.suppressedUnflaggedMatched,
            campaignSuppressedMatched: j.campaignSuppressedMatched,
            floor: j.floor,
          },
        })
      } catch {
        setPreview({ open: true, loading: false, terms: [], bid: null, error: 'Preview is unavailable right now.' })
      }
      return
    }
    try {
      const lb = groups[0]?.lookback ?? 'Last 60 Days'
      const windowDays = Number((lb.match(/\d+/) ?? ['60'])[0]) || 60
      const all = groups.flatMap((g) => g.conditions)
      const sc = all.find((c) => c.metric === 'Spend')
      if (isHarvest) {
        const oc = all.find((c) => c.metric === 'PPC Orders' || c.metric === 'Orders')
        const minOrders = oc ? Math.max(1, Math.round(Number(oc.value) || 1)) : 1
        const qs = new URLSearchParams({ windowDays: String(windowDays), minOrders: String(minOrders), ...(sc ? { minSpendCents: String(Math.round((Number(sc.value) || 0) * 100)) } : {}) })
        const j = await fetch(`${getBackendUrl()}/api/advertising/harvest/preview?${qs}`).then((r) => r.json()).catch(() => ({}))
        // 🔴 HV.8c — this Preview has never shown a row. The endpoint returns
        // `{ negatives, graduations, productNegatives, productGraduations, windowDays }` and the
        // read asked for `candidates`/`terms`/`items`, so `raw` was ALWAYS `[]` and the panel
        // rendered an empty list under a working button. A harvest rule's preview is what it would
        // GRADUATE; the older keys stay as a fallback so nothing that did work stops.
        const raw = (j.graduations ?? j.candidates ?? j.terms ?? j.items ?? (Array.isArray(j) ? j : [])) as Array<Record<string, unknown>>
        // `costCents` is the field a harvest candidate actually carries — `spendCents` is the shape
        // the other endpoint uses, and reading only that rendered every spend blank.
        setPreview({ open: true, loading: false, terms: raw.slice(0, 100).map((t) => ({ term: String(t.searchTerm ?? t.term ?? t.query ?? ''), orders: Number(t.orders ?? t.ppcOrders ?? 0) || undefined, spend: t.costCents != null ? Number(t.costCents) / 100 : (t.spendCents != null ? Number(t.spendCents) / 100 : (t.spend != null ? Number(t.spend) : undefined)) })).filter((t) => t.term) })
      } else {
        const minSpend = sc ? Math.max(0, Number(sc.value) || 0) : 0
        const qs = new URLSearchParams({ lookbackDays: String(windowDays), minSpend: String(minSpend), limit: '100' })
        const j = await fetch(`${getBackendUrl()}/api/advertising/reports/negative-keyword-candidates?${qs}`).then((r) => r.json()).catch(() => ({}))
        const raw = (j.candidates ?? j.terms ?? j.items ?? (Array.isArray(j) ? j : [])) as Array<Record<string, unknown>>
        setPreview({ open: true, loading: false, terms: raw.slice(0, 100).map((t) => ({ term: String(t.query ?? t.searchTerm ?? t.term ?? ''), matchType: t.matchType ? String(t.matchType) : undefined, clicks: Number(t.totalClicks ?? t.clicks ?? 0) || undefined, spend: t.totalCostUnits != null ? Number(t.totalCostUnits) : (t.spendCents != null ? Number(t.spendCents) / 100 : (t.spend != null ? Number(t.spend) : undefined)) })).filter((t) => t.term) })
      }
    } catch { setPreview({ open: true, loading: false, terms: [] }) }
  // 🔴 BUD-PP — `scopeMarket` and the two payload builders MUST be here. Without them this
  // callback captured the market chosen when the form first rendered ('all'), so switching the
  // scope to FR still previewed the DE campaigns — a stale closure producing a confident wrong
  // answer, invisible to unit tests and to a direct API call. Found by driving the real form.
  }, [groups, isHarvest, isBudget, isPlacement, isBidLike, isRank, selCampaigns, budgetFloor, budgetCeiling, placeFloor, placeCeiling, bidFloor, bidCeiling, scopeMarket, previewActions, previewConditions])
  // Esc closes the Preview modal
  useEffect(() => {
    if (!preview?.open) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreview(null) }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [preview?.open])

  const scrollRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState('rule-name')

  // scroll-spy: the section whose top is nearest above the fold is "active"
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const top = el.scrollTop + 140
      let cur = steps[0].id
      for (const s of steps) {
        const node = document.getElementById(`rb-${s.id}`)
        if (node && node.offsetTop <= top) cur = s.id
      }
      setActive(cur)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  }, [steps])

  const goto = (id: string) => {
    /**
     * BP.P3 — instant `scrollIntoView`, not a smooth `scrollTo`. Two defects lived here:
     * `node.offsetTop` is measured from `.h10-rb` (the offset parent), not from the scroll
     * container, so the target landed ~56px low; and the smooth animation was cancelled by
     * the scroll-spy's re-render churn (see the `steps` memo above) — clicking a step moved
     * the pane ~6px and stopped. `.h10-rb-sec` carries `scroll-margin-top: 24px` for the gap.
     */
    document.getElementById(`rb-${id}`)?.scrollIntoView({ block: 'start' })
  }

  // criteria mutations
  const addCondition = (gid: number) => setGroups((gs) => gs.map((g) => g.id === gid ? { ...g, conditions: [...g.conditions, { metric: 'Clicks', op: 'gte', value: '' }] } : g))
  const removeCondition = (gid: number, i: number) => setGroups((gs) => gs.map((g) => g.id === gid ? { ...g, conditions: g.conditions.filter((_, j) => j !== i) } : g).filter((g) => g.conditions.length > 0))
  const setCond = (gid: number, i: number, patch: Partial<Condition>) => setGroups((gs) => gs.map((g) => g.id === gid ? { ...g, conditions: g.conditions.map((c, j) => j === i ? { ...c, ...patch } : c) } : g))
  const addGroup = () => setGroups((gs) => [...gs, newGroup(slug)])
  const dupGroup = (gid: number) => setGroups((gs) => { const g = gs.find((x) => x.id === gid); return g ? [...gs, { ...g, id: _cid++, conditions: g.conditions.map((c) => ({ ...c })) }] : gs })
  const delGroup = (gid: number) => setGroups((gs) => (gs.length > 1 ? gs.filter((g) => g.id !== gid) : gs))
  const setBudgetAct = (gid: number, patch: { budgetOp?: string; budgetValue?: string; placeTarget?: string }) => setGroups((gs) => gs.map((g) => g.id === gid ? { ...g, ...patch } : g))

  const adGroupCount = blocks.reduce((n, b) => n + b.groups.length, 0)
  /** every IF row has a value — the only thing a criteria-only save actually writes */
  const conditionsFilled = groups.every((g) => g.conditions.length > 0 && g.conditions.every((c) => c.value.trim() !== ''))
  /**
   * C1 — an action whose unit is `'none'` computes its own number, so requiring a THEN value
   * would make a finished rule unsaveable. Every other action still demands one.
   */
  const thenActions = isPlacement ? PLACEMENT_ACTIONS : isBidLike ? BID_ACTIONS : BUDGET_ACTIONS
  const criteriaValid = conditionsFilled && groups.every((g) =>
    !isCampaign || actionUnit(thenActions, g.budgetOp) === 'none' || (g.budgetValue ?? '').trim() !== '')
  const targetsValid = isCampaign ? selCampaigns.length > 0 : adGroupCount > 0
  /**
   * 🔴 EA5 — an ENGINE-NATIVE rule is valid on its name and its IF rows alone.
   *
   * The two extra demands both describe things this save does NOT write:
   *  · `targetsValid` wants a campaign selection these rules do not carry in the action at all —
   *    their scope lives in the `scope*` columns.
   *  · `criteriaValid` wants the THEN value ("Set Bid to €"), which belongs to the action — and
   *    the action is exactly what a criteria-only save leaves untouched. There is nothing to
   *    hydrate it from, so requiring it pins Save shut on every stored rule.
   *
   * Getting this wrong is not cosmetic: a permanently-disabled Save is what made the original
   * destructive path look safe for as long as it did.
   */
  const valid = locked
    ? ruleName.trim().length > 0 && (locked.level === 'meta' || conditionsFilled)
    : ruleName.trim().length > 0 && targetsValid && criteriaValid
  const floorOverCeiling = isBudget && budgetCeiling.trim() !== '' && (Number(budgetFloor) || 0) > (Number(budgetCeiling) || 0)
  const bidFloorOverCeiling = isBidLike && bidCeiling.trim() !== '' && (Number(bidFloor) || 0) > (Number(bidCeiling) || 0)

  // ── create the rule (POST /advertising/automation-rules — starts disabled + dry-run) ──
  const submit = useCallback(async () => {
    if (!valid || creating) return
    // KT-P1 — the button is `held` rather than disabled, so the refusal is enforced here too.
    if (rankBlocked) { setRankHeldNote(true); return }
    setCreating(true)
    try {
      /**
       * 🔴 EA5 — an ENGINE-NATIVE rule gets a FIELD-SCOPED patch, never the full payload.
       *
       * The payload below replaces `conditions` AND `actions` wholesale. On a rule the builder
       * cannot fully represent that would overwrite the action the engine is actually running —
       * so for these we send only what this form genuinely owns and omit `actions` entirely. The
       * PATCH route applies only the keys present, and translates the criteria back to the rule's
       * own engine-native shape (`conditionsForStorage`), so nothing about the action is touched.
       *
       * 'meta' also omits `conditions`: one of them has no builder metric and is not on screen,
       * so writing the visible ones back would silently delete it.
       */
      if (locked) {
        const partial: Record<string, unknown> = { name: ruleName.trim() }
        if (locked.level === 'criteria') {
          partial.conditions = groups.map((g) => ({ match: 'all', lookback: pcWindowLabel(slug), exclude: PC_TRUTH_EXCLUDE, conditions: g.conditions }))
        }
        if (maxAdSpend.trim()) partial.maxDailyAdSpendCentsEur = Math.round(Number(maxAdSpend) * 100)
        if (maxWrites.trim()) partial.maxWritesPerDay = Math.max(1, Math.round(Number(maxWrites)))
        if (maxExecs.trim()) partial.maxExecutionsPerDay = Math.max(1, Math.round(Number(maxExecs)))
        if (scopeMarket !== 'all') partial.scopeMarketplace = scopeMarket
        const rp = await fetch(`${getBackendUrl()}/api/advertising/automation-rules/${ruleId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(partial),
        })
        const rj = await rp.json().catch(() => ({}))
        if (rp.ok && rj?.error == null) router.push(`/marketing/ads/rules-automation/${ownTab}`)
        emitAdsChange('ads.rule.changed')
        setCreating(false)
        return
      }
      const payload = {
        name: ruleName.trim(),
        description: `${rt?.label ?? 'Rule'} — ${isEdit ? 'edited' : 'created'} in Rule Builder`,
        trigger: TRIGGER_BY_SLUG[slug] ?? 'SCHEDULE',
        // P2.1 — lookback/exclude store the TRUTH (the trigger's fixed window), never a select's
        // unread value. The engine evaluates over ruleWindowBounds regardless; these fields are
        // the record of what the author was told.
        conditions: previewConditions(),
        actions: previewActions(),
        // P2.2 — ceiling, write cap and market scope are sent for EVERY rule type. They used to be
        // budget-only, so every other builder rule was created account-wide with no way to scope
        // it from here, and with the maxWritesPerDay brake unset.
        maxDailyAdSpendCentsEur: maxAdSpend.trim() ? Math.round(Number(maxAdSpend) * 100) : undefined,
        maxWritesPerDay: maxWrites.trim() ? Math.max(1, Math.round(Number(maxWrites))) : undefined,
        // BP.P2 — surfaced (default 10 server-side); blank falls back to that same default.
        maxExecutionsPerDay: maxExecs.trim() ? Math.max(1, Math.round(Number(maxExecs))) : undefined,
        scopeMarketplace: scopeMarket === 'all' ? undefined : scopeMarket,
      }
      const base = `${getBackendUrl()}/api/advertising/automation-rules`
      const r = await fetch(isEdit ? `${base}/${ruleId}` : base, { method: isEdit ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j?.error == null) {
        /**
         * BP.P1 — the Control step is REAL. The create route stores every rule `enabled:false`
         * (a safe default for API callers), and `resolveAutonomy` never reads `actions[0].control`
         * — so before this, a rule authored here did NOTHING until someone found the Automations
         * page, whatever the radio said. The level now applies through the ONE mode write route:
         * Manual → PROPOSE (enabled; every action queues on the Suggestions page), Automate →
         * AUTO (enabled; acts on its own inside its caps and the write gate). A 409 is the
         * graduation ceiling — a pausing Bid rule may not reach AUTO — and falls back to PROPOSE
         * so the rule still runs; the pause action's own hover copy already says exactly this.
         * On EDIT the level is re-applied only when the radio was changed this session (see
         * `initialControl`).
         */
        const savedId = isEdit ? ruleId : (j?.rule?.id != null ? String(j.rule.id) : null)
        if (savedId && (!isEdit || initialControl.current !== control)) {
          const patchLevel = (level: string) => fetch(`${getBackendUrl()}/api/advertising/autonomy/rules/${savedId}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level }),
          })
          try {
            const want = control === 'automate' ? 'AUTO' : 'PROPOSE'
            const res = await patchLevel(want)
            if (!res.ok && res.status === 409 && want === 'AUTO') await patchLevel('PROPOSE')
          } catch { /* the save landed; the grid's toggle and off chip report the true mode */ }
        }
        router.push(`/marketing/ads/rules-automation/${ownTab}`)
      }
      // RT.1 — a saved rule moves every tab badge and every page's rule section.
      emitAdsChange('ads.rule.changed')
    } finally { setCreating(false) }
  }, [valid, creating, rankBlocked, locked, ruleName, rt, slug, groups, control, dedupe, negateInSource, bidMode, bidValue, brandExclude, competitorOnly, isHarvest, isNegative, isBudget, isBid, isBidLike, isPlacement, isCampaign, advLookback, selCampaigns, budgetFloor, budgetCeiling, maxAdSpend, maxWrites, maxExecs, scopeMarket, placeFloor, placeCeiling, bidFloor, bidCeiling, lookbackDays, protectConverting, protectDays, negationLevel, searchTerms, frequency, everyN, interval, onDay, time, timezone, blocks, isEdit, ruleId, router])

  // ── edit mode: load an existing rule's stored JSON back into the builder ──
  useEffect(() => {
    if (!ruleId) return
    let alive = true
    ;(async () => {
      try {
        const j = await fetch(`${getBackendUrl()}/api/advertising/automation-rules/${ruleId}`).then((r) => r.json())
        const rule = j?.rule
        if (!alive || !rule) return
        setRuleName(rule.name ?? '')

        /**
         * EA4 — an ENGINE-NATIVE rule arrives with `builderView`, translated server-side by the
         * inverse of the adapter that already runs builder rules (`ads-rule-adapter.service.ts`).
         * Its conditions are REAL — read from `{field, op, value}` through the same metric map, so
         * "campaign.acos lte 0.2" comes back as "ACOS / lte / 20". The action is a summary line
         * only: the builder writes one action from a fixed set, and most engine rules use types it
         * cannot produce, so those open read-only rather than pretending to be editable.
         */
        const bv = j?.builderView as { slug: string | null; groups?: Array<{ conditions: Condition[] }>; actionSummary?: string[]; editLevel?: 'full' | 'criteria' | 'meta'; blockers?: string[] } | null | undefined
        if (bv) {
          if (bv.groups?.length) {
            setGroups(bv.groups.map((g) => ({ id: ++_cid, conditions: g.conditions.length ? g.conditions : [defaultCondition(slug)], lookback: pcWindowLabel(slug), exclude: PC_TRUTH_EXCLUDE, budgetOp: 'set', budgetValue: '' })))
          }
          if (rule.scopeMarketplace) setScopeMarket(rule.scopeMarketplace)
          if (rule.maxDailyAdSpendCentsEur != null) setMaxAdSpend(String(rule.maxDailyAdSpendCentsEur / 100))
          if (rule.maxWritesPerDay != null) setMaxWrites(String(rule.maxWritesPerDay))
          if (rule.maxExecutionsPerDay != null) setMaxExecs(String(rule.maxExecutionsPerDay))
          setLocked({ level: bv.editLevel === 'criteria' ? 'criteria' : 'meta', blockers: bv.blockers ?? [], actionSummary: bv.actionSummary ?? [] })
          return
        }

        const conds = Array.isArray(rule.conditions) ? rule.conditions : []
        if (conds.length) setGroups(conds.map((c: { conditions?: Condition[]; lookback?: string; exclude?: string; action?: { op?: string; value?: string; placeTarget?: string } }) => ({ id: ++_cid, conditions: Array.isArray(c.conditions) && c.conditions.length ? c.conditions : [defaultCondition(slug)], lookback: pcWindowLabel(slug), exclude: PC_TRUTH_EXCLUDE, budgetOp: c.action?.op ?? 'set', budgetValue: c.action?.value ?? '', placeTarget: c.action?.placeTarget ?? 'tos' })))
        const a = (Array.isArray(rule.actions) ? rule.actions[0] : null) ?? {}
        setControl(a.control === 'automate' ? 'automate' : 'manual')
        initialControl.current = a.control === 'automate' ? 'automate' : 'manual'
        setDedupe(a.dedupe !== false)
        // HP1 — these four were never hydrated, so an edit-save silently reset them to defaults.
        if (typeof a.negateInSource === 'boolean') setNegateInSource(a.negateInSource)
        if (a.bid != null) {
          const b = a.bid as { mode?: string; value?: unknown }
          setBidMode(b.mode === 'fixed' ? 'fixed' : b.mode === 'cpcPlus' ? 'cpcPlus' : b.mode === 'adGroupDefault' ? 'adGroupDefault' : 'cpc')
          if (b.value != null && String(b.value).trim() !== '') setBidValue(String(b.value))
        }
        const flt = a.filters as { brandExclude?: unknown; competitorOnly?: unknown } | undefined
        if (Array.isArray(flt?.brandExclude)) setBrandExclude((flt.brandExclude as unknown[]).map(String).join('\n'))
        if (typeof flt?.competitorOnly === 'boolean') setCompetitorOnly(flt.competitorOnly)
        if (typeof a.protectConverting === 'boolean') setProtectConverting(a.protectConverting)
        if (a.protectDays != null) setProtectDays(String(a.protectDays))
        if (a.negationLevel) setNegationLevel(a.negationLevel)
        if (isCampaign && Array.isArray(a.campaigns)) setSelCampaigns(a.campaigns.map((c: Record<string, unknown>) => ({ id: String(c.id), name: String(c.name ?? c.id), marketplace: (c.marketplace as string) ?? null, status: String(c.status ?? 'ENABLED').toUpperCase(), targetingType: String(c.targetingType ?? 'MANUAL'), adProduct: String(c.adProduct ?? 'SP'), dailyBudget: c.dailyBudget != null ? Number(c.dailyBudget) : null })))
        if (isBudget) {
          if (a.budgetFloor != null) setBudgetFloor(String(a.budgetFloor))
          if (a.budgetCeiling != null) setBudgetCeiling(String(a.budgetCeiling))
        }
        // P2.2 — ceiling, write cap and market scope hydrate for EVERY rule type, matching the
        // controls below that are no longer budget-only.
        if (rule.maxDailyAdSpendCentsEur != null) setMaxAdSpend(String(rule.maxDailyAdSpendCentsEur / 100))
        if (rule.maxWritesPerDay != null) setMaxWrites(String(rule.maxWritesPerDay))
        if (rule.maxExecutionsPerDay != null) setMaxExecs(String(rule.maxExecutionsPerDay))
        if (rule.scopeMarketplace) setScopeMarket(rule.scopeMarketplace)
        if (isPlacement) {
          if (a.placeFloor != null) setPlaceFloor(String(a.placeFloor))
          if (a.placeCeiling != null) setPlaceCeiling(String(a.placeCeiling))
        }
        if (isBidLike) {
          if (a.bidFloor != null) setBidFloor(String(a.bidFloor))
          if (a.bidCeiling != null) setBidCeiling(String(a.bidCeiling))
          if (a.windowDays != null) setLookbackDays(String(a.windowDays))
        }
        if (Array.isArray(a.searchTerms)) setSearchTerms(a.searchTerms)
        const s = a.schedule ?? {}
        if (s.frequency) setFrequency(s.frequency)
        if (s.everyN != null) setEveryN(String(s.everyN))
        if (s.interval) setInterval(s.interval)
        if (s.onDay) setOnDay(s.onDay)
        if (s.time) setTime(s.time)
        if (s.timezone) setTimezone(s.timezone)
        const maps = Array.isArray(a.mappings) ? a.mappings : []
        if (maps.length) setBlocks(maps.map((m: { groups?: Array<Partial<SelGroup>> }) => ({ id: ++_bid, groups: (Array.isArray(m.groups) ? m.groups : []).map((g) => ({ id: String(g.id), name: g.name ?? String(g.id), campaignId: g.campaignId ?? '', campaignName: g.campaignName ?? null, status: g.status ?? 'ENABLED', campaignStatus: null, adProduct: g.adProduct ?? null, portfolioId: g.portfolioId ?? null, look: g.look !== false, types: g.types ?? { P: true, E: true, product: false }, paused: g.paused === true })) })))
      } catch { /* ignore */ }
    })()
    return () => { alive = false }
  }, [ruleId, slug, isBudget, isBidLike, isPlacement, isCampaign])

  return (
    <div className="h10-rb">
      {/* top bar */}
      <header className="h10-rb-top">
        <div className="l">
          <button type="button" className="x" aria-label="Close" onClick={close}><X size={19} /></button>
          <AtomMark size={20} />
          <b>{isEdit ? 'Edit' : 'Create'} Rule - {rt?.label ?? 'Rule'}</b>
        </div>
        <div className="r">
          {/* BP (2026-08-21) — H10's "Learn" video pill was here as a dead placeholder (no
              handler since the builder shipped); the operator chose removal over wiring it. */}
          <button type="button" className="learn" onClick={runPreview}><Eye size={15} /> Preview</button>
          <button
            type="button"
            className={`h10-rb-create${rankBlocked ? ' held' : ''}`}
            disabled={!rankBlocked && (!valid || creating)}
            {...(rankBlocked ? { 'aria-disabled': true } : {})}
            onClick={rankBlocked ? () => setRankHeldNote(true) : submit}
          >{creating ? (isEdit ? 'Saving…' : 'Creating…') : (isEdit ? 'Save Changes' : 'Create Rule')}</button>
        </div>
      </header>

      <div className="h10-rb-body" ref={scrollRef}>
        {/* sticky left step nav */}
        <nav className="h10-rb-nav" role="tablist" aria-label="Rule steps">
          {steps.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={active === s.id} className={`h10-rb-step ${active === s.id ? 'on' : ''}`} onClick={() => goto(s.id)}>{s.label}</button>
          ))}
        </nav>

        {/* scrolling content */}
        <main className="h10-rb-main">
          <div className="h10-rb-wrap">
            {/*
              EA5 — the notice for an ENGINE-NATIVE rule. It states what this form owns, shows the
              rule's real action as a summary so the page is never blank about what it DOES, and
              names every part the builder cannot carry. It is NOT a blanket read-only lock: the
              PATCH route applies only the fields sent, so an unrepresentable action is no reason to
              refuse an edit to the criteria.
            */}
            {locked && (
              <div className="h10-rb-locked" role="status">
                <b><Lock size={14} aria-hidden /> {locked.level === 'criteria' ? 'The action of this rule is not editable here' : 'The criteria of this rule are not editable here'}</b>
                <p>
                  Everything below is the rule&rsquo;s real stored value. This builder writes one
                  action from a fixed set and this rule&rsquo;s action is not one of them, so a save
                  from here sends only the fields this form owns and leaves the action exactly as
                  the engine is running it.
                </p>
                {locked.actionSummary.length > 0 && (
                  <p className="act"><span className="k">What it does</span>{locked.actionSummary.map((a, i) => <em key={i}>{a}</em>)}</p>
                )}
                <ul>{locked.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
                {/* Any reason a control is unavailable lives HERE, never as a `title` on a disabled
                    element — the browser fires no mouse events on those, so the tooltip never shows.
                    The repo's silent-disabled ratchet exists to catch exactly that, and it caught an
                    earlier version of this banner's Save button. */}
                <p className="foot">
                  {locked.level === 'criteria'
                    ? <><b>You can edit</b> the name, the criteria, the caps and the market scope, and save normally.</>
                    : <><b>You can edit</b> the name, the caps and the market scope. The criteria are read-only because one of this rule&rsquo;s conditions has no control here, and saving the visible ones would delete it.</>}
                </p>
              </div>
            )}
            {/* ── Rule Name ── */}
            <section id="rb-rule-name" className="h10-rb-sec">
              <h2>Rule Name</h2>
              <Input fieldClassName="h10-rb-input rn" value={ruleName} onChange={(e) => setRuleName(e.target.value)} placeholder="Enter a rule name" aria-label="Rule name" />
            </section>

            {/* ── Negative Rule Setup ── */}
            <section id="rb-setup" className="h10-rb-sec">
              <div className="h10-rb-setuphd">
                <h2>{setup.sectionTitle ?? steps[1].label}</h2>
                {setup.mapping && <div className="maprow">
                  <button type="button" className="h10-rb-btn primary" onClick={addBlock}><Plus size={14} /> Ad Group Mapping</button>
                  <button type="button" className="chevbtn" aria-label={setupCollapsed ? 'Expand' : 'Collapse'} aria-expanded={!setupCollapsed} onClick={() => setSetupCollapsed((v) => !v)}><ChevronDown size={18} className={`chev ${setupCollapsed ? 'up' : ''}`} /></button>
                </div>}
              </div>
              <p className="h10-rb-desc">{setup.desc}</p>
              {setup.banner && <div className="h10-rb-banner"><Info size={16} /><span>{setup.banner}</span></div>}
              {/* 🔴 KT-P1 — the feed, stated before the operator fills in a rule that cannot run.
                  Numbers are live (`/keyword-tracker/feed-health`); nothing here is a constant. */}
              {rankBlocked && (
                <div className="h10-rb-banner warn" role="status">
                  <AlertTriangle size={16} />
                  <span>
                    <b>No keyword rank has ever been recorded, so this rule could not act.</b>{' '}
                    Organic and paid rank come from the keyword-rank feed, and it is empty — 0 observations
                    across 0 keywords, against {rankFeed?.totalTargets.toLocaleString('en-GB')} keyword targets
                    in your campaigns. Amazon publishes no organic-position API, so this feed is filled by
                    import; until it is, a Keyword Tracker rule would match nothing on every run.{' '}
                    <b>Spend and ACOS are real</b> — but they reach this rule only through a keyword that has
                    a rank observation, so today they cannot be used here either. A Bid rule measures the
                    same two directly.
                  </span>
                </div>
              )}

              {surface === 'search-terms' && !setupCollapsed && blocks.map((block, bi) => (
                <MappingBlock
                  key={block.id}
                  block={block}
                  setup={setup}
                  index={bi}
                  isMulti={blocks.length > 1}
                  popOpen={openPop === block.id}
                  onTogglePop={() => setOpenPop((cur) => (cur === block.id ? null : block.id))}
                  onClosePop={() => setOpenPop(null)}
                  onAdd={(items) => addGroups(block.id, items)}
                  onRemoveGroup={(id) => removeGroup(block.id, id)}
                  onToggleLook={(id) => toggleLook(block.id, id)}
                  onToggleType={(id, t) => toggleType(block.id, id, t)}
                  onRemoveBlock={() => removeBlock(block.id)}
                />
              ))}
              {/* THE campaign selector — `_schedule/CampaignSection.tsx`, the same component the
                  dayparting and rank-goal builders use, adopted here on operator instruction
                  2026-08-18 so a change to the picker is made once. It brings the Portfolios and
                  Products tabs and the ranked search this builder's private copy never had.
                  `defaultStatus="enabled"` keeps H10's opening state for a criteria rule. */}
              {isCampaign && (
                <CampaignSection selected={selCampaigns} onAdd={addCampaign} onAddMany={addCampaigns} onRemove={removeCampaign} onClear={clearCampaigns} defaultStatus="enabled" />
              )}
            </section>

            {/* ── Criteria ── */}
            {/* EA5 — at 'meta' the criteria are INCOMPLETE (a condition has no builder metric and
                is not drawn), so the section is held non-interactive rather than disabled control
                by control: `inert` takes it out of tab order and out of the pointer, and the banner
                above already carries the reason. Editing here would write back only what is
                visible and delete the rest. */}
            <section id="rb-criteria" className={`h10-rb-sec${locked?.level === 'meta' ? ' held' : ''}`} {...(locked?.level === 'meta' ? { inert: '' as unknown as boolean, 'aria-disabled': true } : {})}>
              <div className="h10-rb-crit-hd">
                <div className="t"><h2>Criteria</h2><p className="h10-rb-desc">Set up the performance criteria and actions</p></div>
                {(isCampaign || isHarvest || isNegative) && <button type="button" className="h10-rb-tmpl" onClick={() => setTmpl({ mode: 'apply' })}><LayoutTemplate size={15} /> Apply Template</button>}
              </div>

              {groups.map((g, gi) => (
                <div className="h10-rb-card crit" key={g.id}>
                  <div className="h10-rb-card-h">
                    <b>Criteria {gi + 1}</b>
                    <span className="acts">
                      <button type="button" aria-label="Duplicate criteria" onClick={() => dupGroup(g.id)}><Copy size={15} /></button>
                      <button type="button" aria-label="Delete criteria" onClick={() => delGroup(g.id)}><Trash2 size={15} /></button>
                    </span>
                  </div>
                  <div className="h10-rb-conds">
                    {g.conditions.map((c, i) => (
                      <div className="cond" key={i}>
                        <span className={`pill ${i === 0 ? 'if' : 'and'}`}>{i === 0 ? 'IF' : 'AND'}</span>
                        {/* PLC-P7 — the lane a condition MEASURES, and it is read now.
                            `translateConditions` took metric/op/value only and the context carried
                            no per-lane fields, so "IF Top of Search · ACoS > 40%" evaluated the
                            CAMPAIGN's ACoS. `buildCampaignBudgetContexts` now emits
                            `placement.{tos,pdp,ros}` from Amazon's placement report and
                            `placementScopedField` re-points the condition at it. Choosing a lane
                            opens the note below, because lane data is thinner than campaign data
                            and the window is usually why a lane rule matches nothing. */}
                        {isPlacement && <Listbox width={190} options={PLACEMENT_SCOPES} value={c.scope ?? 'campaign'} onChange={(v) => { setCond(g.id, i, { scope: v }); if (v !== 'campaign') setScopeNote(g.id) }} ariaLabel="Placement scope" />}
                        <Listbox width={isPlacement ? 220 : 300} options={isPlacement ? METRICS_PLACEMENT : isBudget ? METRICS_BUDGET : isSov ? METRICS_SOV : isRank ? METRICS_RANK : isBid ? PC_METRICS_BID : METRICS} value={c.metric} onChange={(v) => setCond(g.id, i, { metric: v })} ariaLabel="Metric" />
                        <Listbox width={300} options={OPERATORS} value={c.op} onChange={(v) => setCond(g.id, i, { op: v })} ariaLabel="Operator" />
                        {(() => { const u = METRIC_UNIT[c.metric] ?? ''; return (
                          <span className={`h10-rb-val ${u === 'pct' ? 'hassf' : ''}`}>
                            {u === 'eur' && <span className="pf">€</span>}
                            <input inputMode="decimal" value={c.value} onChange={(e) => setCond(g.id, i, { value: e.target.value })} aria-label="Value" />
                            {u === 'pct' && <span className="sf">%</span>}
                          </span>
                        ) })()}
                        <button type="button" className="rm" aria-label="Remove condition" onClick={() => removeCondition(g.id, i)}><X size={16} /></button>
                      </div>
                    ))}
                    {/* PLC-P7 — a lane-scoped condition is measured from Amazon's placement report,
                        which is thinner than campaign-wide data. Said once per block, when a lane is
                        chosen, because the honest answer to "why did my rule match nothing" is
                        usually the window rather than the threshold. */}
                    {scopeNote === g.id && g.conditions.some((x) => x.scope && x.scope !== 'campaign') && (
                      <p className="h10-rb-heldnote" role="status">
                        <Info size={13} aria-hidden />
                        <span>A lane-scoped condition is measured from Amazon&rsquo;s <b>placement report</b> — that one lane&rsquo;s own impressions, clicks, spend and sales — not the campaign&rsquo;s totals. Lane data is thinner: over 7 settled days only <b>16 of 122</b> campaign-and-lane combinations in this account carry 20+ clicks, against <b>51 of 123</b> over 30. A lane with no data in the window is <b>not measured as zero</b> — it is left alone. Widen the <b>Lookback period</b> in Advanced Settings if a lane rule matches nothing.</span>
                      </p>
                    )}
                    <button type="button" className="h10-rb-addand" onClick={() => addCondition(g.id)}><Plus size={13} /> AND</button>
                    {/* W5 (2026-08-20) — Pacvue's "noise guard", as one-click AND conditions.
                        Every rules platform in the research ships a minimum-evidence bar (min
                        clicks / spend / impressions) so a rule cannot act on statistically thin
                        data — one unlucky click on a €4 keyword reads as 100%+ ACoS and would be
                        cut by any threshold rule. These are ordinary conditions once added —
                        editable, removable — not a separate mechanism the engine has to know
                        about. A guard whose metric this rule type does not offer, or that the
                        group already carries, is simply not offered. */}
                    {(() => {
                      const opts = new Set((isPlacement ? METRICS_PLACEMENT : isBudget ? METRICS_BUDGET : isSov ? METRICS_SOV : isRank ? METRICS_RANK : isBid ? PC_METRICS_BID : METRICS).map((o) => o.value))
                      const guards = [
                        { metric: 'Clicks', value: '10', label: 'Clicks ≥ 10' },
                        { metric: 'Spend', value: '5', label: 'Spend ≥ €5' },
                        { metric: 'Impressions', value: '500', label: 'Impressions ≥ 500' },
                      ].filter((gd) => opts.has(gd.metric) && !g.conditions.some((c) => c.metric === gd.metric))
                      if (guards.length === 0) return null
                      return (
                        <div className="h10-rb-noise">
                          <span className="lbl" title="A minimum-evidence bar: the rule only acts once the data is thick enough to mean something. Each button adds an ordinary AND condition you can edit or remove.">Noise guard</span>
                          {guards.map((gd) => (
                            <button key={gd.metric} type="button" onClick={() => setGroups((gs) => gs.map((x) => x.id === g.id ? { ...x, conditions: [...x.conditions, { metric: gd.metric, op: 'gte', value: gd.value }] } : x))}>
                              <Plus size={11} aria-hidden /> {gd.label}
                            </button>
                          ))}
                        </div>
                      )
                    })()}
                    {isCampaign && (() => { const actions = isPlacement ? PLACEMENT_ACTIONS : isBidLike ? BID_ACTIONS : BUDGET_ACTIONS; const u = actionUnit(actions, g.budgetOp); return (
                      <div className="cond then">
                        <span className="pill then">THEN</span>
                        {isPlacement && <Listbox width={190} options={PLACEMENTS} value={g.placeTarget ?? 'tos'} onChange={(v) => setBudgetAct(g.id, { placeTarget: v })} ariaLabel="Placement target" />}
                        <Listbox width={isPlacement ? 200 : 300} options={actions} value={g.budgetOp ?? 'set'} onChange={(v) => setBudgetAct(g.id, { budgetOp: v })} ariaLabel={isPlacement ? 'Placement action' : isBidLike ? 'Bid action' : 'Budget action'} />
                        {/* C1 — a computed action ('none') has no number to take, so the box is
                            not rendered rather than rendered empty or disabled. A disabled input
                            beside a chosen action reads as "you forgot something". */}
                        {u !== 'none' && (
                        <span className={`h10-rb-val ${u === 'pct' ? 'hassf' : ''}`}>
                          {u === 'eur' && <span className="pf">€</span>}
                          <input inputMode="decimal" value={g.budgetValue ?? ''} onChange={(e) => setBudgetAct(g.id, { budgetValue: e.target.value })} /* 🔴 `targetAcos` FIRST: it is the one bid action whose input is not a bid. Ordered after
                              `isBidLike` — as it was on the first cut — the branch is unreachable and a screen
                              reader announces "Bid amount" over a field that takes a target ACoS percentage.
                              Measured on prod: the visible % suffix made it look right to a sighted operator. */
                          aria-label={g.budgetOp === 'targetAcos' || g.budgetOp === 'curBidTargetAcos' ? 'Target ACoS percentage' : isPlacement ? 'Placement modifier' : isBidLike ? 'Bid amount' : 'Budget amount'} />
                          {u === 'pct' && <span className="sf">%</span>}
                        </span>
                        )}
                        {isBidLike && <HoverCard text={
                          g.budgetOp === 'targetAcos'
                            ? 'The bid becomes the target’s own measured cost-per-click, scaled by how far its ACoS is from the figure you type here. A keyword at 50% ACoS against a 25% target has its bid halved; one already at 12.5% has it doubled — bounded by the rule’s min/max bid.'
                            : g.budgetOp === 'curBidTargetAcos'
                              ? 'The bid becomes its CURRENT value, scaled by how far the target’s ACoS is from the figure you type here — the same ratio as the CPC variant, anchored to the bid you set rather than the measured cost-per-click. Bounded by the rule’s min/max bid.'
                            : g.budgetOp === 'revPerClick'
                              ? 'The bid becomes what a click on this target has actually been worth: attributed sales ÷ clicks over the rule’s window — the break-even bid at 100% ACoS. Refuses, named, when the target has no attributed sales. No value to set.'
                            : g.budgetOp === 'setCpc'
                              ? 'The bid becomes the target’s own measured cost-per-click over the rule’s window — what it has actually been paying per click, with no adjustment. No value to set.'
                              : g.budgetOp === 'pauseTarget'
                                ? 'Stops this target in Amazon outright — no bid change. ⚠ Amazon re-enters its learning phase for the target when it is unpaused, so a bid decrease is the gentler tool where it will do. Rules that pause are held below Auto: this one will propose the pause for you to accept.'
                                : g.budgetOp === 'enableTarget'
                                  ? 'Turns a paused target back on. It keeps whatever bid it had; Amazon treats it as new and re-learns it. Held below Auto like its counterpart.'
                                  : 'The bid this rule sets — or the amount it raises/lowers the current keyword bid by — when the criteria are met.'
                        } placement="above"><span className="h10-rb-theninfo" aria-hidden="true"><Info size={15} /></span></HoverCard>}
                        {isPlacement && <HoverCard text="The placement bid modifier this rule sets (or raises/lowers) for the chosen placement when the criteria are met. Amazon allows 0–900%." placement="above"><span className="h10-rb-theninfo" aria-hidden="true"><Info size={15} /></span></HoverCard>}
                      </div>
                    ) })()}
                  </div>
                  {(surface === 'search-terms' || (isBidLike && !isBid)) && (
                  <div className="h10-rb-lookback">
                    <label>Measurement window</label>
                    <PcWindowNote slug={slug} />
                  </div>
                  )}
                </div>
              ))}
              <button type="button" className="h10-rb-btn primary addcrit" onClick={addGroup}><Plus size={14} /> Criteria</button>
              {/* BP.P4b — multi-block selection is real now, and its law is stated where the
                  blocks are made: first matched block acts. */}
              {isCampaign && groups.length > 1 && (
                <p className="h10-rb-blocknote">Criteria blocks are checked in order — on each {isBidLike ? 'keyword' : 'campaign'}, the first block whose conditions match acts; the rest are skipped.</p>
              )}
              {/* BP.P4 — the Bid rule's lookback, honoured by the engine (per-window context
                  passes + computed ops). One window per rule, stated as such. */}
              {isBid && (
                <div className="h10-rb-lookback rulewide">
                  <label>Lookback period</label>
                  <div className="lbrow">
                    <Listbox width={170} options={LOOKBACK_DAYS} value={lookbackDays} onChange={setLookbackDays} ariaLabel="Lookback period" />
                    {/* The settling-tail half of this sentence moved into the note below rather
                        than being said twice a line apart. */}
                    <span className="exc">Applies to every criteria block.</span>
                  </div>
                  {/**
                   * 🔴 BID-P — the trigger's floor, on screen at last.
                   *
                   * Bid is the one bid-like surface that does NOT render `PcWindowNote` (the
                   * per-criteria note is gated `isBidLike && !isBid`, because Bid states its window
                   * once here instead). So the floor sentence added to that component for `bid` was
                   * a string nothing displayed — a stored-but-unread control, caught by driving the
                   * deployed page rather than by reading the diff. It renders HERE, beside the
                   * window it qualifies, reading the same `HIGH_ACOS_FLOOR` the emitter filters on.
                   *
                   * Measured: 8 of the account's 3,155 positive ad targets clear this bar. A Bid
                   * rule cannot act on a zero-sales waster at all.
                   */}
                  <PcWindowNote slug="bid" days={Math.max(7, Math.min(90, Math.round(Number(lookbackDays)) || 14))} />
                </div>
              )}
            </section>

            {/* ── Search Terms (term-based surfaces only; Budget has none) ── */}
            {surface === 'search-terms' && (
            <section id="rb-search-terms" className="h10-rb-sec">
              <h2>Search Terms</h2>
              <p className="h10-rb-desc">Isolate specific search terms using the &ldquo;contains&rdquo; or &ldquo;does not contain&rdquo; operator.</p>
              <div className="h10-rb-st">
                <div className="left">
                  <div className="strow">
                    <span className="l">Only suggest if search term:</span>
                    <label className="rad"><input type="radio" name="stmode" checked={searchMode === 'contains'} onChange={() => setSearchMode('contains')} /> Contains</label>
                    <label className="rad"><input type="radio" name="stmode" checked={searchMode === 'not'} onChange={() => setSearchMode('not')} /> Does Not Contain</label>
                  </div>
                  <Textarea className="h10-rb-ta" value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Enter or paste search terms here" aria-label="Search terms" />
                  <div className="staction"><button type="button" className="h10-rb-btn ghost" disabled={!searchText.trim()} onClick={addSearchTerms}>Add Search Terms</button></div>
                </div>
                <div className="right">
                  <div className="sth"><b>{searchTerms.length} Search Terms Added</b><button type="button" className="h10-rb-btn ghost sm" disabled={!searchTerms.length} onClick={() => setSearchTerms([])}><Trash2 size={13} /> Remove All</button></div>
                  <div className="sttable">
                    <div className="thr"><span>Search Term</span><span>Operator</span></div>
                    {searchTerms.length === 0 ? <div className="nodata">No data</div> : searchTerms.map((st, i) => (
                      <div className="strowdata" key={`${st.op}-${st.term}-${i}`}>
                        <span className="term" title={st.term}>{st.term}</span>
                        <span className="op">{st.op === 'contains' ? 'Contains' : 'Does Not Contain'}</span>
                        <button type="button" className="strm" onClick={() => setSearchTerms((cur) => cur.filter((_, j) => j !== i))} aria-label={`Remove ${st.term}`}><X size={14} /></button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="h10-rb-brand">
                <div className="bl"><b>Brand &amp; competitor filters</b><span>{isHarvest ? 'Don’t harvest your own brand terms; optionally only harvest competitor ASINs.' : 'Never negate your own brand terms; optionally only negate competitor ASINs.'}</span></div>
                <Textarea className="h10-rb-ta brand" value={brandExclude} onChange={(e) => setBrandExclude(e.target.value)} placeholder={isHarvest ? 'Brand terms to never harvest (one per line or comma-separated)' : 'Brand terms to never negate (one per line or comma-separated)'} aria-label="Brand terms to protect" />
                <label className="h10-rb-compt"><button type="button" className={`h10-bktoggle ${competitorOnly ? 'on' : ''}`} role="switch" aria-checked={competitorOnly} aria-label="Only competitor ASINs" onClick={() => setCompetitorOnly((v) => !v)}><span /></button> Only {isHarvest ? 'harvest' : 'negate'} competitor ASINs (exclude same-brand search terms)</label>
              </div>
            </section>
            )}

            {/* ── Advanced Settings ── */}
            <section id="rb-advanced" className="h10-rb-sec">
              <h2>Advanced Settings</h2>
              <div className="h10-rb-card adv">
                {advLookback && (
                <div className="advblock">
                  <b>Measurement window</b>
                  {/* BUD-P3 — Budget rules choose their own lookback (H10 keeps it in Advanced
                      Settings); the note then states the CHOSEN window, not the default. */}
                  {/* PLC-P5 — Placement chooses its own lookback too. Same trigger, same contexts,
                      same 7–90 clamp as Budget, and the evaluator builds a per-window context pass
                      for either slug (`campaignRuleWindow`). Before this the block rendered a fixed
                      7-day sentence and the operator had no way to widen it — which matters most
                      for the lane-scoped criteria PLC-P7 adds, since over 7 days only 16 of 122
                      campaign×lane cells clear 20 clicks against 51 of 123 over 30. */}
                  {advLookback && (
                    <div className="lbrow">
                      <Listbox width={170} options={LOOKBACK_DAYS} value={lookbackDays} onChange={setLookbackDays} ariaLabel="Lookback period" />
                    </div>
                  )}
                  <PcWindowNote slug={slug} {...(advLookback ? { days: Math.max(7, Math.min(90, Math.round(Number(lookbackDays)) || 7)) } : {})} />
                </div>
                )}
                <div className="advblock">
                  <b>Frequency</b>
                  {/* BP.P2 — the schedule is real now (the evaluator holds the rule until it is
                      due), so the copy states the one deviation: a fresh rule's first check. */}
                  <p>Set how often the rule should check the criteria. The first check runs within 15 minutes of creating the rule; after that, on this schedule.</p>
                  <div className="freqrow">
                    <Listbox width={150} options={FREQUENCY} value={frequency} onChange={setFrequency} ariaLabel="Frequency" />
                    {frequency === 'Custom' && (<>
                      <span className="lbl">Every</span>
                      <Input fieldClassName="h10-rb-num" inputMode="numeric" placeholder="Please enter" value={everyN} onChange={(e) => setEveryN(e.target.value)} aria-label="Every (number)" />
                      <Listbox width={130} options={INTERVAL} value={interval} onChange={setInterval} ariaLabel="Interval" />
                      {interval === 'Weeks' && (<>
                        <span className="lbl">on</span>
                        <Listbox width={150} options={DAYS} value={onDay} onChange={setOnDay} ariaLabel="Day of week" />
                      </>)}
                    </>)}
                    <span className="at">at</span>
                    <Listbox width={200} options={TIMES} value={time} onChange={setTime} ariaLabel="Time" />
                  </div>
                </div>
                <div className="advblock">
                  <b>Timezone</b>
                  <p>Select the timezone for this rule</p>
                  <Listbox width={430} options={TIMEZONES} value={timezone} onChange={setTimezone} ariaLabel="Timezone" />
                </div>
                {isBudget && (
                <div className="advblock">
                  <b>Budget Guardrails</b>
                  <p>Hard limits so automation can never run a budget away — Amazon’s daily minimum is €1</p>
                  <div className="freqrow">
                    <span className="lbl">Min</span>
                    <span className="h10-rb-val bidv"><span className="pf">€</span><input inputMode="decimal" value={budgetFloor} onChange={(e) => setBudgetFloor(e.target.value)} aria-label="Min daily budget" /></span>
                    <span className="lbl">Max</span>
                    <span className="h10-rb-val bidv"><span className="pf">€</span><input inputMode="decimal" placeholder="No cap" value={budgetCeiling} onChange={(e) => setBudgetCeiling(e.target.value)} aria-label="Max daily budget" /></span>
                  </div>
                  {floorOverCeiling && <div className="h10-rb-warn">Min budget (€{budgetFloor}) is above Max (€{budgetCeiling}) — increases would be capped at the Max.</div>}
                </div>
                )}
                {/* P2.2 — spend ceiling + write cap + market scope for EVERY rule type. These were
                    budget-only, so a bid or negation rule was created account-wide and uncapped
                    with no control ever offered. */}
                <div className="advblock">
                  <b>Spend ceiling &amp; write cap</b>
                  {/* BP.P2 — the two server defaults are stated and prefilled, because they apply
                      whether or not this form mentions them: a blank spend ceiling still stores
                      €100/day, and a blank run cap still stores 10. "No cap" was false copy. */}
                  <p>Refuse further work past the ceiling; past the write cap the rule keeps proposing but stops writing. Every rule carries a €100/day spend ceiling and a 10-runs-per-day cap unless you change them here.</p>
                  <div className="freqrow">
                    <span className="lbl">Max daily ad spend</span>
                    <span className="h10-rb-val bidv"><span className="pf">€</span><input inputMode="decimal" placeholder="100 (default)" value={maxAdSpend} onChange={(e) => setMaxAdSpend(e.target.value)} aria-label="Max daily ad spend" /></span>
                    <span className="lbl">Max writes per day</span>
                    <span className="h10-rb-val bidv"><input inputMode="numeric" placeholder="No cap" value={maxWrites} onChange={(e) => setMaxWrites(e.target.value)} aria-label="Max writes per day" /></span>
                    <span className="lbl">Max runs per day</span>
                    <span className="h10-rb-val bidv"><input inputMode="numeric" placeholder="10 (default)" value={maxExecs} onChange={(e) => setMaxExecs(e.target.value)} aria-label="Max rule runs per day" /></span>
                  </div>
                </div>
                <div className="advblock">
                  <b>Marketplace</b>
                  <p>Limit this rule to a single marketplace — unscoped, it acts in every market</p>
                  <Listbox width={260} options={MARKETS} value={scopeMarket} onChange={setScopeMarket} ariaLabel="Marketplace scope" />
                </div>
                {isPlacement && (
                <div className="advblock">
                  <b>Placement Guardrails</b>
                  <p>Hard limits on the placement bid modifier — Amazon allows 0–900%</p>
                  <div className="freqrow">
                    <span className="lbl">Min</span>
                    <span className="h10-rb-val bidv hassf"><input inputMode="decimal" value={placeFloor} onChange={(e) => setPlaceFloor(e.target.value)} aria-label="Min placement modifier" /><span className="sf">%</span></span>
                    <span className="lbl">Max</span>
                    <span className="h10-rb-val bidv hassf"><input inputMode="decimal" value={placeCeiling} onChange={(e) => setPlaceCeiling(e.target.value)} aria-label="Max placement modifier" /><span className="sf">%</span></span>
                  </div>
                  {placeCeiling.trim() !== '' && (Number(placeFloor) || 0) > (Number(placeCeiling) || 0) && <div className="h10-rb-warn">Min ({placeFloor}%) is above Max ({placeCeiling}%) — increases would be capped at the Max.</div>}
                </div>
                )}
                {isBidLike && (
                <div className="advblock">
                  <b>Bid Guardrails</b>
                  <p>Hard limits on the keyword bid so automation can never run a bid away — Amazon’s minimum is €0.02</p>
                  <div className="freqrow">
                    <span className="lbl">Min</span>
                    <span className="h10-rb-val bidv"><span className="pf">€</span><input inputMode="decimal" value={bidFloor} onChange={(e) => setBidFloor(e.target.value)} aria-label="Min bid" /></span>
                    <span className="lbl">Max</span>
                    <span className="h10-rb-val bidv"><span className="pf">€</span><input inputMode="decimal" placeholder="No cap" value={bidCeiling} onChange={(e) => setBidCeiling(e.target.value)} aria-label="Max bid" /></span>
                  </div>
                  {bidFloorOverCeiling && <div className="h10-rb-warn">Min bid (€{bidFloor}) is above Max (€{bidCeiling}) — increases would be capped at the Max.</div>}
                </div>
                )}
                {isNegative && (
                <div className="advblock">
                  <b>Negation Level</b>
                  {/* NEG-P2 — the landing rate is a measured fact, not a preference: ad-group
                      negatives confirm at Amazon ~99%; campaign-level ones have historically
                      confirmed 0 of 20. The select stays free; the fact rides beside it. */}
                  <p>Where to place the negative keyword / product target when this rule fires. Ad-group negatives are the ones that demonstrably land at Amazon in this account; campaign-level negatives have historically never confirmed.</p>
                  <Listbox width={280} options={[{ value: 'adgroup', label: 'Ad Group' }, { value: 'campaign', label: 'Campaign' }, { value: 'both', label: 'Ad Group + Campaign' }]} value={negationLevel} onChange={(v) => setNegationLevel(v as 'adgroup' | 'campaign' | 'both')} ariaLabel="Negation level" />
                </div>
                )}
                {isHarvest && (
                <div className="advblock">
                  <b>New Target Bid</b>
                  <p>Starting bid for the targets this rule creates. Current CPC inherits what the search term actually costs per click in the rule’s window; the write gate’s campaign ceilings still bind.</p>
                  <div className="freqrow">
                    {/* HP1 — H10's four modes, every one computed by the engine (the old
                        "Suggested bid" was a €0.75 constant). CPC = the term's own measured
                        cost-per-click in the rule's window — the going rate for that demand. */}
                    <Listbox width={230} options={[
                      { value: 'cpc', label: 'Set to Current CPC' },
                      { value: 'cpcPlus', label: 'Current CPC + %' },
                      { value: 'adGroupDefault', label: 'Ad group default bid' },
                      { value: 'fixed', label: 'Custom bid' },
                    ]} value={bidMode} onChange={(v) => setBidMode(v as 'cpc' | 'cpcPlus' | 'adGroupDefault' | 'fixed')} ariaLabel="New target bid mode" />
                    {bidMode === 'fixed' && <span className="h10-rb-val bidv"><span className="pf">€</span><input inputMode="decimal" placeholder="0.75" value={bidValue} onChange={(e) => setBidValue(e.target.value)} aria-label="Custom bid amount" /></span>}
                    {bidMode === 'cpcPlus' && <span className="h10-rb-val bidv hassf"><input inputMode="decimal" placeholder="10" value={bidValue} onChange={(e) => setBidValue(e.target.value)} aria-label="Percent above the term’s CPC" /><span className="sf">%</span></span>}
                  </div>
                </div>
                )}
              </div>
            </section>

            {/* ── Control ── */}
            <section id="rb-control" className="h10-rb-sec">
              <h2>Control</h2>
              {/* BP.P1 — the second sentence is the round-trip honesty line: the radio ARMS the
                  rule on save now (level via the autonomy route), so the copy must say so. */}
              <p className="h10-rb-desc">
                Determine the level of control over the actions of this rule.
                {isEdit
                  ? ' Changing the mode here applies when you save.'
                  : ' The rule is live at the mode you choose as soon as you create it — Manual queues every action on the Suggestions page for your approval; Automate applies them on its own, inside the rule’s caps and the write gate.'}
                {/* HP4 — the graduation ceiling, stated BEFORE save (the bid builder's
                    pause-action HoverCard precedent): a structural rule cannot reach full
                    automation, and the radio must not promise it. */}
                {(isHarvest || isNegative) && ' This rule CREATES things, and creation is held below full automation by policy: whichever you choose, its actions queue on the Suggestions page for your approval.'}
              </p>
              <div className="h10-rb-card control">
                {surface === 'search-terms' && (<div className="h10-rb-dedupe">
                  <button type="button" className={`h10-bktoggle ${dedupe ? 'on' : ''}`} role="switch" aria-checked={dedupe} aria-label="Do not suggest existing search terms" onClick={() => setDedupe((v) => !v)}><span /></button>
                  {/* NEG-P2 — one toggle, two truths: for a negative rule the duplicate being
                      skipped is an existing NEGATIVE at the chosen level, not a keyword. */}
                  <span>{isNegative
                    ? 'Select to NOT re-negate any search term that is already negated with the same match type at the chosen level in the ad groups from this rule group'
                    : 'Select to NOT suggest any search terms that already exist with the same match type in the campaigns from this rule group'}</span>
                </div>)}
                {isNegative && (
                <div className="h10-rb-dedupe">
                  <button type="button" className={`h10-bktoggle ${protectConverting ? 'on' : ''}`} role="switch" aria-checked={protectConverting} aria-label="Protect converting search terms" onClick={() => setProtectConverting((v) => !v)}><span /></button>
                  <span>Never create a negative for a term that <b>converted</b> (≥1 order) in the last <Input size="xs" fieldClassName="h10-rb-ninline" className="h10-rb-nincenter" inputMode="numeric" value={protectDays} onChange={(e) => setProtectDays(e.target.value)} aria-label="Protection window in days" /> days in any campaign — protects proven keywords from being blocked.</span>
                </div>
                )}
                {isHarvest && (
                <div className="h10-rb-dedupe">
                  <button type="button" className={`h10-bktoggle ${negateInSource ? 'on' : ''}`} role="switch" aria-checked={negateInSource} aria-label="Negate harvested terms in source" onClick={() => setNegateInSource((v) => !v)}><span /></button>
                  <span>Also add each harvested term as a <b>negative</b> in its source ad group — stops the source (Auto/Broad) campaign from competing with the new target.</span>
                </div>
                )}
                <label className={`h10-rb-ctrl ${control === 'manual' ? 'on' : ''}`}>
                  <input type="radio" name="control" checked={control === 'manual'} onChange={() => setControl('manual')} />
                  <span className="b"><span className="t">Manual</span><span className="d">Manually approve rule actions on the Suggestions page</span></span>
                </label>
                <label className={`h10-rb-ctrl ${control === 'automate' ? 'on' : ''}`}>
                  <input type="radio" name="control" checked={control === 'automate'} onChange={() => setControl('automate')} />
                  <span className="b"><span className="t">Automate</span><span className="d">Automate this rule to have Nexus Ads automatically apply rule actions</span></span>
                </label>
              </div>
            </section>

            {/* KT-P1 — a held control that has been clicked must answer it.
                🔴 ABOVE the footer, not inside it. Rendered as a flex item in `.h10-rb-foot`
                (`display:flex; align-items:center`) it consumed the row and wrapped both buttons
                onto two lines each — "Save / Template" and "Create / Rule" — so the refusal broke
                the very controls it was explaining. Measured on the rig, not read from the diff. */}
            {rankHeldNote && rankBlocked && (
              <p className="h10-rb-heldnote ktp" role="status" ref={rankNoteRef}>
                <AlertTriangle size={13} aria-hidden />
                <span>
                  This rule is not saved because it could never act: the keyword-rank feed holds no
                  observations, so every run would match nothing. Nothing you can change on this form
                  fixes that — the feed has to be filled first. To move bids on the evidence that{' '}
                  <i>does</i> exist today, build a <b>Bid</b> rule (ACoS, spend, clicks, CPC, current
                  bid) or a <b>Share of Voice</b> rule.
                </span>
              </p>
            )}
            {/* footer */}
            <div className="h10-rb-foot">
              <button type="button" className="h10-rb-btn ghost" onClick={close}>Cancel</button>
              <span className="grow" />
              {(isCampaign || isHarvest || isNegative) && <button type="button" className="h10-rb-btn ghost" disabled={!valid} onClick={() => setTmpl({ mode: 'save' })}>Save Template</button>}
              <button
            type="button"
            className={`h10-rb-create${rankBlocked ? ' held' : ''}`}
            disabled={!rankBlocked && (!valid || creating)}
            {...(rankBlocked ? { 'aria-disabled': true } : {})}
            onClick={rankBlocked ? () => setRankHeldNote(true) : submit}
          >{creating ? (isEdit ? 'Saving…' : 'Creating…') : (isEdit ? 'Save Changes' : 'Create Rule')}</button>
            </div>
          </div>
        </main>
      </div>
      {preview?.open && (
        <div className="h10-rb-prevback" onClick={() => setPreview(null)}>
          <div className={`h10-rb-prev${isRank ? ' ktp' : ''}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={isRank ? 'Keyword Tracker preview' : isSov ? 'Share of Voice preview' : isBidLike ? 'Bid preview' : isPlacement ? 'Placement preview' : isBudget ? 'Budget preview' : isHarvest ? 'Harvest preview' : 'Negative targeting preview'}>
            <div className="ph"><b>{isSov ? 'Share of Voice Preview — current → proposed' : isBidLike ? 'Bid Preview — current → proposed' : isPlacement ? 'Placement Preview — current → proposed' : isBudget ? 'Budget Preview — current → proposed' : isHarvest ? 'Preview — converting search terms' : 'Preview — wasting search terms'}</b><button type="button" onClick={() => setPreview(null)} aria-label="Close"><X size={18} /></button></div>
            <div className="psub">{isRank ? (preview?.rank && preview.rank.matched > 0
              ? `Live, read-only: the ${preview.rank.matched} keyword${preview.rank.matched === 1 ? '' : 's'} in your ${preview.rank.selected} selected campaign${preview.rank.selected === 1 ? '' : 's'} that ${preview.rank.matched === 1 ? 'matches' : 'match'} these criteria right now, and the bid each would get. Evaluated by the rule engine against the latest rank observation for each keyword.`
              : 'Live, read-only: the keywords that match these criteria right now, and the bid each would get.') : isSov ? (preview?.sov && preview.sov.matched > 0
              ? `Live, read-only: the ${preview.sov.matched} keyword${preview.sov.matched === 1 ? '' : 's'} in your ${preview.sov.selected} selected campaign${preview.sov.selected === 1 ? '' : 's'} that ${preview.sov.matched === 1 ? 'matches' : 'match'} these criteria right now, and the bid each would get. Evaluated by the rule engine against Amazon’s own market share for each keyword.`
              : 'Live, read-only: the keywords that match these criteria right now, and the bid each would get.') : isRank ? 'Read-only: each keyword’s current organic / paid rank and the new bid it would get when this rule fires.' : isBidLike ? 'Read-only: the new bid each keyword/target in your selected campaigns would get when this rule fires.' : isPlacement ? (preview?.place && preview.place.matched > 0
              ? `Live, read-only: the ${preview.place.matched} of ${preview.place.selected} selected campaigns that ${preview.place.matched === 1 ? 'matches' : 'match'} these criteria right now, and the placement modifier each would get. Evaluated by the rule engine over the last ${preview.place.windowDays} settled days.`
              : 'Live, read-only: the campaigns that match these criteria right now, and the placement modifier each would get.') : isBudget ? (preview?.budget && preview.budget.matched > 0
              ? `Live, read-only: the ${preview.budget.matched} of ${preview.budget.selected} selected campaigns that ${preview.budget.matched === 1 ? 'matches' : 'match'} these criteria right now, and the daily budget each would get. Evaluated by the rule engine over the last ${preview.budget.windowDays} settled days.`
              : 'Live, read-only: the campaigns that match these criteria right now, and the daily budget each would get.') : isHarvest ? 'Live, read-only: search terms currently meeting your criteria that would be harvested.' : 'Live, read-only: search terms currently meeting your criteria that would be negated.'}</div>
            <div className="pbody">
              {preview.loading ? <div className="pmsg">Loading…</div>
                : preview.terms.length === 0 ? <div className="pmsg">{isBid ? (preview.error ? preview.error
                  /* 🔴 The trigger's floor is the commonest reason a Bid preview is empty, and the
                     old panel never mentioned it. "Never offered" and "considered and rejected"
                     are different facts and must not share a sentence. */
                  : !preview.bid || preview.bid.selected === 0 ? 'Add campaigns above to preview their keyword bids.'
                  : preview.bid.measurable === 0 ? `None of the ${preview.bid.selectedTargets} target${preview.bid.selectedTargets === 1 ? '' : 's'} in your selected campaigns clears the bar a bid rule needs: at least ${preview.bid.floor.minOrders} order, €${preview.bid.floor.minSpendEur.toFixed(2)} of spend and ${preview.bid.floor.minAcosPct}% ACoS over the last ${preview.bid.windowDays} settled days. This is not a problem with your criteria — those keywords are never offered to a bid rule at all.`
                  : preview.bid.inScope === 0 ? `${preview.bid.measurable} of your keywords clear that bar, but none is in ${scopeMarket === 'all' ? 'the chosen market' : scopeMarket}.`
                  : `No keyword matches these criteria right now — ${preview.bid.inScope} ${preview.bid.inScope === 1 ? 'was' : 'were'} measured. The rule is still valid; it will act when one does.`) : isRank ? (preview.error ? preview.error
                  /* 🔴 KT-P2 — five different reasons for an empty rank preview, and only one of
                     them is "your criteria are too tight". Collapsing them into one sentence is
                     what let a builder over an EMPTY FEED read as a working rule with no matches. */
                  : !preview.rank || preview.rank.selected === 0 ? 'Add campaigns above to preview their keyword bids.'
                  : preview.rank.feed.rows === 0 ? `No keyword rank has ever been recorded, so this rule matches nothing — and would match nothing on every run. The feed holds 0 observations against ${preview.rank.feed.totalTargets.toLocaleString('en-GB')} keyword targets in your campaigns. This is not a problem with your criteria.`
                  : preview.rank.feed.coveredTargets === 0 ? `The rank feed holds ${preview.rank.feed.rows.toLocaleString('en-GB')} observation${preview.rank.feed.rows === 1 ? '' : 's'} across ${preview.rank.feed.keywords} keyword${preview.rank.feed.keywords === 1 ? '' : 's'}, but none of them matches a keyword you are bidding on, so no rule can reach any of your targets yet.`
                  : preview.rank.measurable === 0 ? `${preview.rank.feed.coveredTargets} of your keyword targets have a rank observation, but none is in the campaigns you selected.`
                  : preview.rank.inScope === 0 ? `${preview.rank.measurable} of your keywords have a rank observation, but none is in ${scopeMarket === 'all' ? 'the chosen market' : scopeMarket}.`
                  : `No keyword matches these criteria right now — ${preview.rank.inScope} keyword${preview.rank.inScope === 1 ? ' was' : 's were'} measured against the latest rank observation. The rule is still valid; it will act when one does.`) : isSov ? (preview.error ? preview.error
                  /* 🔴 Five different reasons for an empty SOV preview, and only one of them is
                     "your criteria are too tight". "Never offered" and "considered and rejected"
                     must never share a sentence. */
                  : !preview.sov || preview.sov.selected === 0 ? 'Add campaigns above to preview their keyword bids.'
                  : preview.sov.eligible === 0 ? `None of the ${preview.sov.selectedTargets} target${preview.sov.selectedTargets === 1 ? '' : 's'} in your selected campaigns is an enabled keyword, and a Share of Voice rule can only act on those. This is not a problem with your criteria.`
                  : preview.sov.measurable === 0 ? `Amazon has not reported a market share for any of your ${preview.sov.eligible} enabled keyword${preview.sov.eligible === 1 ? '' : 's'} in these campaigns, so no Share of Voice rule can reach ${preview.sov.eligible === 1 ? 'it' : 'them'} yet.`
                  : preview.sov.inScope === 0 ? `${preview.sov.measurable} of your keywords carry a market share, but none is in ${scopeMarket === 'all' ? 'the chosen market' : scopeMarket}.`
                  : `No keyword matches these criteria right now — ${preview.sov.inScope} ${preview.sov.inScope === 1 ? 'was' : 'were'} measured against Amazon’s latest complete week. The rule is still valid; it will act when one does.`) : isBidLike ? 'Add campaigns above to preview their keyword bids.' : isPlacement ? (preview.error ? preview.error
                  : !preview.place || preview.place.selected === 0 ? 'Add campaigns above to preview their new placement modifiers.'
                  : preview.place.measurable === 0 ? `${preview.place.selected === 1 ? 'Your selected campaign has' : `None of your ${preview.place.selected} selected campaigns has`} no ad spend in the last ${preview.place.windowDays} settled days, so no placement rule can reach ${preview.place.selected === 1 ? 'it' : 'them'} yet.`
                  : preview.place.inScope === 0 ? `${preview.place.measurable} of your selected campaigns ${preview.place.measurable === 1 ? 'has' : 'have'} spend in the window, but none is in ${scopeMarket === 'all' ? 'the chosen market' : scopeMarket}.`
                  : `No campaign matches these criteria right now — ${preview.place.inScope} campaign${preview.place.inScope === 1 ? ' was' : 's were'} measured over the last ${preview.place.windowDays} settled days. The rule is still valid; it will act when one does.`) : isBudget ? (preview.error ? preview.error
                  : !preview.budget || preview.budget.selected === 0 ? 'Add campaigns above to preview their new budgets.'
                  : preview.budget.measurable === 0 ? `${preview.budget.selected === 1 ? 'Your selected campaign has' : `None of your ${preview.budget.selected} selected campaigns has`} no ad spend in the last ${preview.budget.windowDays} settled days, so no budget rule can reach ${preview.budget.selected === 1 ? 'it' : 'them'} yet.`
                  : preview.budget.inScope === 0 ? `${preview.budget.measurable} of your selected campaigns ${preview.budget.measurable === 1 ? 'has' : 'have'} spend in the window, but none is in ${scopeMarket === 'all' ? 'the chosen market' : scopeMarket}.`
                  : `No campaign matches these criteria right now — ${preview.budget.inScope} campaign${preview.budget.inScope === 1 ? ' was' : 's were'} measured over the last ${preview.budget.windowDays} settled days. The rule is still valid; it will act when one does.`) : isHarvest ? 'No converting search terms match the current criteria yet.' : 'No wasting search terms match the current criteria yet.'}</div>
                : isRank
                  ? (<>
                    {/* 🔴 KT-P2 — every rank cell is null-safe by construction: the context OMITS an
                        unmeasured rank rather than sending 0, and `—` is the only thing a missing
                        observation may render as. A `#0` or a `0` here would be a fabricated
                        position ([[reference_sov_zero_vs_rounding]]). */}
                    <div className="ptable ktp"><div className="pthr"><span>Keyword</span><span>Market</span><span>Organic</span><span>Sponsored</span><span>Δ</span><span>Current</span><span>New Bid</span></div>{preview.terms.map((t, i) => (<div className="ptr" key={i}><span className="term" title={t.term}>{t.term}{t.suppressed ? <em className="pnote sup" title={t.suppressed === 'flag' ? 'This target carries a suppression flag — it was deliberately switched off, and the bid action refuses to switch it back on.' : 'This target bids at or under 3¢, this account’s convention for switching delivery off. It carries no flag, so only the bid says so.'}>{t.suppressed === 'flag' ? 'suppressed' : 'suppressed (2¢)'}</em> : null}</span><span>{t.marketplace ?? '—'}</span><span>{t.organicRank != null ? `#${t.organicRank}` : '—'}</span><span>{t.sponsoredRank != null ? `#${t.sponsoredRank}` : '—'}</span><span className={t.rankDelta != null ? (t.rankDelta > 0 ? 'up' : t.rankDelta < 0 ? 'down' : '') : ''}>{t.rankDelta != null ? (t.rankDelta > 0 ? `+${t.rankDelta}` : String(t.rankDelta)) : '—'}</span><span>{t.current != null ? `€${t.current.toFixed(2)}` : '—'}</span><span className={`newb ${t.refused ? '' : t.proposed != null && t.current != null ? (t.proposed > t.current ? 'up' : t.proposed < t.current ? 'down' : '') : ''}`}>{t.refused ? '—' : t.proposed != null ? `€${t.proposed.toFixed(2)}` : '—'}{t.refused ? <em className="pnote"> {t.refused}</em> : null}</span></div>))}</div>
                    {preview.rank && (
                      <p className="pfoot">
                        {preview.rank.selected} campaign{preview.rank.selected === 1 ? '' : 's'} selected · {preview.rank.measurable} keyword{preview.rank.measurable === 1 ? '' : 's'} with a rank observation · {preview.rank.inScope} in scope · <b>{preview.rank.matched} match</b>
                        {preview.rank.noChange > 0 ? <> · {preview.rank.noChange} of them already {preview.rank.noChange === 1 ? 'bids' : 'bid'} this, where this rule does nothing</> : null}
                        {/* 🔴 The suppression warning. `bid_apply` carries NO suppression guard and
                            its floor is €0.05, so it cannot write ≤3¢ — every op on a suppressed
                            target switches delivery back on for traffic somebody switched off. The
                            preview reports what would REALLY happen rather than filtering these
                            out, because a preview that disagrees with the engine is the defect this
                            whole path exists to remove. Counted in two, never merged: the flag is
                            evidence and ≤3¢ is a convention, and merging them hides the ones the
                            flag does not know about ([[reference_ads_suppression_by_low_bid]]). */}
                        {preview.rank.suppressedMatched > 0 && (
                          <span className="pwarn">⚠ {preview.rank.suppressedMatched} of the {preview.rank.matched} {preview.rank.suppressedMatched === 1 ? 'is' : 'are'} deliberately suppressed
                            {preview.rank.suppressedUnflaggedMatched > 0 ? ` (${preview.rank.suppressedUnflaggedMatched} of those ${preview.rank.suppressedUnflaggedMatched === 1 ? 'carries' : 'carry'} no suppression flag — only a ≤3¢ bid says so)` : ''}
                            {' '}and {preview.rank.suppressedMatched === 1 ? 'is' : 'are'} <b>left alone</b>: delivery there was switched off on purpose, and the bid action refuses to switch it back on. Un-suppressing is a separate decision, not a side effect of a bid rule.
                            {preview.rank.campaignSuppressedMatched > 0 ? ` A further ${preview.rank.campaignSuppressedMatched} sit${preview.rank.campaignSuppressedMatched === 1 ? 's' : ''} in a campaign whose bids are suppressed right now, where a write would be undone by the next resume — also skipped.` : ''}
                          </span>
                        )}
                        <span className="phour">Bids read at {new Date(preview.rank.readAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}. Rank is the latest observation per keyword, not an average.</span>
                      </p>
                    )}
                  </>)
                : isSov
                  ? (<>
                    {/* Share of Voice is a COLUMN: it is the number that decided the row, and a
                        current → proposed pair with the deciding metric off-screen is a cell the
                        operator cannot check. */}
                    <div className="ptable budp"><div className="pthr"><span>Keyword</span><span>Market</span><span>Share of Voice</span><span>Current</span><span>New Bid</span></div>{preview.terms.map((t, i) => (<div className="ptr" key={i}><span className="term" title={t.term}>{t.term}</span><span>{t.marketplace ?? '—'}</span><span title={t.concentrationPct != null ? `${(t.concentrationPct * 100).toFixed(0)}% of the impressions you took on this term came from one campaign` : 'You ran no ads on this term in the last 30 days, so there is no campaign concentration'}>{t.sovPct != null ? (t.sovPct > 0 && t.sovPct < 0.0001 ? '<0.01%' : `${(t.sovPct * 100).toFixed(2)}%`) : '—'}</span><span>{t.current != null ? `€${t.current.toFixed(2)}` : '—'}{t.suppressed ? <em className="pnote" title={t.suppressed === 'flag' ? 'This target carries a suppression flag — it was deliberately taken out of delivery.' : 'Nothing but the bid says so: at or under 3¢ with no suppression flag.'}> suppressed</em> : null}</span><span className={`newb ${t.refused ? '' : t.clamped ? '' : t.proposed != null && t.current != null ? (t.proposed > t.current ? 'up' : t.proposed < t.current ? 'down' : '') : ''}`}>{t.refused ? <em className="pnote" title={t.refused}> no change — {t.suppressed || t.campaignSuppressed ? 'suppressed' : 'refused'}</em> : t.proposed != null ? `€${t.proposed.toFixed(2)}` : '—'}{!t.refused && t.clamped ? <em className="pnote"> no change — guardrail</em> : null}</span></div>))}</div>
                    {preview.sov && (
                      <p className="pfoot">
                        {preview.sov.selectedTargets} target{preview.sov.selectedTargets === 1 ? '' : 's'} selected · {preview.sov.eligible} enabled keyword{preview.sov.eligible === 1 ? '' : 's'}
                        {preview.sov.notEnabled > 0 ? <> ({preview.sov.notEnabled} paused or archived, which this rule skips)</> : null}
                        {' '}· {preview.sov.measurable} carry a market share · {preview.sov.inScope} in scope · <b>{preview.sov.matched} match</b>
                        {preview.sov.noChange > 0 ? <> · {preview.sov.noChange} of them sit at a guardrail, where this rule does nothing</> : null}
                        {/* 🔴 `bid_apply`'s floor is max(0.05, minEur), so it CANNOT write ≤3¢:
                            every op on a suppressed target switches delivery back on for traffic
                            somebody deliberately switched off. Two counts, never merged — the flag
                            is evidence, ≤3¢ is a convention, and merging them hides the ones the
                            flag does not know about. */}
                        {/* 🔴 This sentence used to say the rule WOULD RAISE them. KT-P6
                            (`cba86dc11`) added a suppression guard to `bid_apply` that returns
                            before the dryRun, so the engine now refuses instead — and a warning
                            about an action the engine no longer takes is a lie with a yellow
                            background. The rows are listed with the handler's own reason; this
                            counts them. Two counts, never merged: the flag is evidence, ≤3¢ is a
                            convention, and merging them hides the ones the flag does not know
                            about. */}
                        {preview.sov.suppressedMatched > 0 && (
                          <span className="pwarn">⚠ {preview.sov.suppressedMatched} of the {preview.sov.matched} matched {preview.sov.suppressedMatched === 1 ? 'keyword is' : 'keywords are'} deliberately suppressed, so the bid action <b>leaves {preview.sov.suppressedMatched === 1 ? 'it' : 'them'} alone</b> — it refuses to raise a suppressed target back into delivery. {preview.sov.suppressedMatched === 1 ? 'It is' : 'They are'} listed above with the refusal in place of a new bid, so fewer bids move than criteria match.
                            {preview.sov.suppressedUnflaggedMatched > 0 ? ` ${preview.sov.suppressedUnflaggedMatched} of those carry no suppression flag — only a ≤3¢ bid says so.` : ''}
                            {preview.sov.campaignSuppressedMatched > 0 ? ` ${preview.sov.campaignSuppressedMatched} sit${preview.sov.campaignSuppressedMatched === 1 ? 's' : ''} in a campaign whose bids are suppressed right now.` : ''}
                          </span>
                        )}
                        {/* The week, always — a share is a reading from a dated report, not a
                            setting, and its age is Amazon's to decide. */}
                        <span className="phour">
                          {preview.sov.periods.filter((x) => !x.refused).length > 0
                            ? `Amazon’s week: ${preview.sov.periods.filter((x) => !x.refused).map((x) => `${x.marketplace} ${x.week}${x.ageDays != null ? ` (${x.ageDays}d old)` : ''}`).join(' · ')}.`
                            : 'No market has a complete week of Amazon search-query data right now.'}
                          {preview.sov.periods.some((x) => x.refused) ? ` ${preview.sov.periods.filter((x) => x.refused).map((x) => x.marketplace).join('/')} skipped — Amazon has not published a complete week, and a partial one would move bids on a denominator that is still being filled.` : ''}
                        </span>
                      </p>
                    )}
                  </>)
                : isBid
                  ? (<>
                    {/* ACoS and spend are COLUMNS: they are what selected the row and what the
                        criteria read, and a current → proposed pair with them off-screen cannot be
                        checked by the operator. */}
                    <div className="ptable budp"><div className="pthr"><span>Keyword</span><span>Market</span><span>ACoS</span><span>Current</span><span>New Bid</span></div>{preview.terms.map((t, i) => (<div className="ptr" key={i}><span className="term" title={t.term}>{t.term}</span><span>{t.marketplace ?? '—'}</span><span title={t.spend != null ? `€${t.spend.toFixed(2)} spend in the window` : undefined}>{t.acosPct != null ? `${t.acosPct.toFixed(0)}%` : '—'}</span><span>{t.current != null ? `€${t.current.toFixed(2)}` : '—'}{t.suppressed ? <em className="pnote" title={t.suppressed === 'flag' ? 'This target carries a suppression flag.' : 'At or under 3¢ with no flag — this account’s suppression convention.'}> suppressed</em> : null}</span><span className={`newb ${t.refused || t.clamped ? '' : t.proposed != null && t.current != null ? (t.proposed > t.current ? 'up' : t.proposed < t.current ? 'down' : '') : ''}`}>{t.refused ? <em className="pnote" title={t.refused}> no change — refused</em> : t.proposed != null ? `€${t.proposed.toFixed(2)}` : '—'}{!t.refused && t.clamped ? <em className="pnote"> no change — guardrail</em> : null}</span></div>))}</div>
                    {preview.bid && (
                      <p className="pfoot">
                        {preview.bid.selectedTargets} target{preview.bid.selectedTargets === 1 ? '' : 's'} selected · {preview.bid.measurable} clear the bid trigger’s bar · {preview.bid.inScope} in scope · <b>{preview.bid.matched} match</b>
                        {preview.bid.noChange > 0 ? <> · {preview.bid.noChange} of them sit at a guardrail, where this rule does nothing</> : null}
                        {/* 🔴 The floor, always. It is the difference between "your criteria are
                            tight" and "these keywords are never offered to a bid rule". */}
                        <span className="phour">A bid rule only ever sees keywords with at least {preview.bid.floor.minOrders} order, €{preview.bid.floor.minSpendEur.toFixed(2)} of spend and {preview.bid.floor.minAcosPct}% ACoS over the last {preview.bid.windowDays} settled days — the KEYWORD_HIGH_ACOS trigger’s own bar, applied before any rule runs.</span>
                        {preview.bid.refusedNoSignal > 0 && (
                          <span className="pwarn">⚠ {preview.bid.refusedNoSignal} of the {preview.bid.matched} matched {preview.bid.refusedNoSignal === 1 ? 'keyword was' : 'keywords were'} <b>refused by the bid action</b>, not left unchanged — a computed bid needs a signal those {preview.bid.refusedNoSignal === 1 ? 'target lacks' : 'targets lack'} in the window. Each row carries the handler’s own reason; hover the refusal to read it.</span>
                        )}
                        {preview.bid.suppressedMatched > 0 && (
                          <span className="pwarn">⚠ {preview.bid.suppressedMatched} of the {preview.bid.matched} matched {preview.bid.suppressedMatched === 1 ? 'keyword is' : 'keywords are'} deliberately suppressed, so the bid action <b>leaves {preview.bid.suppressedMatched === 1 ? 'it' : 'them'} alone</b>.
                            {preview.bid.suppressedUnflaggedMatched > 0 ? ` ${preview.bid.suppressedUnflaggedMatched} of those carry no suppression flag — only a ≤3¢ bid says so.` : ''}
                            {preview.bid.campaignSuppressedMatched > 0 ? ` ${preview.bid.campaignSuppressedMatched} sit${preview.bid.campaignSuppressedMatched === 1 ? 's' : ''} in a campaign whose bids are suppressed right now.` : ''}
                          </span>
                        )}
                      </p>
                    )}
                  </>)
                : isBidLike
                  ? (<div className="ptable bud"><div className="pthr"><span>Keyword / Target</span><span>Current</span><span>New Bid</span></div>{preview.terms.map((t, i) => (<div className="ptr" key={i}><span className="term" title={t.term}>{t.term}</span><span>{t.current != null ? `€${t.current.toFixed(2)}` : '—'}</span><span className={`newb ${t.proposed != null && t.current != null ? (t.proposed > t.current ? 'up' : t.proposed < t.current ? 'down' : '') : ''}`}>{t.proposed != null ? `€${t.proposed.toFixed(2)}` : '—'}</span></div>))}</div>)
                : isPlacement
                  ? (<>
                    {/* 🔴 Lane is a COLUMN, not a subtitle. On a multi-block rule the lane is
                        decided per campaign by whichever block matched, so one lane named up top
                        would be wrong on some rows — and "Set 50%" with no lane is the cell that
                        makes three different placement rules read identically. */}
                    <div className="ptable plcp"><div className="pthr"><span>Campaign</span><span>Lane</span><span>Current</span><span>New Modifier</span></div>{preview.terms.map((t, i) => (<div className="ptr" key={i}><span className="term" title={t.term}>{t.term}</span><span className="lane">{t.lane ?? '—'}</span><span>{t.current != null ? `${t.current}%` : '—'}{t.governed ? <em className="pnote eng" title={t.lastEngineWriteAt ? `The rank engine last rewrote this lane at ${new Date(t.lastEngineWriteAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}.` : 'An enabled schedule governs this campaign, though this lane has not moved in the last 7 days.'}>engine-managed</em> : null}</span><span className={`newb ${t.clamped ? '' : t.proposed != null && t.current != null ? (t.proposed > t.current ? 'up' : t.proposed < t.current ? 'down' : '') : ''}`}>{t.proposed != null ? `${t.proposed}%` : '—'}{t.clamped ? <em className="pnote"> no change — guardrail</em> : null}</span></div>))}</div>
                    {preview.place && (
                      <p className="pfoot">
                        {preview.place.selected} selected · {preview.place.measurable} with spend in the window · {preview.place.inScope} in scope · <b>{preview.place.matched} match</b>
                        {preview.place.noChange > 0 ? <> · {preview.place.noChange} of them sit at a guardrail, where this rule does nothing</> : null}
                        {/* 🔴 The hour, always. `placement_apply` reads the current multiplier from
                            the campaign at execution time, and on a governed campaign that field is
                            rewritten on a clock — so "current" is a reading with a timestamp, not a
                            setting. Stating it is the difference between an honest preview and one
                            that is quietly false an hour later. */}
                        <span className="phour">Current values read at {new Date(preview.place.readAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.
                          {preview.place.governedMatched > 0
                            ? ` ${preview.place.governedMatched} of the ${preview.place.matched} ${preview.place.governedMatched === 1 ? 'is' : 'are'} governed by the rank engine, which rewrites these lanes on a schedule — there, the current value is a reading rather than a setting, and a rule's write is undone on the engine's next pass.`
                            : ' No matched campaign is governed by the rank engine, so these values hold until something changes them.'}
                        </span>
                      </p>
                    )}
                  </>)
                : isBudget
                  ? (<>
                    <div className="ptable budp"><div className="pthr"><span>Campaign</span><span>Market</span><span>Utilization</span><span>Current</span><span>New Budget</span></div>{preview.terms.map((t, i) => (<div className="ptr" key={i}><span className="term" title={t.term}>{t.term}</span><span>{t.marketplace ?? '—'}</span><span>{t.utilPct != null ? `${t.utilPct}%` : '—'}</span><span>{t.current != null ? `€${t.current.toFixed(2)}` : '—'}</span><span className={`newb ${t.clamped ? '' : t.proposed != null && t.current != null ? (t.proposed > t.current ? 'up' : t.proposed < t.current ? 'down' : '') : ''}`}>{t.proposed != null ? `€${t.proposed.toFixed(2)}` : '—'}{t.clamped ? <em className="pnote"> no change — guardrail</em> : null}</span></div>))}</div>
                    {preview.budget && (
                      <p className="pfoot">
                        {preview.budget.selected} selected · {preview.budget.measurable} with spend in the window · {preview.budget.inScope} in scope · <b>{preview.budget.matched} match</b>
                        {preview.budget.noChange > 0 ? <> · {preview.budget.noChange} of them sit at a guardrail, where this rule does nothing</> : null}
                      </p>
                    )}
                  </>)
                  : isHarvest
                  ? (<div className="ptable"><div className="pthr"><span>Search Term</span><span>Orders</span><span>Spend</span></div>{preview.terms.map((t, i) => (<div className="ptr" key={i}><span className="term" title={t.term}>{t.term}</span><span>{t.orders ?? '—'}</span><span>{t.spend != null ? `€${t.spend.toFixed(2)}` : '—'}</span></div>))}</div>)
                  : (<div className="ptable"><div className="pthr"><span>Search Term</span><span>Match</span><span>Clicks</span><span>Spend</span></div>{preview.terms.map((t, i) => (<div className="ptr" key={i}><span className="term" title={t.term}>{t.term}</span><span title={t.matchType}>{matchLabel(t.matchType)}</span><span>{t.clicks ?? '—'}</span><span>{t.spend != null ? `€${t.spend.toFixed(2)}` : '—'}</span></div>))}</div>)}
            </div>
          </div>
        </div>
      )}
      {tmpl && (
        <div className="h10-rb-prevback" onClick={() => setTmpl(null)}>
          <div className="h10-rb-tmpl-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={tmpl.mode === 'save' ? 'Save template' : 'Apply template'}>
            <div className="ph"><b>{tmpl.mode === 'save' ? 'Save as Template' : 'Apply Template'}</b><button type="button" onClick={() => setTmpl(null)} aria-label="Close"><X size={18} /></button></div>
            {tmpl.mode === 'save' ? (
              <div className="tmbody">
                <label htmlFor="tmpl-name">Template name</label>
                <Input id="tmpl-name" fieldClassName="h10-rb-input" value={tmplName} onChange={(e) => setTmplName(e.target.value)} placeholder="e.g. Scale winners — ACoS under 25%" aria-label="Template name" autoFocus />
                <p className="tmhint">Saves this rule’s criteria + budget action so you can reuse it on another rule.</p>
                <div className="tmfoot"><button type="button" className="h10-rb-btn ghost" onClick={() => setTmpl(null)}>Cancel</button><button type="button" className="h10-rb-create" disabled={!tmplName.trim()} onClick={saveTemplate}>Save Template</button></div>
              </div>
            ) : (
              <div className="tmbody">
                {/* BP.P5 — starter templates first (code-shipped archetypes), then the operator's
                    own saved ones. Both apply through the same path and stay fully editable. */}
                {(STARTER_TEMPLATES[slug] ?? []).length > 0 && (<>
                  <div className="tmgrp">Starter templates</div>
                  <div className="tmlist">{(STARTER_TEMPLATES[slug] ?? []).map((t) => (
                    <div className="tmrow" key={t.name}>
                      <span className="tmn" title={t.name}>{t.name}<em className="tmdesc">{t.desc}</em></span>
                      <button type="button" className="h10-rb-btn ghost sm" onClick={() => applyTemplate(t)}>Apply</button>
                    </div>
                  ))}</div>
                  <div className="tmgrp">Saved templates</div>
                </>)}
                {templates.length === 0 ? <div className="tmempty">No saved templates yet. Build a rule and choose &ldquo;Save Template&rdquo; to reuse it later.</div>
                  : <div className="tmlist">{templates.map((t) => (
                      <div className="tmrow" key={t.id}>
                        <span className="tmn" title={t.name}>{t.name}</span>
                        <button type="button" className="h10-rb-btn ghost sm" onClick={() => applyTemplate(t)}>Apply</button>
                      </div>
                    ))}</div>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── one source→target mapping block (the H2 two-panel + multi-block chrome). Harvest can have
//    several; Negative has one (isMulti false ⇒ no label / remove). ──
function MappingBlock({ block, setup, index, isMulti, popOpen, onTogglePop, onClosePop, onAdd, onRemoveGroup, onToggleLook, onToggleType, onRemoveBlock }: {
  block: MapBlock; setup: (typeof SETUP)[string]; index: number; isMulti: boolean; popOpen: boolean
  onTogglePop: () => void; onClosePop: () => void; onAdd: (items: AdGroupItem[]) => void
  onRemoveGroup: (id: string) => void; onToggleLook: (id: string) => void; onToggleType: (id: string, t: 'P' | 'E' | 'product') => void; onRemoveBlock: () => void
}) {
  const groups = block.groups
  return (
    <div className="h10-rb-card setup mapblock">
      <div className="h10-rb-card-h">
        {isMulti && <span className="mblabel">Ad Group Mapping {index + 1}</span>}
        <b>{groups.length} Ad Groups</b>
        <span className="grow" />
        <div className="addwrap">
          <button type="button" className="h10-rb-btn primary" onClick={onTogglePop}><Plus size={14} /> Add Group</button>
          {popOpen && <AddGroupPopover selectedIds={new Set(groups.map((g) => g.id))} onAdd={onAdd} onClose={onClosePop} />}
        </div>
        {isMulti && <button type="button" className="mbrm" onClick={onRemoveBlock} aria-label={`Remove mapping ${index + 1}`}><Trash2 size={16} /></button>}
      </div>
      <div className="h10-rb-twocol">
        <div className="col">
          <div className="colh">What Ad Groups would you like included in this rule?</div>
          <div className="subh"><span>Ad Group</span><span className="muted">Look for Search Terms in These Ad Groups <Info size={13} /></span></div>
          {groups.length === 0 ? (
            <div className="empty"><div className="ill"><MousePointerClick size={26} /></div><div className="t">Add an Ad Group</div><div className="d">Start by adding related ad groups<br />to this rule</div></div>
          ) : (
            <div className="h10-rb-agrows">{groups.map((g) => (
              <div className="agrow" key={g.id}>
                <span className="nm"><b title={g.name}>{g.name}</b>{g.campaignName && <span className="camp" title={g.campaignName}>{g.campaignName}</span>}</span>
                <Checkbox className="look" checked={g.look} onChange={() => onToggleLook(g.id)} aria-label={`Look for search terms in ${g.name}`} />
              </div>
            ))}</div>
          )}
        </div>
        <div className="col">
          <div className="colh">What targets would you like created?</div>
          <div className="subh r"><span className="muted">{setup.targetsTitle}</span><span className="mts">{setup.matchTypes.map((m) => (<HoverCard key={m.key} text={m.tip} placement="above"><span className="mt">{m.product ? <Package size={15} /> : m.key}</span></HoverCard>))}</span></div>
          {groups.length === 0 ? (
            <div className="empty"><div className="ill"><Check size={24} /></div><div className="t">Create a New Target</div><div className="d">Select the type of target you want<br />to create with the search term</div></div>
          ) : (
            <div className="h10-rb-agrows">{groups.map((g) => (
              <div className="agrow tgt" key={g.id}>
                <span className="chips">{setup.matchTypes.map((m) => { const k = m.key as 'P' | 'E' | 'product'; return (<HoverCard key={m.key} text={m.tip} placement="above"><button type="button" className={`tchip ${g.types[k] ? 'on' : ''}`} aria-pressed={g.types[k]} onClick={() => onToggleType(g.id, k)}>{m.product ? <Package size={14} /> : m.key}</button></HoverCard>) })}</span>
                <button type="button" className="agrm" onClick={() => onRemoveGroup(g.id)} aria-label={`Remove ${g.name}`}><X size={15} /></button>
              </div>
            ))}</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── "Add Ad Group to Rule" popover — real data: 4 tabs (Ad Groups flat · Campaigns grouped ·
//    Portfolios grouped · Products) + Campaign/Ad-Group status filters + search + Add All / +Add. ──
const AG_STATUS = [{ value: 'ENABLED', label: 'Enabled' }, { value: 'PAUSED', label: 'Paused' }, { value: 'ARCHIVED', label: 'Archived' }, { value: '', label: 'All' }]
const statusPill = (s: string) => <span className={`st ${s === 'ENABLED' ? 'ok' : s === 'PAUSED' ? 'warn' : 'arch'}`}>{s === 'ENABLED' ? 'Enabled' : s === 'PAUSED' ? 'Paused' : 'Archived'}</span>

function AddGroupPopover({ selectedIds, onAdd, onClose }: { selectedIds: Set<string>; onAdd: (items: AdGroupItem[]) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', h)
    document.addEventListener('keydown', k)
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k) }
  }, [onClose])
  const TABS = ['Ad Groups', 'Campaigns', 'Portfolios', 'Products']
  const [tab, setTab] = useState('Ad Groups')
  const [all, setAll] = useState<AdGroupItem[]>([])
  const [portfolios, setPortfolios] = useState<Array<{ id: string; name: string }>>([])
  /** HP3 — product lines WITH their campaigns, for the Products tab (was a "coming soon" stub). */
  const [lines, setLines] = useState<Array<{ id: string; sku: string; name: string; campaigns: string[] }>>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [campStatus, setCampStatus] = useState('ENABLED')
  const [agStatus, setAgStatus] = useState('ENABLED')
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [a, p, sj] = await Promise.all([
          fetch(`${getBackendUrl()}/api/advertising/ad-groups?limit=3000`).then((r) => r.json()).catch(() => ({ items: [] })),
          fetch(`${getBackendUrl()}/api/advertising/portfolios`).then((r) => r.json()).catch(() => ({ items: [] })),
          // HP3 — the SAME payload CampaignSection's Products tab reads (`/advertising/
          // scope-options` carries each product line WITH its campaigns); a failure leaves the
          // tab saying so, never taking the ad-group list down with it.
          fetch(`${getBackendUrl()}/api/advertising/scope-options`).then((r) => r.json()).catch(() => ({})),
        ])
        if (!alive) return
        setAll((a.items ?? []) as AdGroupItem[])
        const praw = (a && (p.items ?? p) || []) as Array<{ id: string | number; name?: string }>
        setPortfolios((Array.isArray(praw) ? praw : []).map((x) => ({ id: String(x.id), name: String(x.name ?? x.id) })))
        const lraw = (sj?.productLines ?? []) as Array<{ id: string; sku: string; name: string; campaigns?: string[] }>
        setLines((Array.isArray(lraw) ? lraw : []).filter((l) => Array.isArray(l.campaigns) && l.campaigns.length).map((l) => ({ id: l.id, sku: l.sku, name: l.name, campaigns: l.campaigns as string[] })))
      } finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [])
  const ql = q.trim().toLowerCase()
  const filtered = all.filter((g) =>
    (!campStatus || g.campaignStatus === campStatus) && (!agStatus || g.status === agStatus) &&
    (!ql || g.name.toLowerCase().includes(ql) || (g.campaignName ?? '').toLowerCase().includes(ql)))
  const fresh = (items: AdGroupItem[]) => items.filter((g) => !selectedIds.has(g.id))
  const renderRow = (g: AdGroupItem) => {
    const added = selectedIds.has(g.id)
    return (
      <div className="row" key={g.id}>
        <Checkbox checked={added} onChange={() => onAdd([g])} aria-label={`Add ${g.name}`} disabled={added} />
        <span className="nm" title={g.name}>{g.name}</span>
        {statusPill(g.status)}
        <button type="button" className="add" disabled={added} onClick={() => onAdd([g])}>{added ? <><Check size={12} /> Added</> : <><Plus size={12} /> Add</>}</button>
      </div>
    )
  }
  const byKey = (keyOf: (g: AdGroupItem) => string, nameOf: (g: AdGroupItem) => string) => {
    const m = new Map<string, { name: string; items: AdGroupItem[] }>()
    for (const g of filtered) { const k = keyOf(g); if (!m.has(k)) m.set(k, { name: nameOf(g), items: [] }); m.get(k)!.items.push(g) }
    return [...m.values()]
  }
  const groups = tab === 'Campaigns' ? byKey((g) => g.campaignId, (g) => g.campaignName ?? '—')
    : tab === 'Portfolios' ? byKey((g) => g.portfolioId ?? '__none', (g) => (g.portfolioId ? (portfolios.find((p) => p.id === g.portfolioId)?.name ?? g.portfolioId) : 'No Portfolio'))
    : tab === 'Products' ? lines
      .filter((l) => !ql || l.name.toLowerCase().includes(ql) || l.sku.toLowerCase().includes(ql))
      .map((l) => ({ name: `${l.name || l.sku} · ${l.sku}`, items: all.filter((g) => l.campaigns.includes(g.campaignId) && (!campStatus || g.campaignStatus === campStatus) && (!agStatus || g.status === agStatus)) }))
      .filter((grp) => grp.items.length)
    : null
  return (
    <div className="h10-rb-agpop" ref={ref} role="dialog" aria-label="Add Ad Group to Rule">
      <div className="t">Add Ad Group to Rule</div>
      <div className="srch"><Search size={14} /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === 'Products' ? 'Search for a product title or SKU' : 'Search'} aria-label={tab === 'Products' ? 'Search products' : 'Search ad groups'} /></div>
      <div className="tabs">{TABS.map((t) => <button key={t} type="button" className={t === tab ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}</div>
      <div className="filters">
        <div className="f"><label>Campaign Status</label><Listbox width={150} options={AG_STATUS} value={campStatus} onChange={setCampStatus} ariaLabel="Campaign status" /></div>
        <div className="f"><label>Ad Groups Status</label><Listbox width={150} options={AG_STATUS} value={agStatus} onChange={setAgStatus} ariaLabel="Ad groups status" /></div>
        <button type="button" className="addall"
          disabled={tab === 'Products' ? !fresh((groups ?? []).flatMap((g) => g.items)).length : !fresh(filtered).length}
          onClick={() => onAdd(tab === 'Products' ? fresh((groups ?? []).flatMap((g) => g.items)) : fresh(filtered))}>Add All</button>
      </div>
      <div className="list">
        {loading ? <div className="agpop-msg">Loading…</div>
          : tab === 'Products' && (!groups || groups.length === 0) ? <div className="agpop-msg">{lines.length ? 'No products match.' : 'No product lines are mapped to campaigns yet.'}</div>
          : filtered.length === 0 && tab !== 'Products' ? <div className="agpop-msg">No ad groups match.</div>
          : groups ? groups.map((grp, i) => (
              <div className="grp" key={i}>
                <div className="grph"><span className="gn" title={grp.name}>{grp.name}</span><button type="button" className="add" disabled={!fresh(grp.items).length} onClick={() => onAdd(fresh(grp.items))}><Plus size={12} /> Add</button></div>
                {grp.items.map((g) => renderRow(g))}
              </div>
            ))
          : filtered.map((g) => renderRow(g))}
      </div>
    </div>
  )
}

// ── B1: inline campaign picker for the Budget rule's "Budget Rule Setup" (left searchable list
//    with status filter + Add All + pager; right "N Campaigns Added" panel). Data from
//    GET /advertising/campaigns; live dailyBudget is carried through for the B4 preview. ──
/*
 * ⛔ The private `CampaignPicker` that stood here (and its `prodShort` / `toBudgetCampaign` helpers)
 * was DELETED on 2026-08-18, on operator instruction: "use the shared component … so I will simply
 * make changes to one, and it will be implemented on all the pages."
 *
 * It was a near-copy of `_schedule/CampaignSection.tsx` that had drifted: no Portfolios tab, no
 * Products tab, and a plain substring search instead of the ranked matcher — so the same control
 * behaved differently depending on which rule you were writing, and every change had to be made in
 * two places. This builder now renders `CampaignSection` directly (see the Setup section above).
 * Do not reintroduce a local picker: add a prop to the shared one.
 */
