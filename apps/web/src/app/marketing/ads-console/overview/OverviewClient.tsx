'use client'

/**
 * Automation Console — Overview (Phase 1). The new landing page.
 *
 * Top strip: 4 KPI cards — Total spend (30d) · Active automations · Live rules ·
 *            Monthly opportunity from recommendations.
 *
 * Marketplace tiles: one card per active connection showing today's spend/ACOS
 * for that market + a prominent "Open in Amazon ↗" deep link to the real console.
 *
 * Quick actions: shortcuts to Automation / Rank Control / Activity.
 * Recommendations strip: top 3 from /recommendations.
 * Automation status: engine state + quick-toggle summary.
 */

import Link from 'next/link'
import { ExternalLink, Zap, Crosshair, Activity, TrendingUp, ShieldAlert, BarChart3 } from 'lucide-react'
import { amazonCampaignsHref, marketLabel } from '../_shared/amazonLinks'

const BASE = '/marketing/ads-console'

const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(c / 100))
const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`)

interface Conn { profileId: string; marketplace: string; isActive: boolean; mode: string }
interface Camp { marketplace: string | null; spend: string; acos: string | null; status: string }
interface Rule { id: string; name: string; enabled: boolean; dryRun: boolean; trigger: string }
interface Rec { id: string; title: string; detail: string; estImpactCents?: number; severity: string }
interface Props {
  conns: Conn[]
  camps: Camp[]
  rules: Rule[]
  recs: { recommendations?: Rec[]; potentialMonthlyImpactCents?: number } | null
  state: { autonomy?: string; halted?: boolean; effectivelyStopped?: boolean } | null
}

export function OverviewClient({ conns, camps, rules, recs, state }: Props) {
  const activeConns = conns.filter((c) => c.isActive)
  const activeRules = rules.filter((r) => r.enabled)
  const liveRules = activeRules.filter((r) => !r.dryRun)
  const opportunity = recs?.potentialMonthlyImpactCents ?? 0
  const recommendations = recs?.recommendations?.slice(0, 3) ?? []

  // Aggregate spend per marketplace across campaigns
  const spendByMkt: Record<string, { spendCents: number; acosSum: number; acosCount: number; count: number }> = {}
  for (const c of camps) {
    if (!c.marketplace) continue
    const spend = Math.round(Number(c.spend) * 100)
    const a = c.acos != null ? Number(c.acos) : null
    const m = (spendByMkt[c.marketplace] ??= { spendCents: 0, acosSum: 0, acosCount: 0, count: 0 })
    m.spendCents += spend; m.count++
    if (a != null) { m.acosSum += a; m.acosCount++ }
  }

  const totalSpendCents = Object.values(spendByMkt).reduce((s, m) => s + m.spendCents, 0)
  const isHalted = state?.effectivelyStopped || state?.halted

  return (
    <div className="az-wrap">
      {/* Page header */}
      <div className="az-listhead">
        <span className="title"><BarChart3 size={18} style={{ marginRight: 6, color: 'var(--orange)' }} />Overview</span>
      </div>

      {/* KPI strip */}
      <div className="az-hero">
        <div className="az-stat">
          <div className="k">Total spend (30d)</div>
          <div className="v">{eur(totalSpendCents)}</div>
          <div className="s">across {activeConns.length} market{activeConns.length !== 1 ? 's' : ''}</div>
        </div>
        <div className="az-stat">
          <div className="k">Active automations</div>
          <div className="v">{activeRules.length}</div>
          <div className="s">{liveRules.length} live · {activeRules.length - liveRules.length} dry-run</div>
        </div>
        <div className="az-stat">
          <div className="k">Engine status</div>
          <div className="v" style={{ color: isHalted ? '#cc1100' : 'var(--green)' }}>{isHalted ? 'Halted' : state?.autonomy ?? 'AUTO'}</div>
          <div className="s">{isHalted ? 'kill-switch active' : 'running normally'}</div>
        </div>
        <div className="az-stat">
          <div className="k">Opportunity / mo</div>
          <div className="v" style={{ color: 'var(--green)' }}>{eur(opportunity)}</div>
          <div className="s">{recommendations.length} recommendations waiting</div>
        </div>
      </div>

      {/* Halted warning */}
      {isHalted && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: '#fff3f3', border: '1px solid #f4c7c0', borderRadius: 10, marginBottom: 16, fontSize: 13 }}>
          <ShieldAlert size={16} style={{ color: '#cc1100', flexShrink: 0 }} />
          <span>Automation is halted — no rules are firing. <Link href={`${BASE}/automation`} style={{ color: '#cc1100', fontWeight: 700 }}>Go to Guardrails to resume.</Link></span>
        </div>
      )}

      {/* Two-column layout: markets + quick actions */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 20, alignItems: 'start', marginBottom: 20 }}>
        {/* Marketplace tiles */}
        <div>
          <h3 style={{ margin: '0 0 12px', fontSize: 13.5 }}>Marketplaces</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10 }}>
            {activeConns.map((c) => {
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
                    <div><div style={{ fontSize: 10.5, color: 'var(--ink3)', fontWeight: 600 }}>SPEND</div><div style={{ fontWeight: 700 }}>{eur(spend)}</div></div>
                    <div><div style={{ fontSize: 10.5, color: 'var(--ink3)', fontWeight: 600 }}>ACOS</div><div style={{ fontWeight: 700, color: acos != null && acos > 0.4 ? '#cc6a00' : 'inherit' }}>{pct(acos)}</div></div>
                    <div><div style={{ fontSize: 10.5, color: 'var(--ink3)', fontWeight: 600 }}>CAMPAIGNS</div><div style={{ fontWeight: 700 }}>{m?.count ?? 0}</div></div>
                  </div>
                  <a
                    href={amazonCampaignsHref(c.profileId, c.marketplace)}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: 'var(--link)', textDecoration: 'none', padding: '5px 0' }}
                  >
                    Open in Amazon <ExternalLink size={11} />
                  </a>
                </div>
              )
            })}
            {activeConns.length === 0 && (
              <div style={{ color: 'var(--ink2)', fontSize: 13, padding: '20px 14px' }}>No active marketplace connections. Set them up in <Link href={`${BASE}/settings`} style={{ color: 'var(--link)' }}>Settings</Link>.</div>
            )}
          </div>
        </div>

        {/* Quick actions + recommendations */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="az-eng-card" style={{ padding: 14 }}>
            <h4 style={{ margin: '0 0 10px' }}>Quick actions</h4>
            {([
              { href: `${BASE}/automation`, label: 'Manage automations', sub: `${activeRules.length} active rules`, Icon: Zap },
              { href: `${BASE}/rank`, label: 'Rank Control', sub: 'Placement · Keywords · Strategy', Icon: Crosshair },
              { href: `${BASE}/activity`, label: 'Activity feed', sub: 'See what fired recently', Icon: Activity },
              { href: `${BASE}/automation#recs`, label: 'Recommendations', sub: `${eur(opportunity)}/mo opportunity`, Icon: TrendingUp },
            ] as const).map(({ href, label, sub, Icon }) => (
              <Link key={href} href={href} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', borderRadius: 8, textDecoration: 'none', color: 'var(--ink)' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg3)' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '' }}>
                <span style={{ color: 'var(--navy)', flexShrink: 0 }}><Icon size={16} /></span>
                <span><div style={{ fontWeight: 600, fontSize: 12.5 }}>{label}</div><div style={{ color: 'var(--ink2)', fontSize: 11 }}>{sub}</div></span>
              </Link>
            ))}
          </div>

          {recommendations.length > 0 && (
            <div className="az-eng-card" style={{ padding: 14 }}>
              <h4 style={{ margin: '0 0 10px' }}>Top recommendations</h4>
              {recommendations.map((r) => (
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
