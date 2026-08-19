'use client'

/**
 * Shared performance-criteria builder — the IF-conditions + lookback/exclude block used by
 * BOTH the Rules & Automation RuleBuilder and the SP Super Wizard's Step-3 rules. Single
 * source so the metric/operator/unit vocabulary can't drift between the two surfaces.
 * (Config lifted verbatim from RuleBuilder.tsx; the THEN-action lives with each caller.)
 */
import { X, Plus } from 'lucide-react'
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
export function PcWindowNote({ slug }: { slug: string }) {
  const d = PC_WINDOW_DAYS[slug]
  return (
    <p className="h10-pc-winnote">
      {d == null
        ? 'Rank is the latest snapshot; spend and ACOS cover the last 30 days. The most recent 2 days are still settling and are excluded.'
        : `Measured over the last ${d} days — this trigger's fixed window. The most recent 2 days are still settling and are excluded.`}
    </p>
  )
}
export const PC_METRIC_UNIT: Record<string, 'eur' | 'pct' | ''> = {
  Sales: 'eur', Spend: 'eur', CPC: 'eur',
  ACOS: 'pct', CTR: 'pct', CVR: 'pct',
  ROAS: '', Clicks: '', Impressions: '', 'PPC Orders': '', Orders: '',
  'Budget Utilization': 'pct',
  'Share of Voice': 'pct', 'Top Campaign Share': 'pct', 'Impression Share': 'pct',
  'Organic Rank': '', 'Sponsored Rank': '', 'Rank Change': '', 'Search Volume': '',
}
const METRICS_BASE = ['Sales', 'ACOS', 'ROAS', 'Clicks', 'Impressions', 'CVR', 'CTR', 'CPC', 'PPC Orders', 'Spend', 'Orders']
// P2.1 — 'Organic Share' and 'Sponsored Share' are REMOVED: no signal source exists anywhere
// (analyzeShareOfVoice reports sovPct/topCampaignSharePct only), so a condition on either could
// never match and the adapter now refuses rather than drops. Re-offer them when a source ships.
const METRICS_SOV = ['Share of Voice', 'Top Campaign Share', 'Impression Share', 'ACOS', 'Spend', 'Sales', 'Orders']
const METRICS_RANK = ['Organic Rank', 'Sponsored Rank', 'Rank Change', 'Search Volume', 'Share of Voice', 'ACOS', 'Spend']
const METRICS_PLACEMENT = ['ACOS', 'ROAS', 'Sales', 'Spend', 'Orders', 'CVR', 'CTR', 'CPC', 'Clicks', 'Impressions']
// Mapped {value,label}[] forms — exported so RuleBuilder imports them drop-in (single source).
export const PC_METRICS = METRICS_BASE.map((m) => ({ value: m, label: m }))
export const PC_METRICS_SOV = METRICS_SOV.map((m) => ({ value: m, label: m }))
export const PC_METRICS_RANK = METRICS_RANK.map((m) => ({ value: m, label: m }))
export const PC_METRICS_PLACEMENT = METRICS_PLACEMENT.map((m) => ({ value: m, label: m }))
export const pcMetricsFor = (slug: string): Array<{ value: string; label: string }> =>
  (slug === 'sov' ? METRICS_SOV : slug === 'keyword-tracker' ? METRICS_RANK : slug === 'placement' ? METRICS_PLACEMENT : METRICS_BASE).map((m) => ({ value: m, label: m }))
export const pcDefaultCondition = (slug: string): Condition =>
  slug === 'keyword-harvesting' ? { metric: 'PPC Orders', op: 'gte', value: '1' }
    : slug === 'placement' ? { metric: 'ACOS', op: 'gt', value: '', scope: 'campaign' }
      : slug === 'sov' ? { metric: 'Share of Voice', op: 'lt', value: '' }
        : slug === 'keyword-tracker' ? { metric: 'Organic Rank', op: 'gt', value: '' }
          : (slug === 'budget' || slug === 'bid') ? { metric: 'ACOS', op: 'gt', value: '' }
            : { metric: 'Sales', op: 'eq', value: '0' }
export const pcDefaultGroup = (slug: string): CriteriaGroup => ({ conditions: [pcDefaultCondition(slug)], lookback: pcWindowLabel(slug), exclude: PC_TRUTH_EXCLUDE })

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
