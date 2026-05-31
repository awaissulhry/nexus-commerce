/**
 * Trading Desk — Dashboard (Phase 1).
 *
 * The rebuilt advertising home: a clean profit-native overview (live KPIs
 * from /api/advertising/summary) + a launcher into the 7 surfaces. Surfaces
 * not yet rebuilt here open the existing tool in a new tab (↗). Built on the
 * existing legacy Campaign data — no migration; omni-channel (eBay/Shopify)
 * and the MarketingCampaign substrate land in later phases.
 */
import type { Metadata } from 'next'
import {
  Megaphone, ListChecks, Wand2, Crosshair, BarChart3, Settings,
  ArrowUpRight, Wallet, TrendingUp, Coins, Layers, PackageX, ShieldCheck, ShieldAlert,
} from 'lucide-react'
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

interface Area {
  title: string
  desc: string
  href: string
  icon: typeof Megaphone
  phase?: string
  native?: boolean
}
const AREAS: Area[] = [
  { title: 'Campaigns', desc: 'Dense omni-channel grid — by campaign or by product, inline bids & budgets, bulk actions.', href: '/marketing/advertising/campaigns', icon: Megaphone, phase: 'P2' },
  { title: 'Suggestions', desc: 'One inbox for every bid, keyword graduation, negative, budget & retail-pause proposal.', href: '/marketing/advertising/recommendations', icon: ListChecks, phase: 'P3' },
  { title: 'Automation', desc: 'Rules, goals, dayparting, budget pacing & retail-aware guards — each with auto-apply.', href: '/marketing/advertising/automation', icon: Wand2, phase: 'P4–9' },
  { title: 'Competitive', desc: 'Share of Voice, SQP, competitor moves feeding top-of-search defense.', href: '/marketing/advertising/share-of-voice', icon: Crosshair, phase: 'P9' },
  { title: 'Analytics', desc: 'Trends, true profit, search terms & reports — profit-native by default.', href: '/marketing/advertising/analytics', icon: BarChart3, phase: 'P11' },
  { title: 'Settings', desc: 'Connections, live-write gates, budget caps & tags.', href: '/marketing/advertising/debug', icon: Settings },
]

export default async function TradingDeskDashboard() {
  const s = await getSummary()
  const live = s?.mode === 'live'

  return (
    <div className="px-4 py-4 max-w-[1400px]">
      {/* Header */}
      <div className="flex items-center gap-3 mb-1">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Trading Desk</h1>
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
          live ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
               : 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300'}`}>
          {live ? <ShieldCheck size={12} /> : <ShieldAlert size={12} />}{live ? 'Live writes' : 'Sandbox'}
        </span>
      </div>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
        The rebuilt, simpler advertising cockpit — profit-native &amp; omni-channel.
        Surfaces marked <ArrowUpRight size={12} className="inline -mt-0.5" /> open the current tool in a new tab until rebuilt here.
      </p>

      {/* KPIs (last 30 days) */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        <Kpi icon={Wallet} tone="amber" label="Ad spend · 30d" value={eur0(s?.adSpend30dCents)} />
        <Kpi icon={Coins} tone="slate" label="Gross revenue · 30d" value={eur0(s?.grossRevenue30dCents)} />
        <Kpi icon={TrendingUp} tone="violet" label="True profit · 30d" value={eur0(s?.trueProfit30dCents)} detail={`${pct1(s?.trueProfitMargin30dPct)} margin`} highlight />
        <Kpi icon={Layers} tone="blue" label="Active campaigns" value={s ? String(s.campaignCount) : '—'} />
        <Kpi icon={PackageX} tone={s && s.agedSkusFlagged > 0 ? 'rose' : 'slate'} label="Aged SKUs flagged" value={s ? String(s.agedSkusFlagged) : '—'} detail="LTS risk ≤ 30d" />
      </div>

      {/* Launcher */}
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">Surfaces</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {AREAS.map((a) => {
          const Icon = a.icon
          return (
            <a key={a.title} href={a.href} target={a.native ? undefined : '_blank'} rel={a.native ? undefined : 'noopener noreferrer'}
              className="group rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 p-4 hover:border-blue-300 dark:hover:border-blue-800 hover:shadow-sm transition">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-blue-50 dark:bg-blue-950/40 grid place-items-center text-blue-600 dark:text-blue-400 shrink-0">
                  <Icon size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-slate-800 dark:text-slate-100">{a.title}</span>
                    {!a.native && <ArrowUpRight size={13} className="text-slate-400 group-hover:text-blue-500" />}
                    {a.phase && <span className="ml-auto text-[9px] font-semibold text-slate-400 bg-slate-100 dark:bg-slate-800 rounded px-1.5 py-px">{a.phase}</span>}
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">{a.desc}</p>
                </div>
              </div>
            </a>
          )
        })}
      </div>

      <p className="text-xs text-slate-400 mt-6">
        Phase 1 of the advertising rebuild. The legacy{' '}
        <a href="/marketing/advertising" target="_blank" rel="noopener noreferrer" className="underline decoration-dotted hover:text-slate-600">/marketing/advertising</a>{' '}
        section stays fully available while we migrate each surface in here.
      </p>
    </div>
  )
}

function Kpi({
  icon: Icon, label, value, detail, tone, highlight,
}: {
  icon: typeof Wallet
  label: string
  value: string
  detail?: string
  tone: 'amber' | 'slate' | 'violet' | 'blue' | 'rose'
  highlight?: boolean
}) {
  const iconTone: Record<string, string> = {
    amber: 'text-amber-600 bg-amber-50 dark:bg-amber-950/40',
    slate: 'text-slate-500 bg-slate-100 dark:bg-slate-800',
    violet: 'text-violet-600 bg-violet-50 dark:bg-violet-950/40',
    blue: 'text-blue-600 bg-blue-50 dark:bg-blue-950/40',
    rose: 'text-rose-600 bg-rose-50 dark:bg-rose-950/40',
  }
  return (
    <div className={`rounded-xl border p-3.5 ${highlight ? 'border-violet-200 dark:border-violet-900 bg-violet-50/40 dark:bg-violet-950/20' : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40'}`}>
      <div className="flex items-center gap-2">
        <div className={`w-6 h-6 rounded-md grid place-items-center ${iconTone[tone]}`}><Icon size={14} /></div>
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</span>
      </div>
      <div className={`text-2xl font-bold mt-2 tabular-nums ${highlight ? 'text-violet-700 dark:text-violet-300' : 'text-slate-900 dark:text-slate-100'}`}>{value}</div>
      {detail && <div className="text-xs text-slate-400 mt-0.5">{detail}</div>}
    </div>
  )
}
