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
}

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
  SOV_BID: W(30, 'targetPerfMap via buildSovBidContexts'),

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
 * Only two exist. Every other handler acts on the entity the context handed it and does no
 * reading — `bid_up`, `bid_down`, `lower_bid_to_floor` and `raise_bids_for_rank_defense` all
 * take the entity id and write, so their lookback is the trigger's, or nothing.
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
  defend_top_of_search: { kind: 'window', days: 30, settled: false, source: 'ads-top-of-search.service.ts analyzeTopOfSearch' },
}

/** `defend_top_of_search` clamps whatever it is given; stated here so a caller can label it. */
export const TOS_WINDOW_MIN = 7
export const TOS_WINDOW_MAX = 90

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
    // `defend_top_of_search` can carry its own `windowDays`; honour it, clamped as the handler does.
    const days = actType === 'defend_top_of_search' && typeof actionWindowDays === 'number'
      ? Math.max(TOS_WINDOW_MIN, Math.min(TOS_WINDOW_MAX, actionWindowDays))
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
        t ? describeTrigger(trigger, t) : '',
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

/** One sentence about what the trigger's own query looks at. */
function describeTrigger(trigger: string, t: RuleWindowSpec): string {
  switch (t.kind) {
    case 'window':
      return `It is offered rows selected over the last ${t.days} days${t.settled ? `, excluding the ${PROVISIONAL_DAYS} most recent days while Amazon is still attributing conversions to them` : ` — a window that INCLUDES the ${PROVISIONAL_DAYS} still-settling days`}.`
    case 'compare':
      return `It compares the last ${t.days} days against the ${t.days} before them, so it reads ${(t.days as number) * 2} days in two halves rather than one span. ⚠ The recent half includes today, which is still being written.`
    case 'stored':
      return `It is selected off the stored campaign columns (spend · sales · ACoS), whose window the sync does not record${t.days ? `, alongside a ${t.days}-day profit aggregate` : ''} — so how far back this rule looks is not a number this system knows.`
    case 'snapshot':
      return `Rank is the latest reading rather than a span; the spend and ACoS beside it cover ${t.days} days.`
    case 'none':
      return trigger === 'SCHEDULE'
        ? '🔴 It runs on the clock and is handed no performance data at all — only the marketplace and its month-to-date spend. Nothing in this rule reads campaign or keyword history before it acts.'
        : 'It reads no advertising performance data before acting.'
  }
}
