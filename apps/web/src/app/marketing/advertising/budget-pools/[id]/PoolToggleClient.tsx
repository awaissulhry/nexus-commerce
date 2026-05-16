'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Power, FlaskConical, ShieldAlert } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

export function PoolToggleClient({
  poolId,
  initialEnabled,
  initialDryRun,
  strategy,
  coolDownMinutes,
  maxShiftPerRebalancePct,
}: {
  poolId: string
  initialEnabled: boolean
  initialDryRun: boolean
  strategy: 'STATIC' | 'PROFIT_WEIGHTED' | 'URGENCY_WEIGHTED'
  coolDownMinutes: number
  maxShiftPerRebalancePct: number
}) {
  const router = useRouter()
  const [enabled, setEnabled] = useState(initialEnabled)
  const [dryRun, setDryRun] = useState(initialDryRun)
  const [busy, setBusy] = useState(false)

  async function patch(body: Record<string, unknown>) {
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/advertising/budget-pools/${poolId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (res.ok) router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-3 mb-3">
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => patch({ enabled: !enabled }).then(() => setEnabled(!enabled))}
          disabled={busy}
          className={`inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded ring-1 ring-inset transition-colors ${
            enabled
              ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900'
              : 'bg-slate-50 text-slate-700 ring-slate-300 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700'
          }`}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
          {enabled ? 'Pool attivo' : 'Pool disattivato'}
        </button>
        <button
          type="button"
          onClick={() => patch({ dryRun: !dryRun }).then(() => setDryRun(!dryRun))}
          disabled={busy || !enabled}
          className={`inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded ring-1 ring-inset transition-colors disabled:opacity-40 ${
            dryRun
              ? 'bg-amber-50 text-amber-700 ring-amber-200 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900'
              : 'bg-rose-50 text-rose-700 ring-rose-200 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900'
          }`}
        >
          {dryRun ? <FlaskConical className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
          {dryRun ? 'Dry-run' : 'Live'}
        </button>
        <div className="text-xs text-slate-500 dark:text-slate-400 ml-auto flex items-center gap-3 flex-wrap">
          <span>Strategia: <strong className="text-slate-700 dark:text-slate-300">{strategy}</strong></span>
          <span>Cooldown: {coolDownMinutes}m</span>
          <span>Max shift: {maxShiftPerRebalancePct}%</span>
        </div>
      </div>
    </div>
  )
}
