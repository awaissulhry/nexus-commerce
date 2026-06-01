'use client'

/**
 * Custom automation rule builder — composes any trigger + conditions + actions
 * into a real rule (POST /automation-rules). Field/action vocabulary mirrors the
 * backend engine. Human-friendly units (%, €, days) convert to the engine's raw
 * values on save. Created rules are always enabled:false + dryRun:true.
 */

import { useMemo, useState } from 'react'
import { X, Plus, Trash2, Check } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

const TRIGGERS = [
  { t: 'CAC_SPIKE', label: 'Campaign ACOS/CPC spike', hint: 'Evaluates each campaign’s ACOS / spend.' },
  { t: 'CAMPAIGN_PERFORMANCE_BUDGET', label: 'Campaign performance (budget)', hint: 'ROAS / ACOS / budget utilisation per campaign.' },
  { t: 'AD_TARGET_UNDERPERFORMING', label: 'Target underperforming', hint: 'Per keyword/ASIN target spend vs sales.' },
  { t: 'AD_SPEND_PROFITABILITY_BREACH', label: 'Profitability breach', hint: 'Ad spend vs true product profit.' },
  { t: 'SCHEDULE', label: 'Scheduled (runs on a timer)', hint: 'Runs the action on a cadence — for engine actions & caps.' },
  { t: 'FBA_AGE_THRESHOLD_REACHED', label: 'FBA stock ageing', hint: 'Days until a SKU enters long-term storage.' },
]
const FIELDS = [
  { f: 'campaign.acos', label: 'Campaign ACOS', unit: 'pct', on: ['CAC_SPIKE', 'CAMPAIGN_PERFORMANCE_BUDGET'] },
  { f: 'campaign.roas', label: 'Campaign ROAS', unit: 'num', on: ['CAMPAIGN_PERFORMANCE_BUDGET'] },
  { f: 'campaign.spendCents', label: 'Campaign spend', unit: 'eur', on: ['CAC_SPIKE', 'CAMPAIGN_PERFORMANCE_BUDGET'] },
  { f: 'campaign.budgetUtilization', label: 'Budget utilisation', unit: 'pct', on: ['CAMPAIGN_PERFORMANCE_BUDGET'] },
  { f: 'adTarget.spendCents', label: 'Target spend', unit: 'eur', on: ['AD_TARGET_UNDERPERFORMING'] },
  { f: 'adTarget.salesCents', label: 'Target sales', unit: 'eur', on: ['AD_TARGET_UNDERPERFORMING'] },
  { f: 'adTarget.ordersCount', label: 'Target orders', unit: 'num', on: ['AD_TARGET_UNDERPERFORMING'] },
  { f: 'profit.netCents', label: 'Net profit', unit: 'eur', on: ['AD_SPEND_PROFITABILITY_BREACH'] },
  { f: 'budget.monthlySpendCents', label: 'Month-to-date spend', unit: 'eur', on: ['SCHEDULE'] },
  { f: 'fbaAge.daysToLtsThreshold', label: 'Days to LTS', unit: 'days', on: ['FBA_AGE_THRESHOLD_REACHED'] },
]
const OPS = [{ v: 'gte', l: '≥' }, { v: 'lte', l: '≤' }, { v: 'gt', l: '>' }, { v: 'lt', l: '<' }, { v: 'eq', l: '=' }]
const ACTIONS = [
  { t: 'bid_down', label: 'Lower bid by %', params: [{ k: 'percent', label: '%', def: 20 }] },
  { t: 'adjust_ad_budget', label: 'Adjust budget by % (±)', params: [{ k: 'percent', label: '%', def: 15 }] },
  { t: 'pause_ad_group', label: 'Pause the ad group', params: [] },
  { t: 'pause_all_campaigns', label: 'Pause ALL campaigns (failsafe)', params: [] },
  { t: 'bid_to_target_acos', label: 'Optimise bids to target ACOS', params: [] },
  { t: 'harvest_and_negate', label: 'Harvest & negate search terms', params: [{ k: 'windowDays', label: 'window days', def: 60 }, { k: 'minOrders', label: 'min orders', def: 2 }] },
  { t: 'retail_guard', label: 'Retail guard (OOS / Buy Box)', params: [] },
  { t: 'notify', label: 'Notify me', params: [{ k: 'message', label: 'message', def: '', text: true }] },
]
const toRaw = (unit: string, v: number) => (unit === 'pct' ? v / 100 : unit === 'eur' ? Math.round(v * 100) : v)

interface CondRow { field: string; op: string; value: string }
interface ActRow { type: string; params: Record<string, string> }

export function RuleBuilder({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('')
  const [trigger, setTrigger] = useState('CAC_SPIKE')
  const [conds, setConds] = useState<CondRow[]>([{ field: 'campaign.acos', op: 'gte', value: '40' }])
  const [acts, setActs] = useState<ActRow[]>([{ type: 'bid_down', params: { percent: '20' } }])
  const [maxPerDay, setMaxPerDay] = useState('20')
  const [maxSpend, setMaxSpend] = useState('100')
  const [saving, setSaving] = useState(false)

  const fieldsForTrigger = useMemo(() => FIELDS.filter((f) => f.on.includes(trigger)), [trigger])

  const save = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      const conditions = conds.filter((c) => c.field && c.value !== '').map((c) => { const f = FIELDS.find((x) => x.f === c.field); return { field: c.field, op: c.op, value: toRaw(f?.unit ?? 'num', Number(c.value)) } })
      const actions = acts.map((a) => { const def = ACTIONS.find((x) => x.t === a.type); const o: Record<string, unknown> = { type: a.type }; for (const p of def?.params ?? []) { const raw = a.params[p.k]; if (raw == null || raw === '') continue; o[p.k] = (p as { text?: boolean }).text ? raw : Number(raw) } return o })
      await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: 'Custom rule', trigger, conditions, actions, maxExecutionsPerDay: Number(maxPerDay) || 20, maxDailyAdSpendCentsEur: Math.round((Number(maxSpend) || 100) * 100) }),
      })
      onSaved(); onClose()
    } finally { setSaving(false) }
  }

  return (
    <div className="az-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="az-modal" role="dialog" aria-label="Build custom automation" style={{ width: 'min(720px, 96vw)' }}>
        <div className="az-modal-head"><h2>Build a custom automation</h2><button className="x" onClick={onClose} aria-label="Close"><X size={20} /></button></div>
        <div className="az-modal-body" style={{ display: 'block', overflowY: 'auto', padding: '14px 22px' }}>
          <div className="az-fp-sec">
            <h4>Name</h4>
            <input className="az-search" style={{ width: '100%', padding: '8px 12px' }} placeholder="e.g. Cut bids when ACOS > 45%" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="az-fp-sec">
            <h4>When (trigger)</h4>
            <select className="az-search" style={{ width: '100%', padding: '8px 12px', cursor: 'pointer' }} value={trigger} onChange={(e) => { setTrigger(e.target.value); const ff = FIELDS.find((f) => f.on.includes(e.target.value)); setConds(ff ? [{ field: ff.f, op: 'gte', value: '' }] : []) }}>
              {TRIGGERS.map((t) => <option key={t.t} value={t.t}>{t.label}</option>)}
            </select>
            <div className="d" style={{ color: 'var(--ink2)', fontSize: 12, marginTop: 6 }}>{TRIGGERS.find((t) => t.t === trigger)?.hint}</div>
          </div>
          {fieldsForTrigger.length > 0 && (
            <div className="az-fp-sec">
              <h4>Conditions (all must match)</h4>
              {conds.map((c, i) => (
                <div className="az-fp-row" key={i}>
                  <select value={c.field} onChange={(e) => setConds((r) => r.map((x, j) => j === i ? { ...x, field: e.target.value } : x))}>{fieldsForTrigger.map((f) => <option key={f.f} value={f.f}>{f.label}</option>)}</select>
                  <select value={c.op} onChange={(e) => setConds((r) => r.map((x, j) => j === i ? { ...x, op: e.target.value } : x))}>{OPS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
                  <input type="number" step="any" value={c.value} onChange={(e) => setConds((r) => r.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} placeholder="value" />
                  <span style={{ color: 'var(--ink2)', fontSize: 12 }}>{FIELDS.find((f) => f.f === c.field)?.unit === 'pct' ? '%' : FIELDS.find((f) => f.f === c.field)?.unit === 'eur' ? '€' : FIELDS.find((f) => f.f === c.field)?.unit === 'days' ? 'days' : ''}</span>
                  <button className="az-kebab" onClick={() => setConds((r) => r.filter((_, j) => j !== i))} style={{ color: '#cc1100' }}><Trash2 size={14} /></button>
                </div>
              ))}
              <button className="az-link" style={{ marginTop: 6 }} onClick={() => setConds((r) => [...r, { field: fieldsForTrigger[0].f, op: 'gte', value: '' }])}><Plus size={13} /> Add condition</button>
            </div>
          )}
          <div className="az-fp-sec">
            <h4>Then (actions)</h4>
            {acts.map((a, i) => {
              const def = ACTIONS.find((x) => x.t === a.type)
              return (
                <div className="az-fp-row" key={i} style={{ flexWrap: 'wrap' }}>
                  <select value={a.type} onChange={(e) => setActs((r) => r.map((x, j) => j === i ? { type: e.target.value, params: {} } : x))}>{ACTIONS.map((x) => <option key={x.t} value={x.t}>{x.label}</option>)}</select>
                  {(def?.params ?? []).map((p) => <input key={p.k} type={(p as { text?: boolean }).text ? 'text' : 'number'} step="any" placeholder={p.label} value={a.params[p.k] ?? ''} onChange={(e) => setActs((r) => r.map((x, j) => j === i ? { ...x, params: { ...x.params, [p.k]: e.target.value } } : x))} style={(p as { text?: boolean }).text ? { flex: 1, minWidth: 160 } : undefined} />)}
                  <button className="az-kebab" onClick={() => setActs((r) => r.filter((_, j) => j !== i))} style={{ color: '#cc1100' }}><Trash2 size={14} /></button>
                </div>
              )
            })}
            <button className="az-link" style={{ marginTop: 6 }} onClick={() => setActs((r) => [...r, { type: 'notify', params: {} }])}><Plus size={13} /> Add action</button>
          </div>
          <div className="az-fp-sec">
            <h4>Guardrails</h4>
            <div className="az-fp-row">
              <span style={{ fontSize: 12, color: 'var(--ink2)' }}>Max runs/day</span><input type="number" value={maxPerDay} onChange={(e) => setMaxPerDay(e.target.value)} />
              <span style={{ fontSize: 12, color: 'var(--ink2)', marginLeft: 10 }}>Max €/day affected</span><input type="number" value={maxSpend} onChange={(e) => setMaxSpend(e.target.value)} />
            </div>
          </div>
        </div>
        <div className="az-modal-foot">
          <span style={{ flex: 1, color: 'var(--ink2)', fontSize: 12 }}>Saved disabled + dry-run — turn it on from Active rules.</span>
          <button className="az-btn" onClick={onClose}>Cancel</button>
          <button className="az-btn dark" disabled={saving || !name.trim()} onClick={() => void save()}><Check size={15} /> {saving ? 'Saving…' : 'Create rule'}</button>
        </div>
      </div>
    </div>
  )
}
