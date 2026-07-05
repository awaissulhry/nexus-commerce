'use client'

/**
 * CE.4 — Smart Order Routing: Routing Decision Log.
 *
 * Shows recent RoutingDecision rows — which warehouse was chosen,
 * which method (rule-match / scored / fallback), and the score breakdown
 * for scored decisions.
 *
 * Also provides a simulation panel: enter channel + shipping country to
 * preview which warehouse the engine would pick without creating a real order.
 *
 * The API session cookie lives on the API origin (cross-site setup) — the
 * Next server can never present it, so the old server-side fetch 401'd and
 * everyone saw zeroed KPIs + an empty log in prod. Data MUST load
 * client-side where the patched window.fetch adds credentials.
 */

import { useEffect, useState } from 'react'
import { GitBranch } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { RoutingLogClient } from './RoutingLogClient'

interface RoutingDecision {
  id: string
  orderId: string
  warehouseId: string | null
  method: string
  ruleId: string | null
  scoreSummary: Record<string, { proximityScore: number; stockScore: number; total: number }> | null
  createdAt: string
  order: {
    channel: string
    marketplace: string | null
    channelOrderId: string
    customerName: string
    shippingAddress: { country?: string }
  }
}

async function fetchLog(): Promise<RoutingDecision[]> {
  try {
    const res = await fetch(`${getBackendUrl()}/api/orders/routing-log?limit=50`, {
      cache: 'no-store',
    })
    if (!res.ok) return []
    const json = (await res.json()) as { decisions: RoutingDecision[] }
    return json.decisions
  } catch {
    return []
  }
}

export default function RoutingLogPage() {
  const [decisions, setDecisions] = useState<RoutingDecision[] | null>(null)
  useEffect(() => {
    let alive = true
    fetchLog().then((d) => {
      if (alive) setDecisions(d)
    })
    return () => {
      alive = false
    }
  }, [])

  const header = (
    <div className="flex items-start gap-3 mb-5">
      <GitBranch className="h-6 w-6 text-violet-600 dark:text-violet-400 mt-0.5 shrink-0" />
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Routing Log
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
          Warehouse routing decisions — rule-match uses explicit{' '}
          <a href="/fulfillment/routing-rules" className="underline">routing rules</a>;
          scored uses proximity + stock scoring when no rule matches.
        </p>
      </div>
    </div>
  )

  if (!decisions) {
    return (
      <div className="px-4 py-4 max-w-5xl" aria-busy="true">
        {header}
        <div className="grid grid-cols-4 gap-3 mb-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-16 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse"
            />
          ))}
        </div>
        <div className="h-64 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
      </div>
    )
  }

  const byMethod = {
    rule: decisions.filter((d) => d.method === 'rule').length,
    scored: decisions.filter((d) => d.method === 'scored').length,
    fallback: decisions.filter((d) => d.method === 'fallback').length,
    none: decisions.filter((d) => d.method === 'none').length,
  }

  return (
    <div className="px-4 py-4 max-w-5xl">
      {header}

      {/* KPI strip */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        <Stat label="Rule match" value={byMethod.rule} color="violet" />
        <Stat label="Scored" value={byMethod.scored} color="blue" />
        <Stat label="Fallback" value={byMethod.fallback} color="amber" />
        <Stat label="No warehouse" value={byMethod.none} color="rose" />
      </div>

      <RoutingLogClient initialDecisions={decisions} />
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  const colors: Record<string, string> = {
    violet: 'text-violet-700 dark:text-violet-400',
    blue: 'text-blue-700 dark:text-blue-400',
    amber: 'text-amber-700 dark:text-amber-400',
    rose: 'text-rose-700 dark:text-rose-400',
  }
  return (
    <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-md px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${colors[color] ?? ''}`}>{value}</div>
    </div>
  )
}
