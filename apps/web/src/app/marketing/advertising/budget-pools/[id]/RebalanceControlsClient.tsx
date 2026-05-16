'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, PlayCircle, FlaskConical } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { formatEur } from '../../_shared/formatters'

interface ProposedRow {
  allocationId: string
  campaignId: string | null
  marketplace: string
  oldBudgetCents: number
  proposedBudgetCents: number
  shiftCents: number
  clampedReason?: string
}

interface RebalanceOutcome {
  ok: boolean
  poolName: string
  strategy: string
  proposed: ProposedRow[]
  totalShiftCents: number
  warnings: string[]
  skipped?: string
}

export function RebalanceControlsClient({ poolId }: { poolId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null)
  const [preview, setPreview] = useState<RebalanceOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function runPreview() {
    setBusy('preview')
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/advertising/budget-pools/${poolId}/rebalance?preview=1`,
        { method: 'POST' },
      )
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'preview_failed')
        return
      }
      setPreview(json.outcome as RebalanceOutcome)
    } finally {
      setBusy(null)
    }
  }

  async function commit() {
    setBusy('commit')
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/advertising/budget-pools/${poolId}/rebalance`,
        { method: 'POST' },
      )
      const json = await res.json()
      if (!res.ok) {
        setError(json.reason ?? json.error ?? 'commit_failed')
        return
      }
      setPreview(null)
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-3 mb-3">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={runPreview}
          disabled={busy != null}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded ring-1 ring-inset ring-amber-300 dark:ring-amber-700 bg-white dark:bg-slate-900 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40"
        >
          {busy === 'preview' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <FlaskConical className="h-4 w-4" />
          )}
          Dry-run preview
        </button>
        <button
          type="button"
          onClick={commit}
          disabled={busy != null}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded ring-1 ring-inset ring-blue-300 dark:ring-blue-700 bg-white dark:bg-slate-900 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40"
        >
          {busy === 'commit' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <PlayCircle className="h-4 w-4" />
          )}
          Esegui rebalance
        </button>
        <span className="text-xs text-slate-500 dark:text-slate-400 ml-auto">
          Il preview ignora il cooldown. L&apos;esecuzione rispetta pool.dryRun.
        </span>
      </div>

      {error && (
        <div className="mt-2 text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 rounded p-2">
          {error}
        </div>
      )}

      {preview && (
        <div className="mt-3 border-t border-slate-200 dark:border-slate-800 pt-3">
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100 mb-2">
            Preview: strategia {preview.strategy} · shift totale {formatEur(preview.totalShiftCents)}
          </div>
          {preview.warnings.length > 0 && (
            <div className="text-xs text-amber-700 dark:text-amber-300 mb-2">
              {preview.warnings.join(' · ')}
            </div>
          )}
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <tr className="text-left">
                <th className="py-1">Mkt</th>
                <th className="py-1">Campagna</th>
                <th className="py-1 text-right">Attuale</th>
                <th className="py-1 text-right">Proposto</th>
                <th className="py-1 text-right">Δ</th>
                <th className="py-1">Clamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {preview.proposed.map((p) => (
                <tr key={p.allocationId}>
                  <td className="py-1 font-mono">{p.marketplace}</td>
                  <td className="py-1 font-mono text-[10px] truncate max-w-[160px]">
                    {p.campaignId?.slice(0, 8) ?? '—'}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {formatEur(p.oldBudgetCents)}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {formatEur(p.proposedBudgetCents)}
                  </td>
                  <td
                    className={`py-1 text-right tabular-nums ${
                      p.shiftCents > 0
                        ? 'text-emerald-700 dark:text-emerald-300'
                        : p.shiftCents < 0
                          ? 'text-rose-700 dark:text-rose-300'
                          : 'text-slate-500'
                    }`}
                  >
                    {p.shiftCents > 0 ? '+' : ''}
                    {formatEur(p.shiftCents)}
                  </td>
                  <td className="py-1 text-[10px] text-slate-500">{p.clampedReason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
