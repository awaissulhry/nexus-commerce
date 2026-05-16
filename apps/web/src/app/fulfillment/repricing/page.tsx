/**
 * CE.3 — Buy Box Engine: Repricing Decisions Dashboard.
 *
 * Shows the most recent repricing decisions produced by the evaluator
 * cron. Each row shows: product, channel, strategy, old→new price,
 * reason, win-rate context, and whether the price was actually applied.
 *
 * When NEXUS_REPRICER_LIVE=1 is set, applied=true rows indicate that
 * ChannelListing.priceOverride was updated and a PRICE_UPDATE was
 * enqueued to OutboundSyncQueue.
 */

import { TrendingUp } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { RepricingDecisionsClient } from './RepricingDecisionsClient'

export const dynamic = 'force-dynamic'

interface Decision {
  id: string
  oldPrice: string
  newPrice: string
  reason: string
  buyBoxPrice: string | null
  lowestCompPrice: string | null
  applied: boolean
  capped: string | null
  createdAt: string
  rule: {
    id: string
    channel: string
    marketplace: string | null
    strategy: string
    product: { id: string; name: string; brand: string | null }
  }
}

async function fetchDecisions(): Promise<Decision[]> {
  try {
    const res = await fetch(
      `${getBackendUrl()}/api/pricing/repricing-decisions?limit=100`,
      { cache: 'no-store' },
    )
    if (!res.ok) return []
    const json = (await res.json()) as { decisions: Decision[] }
    return json.decisions
  } catch {
    return []
  }
}

export default async function RepricingPage() {
  const decisions = await fetchDecisions()

  const applied = decisions.filter((d) => d.applied).length
  const pending = decisions.filter((d) => !d.applied && Number(d.newPrice) !== Number(d.oldPrice)).length
  const unchanged = decisions.filter((d) => Number(d.newPrice) === Number(d.oldPrice)).length

  return (
    <div className="px-4 py-4 max-w-5xl">
      <div className="flex items-start gap-3 mb-5">
        <TrendingUp className="h-6 w-6 text-violet-600 dark:text-violet-400 mt-0.5 shrink-0" />
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Repricing Decisions
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Buy Box Engine evaluator output — price decisions from the last evaluator tick.
            Set <code className="text-[11px] px-1 py-0.5 bg-slate-100 dark:bg-slate-800 rounded">NEXUS_REPRICER_LIVE=1</code> to
            enable live price writes; without it, decisions are logged for review only.
          </p>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        <Stat label="Applied" value={applied} color="emerald" />
        <Stat label="Pending review" value={pending} color="amber" />
        <Stat label="No change" value={unchanged} color="slate" />
      </div>

      <RepricingDecisionsClient initialDecisions={decisions} />
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  const colors: Record<string, string> = {
    emerald: 'text-emerald-700 dark:text-emerald-400',
    amber: 'text-amber-700 dark:text-amber-400',
    slate: 'text-slate-700 dark:text-slate-400',
  }
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${colors[color] ?? ''}`}>{value}</div>
    </div>
  )
}
