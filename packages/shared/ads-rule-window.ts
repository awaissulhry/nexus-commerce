/**
 * ads-rule-window.ts — WHERE AN ADS RULE'S NUMBERS COME FROM.
 *
 * B2 (2026-08-20). The operator's study of Helium 10's Bid tab lists a **Lookback Period** column:
 * "the exact window of historical time the rule is allowed to look at… wired to Amazon's
 * Advertising API — it tells the ingestion engine how far back to pull historical performance
 * metrics before running your If/Then conditions."
 *
 * 🔴 **Nexus has no such field.** `AutomationRule` stores no lookback. The window is decided in two
 * other places entirely, and this module is the one place that knows both:
 *
 *   ① the TRIGGER — `advertising-rule-evaluator.job.ts` builds one context list per trigger, and
 *     each builder hard-codes its own window. That query is what decides which campaigns, keywords
 *     or search terms a rule is even shown, so it IS the lookback for most rules.
 *   ② the ACTION — two handlers re-query on their own window and ignore the trigger's:
 *     `bid_to_target_acos` (ads-bid-optimizer.service.ts) and `defend_top_of_search`
 *     (ads-top-of-search.service.ts, the only one that already takes `windowDays` as a parameter).
 *
 * ⚠ **This file is the SOURCE, not a copy of one.** The evaluator and the bid optimiser import
 * `TRIGGER_WINDOW` / `ACTION_WINDOW` and pass the numbers to `ruleWindowBounds`; editing a number
 * here changes what the engine reads. That is deliberate and it is the whole point: a table of
 * window sizes that no executor reads is [[reference_fleet_stale_constant_class]] — a surface
 * rendering what nothing obeys — and this section has shipped that bug more than once. If you
 * split this into "the numbers the UI shows" and "the numbers the engine uses", you have
 * reintroduced it. **Grep for a reader before trusting any constant, including this one.**
 *
 * Nothing here changes behaviour on the day it ships: every number below is the number that was
 * already inline at the call site it replaces, transcribed and then diffed against it.
 */

import { PROVISIONAL_DAYS } from './data-vintage.js'

/**
 * How a rule gets the numbers it decides on. Not every rule reads a window, and the three
 * non-window cases are the ones worth naming rather than rounding off to a number:
 *
 * · `window`   — a real N-day span of `AmazonAdsDailyPerformance`.
 * · `compare`  — N days against the N before them (week-over-week). The lookback is 2N, but
 *                saying "14 days" would hide that the halves are compared, not summed.
 * · `stored`   — the rule reads `Campaign.spend` / `.sales` / `.acos`, which the sync writes over
 *                an **unlabelled** window ([[reference_ads_campaigns_payload_already_has_it]] —
 *                measured as roughly 30 days, but the column does not say so and nothing pins it).
 * · `snapshot` — the latest reading, not a span (keyword rank).
 * · `none`     — the rule reads NO performance data before acting.
 */
export type RuleWindowKind = 'window' | 'compare' | 'stored' | 'snapshot' | 'none'

export interface RuleWindowSpec {
  kind: RuleWindowKind
  /** days of history read; null where `kind` is stored / snapshot / none */
  days: number | null
  /**
   * True when the window is built by `ruleWindowBounds`, which drops the last
   * `PROVISIONAL_DAYS` because Amazon is still attributing conversions to them.
   *
   * 🔴 False is not a rounding detail. A window that includes D-0 is measuring a day that is
   * still being written: today's partial spend against today's not-yet-attributed sales makes
   * every rule read the account as less profitable than it is, right at the moment it decides
   * whether to cut a bid.
   */
  settled: boolean
  /** the file and constant that actually holds this, so a reader can go and check */
  source: string
  /**
   * A condition the window depends on that is NOT visible in the number. Appended to the
   * tooltip verbatim. Exists because of `bid_to_target_acos`: it declares 30 days and, on the
   * default metric source, reads none of them.
   */
  caveat?: string
  /**
   * P1 — set when the rule's own `action.windowDays` OVERRIDES `days`.
   *
   * `clamp` records the bounds **the handler applies**, and is omitted where the handler applies
   * none. That asymmetry is deliberate: `defend_top_of_search` clamps 7–90 in
   * `automation-action-handlers.ts`, `harvest_and_negate` clamps nothing, and writing a clamp here
   * that the handler does not enforce would make this cell describe a rule the engine does not run.
   */
  tunable?: { clamp?: readonly [number, number] }
}

/**
 * `defend_top_of_search` clamps whatever it is given; stated here so a caller can label it, and
 * declared above `ACTION_WINDOW` because the entry itself now reads them.
 */
export const TOS_WINDOW_MIN = 7
export const TOS_WINDOW_MAX = 90

/**
 * BP.P4 — the bounds of a Bid rule's own lookback (`actions[0].windowDays`), enforced by BOTH
 * readers: the KEYWORD_HIGH_ACOS context emitter and `targetPerformance` (computed bid ops).
 * Declared here so the grid's Lookback cell, the builder's select and the engine agree.
 */
export const BID_WINDOW_MIN = 7
export const BID_WINDOW_MAX = 90

/**
 * P1 — the thresholds `harvest_and_negate` falls back to when a rule sets none of its own.
 *
 * 🔴 These are the **handler's** defaults (`automation-action-handlers.ts`), which imports them
 * from here, and they are NOT the harvest service's. `previewHarvest` defaults `minSpendCents` to
 * **1500** (€15) where every rule negates at €10. The nightly cron that ran the €15 path bare
 * was retired in HP5 (2026-08-21); the €15 fallback now binds only read-only previews.
 *
 * Exported so the Rules grid can say what binds a rule that states nothing, instead of printing
 * "Always" — the fabricated-cell class this section has shipped three times
 * ([[reference_fleet_stale_constant_class]]).
 */
export const HARVEST_DEFAULTS = { windowDays: 60, minSpendCents: 1000, minOrders: 2 } as const

/**
 * NEG-P3 — the SEARCH_TERM_WASTING emitter's floor, declared ONCE. Three readers: the
 * evaluator's context builder (the floor itself), the builder's window note (the sentence that
 * states it), and the Negative Targeting strip (the candidate count an operator sees). Before
 * this the numbers lived as literals in the evaluator, and any copy stating them was one edit
 * away from lying.
 */
export const WASTING_FLOOR = { minSpendCents: 300, minClicks: 5, topPerTick: 300 } as const

/** Amazon's still-settling tail, re-exported so a caller needs one import to explain a window. */
export { PROVISIONAL_DAYS }

const W = (days: number, source: string, settled = true): RuleWindowSpec => ({ kind: 'window', days, settled, source })

/**
 * Every advertising trigger, and the window its context builder reads.
 *
 * Transcribed from `advertising-rule-evaluator.job.ts` on 2026-08-20 and then imported BY it, so
 * the two cannot drift. The `settled` flag records which builders go through `ruleWindowBounds`
 * and which hand-roll `Date.now() - Nd`; three do the latter and therefore include today.
 */
export const TRIGGER_WINDOW: Record<string, RuleWindowSpec> = {
  // ── settled windows (ruleWindowBounds) ────────────────────────────────────────────────────
  AD_TARGET_UNDERPERFORMING: W(14, 'buildUnderperformContexts'),
  CAMPAIGN_PERFORMANCE_BUDGET: W(7, 'BUDGET_RULE_WINDOW_DAYS'),
  KEYWORD_ZERO_IMPRESSIONS: W(7, 'buildZeroImpressionContexts'),
  KEYWORD_LOW_CTR: W(14, 'buildLowCtrContexts'),
  KEYWORD_WASTED_SPEND: W(14, 'buildWastedKeywordContexts'),
  SEARCH_TERM_CONVERTING: W(30, 'buildSearchTermConvertingContexts'),
  SEARCH_TERM_WASTING: W(30, 'buildSearchTermWastingContexts'),
  KEYWORD_HIGH_ACOS: W(14, 'buildHighAcosKeywordContexts'),
  KEYWORD_SCALE_OPPORTUNITY: W(14, 'buildScaleOpportunityContexts'),
  AD_GROUP_UNDERPERFORMING: W(14, 'buildAdGroupUnderperformContexts'),
  NEW_TO_BRAND_WINNER: W(14, 'buildNewToBrandWinnerContexts'),
  CAMPAIGN_NO_SALES: W(30, 'buildCampaignNoSalesContexts'),

  // ── week-over-week comparisons, and NOT settled: each hand-rolls its own date maths and
  //    therefore counts today's partial day in the recent half ────────────────────────────────
  CVR_DROP: { kind: 'compare', days: 7, settled: false, source: 'buildCvrDropContexts' },
  CAMPAIGN_ROAS_DECLINING: { kind: 'compare', days: 7, settled: false, source: 'buildCampaignRoasDecliningContexts' },
  KEYWORD_RISING_STAR: { kind: 'compare', days: 7, settled: false, source: 'buildRisingStarContexts' },

  // ── no window of their own ────────────────────────────────────────────────────────────────
  /** Selected off `Campaign.acos` / `.spend`, the stored columns. Their window is whatever the
   *  sync last wrote and the column does not record it. */
  CAC_SPIKE: { kind: 'stored', days: null, settled: false, source: 'buildCacSpikeContexts' },
  /** Same stored columns, plus a 30-day profit aggregate that also hand-rolls its dates. */
  AD_SPEND_PROFITABILITY_BREACH: { kind: 'stored', days: 30, settled: false, source: 'PROFITABILITY_WINDOW_DAYS' },
  /** Latest rank reading per keyword; its spend/ACOS side rides the 30-day `targetPerfMap`. */
  KEYWORD_RANK_BID: { kind: 'snapshot', days: 30, settled: true, source: 'buildKeywordRankBidContexts' },
  /**
   * 🔴 SOV-P1 (2026-08-22) — moved from `W(30, …)` to a SNAPSHOT, because it stopped being a span.
   *
   * The old entry declared 30 settled days. That was true of `targetPerfMap` (which does go through
   * `ruleWindowBounds`) and FALSE of the share itself: `analyzeShareOfVoice` built `gte: now − 30d`
   * with no upper bound and never called `ruleWindowBounds`, so the number the trigger is named
   * after included the two days Amazon is still attributing. A `settled: true` covering both halves
   * is the kind of averaged half-truth this table exists to stop.
   *
   * The share now comes from Amazon's own weekly search-query report, gated to the most recent
   * COMPLETE week per market (`ads-sov-keyword-share.service.ts` → `chooseViewPeriod`). That is a
   * reading, not a span, and its age is Amazon's publishing cadence rather than a constant — which
   * is exactly what `snapshot` means here. `days: 30` continues to describe the spend/ACoS side.
   */
  SOV_BID: { kind: 'snapshot', days: 30, settled: true, source: 'keywordMarketShares + targetPerfMap via buildSovBidContexts' },
  /** Stock ageing, not advertising performance. */
  FBA_AGE_THRESHOLD_REACHED: { kind: 'none', days: null, settled: false, source: 'buildFbaAgeContexts' },
  /**
   * 🔴 The one that matters most, because it is the commonest trigger in the account (23 of 51
   * rules on 2026-08-20). A SCHEDULE context carries month-to-date spend and NOTHING else — no
   * campaign, no keyword, no window. Whatever a SCHEDULE rule reads, it reads inside its action.
   * So the honest Lookback of a SCHEDULE rule is its ACTION's, and where the action has none
   * either, the honest answer is that the rule reads no performance data at all.
   */
  SCHEDULE: { kind: 'none', days: null, settled: false, source: 'scheduleContexts (marketplace + monthlySpendCents)' },
}

/**
 * Actions that re-query on a window of their own, overriding whatever the trigger selected on.
 *
 * Three exist (P1 added the third — `harvest_and_negate`, which had been re-querying inside
 * `previewHarvest` since long before this table did). Every other handler acts on the entity the
 * context handed it and does no reading — `bid_up`, `bid_down`, `lower_bid_to_floor` and
 * `raise_bids_for_rank_defense` all take the entity id and write, so their lookback is the
 * trigger's, or nothing.
 *
 * ⚠ Adding an entry here CHANGES WHAT THE GRID SAYS about every rule carrying that action, on
 * every tab, because `ruleLookback` prefers the first action that has a window over the trigger.
 * Before adding one, confirm the handler really re-queries; an action that merely accepts a
 * `windowDays` it never uses belongs in neither table.
 */
export const ACTION_WINDOW: Record<string, RuleWindowSpec> = {
  /**
   * 🔴 30 days, and NOT settled — `ads-bid-optimizer.service.ts` builds its own
   * `Date.now() - 30d` instead of calling `ruleWindowBounds`, so unlike all thirteen settled
   * triggers above it counts D-0 and D-1. Four of the eighteen bid rules compute their bids
   * this way, three of them at AUTO. Flagged rather than silently fixed: changing it moves live
   * bids, which is a decision, not a tidy-up.
   */
  bid_to_target_acos: {
    kind: 'window', days: 30, settled: false,
    source: 'ads-bid-optimizer.service.ts DAILY_WINDOW_DAYS',
    /**
     * 🔴 The window is declared, and on the default source it is not read.
     * `previewBidOptimization` takes its per-target metrics from `resolveSource()`, which
     * defaults to `legacy` — the `AdTarget.spendCents/.clicks/.salesCents/.ordersCount` columns,
     * whose only writer (`ads-metrics-ingest`) was retired in H.2e and has never run since. The
     * rule handler calls it with no explicit source, so unless `NEXUS_BID_OPTIMIZER_SOURCE=daily`
     * is set, the 30 days below are never queried and the rule computes from nothing.
     * ([[reference_four_inert_ads_rules]] — read `actionResults`, never `status`.)
     */
    caveat: 'This window is only read when the bid optimiser’s metric source is the daily performance table. Its default source (`legacy`) reads per-target columns that no job has written since H.2e, so unless NEXUS_BID_OPTIMIZER_SOURCE=daily is set on the API, this rule computes from no data at all — and still reports success.',
  },
  /** The only window an operator can already set: `action.windowDays`, clamped 7–90, default 30. */
  defend_top_of_search: {
    kind: 'window', days: 30, settled: false, source: 'ads-top-of-search.service.ts analyzeTopOfSearch',
    tunable: { clamp: [TOS_WINDOW_MIN, TOS_WINDOW_MAX] },
  },
  /**
   * 🔴 P1 — the entry whose ABSENCE made the Keyword Harvest tab lie twice over.
   *
   * `harvest_and_negate` re-queries `AmazonAdsSearchTerm` inside `previewHarvest` over
   * `action.windowDays`, so it belongs here beside the other two re-queriers. Without it, a
   * SCHEDULE harvest rule fell through to `TRIGGER_WINDOW.SCHEDULE` and the grid printed **"None"**
   * under a tooltip insisting the rule "is handed no performance data at all" — on three rules
   * reading 60, 60 and 30 days (measured on prod 2026-08-20).
   *
   * And because `ruleLookback` takes *the first action that HAS a window*, a rule carrying both
   * `bid_to_target_acos` and `harvest_and_negate` skipped the harvest half and reported **the bid
   * optimiser's 30-day unsettled window on the Keyword Harvest tab** — the exact cross-tab leak
   * the `tabKey` ordering exists to prevent, defeated by a missing map entry rather than by the
   * ordering. One entry closes both.
   *
   * `settled: false` is not an oversight: `previewHarvest` builds `Date.now() - windowDays * 86400e3`
   * directly and never calls `ruleWindowBounds`, so unlike `SEARCH_TERM_CONVERTING` — the OTHER
   * harvest path — it counts the days Amazon is still attributing. The two harvest engines disagree
   * about this, and the cell now says so instead of averaging them (HV-R plan P6).
   */
  harvest_and_negate: {
    kind: 'window', days: HARVEST_DEFAULTS.windowDays, settled: false,
    source: 'automation-action-handlers.ts harvest_and_negate → ads-harvest.service.ts previewHarvest',
    tunable: {},
    caveat: 'The other harvest path, `promote_to_exact` on SEARCH_TERM_CONVERTING, reads 30 settled days through ruleWindowBounds. Two engines, two windows, two latency policies — a rule carrying both harvests twice over different spans.',
  },
  /**
   * BP.P4 — a builder Bid rule's lookback is ITS OWN (`actions[0].windowDays`, the builder's
   * "Lookback period" select), defaulting to the KEYWORD_HIGH_ACOS trigger's 14 settled days.
   *
   * The key is the builder SLUG, because that is the action type a stored builder rule carries
   * (`actions[0].type = 'bid'`) — the grid reads STORED actions, never the translation. Both
   * engine readers honour the same number: the context emitter builds this rule's contexts over
   * its window (`advertising-rule-evaluator.job.ts`, per-window passes), and `targetPerformance`
   * measures computed ops (Set to CPC · the two ratio actions · Revenue per Click) over it.
   * Settled: both readers go through `ruleWindowBounds`, which drops the two attributing days.
   */
  bid: {
    kind: 'window', days: 14, settled: true,
    source: 'advertising-rule-evaluator.job.ts buildHighAcosKeywordContexts + targetPerformance (both via ruleWindowBounds)',
    tunable: { clamp: [BID_WINDOW_MIN, BID_WINDOW_MAX] },
  },
  /**
   * BUD-P3 — a builder Budget rule may choose its own lookback (Advanced Settings, 7–90,
   * default = the trigger's 7). Same mechanism as `bid`: per-window context passes in the
   * evaluator, and the grid's Lookback cell reads this entry's tunable clamp.
   */
  budget: {
    kind: 'window', days: 7, settled: true,
    source: 'advertising-rule-evaluator.job.ts buildCampaignBudgetContexts (via ruleWindowBounds)',
    tunable: { clamp: [BID_WINDOW_MIN, BID_WINDOW_MAX] },
  },
  /**
   * PLC-P5 — a builder Placement rule may choose its own lookback, exactly as Budget may.
   *
   * Same trigger, same contexts, same clamp: Placement and Budget are both
   * `CAMPAIGN_PERFORMANCE_BUDGET` and both read `buildCampaignBudgetContexts`, so one mechanism
   * serves both and the evaluator's per-window helper now tests for either slug.
   *
   * 🔴 The absence of this entry was a two-sided lie. The grid's Lookback cell fell through to the
   * trigger and printed a flat "7 days" for every placement rule — true only while no placement
   * rule could choose otherwise — and the evaluator's `budgetRuleWindow` tested
   * `a0.type !== 'budget'`, so a `windowDays` stored on a placement rule was read by nobody. The
   * builder never offered the control, which is the only reason that never became a live defect.
   *
   * It matters more here than on Budget. A placement rule's criteria are campaign-wide today, but
   * PLC-P7's lane-scoped criteria are measured per campaign×lane, and over 7 days only 16 of 122
   * campaign×lane cells clear 20 clicks against 51 of 123 over 30 (measured 2026-08-22). Without a
   * widenable window a lane-scoped rule cannot be evidenced at all.
   */
  placement: {
    kind: 'window', days: 7, settled: true,
    source: 'advertising-rule-evaluator.job.ts buildCampaignBudgetContexts (via ruleWindowBounds)',
    tunable: { clamp: [BID_WINDOW_MIN, BID_WINDOW_MAX] },
  },
}

export interface RuleLookback extends RuleWindowSpec {
  /** the Lookback cell, ~12 characters: "14 days" · "30 days" · "None" · "Unlabelled" */
  label: string
  /** the whole truth, for the cell's tooltip — names the trigger's part AND the action's */
  why: string
  /** true when the answer came from the action rather than the trigger */
  fromAction: boolean
}

const dayWord = (n: number) => `${n} day${n === 1 ? '' : 's'}`

/**
 * What window does THIS rule read?
 *
 * The action wins when it has one, because an action that re-queries is where the numbers the
 * rule acts on actually come from — the trigger only decided which rows it was offered. When they
 * differ, `why` states both, so the cell is short and the tooltip is complete.
 *
 * `actionTypes` should be the rule's actions in order; the first one carrying its own window wins.
 * Passing the tab's own action (rather than `actions[0]`) is what keeps a multi-action rule
 * describing the right half of itself on each tab — the same rule the Criteria cell follows.
 */
export function ruleLookback(trigger: string, actionTypes: string[] = [], actionWindowDays?: number | null): RuleLookback {
  const t = TRIGGER_WINDOW[trigger]
  const actType = actionTypes.find((a) => ACTION_WINDOW[a])
  const a = actType ? ACTION_WINDOW[actType] : undefined

  if (a) {
    /**
     * A tunable action carries its own `windowDays`; honour it, clamped exactly as ITS handler
     * clamps and not otherwise.
     *
     * 🔴 P1 generalised this off the literal `actType === 'defend_top_of_search'`. That test was
     * correct for one action and silently wrong for the second: `harvest_and_negate` stores
     * `windowDays` 60 or 30 per rule, and under the old test every harvest rule would have
     * rendered the table's default rather than the number the engine actually reads. The rule that
     * decides is now the entry's own `tunable`, so adding a third re-querying action needs no edit
     * here — which is the point, because the previous shape needed one and did not get it.
     */
    const days = a.tunable && typeof actionWindowDays === 'number'
      ? (a.tunable.clamp
        ? Math.max(a.tunable.clamp[0], Math.min(a.tunable.clamp[1], actionWindowDays))
        : actionWindowDays)
      : a.days
    const spec: RuleWindowSpec = { ...a, days }
    return {
      ...spec,
      label: days == null ? 'None' : dayWord(days),
      fromAction: true,
      why: [
        `This rule computes from the last ${days} days of Amazon performance data — the window ${actType} reads, not the trigger's.`,
        spec.settled
          ? `The most recent ${PROVISIONAL_DAYS} days are excluded because Amazon is still attributing conversions to them.`
          : `⚠ This window INCLUDES the last ${PROVISIONAL_DAYS} days, which Amazon is still attributing conversions to — unlike most triggers, which drop them. Today's partial spend is measured against sales that have not landed yet.`,
        spec.caveat ?? '',
        /**
         * 🔴 P1 — `true` because the ACTION supplied this window, and the trigger's own sentence
         * has to be phrased as a contribution rather than as a verdict.
         *
         * `describeTrigger('SCHEDULE', …)` reads "🔴 It runs on the clock and is handed no
         * performance data at all… Nothing in this rule reads campaign or keyword history before
         * it acts." That is true of a SCHEDULE rule whose action reads nothing, and flatly FALSE
         * of one whose action re-queries — which is most of them. Appended verbatim, it produced a
         * tooltip that said "computes from the last 60 days of Amazon performance data" and "is
         * handed no performance data at all" in the same paragraph.
         *
         * Not a harvest bug: 23 of 51 rules are SCHEDULE-triggered and every one of them carrying
         * `bid_to_target_acos` or `defend_top_of_search` has been contradicting itself since B2.
         * Caught by the harvest test, fixed for all three.
         */
        t ? describeTrigger(trigger, t, true) : '',
        `Source: ${spec.source}.`,
      ].filter(Boolean).join(' '),
    }
  }

  if (!t) {
    return {
      kind: 'none', days: null, settled: false, source: 'unmapped trigger', fromAction: false,
      label: 'Unknown',
      why: `“${trigger}” has no entry in TRIGGER_WINDOW, so this page cannot say what window it reads. That is a gap in the map, not a rule that reads nothing — add it to packages/shared/ads-rule-window.ts.`,
    }
  }

  const label = t.kind === 'window' ? dayWord(t.days as number)
    // "7 days ×2" reads as a multiplier on the window; the halves are COMPARED, not summed.
    : t.kind === 'compare' ? `${t.days} vs prior ${t.days}`
    : t.kind === 'snapshot' ? 'Latest'
    : t.kind === 'stored' ? 'Unlabelled'
    : 'None'

  return {
    ...t,
    label,
    fromAction: false,
    why: `${describeTrigger(trigger, t)} Source: ${t.source}.`,
  }
}

/**
 * One sentence about what the trigger's own query looks at.
 *
 * `actionSuppliesWindow` is set when an ACTION has already supplied the window, and it changes
 * only the `none` case — where the difference is between "this rule reads nothing" (a verdict on
 * the whole rule) and "the trigger contributes nothing" (a fact about one half of it). Getting
 * that wrong put two contradictory sentences in one tooltip; see the call site.
 */
function describeTrigger(trigger: string, t: RuleWindowSpec, actionSuppliesWindow = false): string {
  if (t.kind === 'none' && actionSuppliesWindow) {
    return trigger === 'SCHEDULE'
      ? 'Its trigger adds nothing to that: a SCHEDULE context carries only the marketplace and its month-to-date spend, so the window above is entirely the action\'s doing and no campaign or keyword was pre-selected before it ran.'
      : 'Its trigger selects on no performance data, so the window above is entirely the action\'s doing.'
  }
  switch (t.kind) {
    case 'window':
      return `It is offered rows selected over the last ${t.days} days${t.settled ? `, excluding the ${PROVISIONAL_DAYS} most recent days while Amazon is still attributing conversions to them` : ` — a window that INCLUDES the ${PROVISIONAL_DAYS} still-settling days`}.`
    case 'compare':
      return `It compares the last ${t.days} days against the ${t.days} before them, so it reads ${(t.days as number) * 2} days in two halves rather than one span. ⚠ The recent half includes today, which is still being written.`
    case 'stored':
      return `It is selected off the stored campaign columns (spend · sales · ACoS), whose window the sync does not record${t.days ? `, alongside a ${t.days}-day profit aggregate` : ''} — so how far back this rule looks is not a number this system knows.`
    case 'snapshot':
      // Two triggers are snapshots and they snapshot different things. Branching on the trigger is
      // the same move the `none` case makes for SCHEDULE: one sentence for two readings would have
      // to say "rank" on a rule that reads a market share.
      return trigger === 'SOV_BID'
        ? `Share of Voice is a reading rather than a span — Amazon's most recent COMPLETE weekly search-query report for each market, so how old it is depends on when Amazon last published one, and a market with no complete week is skipped rather than measured on a partial one. The spend and ACoS beside it cover ${t.days} days.`
        : `Rank is the latest reading rather than a span; the spend and ACoS beside it cover ${t.days} days.`
    case 'none':
      return trigger === 'SCHEDULE'
        ? '🔴 It runs on the clock and is handed no performance data at all — only the marketplace and its month-to-date spend. Nothing in this rule reads campaign or keyword history before it acts.'
        : 'It reads no advertising performance data before acting.'
  }
}
