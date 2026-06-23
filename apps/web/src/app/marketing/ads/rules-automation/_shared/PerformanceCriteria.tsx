'use client'

/**
 * Shared performance-criteria builder — the IF-conditions + lookback/exclude block used by
 * BOTH the Rules & Automation RuleBuilder and the SP Super Wizard's Step-3 rules. Single
 * source so the metric/operator/unit vocabulary can't drift between the two surfaces.
 * (Config lifted verbatim from RuleBuilder.tsx; the THEN-action lives with each caller.)
 */
import { X, Plus } from 'lucide-react'

export interface Condition { metric: string; op: string; value: string; scope?: string }
export interface CriteriaGroup { conditions: Condition[]; lookback: string; exclude: string }

export const PC_OPERATORS = [
  { value: 'eq', label: 'Equal to =' },
  { value: 'ne', label: 'Not equal to ≠' },
  { value: 'gt', label: 'Greater than >' },
  { value: 'gte', label: 'Greater than or equal to >=' },
  { value: 'lt', label: 'Less than <' },
  { value: 'lte', label: 'Less than or equal to <=' },
]
export const PC_LOOKBACK = ['Last 7 Days', 'Last 14 Days', 'Last 30 Days', 'Last 60 Days', 'Last 90 Days', 'Lifetime'].map((l) => ({ value: l, label: l }))
export const PC_EXCLUDE = ['None', 'Last 1 Day', 'Last 3 Days', 'Last 7 Days', 'Last 14 Days', 'Last 30 Days'].map((l) => ({ value: l, label: l }))
export const PC_METRIC_UNIT: Record<string, 'eur' | 'pct' | ''> = {
  Sales: 'eur', Spend: 'eur', CPC: 'eur',
  ACOS: 'pct', CTR: 'pct', CVR: 'pct',
  ROAS: '', Clicks: '', Impressions: '', 'PPC Orders': '', Orders: '',
  'Budget Utilization': 'pct',
  'Share of Voice': 'pct', 'Top Campaign Share': 'pct', 'Impression Share': 'pct', 'Organic Share': 'pct', 'Sponsored Share': 'pct',
  'Organic Rank': '', 'Sponsored Rank': '', 'Rank Change': '', 'Search Volume': '',
}
const METRICS_BASE = ['Sales', 'ACOS', 'ROAS', 'Clicks', 'Impressions', 'CVR', 'CTR', 'CPC', 'PPC Orders', 'Spend', 'Orders']
const METRICS_SOV = ['Share of Voice', 'Top Campaign Share', 'Impression Share', 'Organic Share', 'Sponsored Share', 'ACOS', 'Spend', 'Sales', 'Orders']
const METRICS_RANK = ['Organic Rank', 'Sponsored Rank', 'Rank Change', 'Search Volume', 'Share of Voice', 'ACOS', 'Spend']
const METRICS_PLACEMENT = ['ACOS', 'ROAS', 'Sales', 'Spend', 'Orders', 'CVR', 'CTR', 'CPC', 'Clicks', 'Impressions']
export const pcMetricsFor = (slug: string): Array<{ value: string; label: string }> =>
  (slug === 'sov' ? METRICS_SOV : slug === 'keyword-tracker' ? METRICS_RANK : slug === 'placement' ? METRICS_PLACEMENT : METRICS_BASE).map((m) => ({ value: m, label: m }))
export const pcDefaultCondition = (slug: string): Condition =>
  slug === 'keyword-harvesting' ? { metric: 'PPC Orders', op: 'gte', value: '1' }
    : slug === 'placement' ? { metric: 'ACOS', op: 'gt', value: '', scope: 'campaign' }
      : slug === 'sov' ? { metric: 'Share of Voice', op: 'lt', value: '' }
        : slug === 'keyword-tracker' ? { metric: 'Organic Rank', op: 'gt', value: '' }
          : (slug === 'budget' || slug === 'bid') ? { metric: 'ACOS', op: 'gt', value: '' }
            : { metric: 'Sales', op: 'eq', value: '0' }
export const pcDefaultGroup = (slug: string): CriteriaGroup => ({ conditions: [pcDefaultCondition(slug)], lookback: 'Last 60 Days', exclude: 'Last 3 Days' })

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
            <select className="h10-pc-sel" value={c.metric} onChange={(e) => setCond(i, { metric: e.target.value })} aria-label="Metric">{metrics.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select>
            <select className="h10-pc-sel op" value={c.op} onChange={(e) => setCond(i, { op: e.target.value })} aria-label="Operator">{PC_OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
            <div className={`h10-pc-val ${unit}`}>{unit === 'eur' && <span className="u">€</span>}<input inputMode="decimal" value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} placeholder="Value" aria-label="Value" />{unit === 'pct' && <span className="u">%</span>}</div>
            {value.conditions.length > 1 && <button type="button" className="h10-pc-rm" onClick={() => rmCond(i)} aria-label="Remove condition"><X size={14} /></button>}
          </div>
        )
      })}
      <button type="button" className="h10-pc-add" onClick={addCond}><Plus size={13} /> Add condition</button>
      <div className="h10-pc-windows">
        <label className="h10-pc-win"><span>Lookback period</span><select className="h10-pc-sel" value={value.lookback} onChange={(e) => onChange({ ...value, lookback: e.target.value })} aria-label="Lookback period">{PC_LOOKBACK.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}</select></label>
        <label className="h10-pc-win"><span>Exclude</span><select className="h10-pc-sel" value={value.exclude} onChange={(e) => onChange({ ...value, exclude: e.target.value })} aria-label="Exclude window">{PC_EXCLUDE.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}</select></label>
      </div>
    </div>
  )
}
