/**
 * AD.5 — Budget pools workspace.
 *
 * Lists every BudgetPool with current allocations + last rebalance.
 * Operator can create new pools, enable/disable, switch strategy.
 * Per-pool detail at /budget-pools/[id].
 */

import Link from 'next/link'
import { Wallet, ChevronRight } from 'lucide-react'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { WriteModeBanner } from '../_shared/WriteModeBanner'
import { getBackendUrl } from '@/lib/backend-url'
import { formatEur } from '../_shared/formatters'
import { CreatePoolButton } from './CreatePoolButton'

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
  _count: { allocations: number; rebalances: number }
}

async function fetchPools(): Promise<Pool[]> {
  const res = await fetch(`${getBackendUrl()}/api/advertising/budget-pools`, {
    cache: 'no-store',
  })
  if (!res.ok) return []
  const json = (await res.json()) as { items: Pool[] }
  return json.items
}

const STRATEGY_LABEL: Record<Pool['strategy'], string> = {
  STATIC: 'Static',
  PROFIT_WEIGHTED: 'Profit-weighted',
  URGENCY_WEIGHTED: 'Urgency-weighted',
}

export default async function BudgetPoolsPage() {
  const pools = await fetchPools()
  const totalBudgetCents = pools.reduce(
    (acc, p) => (p.enabled ? acc + p.totalDailyBudgetCents : acc),
    0,
  )

  return (
    <div className="px-4 py-4">
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
        <Wallet className="h-5 w-5 text-blue-500" />
        Budget Pools
      </h1>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
        Group Amazon campaigns across IT/DE/FR under a shared daily budget.
        Three allocation strategies: static (target%), profit-weighted (30d true profit),
        or urgency-weighted (aged stock pressure).
      </p>
      <AdvertisingNav />
      <WriteModeBanner />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Stat label="Pools" value={pools.length} />
        <Stat label="Active" value={pools.filter((p) => p.enabled).length} tone="emerald" />
        <Stat label="Active budget/day" value={formatEur(totalBudgetCents)} />
        <Stat
          label="Allocations"
          value={pools.reduce((a, p) => a + p._count.allocations, 0)}
        />
      </div>

      <div className="mb-3 flex items-center gap-2">
        <CreatePoolButton />
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden">
        {pools.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-slate-500">
            No pools yet. Create the first one to start balancing budget across
            marketplaces.
          </div>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {pools.map((p) => {
              const marketplaces = Array.from(new Set(p.allocations.map((a) => a.marketplace)))
              return (
                <li key={p.id}>
                  <Link
                    href={`/marketing/advertising/budget-pools/${p.id}`}
                    className="block px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-950/40"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                            {p.name}
                          </span>
                          <span
                            className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset ${
                              p.enabled
                                ? p.dryRun
                                  ? 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900'
                                  : 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900'
                                : 'bg-slate-50 text-slate-500 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700'
                            }`}
                          >
                            {p.enabled ? (p.dryRun ? 'Dry-run' : 'Live') : 'Disabled'}
                          </span>
                          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:ring-blue-900">
                            {STRATEGY_LABEL[p.strategy]}
                          </span>
                          {marketplaces.map((m) => (
                            <span
                              key={m}
                              className="text-[10px] font-mono px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400"
                            >
                              {m}
                            </span>
                          ))}
                        </div>
                        {p.description && (
                          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-1">
                            {p.description}
                          </p>
                        )}
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-3 flex-wrap">
                          <span>Budget {formatEur(p.totalDailyBudgetCents)}/d</span>
                          <span>·</span>
                          <span>{p._count.allocations} allocations</span>
                          <span>·</span>
                          <span>Max shift {p.maxShiftPerRebalancePct}%</span>
                          <span>·</span>
                          <span>Cooldown {p.coolDownMinutes}min</span>
                          {p.lastRebalancedAt && (
                            <>
                              <span>·</span>
                              <span>
                                Last rebalance{' '}
                                {new Date(p.lastRebalancedAt).toLocaleString('en-GB', {
                                  month: '2-digit',
                                  day: '2-digit',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      <ChevronRight
                        className="h-4 w-4 text-slate-400 dark:text-slate-600 mt-1"
                        aria-hidden="true"
                      />
                    </div>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number | string
  tone?: 'emerald' | 'amber'
}) {
  const valueClass =
    tone === 'emerald'
      ? 'text-emerald-700 dark:text-emerald-300'
      : tone === 'amber'
        ? 'text-amber-700 dark:text-amber-300'
        : 'text-slate-900 dark:text-slate-100'
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div className={`text-base font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  )
}
