'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface SpikeRow {
  id: string
  marketplace: string
  category: string
  rate7dNumerator: number
  rate7dDenominator: number
  rate28dNumerator: number
  rate28dDenominator: number
  spikeMultiplier: string | null
  sampleTopPhrases: string[]
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED'
  detectedAt: string
  product: { id: string; sku: string; name: string } | null
}

const CATEGORY_LABEL: Record<string, string> = {
  FIT_SIZING: 'Vestibilità',
  DURABILITY: 'Durabilità',
  SHIPPING: 'Spedizione',
  VALUE: 'Prezzo',
  DESIGN: 'Design',
  QUALITY: 'Qualità',
  SAFETY: 'Sicurezza',
  COMFORT: 'Comfort',
  OTHER: 'Altro',
}

export function SpikeFeed({ initial }: { initial: SpikeRow[] }) {
  const router = useRouter()
  const [items, setItems] = useState<SpikeRow[]>(initial)
  const [busy, setBusy] = useState<string | null>(null)

  async function patch(id: string, status: 'ACKNOWLEDGED' | 'RESOLVED') {
    setBusy(id)
    try {
      const res = await fetch(`${getBackendUrl()}/api/reviews/spikes/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (res.ok) {
        setItems((prev) => prev.filter((s) => s.id !== id))
        router.refresh()
      }
    } finally {
      setBusy(null)
    }
  }

  if (items.length === 0) {
    return (
      <div className="px-3 py-4 text-xs text-slate-500 dark:text-slate-400">
        Nessuno spike aperto. Il rilevatore confronta i tassi 7g vs 28g e riconosce un
        picco quando 7g supera 2× la baseline con ≥3 recensioni negative.
      </div>
    )
  }

  return (
    <ul className="divide-y divide-slate-200 dark:divide-slate-800 max-h-[600px] overflow-y-auto">
      {items.map((s) => {
        const rate7 = s.rate7dDenominator > 0 ? s.rate7dNumerator / s.rate7dDenominator : 0
        const rate28 = s.rate28dDenominator > 0 ? s.rate28dNumerator / s.rate28dDenominator : 0
        return (
          <li key={s.id} className="px-3 py-2 text-xs">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-slate-500">{s.marketplace}</span>
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900">
                {CATEGORY_LABEL[s.category] ?? s.category}
              </span>
              {s.spikeMultiplier && (
                <span className="font-mono text-rose-700 dark:text-rose-300">
                  {Number(s.spikeMultiplier).toFixed(1)}×
                </span>
              )}
            </div>
            {s.product && (
              <Link
                href={`/products/${s.product.id}`}
                className="mt-1 inline-block text-blue-600 dark:text-blue-400 hover:underline font-mono"
              >
                {s.product.sku}
              </Link>
            )}
            <div className="mt-1 text-[11px] text-slate-600 dark:text-slate-400 tabular-nums">
              7g: {s.rate7dNumerator}/{s.rate7dDenominator} ({(rate7 * 100).toFixed(0)}%) · 28g:{' '}
              {s.rate28dNumerator}/{s.rate28dDenominator} ({(rate28 * 100).toFixed(0)}%)
            </div>
            {s.sampleTopPhrases.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {s.sampleTopPhrases.slice(0, 2).map((p, i) => (
                  <li
                    key={i}
                    className="text-[11px] italic text-slate-600 dark:text-slate-400 line-clamp-2"
                  >
                    “{p}”
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-1.5 flex items-center gap-2">
              <button
                type="button"
                onClick={() => patch(s.id, 'ACKNOWLEDGED')}
                disabled={busy === s.id}
                className="text-[11px] px-2 py-0.5 rounded ring-1 ring-inset ring-amber-300 text-amber-700 hover:bg-amber-50 dark:ring-amber-700 dark:text-amber-300 dark:hover:bg-amber-950/40 disabled:opacity-40"
              >
                {busy === s.id && <Loader2 className="h-3 w-3 animate-spin inline mr-1" />}
                Riconosci
              </button>
              <button
                type="button"
                onClick={() => patch(s.id, 'RESOLVED')}
                disabled={busy === s.id}
                className="text-[11px] px-2 py-0.5 rounded ring-1 ring-inset ring-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:ring-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-950/40 disabled:opacity-40"
              >
                Risolvi
              </button>
              <span className="ml-auto text-[10px] text-slate-500">
                {new Date(s.detectedAt).toLocaleString('it-IT', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
