'use client'

/**
 * Automation configurator — opens for any distinct automation and lets the
 * operator tune its parameters (thresholds, %, €, windows, scope) before adding
 * it. Renders a live plain-English preview of exactly what it will do, then
 * POSTs a tailored rule (enabled:false + dryRun:true). This is what makes every
 * automation dynamic + unlimited — one concept, infinitely configurable.
 */

import { useMemo, useState } from 'react'
import { X, Check, ChevronDown } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { buildRule, type AutomationDef, type ParamDef } from './automations'
import { CatIcon } from './_icons'

const ACTION_LABEL: Record<string, string> = {
  bid_down: 'lower bids', bid_up: 'raise bids', lower_bid_to_floor: 'drop bids to the floor', adjust_ad_budget: 'adjust the budget', set_daily_budget: 'set the daily budget', set_campaign_target_acos: 'set the target ACOS', pause_campaign: 'pause the campaign', pause_ad_group: 'pause the ad group', pause_all_campaigns: 'pause ALL campaigns', enable_campaign: 'enable the campaign', resume_campaign: 'resume the campaign', archive_keyword: 'archive the keyword', add_negative_exact: 'add a negative keyword', promote_to_exact: 'promote it to an exact keyword', harvest_and_negate: 'harvest & negate search terms', retail_guard: 'pause/resume on stock & Buy Box', liquidate_aged_stock: 'liquidate the aged stock', create_amazon_promotion: 'create a promotion', set_placement_multiplier: 'tune the placement multiplier', reroute_marketplace_budget: 'reroute budget across marketplaces', sync_negatives_across_campaigns: 'sync negatives across campaigns', raise_bids_for_rank_defense: 'raise bids to defend rank', scale_bids_for_price_change: 're-bid for the price change', bid_to_target_acos: 'optimise bids to target', alert_operator: 'alert you', notify: 'notify you',
}
const TRIGGER_LABEL: Record<string, string> = {
  CAC_SPIKE: 'a campaign’s ACOS spikes', CAMPAIGN_PERFORMANCE_BUDGET: 'a campaign meets performance/budget conditions', AD_TARGET_UNDERPERFORMING: 'a target underperforms', AD_SPEND_PROFITABILITY_BREACH: 'ad spend beats true profit', CVR_DROP: 'conversion rate drops sharply', KEYWORD_LOW_CTR: 'a keyword’s CTR is chronically low', KEYWORD_WASTED_SPEND: 'a keyword wastes spend', KEYWORD_ZERO_IMPRESSIONS: 'a keyword gets no impressions', SEARCH_TERM_CONVERTING: 'a search term is converting', FBA_AGE_THRESHOLD_REACHED: 'stock nears long-term storage', SCHEDULE: 'it runs on schedule',
  // Engine expansion (E-series)
  KEYWORD_HIGH_ACOS: 'a keyword converts but at a high ACOS', KEYWORD_SCALE_OPPORTUNITY: 'a keyword is a proven winner with headroom', AD_GROUP_UNDERPERFORMING: 'an ad group underperforms', NEW_TO_BRAND_WINNER: 'a campaign wins new-to-brand customers', CAMPAIGN_NO_SALES: 'a campaign spends with no sales', SEARCH_TERM_WASTING: 'a search term wastes spend', CAMPAIGN_ROAS_DECLINING: 'a campaign’s ROAS declines week-over-week', KEYWORD_RISING_STAR: 'a keyword’s orders are accelerating',
}
const unitSuffix = (k: ParamDef['kind']) => (k === 'pct' ? '%' : k === 'roas' ? '×' : k === 'days' ? 'days' : '')
// Friendly condition rendering for the live preview (handles the E-series fields
// declinePct / growthPct / ntbOrders / roas alongside the originals).
const condFieldLabel = (f: string) => (f.split('.').pop() ?? f).replace(/Cents$/, '').replace(/Pct$/, '').replace(/([A-Z])/g, ' $1').trim().toLowerCase()
const condValue = (f: string, v: number) => f.includes('Cents') ? '€' + (v / 100) : f.endsWith('Pct') ? v + '%' : (f.includes('acos') || f.includes('Utilization') || f.includes('ctr')) ? (v * 100).toFixed(0) + '%' : String(v)

export function Configurator({ def, onClose, onSaved }: { def: AutomationDef; onClose: () => void; onSaved: () => void }) {
  const [vals, setVals] = useState<Record<string, number | string>>(() => Object.fromEntries(def.params.map((p) => [p.key, p.default])))
  const [name, setName] = useState(def.name)
  const [adv, setAdv] = useState(false)
  const [maxPerDay, setMaxPerDay] = useState<string>('')
  const [maxSpend, setMaxSpend] = useState<string>('')
  const [saving, setSaving] = useState(false)

  const built = useMemo(() => buildRule(def, vals), [def, vals])
  const actionWords = built.actions.map((a) => ACTION_LABEL[String(a.type)] ?? String(a.type)).filter((w, i, arr) => arr.indexOf(w) === i)

  const save = async () => {
    setSaving(true)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim() || def.name, description: def.desc, trigger: def.trigger,
          conditions: built.conditions, actions: built.actions,
          maxExecutionsPerDay: maxPerDay !== '' ? Number(maxPerDay) : built.maxExecutionsPerDay,
          maxDailyAdSpendCentsEur: maxSpend !== '' ? Math.round(Number(maxSpend) * 100) : built.maxDailyAdSpendCentsEur ?? null,
        }),
      })
      onSaved(); onClose()
    } finally { setSaving(false) }
  }

  return (
    <div className="az-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="az-modal" role="dialog" aria-label={`Configure ${def.name}`} style={{ width: 'min(620px, 96vw)' }}>
        <div className="az-modal-head"><h2><span className="az-cfgicon"><CatIcon cat={def.category} size={18} /></span>{def.name}</h2><button className="x" onClick={onClose} aria-label="Close"><X size={20} /></button></div>
        <div className="az-modal-body" style={{ display: 'block', overflowY: 'auto', padding: '14px 22px' }}>
          <div style={{ color: 'var(--ink2)', fontSize: 13, lineHeight: 1.55, marginBottom: 14 }}>{def.desc}</div>

          {/* live plain-English preview */}
          <div style={{ background: 'var(--bg3)', border: '1px solid var(--divider)', borderRadius: 10, padding: '12px 14px', marginBottom: 16, fontSize: 13, lineHeight: 1.6 }}>
            <span style={{ color: 'var(--ink2)' }}>When </span><b>{TRIGGER_LABEL[def.trigger] ?? def.trigger}</b>
            {built.conditions.length > 0 && <><span style={{ color: 'var(--ink2)' }}> and </span><b>{built.conditions.map((c) => `${condFieldLabel(c.field)} ${c.op === 'gte' ? '≥' : c.op === 'lte' ? '≤' : c.op === 'lt' ? '<' : c.op === 'gt' ? '>' : '='} ${condValue(c.field, Number(c.value))}`).join(' and ')}</b></>}
            <span style={{ color: 'var(--ink2)' }}>, this will </span><b>{actionWords.join(' + ')}</b>.
          </div>

          {def.params.length > 0 && (
            <div className="az-fp-sec" style={{ borderBottom: 0 }}>
              <h4>Settings</h4>
              {def.params.map((p) => (
                <div key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '7px 0' }}>
                  <label style={{ flex: 1, fontWeight: 500, fontSize: 13 }}>{p.label}{p.hint && <span style={{ display: 'block', color: 'var(--ink2)', fontSize: 11.5, fontWeight: 400 }}>{p.hint}</span>}</label>
                  {p.kind === 'select'
                    ? <select value={String(vals[p.key])} onChange={(e) => setVals((v) => ({ ...v, [p.key]: e.target.value }))} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px', font: 'inherit', cursor: 'pointer' }}>{(p.options ?? []).map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
                    : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><input type="number" step="any" value={vals[p.key]} onChange={(e) => setVals((v) => ({ ...v, [p.key]: e.target.value }))} style={{ width: 96, border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px', font: 'inherit', textAlign: 'right' }} /><span style={{ color: 'var(--ink2)', fontSize: 12, minWidth: 28 }}>{unitSuffix(p.kind)}</span></span>}
                </div>
              ))}
            </div>
          )}

          <div className="az-fp-sec" style={{ borderBottom: 0 }}>
            <h4>Name</h4>
            <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', font: 'inherit' }} />
          </div>

          <button className="az-link" onClick={() => setAdv((a) => !a)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>Advanced guardrails <ChevronDown size={14} style={{ transform: adv ? 'rotate(180deg)' : undefined }} /></button>
          {adv && (
            <div style={{ display: 'flex', gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
              <label style={{ fontSize: 12, color: 'var(--ink2)' }}>Max runs / day<br /><input type="number" placeholder={String(built.maxExecutionsPerDay ?? 10)} value={maxPerDay} onChange={(e) => setMaxPerDay(e.target.value)} style={{ marginTop: 4, width: 110, border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', font: 'inherit' }} /></label>
              <label style={{ fontSize: 12, color: 'var(--ink2)' }}>Max €/day affected<br /><input type="number" placeholder={built.maxDailyAdSpendCentsEur != null ? String(built.maxDailyAdSpendCentsEur / 100) : 'no limit'} value={maxSpend} onChange={(e) => setMaxSpend(e.target.value)} style={{ marginTop: 4, width: 110, border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', font: 'inherit' }} /></label>
            </div>
          )}
        </div>
        <div className="az-modal-foot">
          <span style={{ flex: 1, color: 'var(--ink2)', fontSize: 12 }}>Added disabled + dry-run — turn it on from Active rules.</span>
          <button className="az-btn" onClick={onClose}>Cancel</button>
          <button className="az-btn dark" disabled={saving} onClick={() => void save()}><Check size={15} /> {saving ? 'Adding…' : 'Add automation'}</button>
        </div>
      </div>
    </div>
  )
}
