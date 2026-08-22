'use client'

/**
 * Shared performance-criteria builder — the IF-conditions + lookback/exclude block used by
 * BOTH the Rules & Automation RuleBuilder and the SP Super Wizard's Step-3 rules. Single
 * source so the metric/operator/unit vocabulary can't drift between the two surfaces.
 * (Config lifted verbatim from RuleBuilder.tsx; the THEN-action lives with each caller.)
 */
import { X, Plus } from 'lucide-react'
import { WASTING_FLOOR } from '@nexus/shared/ads-rule-window'
import { H10Select } from '../../campaigns/FilterDropdown'

export interface Condition {
  metric: string
  op: string
  value: string
  scope?: string
  /**
   * 🔴 EA5.2 — the ENGINE field this condition was read from, when it came off a stored rule.
   *
   * A metric name is context-FREE: "ACOS" is `campaign.acos` on a budget rule and `adTarget.acos`
   * on a bid rule, decided purely by which map the server consults. Carrying the original field
   * through the edit and back is what stops a threshold change from also moving the rule onto a
   * different entity — measured on prod, editing 40 → 45 rewrote `campaign.acos` to
   * `adTarget.acos`. Absent on a freshly-built condition, which resolves by metric as before.
   */
  field?: string
}
export interface CriteriaGroup { conditions: Condition[]; lookback: string; exclude: string }

export const PC_OPERATORS = [
  { value: 'eq', label: 'Equal to =' },
  { value: 'ne', label: 'Not equal to ≠' },
  { value: 'gt', label: 'Greater than >' },
  { value: 'gte', label: 'Greater than or equal to >=' },
  { value: 'lt', label: 'Less than <' },
  { value: 'lte', label: 'Less than or equal to <=' },
]
/**
 * P2.1 — the measurement window is the TRIGGER'S, not the rule author's. The engine evaluates
 * each trigger over its own fixed window (`ruleWindowBounds`, which also excludes the last 2
 * still-settling days), and nothing ever read the stored lookback/exclude — so the old
 * Lookback/Exclude selects were controls whose value changed no behaviour: a stored
 * "Last 60 Days" beside a 7-day evaluation was a lie with a dropdown. The sentence below states
 * the real window; the stored lookback/exclude fields now carry that truth for the record.
 */
export const PC_WINDOW_DAYS: Record<string, number | null> = {
  budget: 7, placement: 7, bid: 14,
  'keyword-harvesting': 30, 'negative-targeting': 30, sov: 30,
  'keyword-tracker': null, // rank = latest snapshot; its spend/ACOS metrics cover 30 days
}
export const pcWindowLabel = (slug: string): string => {
  const d = PC_WINDOW_DAYS[slug]
  return d == null ? 'Latest snapshot' : `Last ${d} Days`
}
export const PC_TRUTH_EXCLUDE = 'Last 2 Days'
export function PcWindowNote({ slug, days }: { slug: string; days?: number }) {
  // BUD-P3 — a rule that chooses its own lookback (Bid, Budget) passes the chosen days so the
  // sentence states the window the engine will actually read, not the trigger's default.
  const d = days ?? PC_WINDOW_DAYS[slug]
  /**
   * 🔴 SOV-P1 — Share of Voice reads TWO windows and the generic sentence described neither.
   *
   * It used to render "Measured over the last 30 days … The most recent 2 days are still settling
   * and are excluded." Verified false on prod 2026-08-22: the share came from `analyzeShareOfVoice`,
   * which builds `gte: now − 30d` with no upper bound and never calls `ruleWindowBounds`, so D-1
   * (19,536 impressions) was in. The sentence was true of the perf half and false of the half the
   * rule is named after.
   *
   * Since P1 the share is Amazon's own weekly search-query report, gated to the most recent
   * COMPLETE week per market — so its age is Amazon's to decide, not a number this form can state.
   * The tab's census strip prints the actual week and its age per market; this says the shape.
   */
  if (slug === 'sov') {
    return (
      <p className="h10-pc-winnote">
        <b>Share of Voice</b> is Amazon’s own measurement of how much of a search term’s market your
        products took — read from the most recent <b>complete</b> weekly search-query report for each
        market, so its age is whenever Amazon last published one. A market with no complete week is
        skipped entirely rather than measured on a partial one.{' '}
        <b>Campaign Concentration</b> is your biggest campaign’s share of the impressions <i>you</i>{' '}
        took on that term, over the last 30 days including the 2 most recent.{' '}
        Spend, Sales, Orders and ACOS cover the last 30 days, excluding the 2 still settling.{' '}
        A keyword Amazon has not reported a market total for is not measured as zero — it is left
        alone.
      </p>
    )
  }
  /**
   * 🔴 KT-P1 — the sentence this replaces was the tab's cardinal-sin defect.
   *
   * It read "Rank is the latest snapshot; spend and ACOS cover the last 30 days. The most recent 2
   * days are still settling and are excluded." — a precise, confident measurement regime asserted
   * over a quantity that has never been measured once. `KeywordRank` holds 0 rows on prod, its only
   * writer is a manual import route nothing calls, and the KEYWORD_RANK_BID trigger has produced 0
   * contexts and 0 executions in the account's history.
   *
   * The LIVE numbers belong to the banner above (which reads `/keyword-tracker/feed-health`); this
   * says the shape, exactly as the SOV branch does. Two things it must state that the old one hid:
   * where a rank comes from, and what happens to a keyword that has none.
   */
  if (slug === 'keyword-tracker') {
    return (
      <p className="h10-pc-winnote">
        <b>Organic Rank</b>, <b>Sponsored Rank</b>, <b>Rank Change</b> and <b>Search Volume</b> are read
        from the keyword-rank feed — the latest observation for each keyword in its own marketplace,
        not an average over a window. <b>Rank Change</b> compares that observation with the previous
        one for the same product; a keyword observed only once has no change and is left alone rather
        than counted as “unchanged”.{' '}
        Spend and ACOS cover the last 30 days, excluding the 2 still settling.{' '}
        🔴 <b>A keyword with no rank observation is skipped entirely.</b> It is not treated as ranking
        last, so a rule reading “Organic Rank &gt; 50” will not reach the keywords you have never
        ranked for — which are usually the ones such a rule is meant to find.
      </p>
    )
  }
  return (
    <p className="h10-pc-winnote">
      {d == null
        ? 'Rank is the latest observation; spend and ACOS cover the last 30 days. The most recent 2 days are still settling and are excluded.'
        : days != null
          ? `Measured over the last ${d} days — this rule's own lookback. The most recent 2 days are still settling and are excluded.`
          : `Measured over the last ${d} days — this trigger's fixed window. The most recent 2 days are still settling and are excluded.`}
      {/* HP1 — the invisible floor, made visible: the emitter only surfaces terms already at
          ≥2 orders, so conditions can tighten that bar but never lower it. */}
      {slug === 'keyword-harvesting' && ' Search terms surface only once they have at least 2 orders in the window — conditions can raise that bar, never lower it.'}
      {/* NEG-P2 — the same honesty for the wasting emitter; the numbers come from the SAME
          declaration the emitter reads (WASTING_FLOOR), so this sentence cannot drift. */}
      {slug === 'negative-targeting' && ` Search terms surface only once they have zero orders on at least ${WASTING_FLOOR.minClicks} clicks and €${(WASTING_FLOOR.minSpendCents / 100).toFixed(0)} of spend in the window — conditions can raise that bar, never lower it.`}
      {/* BUD-P1 — the budget context's floor + H10's Budget Utilization formula, stated. */}
      {slug === 'budget' && ' Enabled campaigns surface only once they have ad spend inside the window. Budget Utilization = average daily spend in the window ÷ the campaign’s CURRENT daily budget, so it reads above 100% where the budget has since been lowered.'}
    </p>
  )
}
export const PC_METRIC_UNIT: Record<string, 'eur' | 'pct' | ''> = {
  Sales: 'eur', Spend: 'eur', CPC: 'eur', 'Current Bid': 'eur',
  ACOS: 'pct', CTR: 'pct', CVR: 'pct',
  ROAS: '', Clicks: '', Impressions: '', 'PPC Orders': '', Orders: '',
  'Budget Utilization': 'pct',
  'Share of Voice': 'pct', 'Campaign Concentration': 'pct',
  'Organic Rank': '', 'Sponsored Rank': '', 'Rank Change': '', 'Search Volume': '',
}
const METRICS_BASE = ['Sales', 'ACOS', 'ROAS', 'Clicks', 'Impressions', 'CVR', 'CTR', 'CPC', 'PPC Orders', 'Spend', 'Orders']
// BUD-P1 — Budget rules add the campaign-level "Budget Utilization" signal (H10's signature
// budget metric). Declared HERE so the builder's catalog and pcMetricsFor cannot drift apart —
// RuleBuilder used to carry its own copy of this list.
const METRICS_BUDGET = [...METRICS_BASE, 'Budget Utilization']
// BP.P4 — H10's Bid list carries "Current Bid" (the target's live bid, in €). Bid rules only:
// the KEYWORD_HIGH_ACOS context is the one that carries adTarget.bidCents.
const METRICS_BID = [...METRICS_BASE, 'Current Bid']
// P2.1 — 'Organic Share' and 'Sponsored Share' are REMOVED: no signal source exists anywhere,
// so a condition on either could never match and the adapter now refuses rather than drops.
// Re-offer them when a source ships.
//
// 🔴 SOV-P1 (2026-08-22) — two more changes, for the same reason one layer down. 'Impression Share'
// is REMOVED because the context assigned it `s.sovPct`: it and 'Share of Voice' were the same
// number under two names, so choosing between them changed nothing. 'Top Campaign Share' is now
// 'Campaign Concentration' — the value is unchanged (our biggest campaign's share of the
// impressions WE took on a query) but the old name read as a share of the market, which it never
// was. 'Share of Voice' itself keeps its name because it is now Amazon's own per-query market
// share (`ads-sov-keyword-share.service.ts`) rather than our account-wide impression mix.
const METRICS_SOV = ['Share of Voice', 'Campaign Concentration', 'ACOS', 'Spend', 'Sales', 'Orders']
// KT-P3 — 'Share of Voice' removed: it named `adTarget.sovPct`, which the rank context never emits,
// and its only source is measured to run NEGATIVELY against Amazon's real per-query share
// (ρ = −0.2445, all four markets). See the note in `ads-rule-adapter.service.ts`'s RANK_METRIC.
// The four rank metrics stay — they are held, not removed, because they are real capabilities
// awaiting a feed. `KEYWORD_RANK_METRICS` is the held set, and the builder reads it.
const METRICS_RANK = ['Organic Rank', 'Sponsored Rank', 'Rank Change', 'Search Volume', 'ACOS', 'Spend']
/** KT-P1 — the metrics with no ingested source today. One declaration, read by the builder's banner. */
export const KEYWORD_RANK_METRICS = ['Organic Rank', 'Sponsored Rank', 'Rank Change', 'Search Volume']
const METRICS_PLACEMENT = ['ACOS', 'ROAS', 'Sales', 'Spend', 'Orders', 'CVR', 'CTR', 'CPC', 'Clicks', 'Impressions']
// Mapped {value,label}[] forms — exported so RuleBuilder imports them drop-in (single source).
export const PC_METRICS = METRICS_BASE.map((m) => ({ value: m, label: m }))
export const PC_METRICS_BUDGET = METRICS_BUDGET.map((m) => ({ value: m, label: m }))
export const PC_METRICS_BID = METRICS_BID.map((m) => ({ value: m, label: m }))
export const PC_METRICS_SOV = METRICS_SOV.map((m) => ({ value: m, label: m }))
export const PC_METRICS_RANK = METRICS_RANK.map((m) => ({ value: m, label: m }))
export const PC_METRICS_PLACEMENT = METRICS_PLACEMENT.map((m) => ({ value: m, label: m }))
export const pcMetricsFor = (slug: string): Array<{ value: string; label: string }> =>
  (slug === 'sov' ? METRICS_SOV : slug === 'keyword-tracker' ? METRICS_RANK : slug === 'placement' ? METRICS_PLACEMENT : slug === 'bid' ? METRICS_BID : slug === 'budget' ? METRICS_BUDGET : METRICS_BASE).map((m) => ({ value: m, label: m }))
export const pcDefaultCondition = (slug: string): Condition =>
  // HP1 — 2, not 1: the SEARCH_TERM_CONVERTING emitter only surfaces terms with ≥2 orders
  // (NEXUS_CONVERTING_MIN_ORDERS), so a '≥1 order' default promised what the engine cannot do.
  slug === 'keyword-harvesting' ? { metric: 'PPC Orders', op: 'gte', value: '2' }
    : slug === 'placement' ? { metric: 'ACOS', op: 'gt', value: '', scope: 'campaign' }
      : slug === 'sov' ? { metric: 'Share of Voice', op: 'lt', value: '' }
        : slug === 'keyword-tracker' ? { metric: 'Organic Rank', op: 'gt', value: '' }
          : (slug === 'budget' || slug === 'bid') ? { metric: 'ACOS', op: 'gt', value: '' }
            : { metric: 'Sales', op: 'eq', value: '0' }
export const pcDefaultGroup = (slug: string): CriteriaGroup => ({
  // NEG-P2 — H10's negative default is a PAIR ("Sales = 0 AND Clicks >= 20"); ours pairs the
  // zero with the emitter's own click floor so the default rule is exactly satisfiable.
  conditions: slug === 'negative-targeting'
    ? [{ metric: 'Sales', op: 'eq', value: '0' }, { metric: 'Clicks', op: 'gte', value: '5' }]
    : [pcDefaultCondition(slug)],
  lookback: pcWindowLabel(slug),
  exclude: PC_TRUTH_EXCLUDE,
})

/** The criteria rows (metric · operator · value+unit, AND-joined) + lookback/exclude windows. */
export function PerformanceCriteria({ value, onChange, slug = 'keyword-harvesting' }: { value: CriteriaGroup; onChange: (g: CriteriaGroup) => void; slug?: string }) {
  const metrics = pcMetricsFor(slug)
  const setCond = (i: number, patch: Partial<Condition>) => onChange({ ...value, conditions: value.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) })
  const addCond = () => onChange({ ...value, conditions: [...value.conditions, { metric: metrics[0].value, op: 'gte', value: '' }] })
  const rmCond = (i: number) => onChange({ ...value, conditions: value.conditions.length > 1 ? value.conditions.filter((_, j) => j !== i) : value.conditions })
  return (
    <div className="h10-pc">
      {value.conditions.map((c, i) => {
        const unit = PC_METRIC_UNIT[c.metric] ?? ''
        return (
          <div className="h10-pc-row" key={i}>
            <span className="h10-pc-join">{i === 0 ? 'IF' : 'AND'}</span>
            <H10Select width={260} options={metrics} value={c.metric} onChange={(v) => setCond(i, { metric: v })} ariaLabel="Metric" />
            <H10Select width={300} options={PC_OPERATORS} value={c.op} onChange={(v) => setCond(i, { op: v })} ariaLabel="Operator" />
            <div className={`h10-pc-val ${unit}`}>{unit === 'eur' && <span className="u">€</span>}<input inputMode="decimal" value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} placeholder="Value" aria-label="Value" />{unit === 'pct' && <span className="u">%</span>}</div>
            {value.conditions.length > 1 && <button type="button" className="h10-pc-rm" onClick={() => rmCond(i)} aria-label="Remove condition"><X size={14} /></button>}
          </div>
        )
      })}
      <button type="button" className="h10-pc-add" onClick={addCond}><Plus size={13} /> Add condition</button>
      <PcWindowNote slug={slug} />
    </div>
  )
}
