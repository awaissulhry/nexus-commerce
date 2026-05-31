'use client'

/**
 * Amazon-faithful "Filter by" panel. Delivery status / Targeting / Portfolio
 * multi-select sections + a metric-filter builder (metric ▸ operator ▸ value,
 * e.g. "ACOS ≥ 40%"). Edits are live (no Apply step) so the active-filter chips
 * outside update instantly. Shared Filters type + option maps are exported so
 * CampaignsTable can both apply the filters and render the removable chips.
 */

import { useState } from 'react'
import { X, Plus } from 'lucide-react'

export interface MetricFilter { id: string; metric: string; op: 'gte' | 'lte'; value: number }
export interface Filters { statuses: string[]; targeting: string[]; portfolios: string[]; metrics: MetricFilter[] }
export const EMPTY_FILTERS: Filters = { statuses: [], targeting: [], portfolios: [], metrics: [] }
export const countFilters = (f: Filters) => f.statuses.length + f.targeting.length + f.portfolios.length + f.metrics.length

export const STATUS_OPTS = [
  { k: 'delivering', label: 'Delivering' }, { k: 'paused', label: 'Paused' },
  { k: 'outOfBudget', label: 'Out of budget' }, { k: 'archived', label: 'Archived' }, { k: 'other', label: 'Other issue' },
]
export const TARGETING_OPTS = [{ k: 'auto', label: 'Automatic' }, { k: 'manual', label: 'Manual' }]
export const METRIC_OPTS = [
  { k: 'spend', label: 'Spend', unit: '€' }, { k: 'sales', label: 'Sales', unit: '€' },
  { k: 'acos', label: 'ACOS', unit: '%' }, { k: 'roas', label: 'ROAS', unit: '×' },
  { k: 'cpc', label: 'CPC', unit: '€' }, { k: 'ctr', label: 'CTR', unit: '%' },
  { k: 'clicks', label: 'Clicks', unit: '' }, { k: 'orders', label: 'Orders', unit: '' },
  { k: 'impressions', label: 'Impressions', unit: '' }, { k: 'budget', label: 'Budget/day', unit: '€' },
]
export const STATUS_LABEL: Record<string, string> = Object.fromEntries(STATUS_OPTS.map((o) => [o.k, o.label]))
export const TARGETING_LABEL: Record<string, string> = Object.fromEntries(TARGETING_OPTS.map((o) => [o.k, o.label]))
export const METRIC_LABEL: Record<string, string> = Object.fromEntries(METRIC_OPTS.map((o) => [o.k, o.label]))
export const METRIC_UNIT: Record<string, string> = Object.fromEntries(METRIC_OPTS.map((o) => [o.k, o.unit]))
export const opSym = (op: string) => (op === 'gte' ? '≥' : '≤')

const toggle = (arr: string[], k: string) => (arr.includes(k) ? arr.filter((x) => x !== k) : [...arr, k])

export function FilterPanel({
  filters, setFilters, portfolios, onClose,
}: {
  filters: Filters
  setFilters: (f: Filters) => void
  portfolios: Array<{ id: string; label: string; count: number }>
  onClose: () => void
}) {
  const [m, setM] = useState('acos')
  const [op, setOp] = useState<'gte' | 'lte'>('gte')
  const [val, setVal] = useState('')

  const addMetric = () => {
    const v = parseFloat(val)
    if (!Number.isFinite(v)) return
    const id = `${m}:${op}:${v}`
    if (filters.metrics.some((x) => x.id === id)) { setVal(''); return }
    setFilters({ ...filters, metrics: [...filters.metrics, { id, metric: m, op, value: v }] })
    setVal('')
  }

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 29 }} onClick={onClose} />
      <div className="az-filterpanel" role="dialog" aria-label="Filter campaigns">
        <div className="az-fp-sec">
          <h4>Delivery status</h4>
          {STATUS_OPTS.map((o) => (
            <label key={o.k} className="az-fp-opt"><input type="checkbox" checked={filters.statuses.includes(o.k)} onChange={() => setFilters({ ...filters, statuses: toggle(filters.statuses, o.k) })} />{o.label}</label>
          ))}
        </div>

        <div className="az-fp-sec">
          <h4>Targeting</h4>
          {TARGETING_OPTS.map((o) => (
            <label key={o.k} className="az-fp-opt"><input type="checkbox" checked={filters.targeting.includes(o.k)} onChange={() => setFilters({ ...filters, targeting: toggle(filters.targeting, o.k) })} />{o.label}</label>
          ))}
        </div>

        {portfolios.length > 0 && (
          <div className="az-fp-sec">
            <h4>Portfolio</h4>
            <div style={{ maxHeight: 168, overflowY: 'auto' }}>
              {portfolios.map((p) => (
                <label key={p.id} className="az-fp-opt"><input type="checkbox" checked={filters.portfolios.includes(p.id)} onChange={() => setFilters({ ...filters, portfolios: toggle(filters.portfolios, p.id) })} />{p.label}<span className="ct">{p.count}</span></label>
              ))}
            </div>
          </div>
        )}

        <div className="az-fp-sec">
          <h4>Metric filters</h4>
          {filters.metrics.map((mf) => (
            <div key={mf.id} className="az-fp-mf">
              {METRIC_LABEL[mf.metric]} {opSym(mf.op)} {mf.value}{METRIC_UNIT[mf.metric]}
              <button className="rm" onClick={() => setFilters({ ...filters, metrics: filters.metrics.filter((x) => x.id !== mf.id) })} aria-label="Remove metric filter"><X size={14} /></button>
            </div>
          ))}
          <div className="az-fp-row">
            <select value={m} onChange={(e) => setM(e.target.value)} aria-label="Metric">
              {METRIC_OPTS.map((o) => <option key={o.k} value={o.k}>{o.label}</option>)}
            </select>
            <select value={op} onChange={(e) => setOp(e.target.value as 'gte' | 'lte')} aria-label="Operator">
              <option value="gte">≥</option><option value="lte">≤</option>
            </select>
            <input type="number" step="any" value={val} placeholder={METRIC_UNIT[m] || '0'} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addMetric() }} aria-label="Value" />
            <button className="az-btn" onClick={addMetric} disabled={!val}><Plus size={14} /> Add</button>
          </div>
        </div>

        <div className="az-fp-foot">
          <button className="az-link" onClick={() => setFilters(EMPTY_FILTERS)} disabled={countFilters(filters) === 0} style={countFilters(filters) === 0 ? { opacity: .4, cursor: 'default' } : undefined}>Clear all</button>
          <button className="az-btn dark" onClick={onClose}>Done</button>
        </div>
      </div>
    </>
  )
}
