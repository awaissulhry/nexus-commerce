'use client'

/**
 * Automation analytics & reports — a live, multi-source dashboard: engine health
 * (executions, success, est. hours saved), the recommendation opportunity by
 * category, automation posture (rules by action type + trigger), the account
 * performance trend for context, a per-rule leaderboard, and CSV export. All
 * data live end-to-end (/automation-health, /automation-rule-executions,
 * /recommendations, /automation-rules, /trends).
 */

import { useEffect, useMemo, useState } from 'react'
import { BarChart3, RefreshCw, Download } from 'lucide-react'
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts'
import { getBackendUrl } from '@/lib/backend-url'

interface Rule { id: string; name: string; trigger: string; actions: Array<{ type?: string }>; enabled: boolean; dryRun: boolean; evaluationCount: number; matchCount: number; executionCount: number; domain: string }
interface Health { executions30d?: { total: number; success: number; failed: number; dryRun: number }; matches30d?: number; successRatePct?: number | null; estTimeSavedHours?: number; rules?: { total: number; live: number; dryRun: number; disabled: number } }
interface RecResp { counts?: Record<string, number>; potentialMonthlyImpactCents?: number }
interface Trend { date: string; adSpendCents: number; adSalesCents: number }

const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(c / 100))
const ACTION_LABEL: Record<string, string> = { bid_down: 'Bid down', bid_up: 'Bid up', lower_bid_to_floor: 'Bid → floor', adjust_ad_budget: 'Adj. budget', set_daily_budget: 'Set budget', set_campaign_target_acos: 'Target ACOS', pause_campaign: 'Pause camp.', pause_ad_group: 'Pause group', pause_all_campaigns: 'Pause all', archive_keyword: 'Archive kw', add_negative_exact: 'Negate', promote_to_exact: 'Promote', harvest_and_negate: 'Harvest', retail_guard: 'Retail guard', liquidate_aged_stock: 'Liquidate', create_amazon_promotion: 'Promo', set_placement_multiplier: 'Placement', reroute_marketplace_budget: 'Reroute', sync_negatives_across_campaigns: 'Sync neg.', raise_bids_for_rank_defense: 'Rank defend', scale_bids_for_price_change: 'Re-bid price', bid_to_target_acos: 'Bid optimise', alert_operator: 'Alert', notify: 'Notify', resume_campaign: 'Resume', enable_campaign: 'Enable' }
const BAR = ['#232f3e', '#0a7cd1', '#067d62', '#ff9900', '#8b5cf6', '#e11d48', '#0d9488', '#b45309']

export function AnalyticsTab() {
  const [rules, setRules] = useState<Rule[]>([])
  const [health, setHealth] = useState<Health | null>(null)
  const [recs, setRecs] = useState<RecResp | null>(null)
  const [trend, setTrend] = useState<Trend[]>([])
  const [loading, setLoading] = useState(true)
  const load = () => {
    setLoading(true)
    const b = getBackendUrl()
    Promise.all([
      fetch(`${b}/api/advertising/automation-rules`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ items: [] })),
      fetch(`${b}/api/advertising/automation-health`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
      fetch(`${b}/api/advertising/recommendations?limit=80`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
      fetch(`${b}/api/advertising/trends?windowDays=30`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ rows: [] })),
    ]).then(([ru, he, re, tr]) => { setRules((ru.items ?? []).filter((r: Rule) => r.domain === 'advertising')); setHealth(he); setRecs(re); setTrend(tr.rows ?? []) }).finally(() => setLoading(false))
  }
  useEffect(load, [])

  const actionBreakdown = useMemo(() => {
    const m: Record<string, number> = {}
    for (const r of rules) for (const a of (r.actions ?? [])) { const t = a?.type; if (!t || t === 'notify') continue; m[t] = (m[t] ?? 0) + 1 }
    return Object.entries(m).map(([type, count]) => ({ name: ACTION_LABEL[type] ?? type, count })).sort((a, b) => b.count - a.count).slice(0, 8)
  }, [rules])
  const spendTrend = useMemo(() => trend.map((t) => ({ date: t.date.slice(5), spend: Math.round(t.adSpendCents / 100), sales: Math.round(t.adSalesCents / 100) })), [trend])
  const leaderboard = useMemo(() => [...rules].sort((a, b) => (b.executionCount + b.matchCount) - (a.executionCount + a.matchCount)).slice(0, 12), [rules])
  const recRows = useMemo(() => Object.entries(recs?.counts ?? {}).map(([k, v]) => ({ k, v })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v), [recs])

  const exportCsv = () => {
    const head = ['Rule', 'Trigger', 'Status', 'Mode', 'Evaluations', 'Matches', 'Executions']
    const lines = [head.join(',')]
    for (const r of rules) lines.push([r.name, r.trigger, r.enabled ? 'Active' : 'Off', r.dryRun ? 'Dry-run' : 'Live', r.evaluationCount, r.matchCount, r.executionCount].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(','))
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); const a = document.createElement('a'); a.href = url; a.download = 'automation-report.csv'; a.click(); URL.revokeObjectURL(url)
  }

  const exec = health?.executions30d
  return (
    <div style={{ paddingTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{ fontWeight: 700 }}><BarChart3 size={15} style={{ verticalAlign: 'text-bottom', marginRight: 5 }} />Automation analytics &amp; reports</span>
        <span style={{ flex: 1 }} />
        <button className="az-btn" onClick={exportCsv}><Download size={14} />Export report</button>
        <button className="az-iconbtn" onClick={load} title="Refresh"><RefreshCw size={15} className={loading ? 'az-spin' : ''} /></button>
      </div>

      <div className="az-hero">
        <div className="az-stat"><div className="k">Executions (30d)</div><div className="v">{exec?.total ?? 0}</div><div className="s">{exec?.success ?? 0} ok · {exec?.dryRun ?? 0} dry</div></div>
        <div className="az-stat"><div className="k">Matches (30d)</div><div className="v">{health?.matches30d ?? 0}</div><div className="s">conditions met</div></div>
        <div className="az-stat"><div className="k">Success rate</div><div className="v">{health?.successRatePct != null ? `${health.successRatePct}%` : '—'}</div><div className="s">of executions</div></div>
        <div className="az-stat"><div className="k">Hours saved</div><div className="v" style={{ color: 'var(--green)' }}>{(health?.estTimeSavedHours ?? 0).toFixed(1)}</div><div className="s">vs manual (30d)</div></div>
        <div className="az-stat"><div className="k">Opportunity</div><div className="v" style={{ color: 'var(--green)' }}>{eur(recs?.potentialMonthlyImpactCents)}</div><div className="s">/mo from recommendations</div></div>
        <div className="az-stat"><div className="k">Rules live</div><div className="v">{health?.rules?.live ?? 0}<span style={{ fontSize: 12, color: 'var(--ink2)', fontWeight: 500 }}> / {health?.rules?.total ?? rules.length}</span></div><div className="s">{health?.rules?.dryRun ?? 0} dry · {health?.rules?.disabled ?? 0} off</div></div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(360px,1fr))', gap: 16, margin: '6px 0 16px' }}>
        <div className="az-eng-card">
          <h4>Automation posture — actions in play</h4>
          <p style={{ marginBottom: 8 }}>What your enabled rules are configured to do.</p>
          <div style={{ height: 230 }}>
            {actionBreakdown.length === 0 ? <div className="az-empty">Add automations to see the breakdown.</div> : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={actionBreakdown} layout="vertical" margin={{ left: 18, right: 12, top: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e7e7e7" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: '#565959' }} allowDecimals={false} />
                  <YAxis type="category" dataKey="name" width={80} tick={{ fontSize: 11, fill: '#565959' }} />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #d5d9d9' }} cursor={{ fill: 'rgba(0,0,0,.04)' }} />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>{actionBreakdown.map((_, i) => <Cell key={i} fill={BAR[i % BAR.length]} />)}</Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
        <div className="az-eng-card">
          <h4>Account performance — 30 days (context)</h4>
          <p style={{ marginBottom: 8 }}>Ad spend vs ad sales the automation is steering.</p>
          <div style={{ height: 230 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={spendTrend} margin={{ left: 4, right: 8, top: 4, bottom: 4 }}>
                <defs>
                  <linearGradient id="gSales" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#067d62" stopOpacity={0.3} /><stop offset="100%" stopColor="#067d62" stopOpacity={0} /></linearGradient>
                  <linearGradient id="gSpend" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#ff9900" stopOpacity={0.3} /><stop offset="100%" stopColor="#ff9900" stopOpacity={0} /></linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e7e7e7" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#565959' }} minTickGap={24} />
                <YAxis tick={{ fontSize: 11, fill: '#565959' }} width={44} tickFormatter={(v: number) => `€${v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v}`} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #d5d9d9' }} />
                <Area type="monotone" dataKey="sales" stroke="#067d62" strokeWidth={2} fill="url(#gSales)" />
                <Area type="monotone" dataKey="spend" stroke="#ff9900" strokeWidth={2} fill="url(#gSpend)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {recRows.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <h4 style={{ margin: '0 2px 8px', fontSize: 13.5 }}>Opportunity by category</h4>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{recRows.map((r) => <span key={r.k} className="chip" style={{ border: '1px solid var(--border)', borderRadius: 16, padding: '5px 12px', fontWeight: 600, fontSize: 12.5, textTransform: 'capitalize' }}>{r.k}: <b>{r.v}</b></span>)}</div>
        </div>
      )}

      <h4 style={{ margin: '4px 2px 8px', fontSize: 13.5 }}>Rule leaderboard</h4>
      <div className="az-tablewrap">
        <table className="az-table">
          <thead><tr><th className="l">Rule</th><th className="l">Trigger</th><th className="l">Status</th><th>Evaluations</th><th>Matches</th><th>Executions</th></tr></thead>
          <tbody>
            {leaderboard.length === 0 && <tr><td className="az-empty" colSpan={6}>{loading ? 'Loading…' : 'No rules yet.'}</td></tr>}
            {leaderboard.map((r) => (
              <tr key={r.id}>
                <td className="l" style={{ fontWeight: 500 }}>{r.name}</td>
                <td className="l">{r.trigger === 'SCHEDULE' ? 'Scheduled' : r.trigger.replace(/_/g, ' ').toLowerCase()}</td>
                <td className="l">{r.enabled ? <span className={`az-live ${r.dryRun ? 'dry' : 'on'}`}>{r.dryRun ? 'Dry run' : 'LIVE'}</span> : <span className="az-badge paused">Off</span>}</td>
                <td className="num">{r.evaluationCount}</td><td className="num">{r.matchCount}</td><td className="num">{r.executionCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
