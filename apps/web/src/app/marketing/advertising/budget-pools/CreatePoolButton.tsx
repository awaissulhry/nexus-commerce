'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Plus } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

export function CreatePoolButton() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [budget, setBudget] = useState('100')
  const [strategy, setStrategy] = useState<'STATIC' | 'PROFIT_WEIGHTED' | 'URGENCY_WEIGHTED'>(
    'PROFIT_WEIGHTED',
  )

  async function commit() {
    if (!name.trim()) {
      setError('Nome obbligatorio')
      return
    }
    const totalDailyBudgetCents = Math.round(Number(budget) * 100)
    if (!Number.isFinite(totalDailyBudgetCents) || totalDailyBudgetCents <= 0) {
      setError('Budget non valido')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/advertising/budget-pools`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          totalDailyBudgetCents,
          strategy,
        }),
      })
      if (!res.ok) {
        const json = await res.json()
        setError(json.error ?? 'create_failed')
        return
      }
      const json = (await res.json()) as { pool: { id: string } }
      setOpen(false)
      router.push(`/marketing/advertising/budget-pools/${json.pool.id}`)
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded ring-1 ring-inset ring-blue-300 dark:ring-blue-700 bg-white dark:bg-slate-900 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40"
      >
        <Plus className="h-4 w-4" />
        Nuovo pool
      </button>
    )
  }

  return (
    <div className="bg-white dark:bg-slate-900 border border-blue-200 dark:border-blue-900 rounded-md p-3 w-full max-w-xl">
      <div className="text-sm font-medium text-slate-900 dark:text-slate-100 mb-2">
        Nuovo budget pool
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-2">
        <input
          type="text"
          placeholder="Nome"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1"
        />
        <input
          type="number"
          step="1"
          min="1"
          placeholder="Budget €/g"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          className="text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1"
        />
        <select
          value={strategy}
          onChange={(e) => setStrategy(e.target.value as typeof strategy)}
          className="text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1"
        >
          <option value="STATIC">Statico (target%)</option>
          <option value="PROFIT_WEIGHTED">Pesato sul profitto</option>
          <option value="URGENCY_WEIGHTED">Pesato su urgenza stock</option>
        </select>
      </div>
      {error && <div className="text-xs text-rose-700 dark:text-rose-300 mb-2">{error}</div>}
      <div className="flex items-center gap-2 justify-end">
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={busy}
          className="px-3 py-1 text-sm rounded text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          Annulla
        </button>
        <button
          type="button"
          onClick={commit}
          disabled={busy}
          className="inline-flex items-center gap-1 px-3 py-1 text-sm rounded ring-1 ring-inset ring-blue-300 bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {busy && <Loader2 className="h-3 w-3 animate-spin" />}
          Crea
        </button>
      </div>
    </div>
  )
}
