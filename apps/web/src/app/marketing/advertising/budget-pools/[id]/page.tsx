/**
 * AD.5 — BudgetPool detail with rebalance controls + history.
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeft, Wallet } from 'lucide-react'
import { AdvertisingNav } from '../../_shared/AdvertisingNav'
import { WriteModeBanner } from '../../_shared/WriteModeBanner'
import { formatEur } from '../../_shared/formatters'
import { getBackendUrl } from '@/lib/backend-url'
import { RebalanceControlsClient } from './RebalanceControlsClient'
import { AllocationsClient } from './AllocationsClient'
import { PoolToggleClient } from './PoolToggleClient'

export const dynamic = 'force-dynamic'

interface Allocation {
  id: string
  marketplace: string
  campaignId: string | null
  targetSharePct: string
  minDailyBudgetCents: number
  maxDailyBudgetCents: number | null
}

interface Pool {
  id: string
  name: string
  description: string | null
  currency: string
  totalDailyBudgetCents: number
  strategy: 'STATIC' | 'PROFIT_WEIGHTED' | 'URGENCY_WEIGHTED'
  coolDownMinutes: number
  maxShiftPerRebalancePct: number
  enabled: boolean
  dryRun: boolean
  lastRebalancedAt: string | null
  allocations: Allocation[]
  rebalances: Array<{
    id: string
    triggeredBy: string
    inputs: unknown
    outputs: unknown
    dryRun: boolean
    appliedAt: string | null
    totalShiftCents: number
    createdAt: string
  }>
}

interface CampaignSnapshot {
  id: string
  name: string
  marketplace: string | null
  status: string
  dailyBudget: string
}

interface PoolResponse {
  pool: Pool
  campaigns: CampaignSnapshot[]
}

async function fetchPool(id: string): Promise<PoolResponse | null> {
  const res = await fetch(`${getBackendUrl()}/api/advertising/budget-pools/${id}`, {
    cache: 'no-store',
  })
  if (!res.ok) return null
  return (await res.json()) as PoolResponse
}

export default async function BudgetPoolDetailPage({
  params,
}: {
  params: { id: string }
}) {
  const data = await fetchPool(params.id)
  if (!data) notFound()
  const { pool, campaigns } = data

  const campaignsById = new Map(campaigns.map((c) => [c.id, c]))
  const currentTotal = pool.allocations.reduce((acc, a) => {
    const c = a.campaignId ? campaignsById.get(a.campaignId) : null
    return c ? acc + Math.round(Number(c.dailyBudget) * 100) : acc
  }, 0)
  const currentVsTargetDelta = currentTotal - pool.totalDailyBudgetCents

  return (
    <div className="px-4 py-4">
      <div className="mb-2">
        <Link
          href="/marketing/advertising/budget-pools"
          className="inline-flex items-center gap-1 text-xs text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
        >
          <ChevronLeft className="h-3 w-3" /> Budget Pools
        </Link>
      </div>
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
        <Wallet className="h-5 w-5 text-blue-500" />
        {pool.name}
      </h1>
      {pool.description && (
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-2">{pool.description}</p>
      )}
      <AdvertisingNav />
      <WriteModeBanner />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Stat label="Target budget/d" value={formatEur(pool.totalDailyBudgetCents)} />
        <Stat label="Allocations" value={pool.allocations.length} />
        <Stat label="Current total" value={formatEur(currentTotal)} />
        <Stat
          label="Δ vs target"
          value={`${currentVsTargetDelta >= 0 ? '+' : ''}${formatEur(currentVsTargetDelta)}`}
          tone={Math.abs(currentVsTargetDelta) > pool.totalDailyBudgetCents * 0.1 ? 'amber' : null}
        />
      </div>

      <PoolToggleClient
        poolId={pool.id}
        initialEnabled={pool.enabled}
        initialDryRun={pool.dryRun}
        strategy={pool.strategy}
        coolDownMinutes={pool.coolDownMinutes}
        maxShiftPerRebalancePct={pool.maxShiftPerRebalancePct}
      />

      <RebalanceControlsClient poolId={pool.id} />

      <section className="mt-4">
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
          Allocations
        </h2>
        <AllocationsClient
          poolId={pool.id}
          allocations={pool.allocations}
          campaigns={campaigns}
        />
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
          Rebalance history ({pool.rebalances.length})
        </h2>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md">
          {pool.rebalances.length === 0 ? (
            <div className="px-3 py-4 text-sm text-slate-500">
              No rebalances recorded. Run a dry-run from the button above.
            </div>
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {pool.rebalances.map((rb) => (
                <li key={rb.id} className="px-3 py-2">
                  <div className="flex items-center gap-2 flex-wrap text-xs">
                    <span className="font-mono text-slate-500 tabular-nums w-32">
                      {new Date(rb.createdAt).toLocaleString('en-GB', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </span>
                    <span
                      className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset ${
                        rb.appliedAt
                          ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900'
                          : 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900'
                      }`}
                    >
                      {rb.appliedAt ? 'APPLIED' : 'DRY-RUN'}
                    </span>
                    <span className="font-mono text-[11px] text-slate-500">{rb.triggeredBy}</span>
                    <span className="text-slate-600 dark:text-slate-300 tabular-nums">
                      shift {formatEur(rb.totalShiftCents)}
                    </span>
                  </div>
                  <details className="mt-1">
                    <summary className="text-[11px] text-slate-500 dark:text-slate-400 cursor-pointer">
                      Input / output
                    </summary>
                    <pre className="mt-1 text-[11px] text-slate-600 dark:text-slate-400 overflow-auto max-h-[300px] bg-slate-50 dark:bg-slate-950/60 rounded p-2">
                      {JSON.stringify({ inputs: rb.inputs, outputs: rb.outputs }, null, 2)}
                    </pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string | number
  tone?: 'amber' | null
}) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div
        className={`text-base font-semibold tabular-nums ${
          tone === 'amber' ? 'text-amber-700 dark:text-amber-300' : 'text-slate-900 dark:text-slate-100'
        }`}
      >
        {value}
      </div>
    </div>
  )
}
