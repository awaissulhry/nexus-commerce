'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Plus, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { formatEur } from '../../_shared/formatters'

interface Allocation {
  id: string
  marketplace: string
  campaignId: string | null
  targetSharePct: string
  minDailyBudgetCents: number
  maxDailyBudgetCents: number | null
}

interface CampaignSnapshot {
  id: string
  name: string
  marketplace: string | null
  status: string
  dailyBudget: string
}

export function AllocationsClient({
  poolId,
  allocations,
  campaigns,
}: {
  poolId: string
  allocations: Allocation[]
  campaigns: CampaignSnapshot[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [campaignIdInput, setCampaignIdInput] = useState('')
  const [error, setError] = useState<string | null>(null)

  const campaignsById = new Map(campaigns.map((c) => [c.id, c]))

  async function add() {
    if (!campaignIdInput.trim()) return
    setBusy('add')
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/advertising/budget-pools/${poolId}/allocations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ campaignId: campaignIdInput.trim() }),
        },
      )
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'add_failed')
        return
      }
      setAdding(false)
      setCampaignIdInput('')
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  async function remove(allocationId: string) {
    setBusy(allocationId)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/advertising/budget-pools/${poolId}/allocations/${allocationId}`,
        { method: 'DELETE' },
      )
      if (res.ok) router.refresh()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md">
      {allocations.length === 0 ? (
        <div className="px-3 py-4 text-sm text-slate-500">
          Nessuna allocazione. Aggiungi almeno 2 campagne perché il rebalance abbia senso.
        </div>
      ) : (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {allocations.map((a) => {
            const c = a.campaignId ? campaignsById.get(a.campaignId) : null
            return (
              <li key={a.id} className="px-3 py-2 flex items-center gap-3 flex-wrap text-xs">
                <span className="font-mono w-12">{a.marketplace}</span>
                {c ? (
                  <span className="text-slate-900 dark:text-slate-100 truncate max-w-[260px]">
                    {c.name}
                  </span>
                ) : (
                  <span className="text-slate-500 font-mono">{a.campaignId?.slice(0, 8) ?? '—'}</span>
                )}
                {c && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                    {c.status}
                  </span>
                )}
                {c && (
                  <span className="text-slate-500 tabular-nums">
                    Budget {formatEur(Math.round(Number(c.dailyBudget) * 100))}/g
                  </span>
                )}
                <span className="text-slate-500">target {a.targetSharePct}%</span>
                <span className="text-slate-500">
                  min {formatEur(a.minDailyBudgetCents)}
                  {a.maxDailyBudgetCents != null
                    ? ` / max ${formatEur(a.maxDailyBudgetCents)}`
                    : ''}
                </span>
                <button
                  type="button"
                  onClick={() => remove(a.id)}
                  disabled={busy === a.id}
                  className="ml-auto text-rose-600 dark:text-rose-400 hover:text-rose-800 dark:hover:text-rose-200 disabled:opacity-40"
                >
                  {busy === a.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <X className="h-3.5 w-3.5" />
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="px-3 py-2 border-t border-slate-200 dark:border-slate-800">
        {adding ? (
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="text"
              placeholder="Campaign ID"
              value={campaignIdInput}
              onChange={(e) => setCampaignIdInput(e.target.value)}
              className="text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 flex-1"
            />
            <button
              type="button"
              onClick={add}
              disabled={busy === 'add'}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded ring-1 ring-inset ring-blue-300 bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
            >
              {busy === 'add' && <Loader2 className="h-3 w-3 animate-spin" />}
              Aggiungi
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false)
                setCampaignIdInput('')
                setError(null)
              }}
              className="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
            >
              Annulla
            </button>
            {error && (
              <span className="basis-full text-xs text-rose-700 dark:text-rose-300">{error}</span>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            <Plus className="h-3 w-3" />
            Aggiungi allocazione
          </button>
        )}
      </div>
    </div>
  )
}
