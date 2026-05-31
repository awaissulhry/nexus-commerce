/**
 * Trading Desk — Dashboard (Phase 1), standalone & styled exactly like the
 * approved spike. Profit-native KPI strip wired to live data
 * (/api/advertising/summary) + a launcher into the 7 surfaces (which open the
 * existing tools in a new tab until rebuilt natively here).
 */
import type { Metadata } from 'next'
import {
  Megaphone, ListChecks, Wand2, Crosshair, BarChart3, Settings, ArrowUpRight, Flag, Calendar,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

export const metadata: Metadata = { title: 'Trading Desk · Advertising' }
export const dynamic = 'force-dynamic'

interface Summary {
  campaignCount: number
  adSpend30dCents: number
  grossRevenue30dCents: number
  trueProfit30dCents: number
  trueProfitMargin30dPct: number | null
  agedSkusFlagged: number
  mode: 'sandbox' | 'live' | string
}

async function getSummary(): Promise<Summary | null> {
  try {
    const res = await fetch(`${getBackendUrl()}/api/advertising/summary`, { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as Summary
  } catch {
    return null
  }
}

const eur0 = (c: number | null | undefined) =>
  c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(c / 100)
const pct1 = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}%`)

interface Area { title: string; desc: string; href: string; icon: LucideIcon; phase?: string; native?: boolean }
const AREAS: Area[] = [
  { title: 'Campaigns', desc: 'Dense omni-channel grid — by campaign or by product, inline bids & budgets, bulk actions.', href: '/marketing/trading-desk/campaigns', icon: Megaphone, native: true },
  { title: 'Suggestions', desc: 'One inbox for every bid, keyword graduation, negative, budget & retail-pause proposal.', href: '/marketing/trading-desk/suggestions', icon: ListChecks, native: true },
  { title: 'Automation', desc: 'Rules, goals, dayparting, budget pacing & retail-aware guards — each with auto-apply.', href: '/marketing/advertising/automation', icon: Wand2, phase: 'P4–9' },
  { title: 'Competitive', desc: 'Share of Voice, SQP & competitor moves feeding top-of-search defense.', href: '/marketing/advertising/share-of-voice', icon: Crosshair, phase: 'P9' },
  { title: 'Analytics', desc: 'Trends, true profit, search terms & reports — profit-native by default.', href: '/marketing/advertising/analytics', icon: BarChart3, phase: 'P11' },
  { title: 'Settings', desc: 'Connections, live-write gates, budget caps & tags.', href: '/marketing/advertising/debug', icon: Settings },
]

export default async function TradingDeskDashboard() {
  const s = await getSummary()
  const live = s?.mode === 'live'

  return (
    <>
      <div className="top">
        <div>
          <h1>Dashboard</h1>
          <div className="sub">Last 30 days · all markets</div>
        </div>
        <span className={`pill ${live ? 'g' : 'a'}`} style={{ marginLeft: 6 }}>{live ? 'Live writes' : 'Sandbox'}</span>
        <span className="spacer" />
        <div className="chips">
          <span className="chip on"><span className="dot" style={{ background: 'var(--az)' }} />Amazon</span>
          <span className="chip off" title="Goes live in Phase 12"><span className="dot" style={{ background: 'var(--ebay)' }} />eBay</span>
          <span className="chip off" title="Goes live in Phase 12"><span className="dot" style={{ background: 'var(--shop)' }} />Shopify</span>
        </div>
        <div className="ctl"><Flag size={14} /><span>IT · DE · FR · ES</span></div>
        <div className="ctl"><Calendar size={14} /><span>Last 30 days</span></div>
      </div>

      <div className="scroll">
        <div className="grid5" style={{ marginBottom: 18 }}>
          <Kpi label="Ad spend · 30d" value={eur0(s?.adSpend30dCents)} />
          <Kpi label="Gross revenue · 30d" value={eur0(s?.grossRevenue30dCents)} />
          <div className="card kpi hero">
            <div className="lbl">True profit · 30d ◆</div>
            <div className="val">{eur0(s?.trueProfit30dCents)}</div>
            <div className="dlt up">{pct1(s?.trueProfitMargin30dPct)} margin</div>
          </div>
          <Kpi label="Active campaigns" value={s ? String(s.campaignCount) : '—'} />
          <Kpi label="Aged SKUs flagged" value={s ? String(s.agedSkusFlagged) : '—'} detail="LTS risk ≤ 30d" />
        </div>

        <div className="sectlbl">Surfaces</div>
        <div className="grid3">
          {AREAS.map((a) => {
            const Icon = a.icon
            return (
              <a key={a.title} className="lnk" href={a.href} target={a.native ? undefined : '_blank'} rel={a.native ? undefined : 'noopener noreferrer'}>
                <div className="li"><Icon size={18} /></div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="lt">
                    <span>{a.title}</span>
                    {!a.native && <ArrowUpRight className="ext" size={13} />}
                    {a.phase && <span className="tag">{a.phase}</span>}
                  </div>
                  <div className="ld">{a.desc}</div>
                </div>
              </a>
            )
          })}
        </div>

        <div className="foot-note">
          Phase 1 of the advertising rebuild — a standalone hub, separate from the untouched{' '}
          <a href="/marketing/advertising" target="_blank" rel="noopener noreferrer">classic Advertising</a>{' '}
          section. KPIs are live from your real account.
        </div>
      </div>
    </>
  )
}

function Kpi({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="card kpi">
      <div className="lbl">{label}</div>
      <div className="val">{value}</div>
      {detail && <div className="dlt" style={{ color: 'var(--ink3)', fontWeight: 600 }}>{detail}</div>}
    </div>
  )
}
