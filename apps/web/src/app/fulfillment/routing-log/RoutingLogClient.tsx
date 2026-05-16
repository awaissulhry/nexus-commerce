'use client'

import { useState } from 'react'
import { Loader2, Play } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

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

interface SimResult {
  warehouseId: string | null
  warehouseName: string | null
  method: string
  ruleId: string | null
  ruleName: string | null
  scoreSummary: Record<string, { proximityScore: number; stockScore: number; total: number }> | null
}

const METHOD_LABEL: Record<string, string> = {
  rule: 'Rule match',
  scored: 'Scored',
  fallback: 'Fallback',
  none: 'No warehouse',
}

const METHOD_COLORS: Record<string, string> = {
  rule: 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:ring-violet-900',
  scored: 'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:ring-blue-900',
  fallback: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900',
  none: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900',
}

export function RoutingLogClient({ initialDecisions }: { initialDecisions: RoutingDecision[] }) {
  const [simChannel, setSimChannel] = useState('AMAZON')
  const [simMarketplace, setSimMarketplace] = useState('IT')
  const [simCountry, setSimCountry] = useState('IT')
  const [simBusy, setSimBusy] = useState(false)
  const [simResult, setSimResult] = useState<SimResult | null>(null)

  async function runSimulation() {
    setSimBusy(true)
    setSimResult(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/orders/simulate-routing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: simChannel,
          marketplace: simMarketplace || null,
          shippingCountry: simCountry || null,
        }),
      })
      const json = (await res.json()) as SimResult
      setSimResult(json)
    } finally {
      setSimBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      {/* Simulation panel */}
      <section>
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
          Simulate routing
        </h2>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md p-4 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={simChannel}
              onChange={(e) => setSimChannel(e.target.value)}
              className="text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-violet-400"
            >
              <option value="AMAZON">Amazon</option>
              <option value="EBAY">eBay</option>
              <option value="SHOPIFY">Shopify</option>
            </select>
            <input
              type="text"
              placeholder="Marketplace (IT, DE…)"
              value={simMarketplace}
              onChange={(e) => setSimMarketplace(e.target.value)}
              className="w-32 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-violet-400"
            />
            <input
              type="text"
              placeholder="Shipping country (IT, DE…)"
              value={simCountry}
              onChange={(e) => setSimCountry(e.target.value)}
              className="w-44 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-violet-400"
            />
            <button
              type="button"
              onClick={runSimulation}
              disabled={simBusy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded ring-1 ring-inset ring-slate-300 dark:ring-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 disabled:opacity-40"
            >
              {simBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Simulate
            </button>
          </div>

          {simResult && (
            <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-1">
              <div className="flex items-center gap-2">
                <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset font-medium ${METHOD_COLORS[simResult.method] ?? ''}`}>
                  {METHOD_LABEL[simResult.method] ?? simResult.method}
                </span>
                <span className="text-sm text-slate-700 dark:text-slate-300 font-medium">
                  {simResult.warehouseName ?? simResult.warehouseId ?? 'No warehouse found'}
                </span>
                {simResult.ruleName && (
                  <span className="text-xs text-slate-500">via rule: {simResult.ruleName}</span>
                )}
              </div>
              {simResult.scoreSummary && Object.keys(simResult.scoreSummary).length > 0 && (
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Score breakdown:{' '}
                  {Object.entries(simResult.scoreSummary)
                    .sort(([, a], [, b]) => b.total - a.total)
                    .map(([whId, s]) => `${whId.slice(-6)} (proximity=${s.proximityScore} default=${s.stockScore} total=${s.total})`)
                    .join(' | ')}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Decision log */}
      <section>
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
          Recent routing decisions
        </h2>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden">
          {initialDecisions.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
              No routing decisions logged yet. Decisions are recorded when orders are ingested.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">Order</th>
                  <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">Channel</th>
                  <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">Ship-to</th>
                  <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">Warehouse</th>
                  <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">Method</th>
                  <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {initialDecisions.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="px-3 py-2">
                      <div className="text-xs font-medium text-slate-900 dark:text-slate-100">
                        {d.order.channelOrderId}
                      </div>
                      <div className="text-[10px] text-slate-400">{d.order.customerName}</div>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400">
                      {d.order.channel}
                      {d.order.marketplace ? ` · ${d.order.marketplace}` : ''}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400">
                      {(d.order.shippingAddress as { country?: string }).country ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-xs font-mono text-slate-600 dark:text-slate-400">
                      {d.warehouseId?.slice(-8) ?? '—'}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset font-medium ${METHOD_COLORS[d.method] ?? ''}`}>
                        {METHOD_LABEL[d.method] ?? d.method}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-400 whitespace-nowrap">
                      {new Date(d.createdAt).toLocaleDateString('en-GB', {
                        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  )
}
