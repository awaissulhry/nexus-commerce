'use client'

/**
 * Health & activity — how the automation engine is performing. Live from
 * GET /automation-health (rule posture, 30-day execution stats, est. hours
 * saved, risk flags) + GET /automation-rule-executions (recent activity log).
 */

import { useEffect, useState } from 'react'
import { Activity, Clock, AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cleanName } from './_icons'

interface Health {
  rules: { total: number; live: number; dryRun: number; disabled: number }
  executions30d: { total: number; success: number; partial: number; failed: number; dryRun: number; noMatch: number }
  matches30d: number; successRatePct: number | null; estTimeSavedHours: number
  risks: { stuckInDryRun: number; disabled: number; recentFailures: number; noManaging: boolean }
  recent: Array<{ id: string; ruleId?: string; ruleName?: string; status?: string; startedAt?: string; errorMessage?: string }>
}
interface Exec { id: string; ruleId?: string; ruleName?: string; status?: string; startedAt?: string; errorMessage?: string; actionsApplied?: number }
const fdt = (s?: string) => (s ? new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')
const stColor = (s?: string) => (s === 'SUCCESS' ? 'var(--green)' : s === 'FAILED' ? '#cc1100' : s === 'PARTIAL' ? 'var(--amber)' : 'var(--ink2)')

export function HealthTab() {
  const [h, setH] = useState<Health | null>(null)
  const [execs, setExecs] = useState<Exec[]>([])
  const load = () => {
    void fetch(`${getBackendUrl()}/api/advertising/automation-health`, { cache: 'no-store' }).then((r) => r.json()).then(setH).catch(() => {})
    void fetch(`${getBackendUrl()}/api/advertising/automation-rule-executions?limit=60`, { cache: 'no-store' }).then((r) => r.json()).then((d) => setExecs(d.items ?? [])).catch(() => {})
  }
  useEffect(load, [])

  const risks = h?.risks
  const riskItems = risks ? [
    risks.recentFailures > 0 && { t: `${risks.recentFailures} rule(s) failing recently`, sev: 'high' },
    risks.noManaging && { t: 'No rule is actively managing — nothing is live', sev: 'medium' },
    risks.stuckInDryRun > 0 && { t: `${risks.stuckInDryRun} rule(s) stuck in dry-run`, sev: 'low' },
  ].filter(Boolean) as Array<{ t: string; sev: string }> : []

  return (
    <div style={{ paddingTop: 4 }}>
      <div className="az-hero">
        <div className="az-stat"><div className="k">Hours saved (30d)</div><div className="v" style={{ color: 'var(--green)' }}>{h ? h.estTimeSavedHours.toFixed(1) : '…'}</div><div className="s">vs doing it by hand</div></div>
        <div className="az-stat"><div className="k">Executions (30d)</div><div className="v">{h?.executions30d.total ?? '…'}</div><div className="s">{h?.executions30d.success ?? 0} ok · {h?.executions30d.failed ?? 0} failed · {h?.executions30d.dryRun ?? 0} dry</div></div>
        <div className="az-stat"><div className="k">Matches (30d)</div><div className="v">{h?.matches30d ?? '…'}</div><div className="s">trigger conditions met</div></div>
        <div className="az-stat"><div className="k">Success rate</div><div className="v">{h?.successRatePct != null ? `${h.successRatePct}%` : '—'}</div><div className="s">{h?.rules.live ?? 0} live · {h?.rules.dryRun ?? 0} dry · {h?.rules.disabled ?? 0} off</div></div>
      </div>

      {riskItems.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          {riskItems.map((r, i) => (
            <div key={i} className="az-rec" style={{ marginBottom: 6 }}><span className={`sev ${r.sev}`} /><div className="body"><div className="t"><AlertTriangle size={13} style={{ verticalAlign: 'text-bottom', color: r.sev === 'high' ? '#cc1100' : 'var(--amber)' }} /> {r.t}</div></div></div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 2px 10px' }}>
        <span style={{ fontWeight: 700 }}><Activity size={15} style={{ verticalAlign: 'text-bottom', marginRight: 5 }} />Activity log</span>
        <span style={{ flex: 1 }} />
        <button className="az-iconbtn" onClick={load} title="Refresh"><RefreshCw size={15} /></button>
      </div>
      <div className="az-tablewrap">
        <table className="az-table">
          <thead><tr><th className="l">When</th><th className="l">Rule</th><th className="l">Status</th><th>Actions</th><th className="l">Detail</th></tr></thead>
          <tbody>
            {execs.length === 0 && <tr><td className="az-empty" colSpan={5}><Clock size={14} style={{ verticalAlign: 'text-bottom' }} /> No executions yet — enable a rule and it’ll show here.</td></tr>}
            {execs.map((e) => (
              <tr key={e.id}>
                <td className="l">{fdt(e.startedAt)}</td>
                <td className="l">{cleanName(e.ruleName ?? e.ruleId ?? '—')}</td>
                <td className="l"><span style={{ color: stColor(e.status), fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>{e.status === 'SUCCESS' ? <CheckCircle2 size={13} /> : e.status === 'FAILED' ? <AlertTriangle size={13} /> : null}{e.status ?? '—'}</span></td>
                <td className="num">{e.actionsApplied ?? 0}</td>
                <td className="l"><span className="sub">{e.errorMessage ?? ''}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
