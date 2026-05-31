'use client'

/**
 * Trading Desk — Automation (native). Lists advertising automation rules with
 * mode (Off / Dry-run / Live) and one-click toggles, wired to the existing
 * rule engine: GET /advertising/automation-rules, PATCH (enabled/dryRun),
 * POST seed-templates. The visual rule-builder still opens in a new tab until
 * it's ported natively.
 */

import { useCallback, useEffect, useState } from 'react'
import { Wand2, Plus, RefreshCw, ExternalLink, Sparkles } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Rule {
  id: string; name: string; description?: string | null; trigger: string
  conditions?: unknown; actions?: unknown; enabled: boolean; dryRun: boolean
  scopeMarketplace?: string | null; executionCount?: number; lastExecutedAt?: string | null
}
const TRIG: Record<string, string> = {
  FBA_AGE_THRESHOLD_REACHED: 'Aged inventory', AD_SPEND_PROFITABILITY_BREACH: 'Unprofitable spend',
  CAC_SPIKE: 'ACOS spike', AD_TARGET_UNDERPERFORMING: 'Underperforming target',
}
const ACT: Record<string, string> = {
  bid_down: 'Lower bid', bid_up: 'Raise bid', pause_ad_group: 'Pause ad group', pause_campaign: 'Pause campaign',
  adjust_ad_budget: 'Adjust budget', create_amazon_promotion: 'Create promo', bid_to_target_acos: 'Bid→target ACOS',
  pace_budget: 'Pace budget', add_negative: 'Add negative', liquidate_aged_stock: 'Liquidate stock',
  reroute_marketplace_budget: 'Reroute budget', defend_top_of_search: 'Defend ToS', notify: 'Notify',
}
const LEGACY = '/marketing/advertising/automation'
const actLabel = (a: { type?: string }) => (a?.type ? ACT[a.type] ?? a.type : 'action')
const when = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : 'never')

export function AutomationClient({ initial }: { initial: Rule[] }) {
  const [rules, setRules] = useState<Rule[]>(initial)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const refetch = useCallback(async () => {
    setLoading(true)
    try {
      const d = await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ items: [] }))
      setRules((d.items ?? []) as Rule[])
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void refetch() }, [refetch])

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusy(id)
    try { await fetch(`${getBackendUrl()}/api/advertising/automation-rules/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); await refetch() } finally { setBusy(null) }
  }
  const seed = async () => {
    setBusy('seed')
    try { await fetch(`${getBackendUrl()}/api/advertising/automation-rules/seed-templates`, { method: 'POST' }); await refetch() } finally { setBusy(null) }
  }

  const live = rules.filter((r) => r.enabled && !r.dryRun).length
  const dry = rules.filter((r) => r.enabled && r.dryRun).length
  const off = rules.filter((r) => !r.enabled).length
  const runs = rules.reduce((a, r) => a + (r.executionCount ?? 0), 0)
  const mode = (r: Rule) => (!r.enabled ? { cls: 'off', label: 'Off' } : r.dryRun ? { cls: 'dry', label: 'Dry-run' } : { cls: 'live', label: 'Live' })

  return (
    <>
      <div className="top">
        <div><h1>Automation</h1><div className="sub">{rules.length} rules · {live} live · {dry} dry-run</div></div>
        <span className="spacer" />
        <a className="ctl" href={`${LEGACY}/new`} target="_blank" rel="noopener noreferrer" title="Open the rule builder in a new tab"><Plus size={14} /><span>New rule</span></a>
        <a className="ctl" href={`${LEGACY}/library`} target="_blank" rel="noopener noreferrer">Library <ExternalLink size={12} /></a>
        <button className="ctl" onClick={() => void refetch()} title="Refresh"><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>
      </div>

      <div className="scroll">
        <div className="statrow">
          <div className="stat"><div className="sv" style={{ color: 'var(--green)' }}>{live}</div><div className="sl">Live</div></div>
          <div className="stat"><div className="sv" style={{ color: 'var(--amber)' }}>{dry}</div><div className="sl">Dry-run</div></div>
          <div className="stat"><div className="sv" style={{ color: 'var(--slate)' }}>{off}</div><div className="sl">Disabled</div></div>
          <div className="stat"><div className="sv">{runs}</div><div className="sl">Total runs</div></div>
        </div>

        {rules.length === 0 ? (
          <div className="card"><div className="bd" style={{ textAlign: 'center', padding: 40 }}>
            <div className="ph-hero" style={{ margin: '0 auto 14px' }}><Wand2 /></div>
            <h2 style={{ margin: '0 0 6px' }}>No automation rules yet</h2>
            <p style={{ color: 'var(--ink3)', maxWidth: 480, margin: '0 auto 16px', lineHeight: 1.6 }}>Seed the starter templates (pause aged stock, cut unprofitable spend, ACOS-spike defense, prune underperformers) or build your own. New rules start <b>Off + dry-run</b> for safety.</p>
            <button className="btn ok" onClick={() => void seed()} disabled={busy === 'seed'}><Sparkles size={14} />{busy === 'seed' ? 'Seeding…' : 'Seed starter templates'}</button>
          </div></div>
        ) : (
          <div className="card">
            <div className="tablewrap"><table>
              <thead><tr><th className="l">Rule</th><th className="l">Trigger</th><th className="l">Actions</th><th>Mode</th><th>Last run</th><th>Runs</th><th></th></tr></thead>
              <tbody>
                {rules.map((r) => {
                  const m = mode(r)
                  const acts = Array.isArray(r.actions) ? (r.actions as Array<{ type?: string }>) : []
                  return (
                    <tr key={r.id}>
                      <td className="l"><div style={{ fontWeight: 650 }}>{r.name}</div>{r.description && <div className="sub">{r.description}</div>}{r.scopeMarketplace && <span className="pill n" style={{ marginTop: 4 }}>{r.scopeMarketplace}</span>}</td>
                      <td className="l"><span className="trg">{TRIG[r.trigger] ?? r.trigger}</span></td>
                      <td className="l">{acts.length === 0 ? <span className="sub">—</span> : acts.slice(0, 3).map((a, i) => <span key={i} className="pill n" style={{ marginRight: 4 }}>{actLabel(a)}</span>)}{acts.length > 3 && <span className="sub">+{acts.length - 3}</span>}</td>
                      <td><span className={`modepill ${m.cls}`}>{m.label}</span></td>
                      <td className="num">{when(r.lastExecutedAt)}</td>
                      <td className="num">{r.executionCount ?? 0}</td>
                      <td><div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button className="iact" disabled={busy === r.id} onClick={() => void patch(r.id, { enabled: !r.enabled })}>{r.enabled ? 'Disable' : 'Enable'}</button>
                        {r.enabled && <button className="iact" disabled={busy === r.id} onClick={() => void patch(r.id, { dryRun: !r.dryRun })} title="Toggle dry-run vs live">{r.dryRun ? 'Go live' : 'Dry-run'}</button>}
                      </div></td>
                    </tr>
                  )
                })}
              </tbody>
            </table></div>
            <div className="legend" style={{ padding: '12px 14px' }}><span><b>Mode</b> — Off: inactive · Dry-run: evaluates + logs, no writes · Live: applies via the gated path. New rules start Off + dry-run.</span></div>
          </div>
        )}
      </div>
    </>
  )
}
