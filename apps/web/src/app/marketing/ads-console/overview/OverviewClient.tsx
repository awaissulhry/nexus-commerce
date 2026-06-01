'use client'

/**
 * Automation Console — Overview (Phase 3 upgrade).
 * Live-refreshing command centre: SSE + reconnect keeps the health strip and
 * today's spend accurate as rules fire and campaigns update.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import Link from 'next/link'
import { ExternalLink, Zap, Crosshair, Activity, TrendingUp, ShieldAlert, BarChart3, CheckCircle, AlertTriangle, Clock, Radio } from 'lucide-react'
import { amazonCampaignsHref, marketLabel } from '../_shared/amazonLinks'
import { getBackendUrl } from '@/lib/backend-url'

const BASE = '/marketing/ads-console'
const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(c / 100))
const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`)
const num = (n: number | null | undefined) => n == null ? '—' : new Intl.NumberFormat('en-US').format(n)

interface Conn { profileId: string; marketplace: string; isActive: boolean; mode: string }
interface Camp { marketplace: string | null; spend: string; acos: string | null; status: string }
interface Rule { id: string; name: string; enabled: boolean; dryRun: boolean; trigger: string }
interface Rec { id: string; title: string; detail: string; estImpactCents?: number; severity: string }
interface Health {
  rules: { total: number; live: number; dryRun: number; disabled: number }
  executions30d: { total: number; success: number; failed: number; dryRun: number }
  successRatePct: number | null
  estTimeSavedHours: number
  risks: { stuckInDryRun: number; disabled: number; recentFailures: number; noManaging: boolean }
  recent: Array<{ ruleName: string; status: string; marketplace?: string; ts: number }>
}
interface Trends { summary: { spendCents: number; salesCents: number; impressions: number; clicks: number; orders: number; acos: number | null } }
interface Props {
  conns: Conn[]
  camps: Camp[]
  rules: Rule[]
  recs: { recommendations?: Rec[]; potentialMonthlyImpactCents?: number } | null
  state: { autonomy?: string; halted?: boolean; effectivelyStopped?: boolean } | null
  health: Health | null
  trends: Trends | null
}

const relTime = (ts: number) => { const s = Math.floor((Date.now() - ts) / 1000); if (s < 5) return 'just now'; if (s < 60) return `${s}s ago`; const m = Math.floor(s / 60); return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago` }

export function OverviewClient({ conns, camps, rules, recs, state, health: initialHealth, trends: initialTrends }: Props) {
  const [health, setHealth] = useState<Health | null>(initialHealth)
  const [trends, setTrends] = useState<Trends | null>(initialTrends)
  const [liveCount, setLiveCount] = useState(0)
  const [connected, setConnected] = useState(false)
  const lastTs = useRef(Date.now())

  const activeConns = conns.filter(c => c.isActive)
  const activeRules = rules.filter(r => r.enabled)
  const liveRules = activeRules.filter(r => !r.dryRun)
  const opportunity = recs?.potentialMonthlyImpactCents ?? 0
  const recommendations = recs?.recommendations?.slice(0, 3) ?? []
  const isHalted = state?.effectivelyStopped || state?.halted
  const todaySpend = trends?.summary.spendCents ?? 0
  const todayOrders = trends?.summary.orders ?? 0

  // Aggregate spend per marketplace
  const spendByMkt: Record<string, { spendCents: number; acosSum: number; acosCount: number; count: number }> = {}
  for (const c of camps) {
    if (!c.marketplace) continue
    const spend = Math.round(Number(c.spend) * 100)
    const a = c.acos != null ? Number(c.acos) : null
    const m = (spendByMkt[c.marketplace] ??= { spendCents: 0, acosSum: 0, acosCount: 0, count: 0 })
    m.spendCents += spend; m.count++
    if (a != null) { m.acosSum += a; m.acosCount++ }
  }

  // Refresh health on each rule execution
  const refreshHealth = useCallback(async () => {
    try {
      const d = await fetch(`${getBackendUrl()}/api/advertising/automation-health`, { cache: 'no-store' }).then(r => r.json())
      setHealth(d)
      const t = await fetch(`${getBackendUrl()}/api/advertising/trends?windowDays=1`, { cache: 'no-store' }).then(r => r.json())
      setTrends(t)
    } catch { /* silent */ }
  }, [])

  // SSE — listen for executions and refresh health
  useEffect(() => {
    const connect = () => {
      const es = new EventSource(`${getBackendUrl()}/api/advertising/execution-events?since=${lastTs.current}`)
      es.addEventListener('ping', () => setConnected(true))
      es.addEventListener('automation.rule.fired', (ev) => {
        try { const e = JSON.parse(ev.data); lastTs.current = Math.max(lastTs.current, e.ts); setLiveCount(n => n + 1); void refreshHealth() } catch { /* ignore */ }
      })
      es.onerror = () => { setConnected(false); es.close(); setTimeout(connect, 10_000) }
      return es
    }
    const es = connect()
    return () => { es.close(); setConnected(false) }
  }, [refreshHealth])

  const risks = health?.risks
  const hasRisks = risks && (risks.stuckInDryRun > 0 || risks.recentFailures > 0 || risks.noManaging)

  return (
    <div className="az-wrap">
      <div className="az-listhead">
        <span className="title"><BarChart3 size={18} style={{ marginRight: 6, color: 'var(--orange)' }} />Overview</span>
        <span style={{ flex: 1 }} />
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: connected ? 'var(--green)' : 'var(--ink3)' }}>
          <Radio size={12} />{connected ? 'Live' : 'Reconnecting…'}{liveCount > 0 && <span style={{ fontWeight: 700, color: 'var(--green)', marginLeft: 3 }}>+{liveCount}</span>}
        </span>
      </div>

      {/* KPI strip — 6 tiles */}
      <div className="az-hero" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
        <div className="az-stat">
          <div className="k">Today's spend</div>
          <div className="v">{eur(todaySpend)}</div>
          <div className="s">{num(todayOrders)} order{todayOrders !== 1 ? 's' : ''} today</div>
        </div>
        <div className="az-stat">
          <div className="k">Rules</div>
          <div className="v">{health?.rules.total ?? activeRules.length}</div>
          <div className="s">{health?.rules.live ?? liveRules.length} live · {health?.rules.dryRun ?? (activeRules.length - liveRules.length)} dry-run</div>
        </div>
        <div className="az-stat">
          <div className="k">Executions (30d)</div>
          <div className="v">{num(health?.executions30d.total ?? 0)}</div>
          <div className="s">{health?.successRatePct != null ? `${health.successRatePct.toFixed(0)}% success rate` : 'no executions yet'}</div>
        </div>
        <div className="az-stat">
          <div className="k">Time saved (est.)</div>
          <div className="v" style={{ color: 'var(--green)' }}>{health?.estTimeSavedHours ?? 0}h</div>
          <div className="s">manual work automated (30d)</div>
        </div>
        <div className="az-stat">
          <div className="k">Engine</div>
          <div className="v" style={{ color: isHalted ? '#cc1100' : 'var(--green)' }}>{isHalted ? 'Halted' : state?.autonomy ?? 'AUTO'}</div>
          <div className="s">{isHalted ? 'kill-switch active' : 'running normally'}</div>
        </div>
        <div className="az-stat">
          <div className="k">Opportunity / mo</div>
          <div className="v" style={{ color: 'var(--green)' }}>{eur(opportunity)}</div>
          <div className="s">{recommendations.length} recommendations</div>
        </div>
      </div>

      {/* Alerts */}
      {isHalted && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: '#fff3f3', border: '1px solid #f4c7c0', borderRadius: 10, marginBottom: 12, fontSize: 13 }}>
          <ShieldAlert size={16} style={{ color: '#cc1100', flexShrink: 0 }} />
          <span>Automation is halted — no rules are firing. <Link href={`${BASE}/automation`} style={{ color: '#cc1100', fontWeight: 700 }}>Go to Guardrails to resume.</Link></span>
        </div>
      )}
      {hasRisks && !isHalted && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: '#fffbf0', border: '1px solid #f0d580', borderRadius: 10, marginBottom: 12, fontSize: 13 }}>
          <AlertTriangle size={16} style={{ color: '#cc6a00', flexShrink: 0 }} />
          <span>
            {risks.stuckInDryRun > 0 && <>{risks.stuckInDryRun} rule{risks.stuckInDryRun !== 1 ? 's' : ''} stuck in dry-run. </>}
            {risks.recentFailures > 0 && <>{risks.recentFailures} recent failure{risks.recentFailures !== 1 ? 's' : ''}. </>}
            {risks.noManaging && <>No live rules — automation has no effect. </>}
            <Link href={`${BASE}/automation`} style={{ color: '#cc6a00', fontWeight: 700 }}>Review in Automation.</Link>
          </span>
        </div>
      )}

      {/* Two-column layout */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 290px', gap: 20, alignItems: 'start', marginBottom: 20 }}>
        {/* Marketplace tiles */}
        <div>
          <h3 style={{ margin: '0 0 12px', fontSize: 13.5 }}>Marketplaces <span style={{ color: 'var(--ink2)', fontWeight: 500, fontSize: 12 }}>· {activeConns.length} active</span></h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10 }}>
            {activeConns.map(c => {
              const m = spendByMkt[c.marketplace]
              const acos = m && m.acosCount > 0 ? m.acosSum / m.acosCount : null
              const spend = m?.spendCents ?? 0
              return (
                <div key={c.marketplace} className="az-eng-card" style={{ padding: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{c.marketplace}</span>
                    <span style={{ flex: 1, color: 'var(--ink2)', fontSize: 12 }}>{marketLabel(c.marketplace)}</span>
                    {c.mode === 'production' && <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--green)', background: '#e8f5e9', borderRadius: 3, padding: '1px 5px' }}>LIVE</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
                    <div><div style={{ fontSize: 10.5, color: 'var(--ink3)', fontWeight: 600 }}>SPEND (30d)</div><div style={{ fontWeight: 700 }}>{eur(spend)}</div></div>
                    <div><div style={{ fontSize: 10.5, color: 'var(--ink3)', fontWeight: 600 }}>ACOS</div><div style={{ fontWeight: 700, color: acos != null && acos > 0.4 ? '#cc6a00' : 'inherit' }}>{pct(acos)}</div></div>
                    <div><div style={{ fontSize: 10.5, color: 'var(--ink3)', fontWeight: 600 }}>CAMPAIGNS</div><div style={{ fontWeight: 700 }}>{m?.count ?? 0}</div></div>
                  </div>
                  <a href={amazonCampaignsHref(c.profileId, c.marketplace)} target="_blank" rel="noopener noreferrer"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: 'var(--link)', textDecoration: 'none' }}>
                    Open in Amazon <ExternalLink size={11} />
                  </a>
                </div>
              )
            })}
            {activeConns.length === 0 && (
              <div style={{ color: 'var(--ink2)', fontSize: 13, padding: '20px 14px' }}>No active connections. Set them up in <Link href={`${BASE}/settings`} style={{ color: 'var(--link)' }}>Settings</Link>.</div>
            )}
          </div>

          {/* Recent automation activity */}
          {(health?.recent ?? []).length > 0 && (
            <div style={{ marginTop: 20 }}>
              <h3 style={{ margin: '0 0 10px', fontSize: 13.5 }}>Recent activity</h3>
              {(health!.recent).map((r, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--divider)', fontSize: 12.5 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: r.status === 'SUCCESS' ? 'var(--green)' : r.status === 'DRY_RUN' ? 'var(--navy)' : '#cc1100', flexShrink: 0 }} />
                  <span style={{ flex: 1, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.ruleName}</span>
                  {r.marketplace && <span className="az-badge">{r.marketplace}</span>}
                  <span style={{ color: 'var(--ink2)', flexShrink: 0 }}><Clock size={11} style={{ verticalAlign: 'text-bottom', marginRight: 3 }} />{relTime(r.ts)}</span>
                </div>
              ))}
              <Link href={`${BASE}/activity`} style={{ display: 'block', marginTop: 8, fontSize: 12, color: 'var(--link)', fontWeight: 600 }}>View full activity feed</Link>
            </div>
          )}
        </div>

        {/* Right column: quick actions + health summary + recommendations */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Automation health summary */}
          {health && (
            <div className="az-eng-card" style={{ padding: 14 }}>
              <h4 style={{ margin: '0 0 10px' }}>Automation health</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {[
                  { label: 'Live rules', v: health.rules.live, good: health.rules.live > 0, bad: false },
                  { label: 'Dry-run rules', v: health.rules.dryRun, good: false, bad: health.rules.dryRun > 0 && health.rules.live === 0 },
                  { label: 'Executions (30d)', v: health.executions30d.total, good: health.executions30d.total > 0, bad: false },
                  { label: 'Success rate', v: health.successRatePct != null ? `${health.successRatePct.toFixed(0)}%` : 'n/a', good: health.successRatePct != null && health.successRatePct >= 90, bad: health.successRatePct != null && health.successRatePct < 70 },
                ].map(row => (
                  <div key={row.label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    {row.good ? <CheckCircle size={13} style={{ color: 'var(--green)', flexShrink: 0 }} /> : row.bad ? <AlertTriangle size={13} style={{ color: '#cc6a00', flexShrink: 0 }} /> : <span style={{ width: 13, height: 13, flexShrink: 0 }} />}
                    <span style={{ flex: 1, color: 'var(--ink2)' }}>{row.label}</span>
                    <span style={{ fontWeight: 700 }}>{String(row.v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Quick actions */}
          <div className="az-eng-card" style={{ padding: 14 }}>
            <h4 style={{ margin: '0 0 10px' }}>Quick actions</h4>
            {([
              { href: `${BASE}/automation`, label: 'Manage automations', sub: `${liveRules.length} live · ${activeRules.length - liveRules.length} dry-run`, Icon: Zap },
              { href: `${BASE}/rank`, label: 'Rank Control', sub: 'Placement · Keywords · Strategy', Icon: Crosshair },
              { href: `${BASE}/activity`, label: 'Activity feed', sub: liveCount > 0 ? `+${liveCount} new since you arrived` : 'See what fired recently', Icon: Activity },
              { href: `${BASE}/automation`, label: 'Recommendations', sub: `${eur(opportunity)}/mo opportunity`, Icon: TrendingUp },
            ] as const).map(({ href, label, sub, Icon }) => (
              <Link key={label} href={href}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', borderRadius: 8, textDecoration: 'none', color: 'var(--ink)' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg3)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '' }}>
                <span style={{ color: 'var(--navy)', flexShrink: 0 }}><Icon size={16} /></span>
                <span><div style={{ fontWeight: 600, fontSize: 12.5 }}>{label}</div><div style={{ color: 'var(--ink2)', fontSize: 11 }}>{sub}</div></span>
              </Link>
            ))}
          </div>

          {/* Top recommendations */}
          {recommendations.length > 0 && (
            <div className="az-eng-card" style={{ padding: 14 }}>
              <h4 style={{ margin: '0 0 10px' }}>Top recommendations</h4>
              {recommendations.map(r => (
                <div key={r.id} style={{ display: 'flex', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--divider)' }}>
                  <span className={`sev ${r.severity}`} style={{ flexShrink: 0, marginTop: 3 }} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 12 }}>{r.title}</div>
                    {r.estImpactCents ? <div style={{ color: 'var(--green)', fontSize: 11, fontWeight: 600 }}>{eur(r.estImpactCents)}/mo</div> : null}
                  </div>
                </div>
              ))}
              <Link href={`${BASE}/automation`} style={{ display: 'block', marginTop: 8, fontSize: 12, color: 'var(--link)', fontWeight: 600 }}>View all recommendations</Link>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
