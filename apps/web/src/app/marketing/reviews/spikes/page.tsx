/**
 * SR.2 — Dedicated spike feed (broader than the homepage right rail).
 *
 * Filter by status (OPEN / ACKNOWLEDGED / RESOLVED) + marketplace.
 * Acknowledge / resolve actions are inline. SR.3 will wire spike
 * rows into the AutomationRule engine (REVIEW_SPIKE_DETECTED trigger).
 */

import { AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { ReviewsNav } from '../_shared/ReviewsNav'
import { SpikesFullClient } from './SpikesFullClient'

export const dynamic = 'force-dynamic'

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
  acknowledgedAt: string | null
  acknowledgedBy: string | null
  resolvedAt: string | null
  product: { id: string; sku: string; name: string } | null
}

async function fetchSpikes(): Promise<SpikeRow[]> {
  try {
    const res = await fetch(`${getBackendUrl()}/api/reviews/spikes?limit=200`, {
      cache: 'no-store',
    })
    if (!res.ok) return []
    const json = (await res.json()) as { items: SpikeRow[] }
    return json.items
  } catch {
    return []
  }
}

export default async function SpikesPage() {
  const items = await fetchSpikes()
  const open = items.filter((s) => s.status === 'OPEN').length
  const ack = items.filter((s) => s.status === 'ACKNOWLEDGED').length
  const resolved = items.filter((s) => s.status === 'RESOLVED').length
  return (
    <div className="px-4 py-4">
      <div className="flex items-start gap-3 mb-3">
        <AlertTriangle className="h-6 w-6 text-rose-500 dark:text-rose-400 mt-0.5" />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Spike feed
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Picchi rilevati dal confronto 7g vs 28g per (prodotto × marketplace × categoria).
            Riconoscere uno spike sospende future ri-attivazioni finché il tasso non torna
            sotto soglia. SR.3 collegherà gli spike OPEN al motore AutomationRule.
          </p>
        </div>
      </div>
      <ReviewsNav />
      <div className="grid grid-cols-3 gap-3 mb-4">
        <Stat label="Aperti" value={open} tone={open > 0 ? 'rose' : null} />
        <Stat label="Riconosciuti" value={ack} tone="amber" />
        <Stat label="Risolti" value={resolved} tone="emerald" />
      </div>
      <SpikesFullClient initial={items} />
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'emerald' | 'amber' | 'rose' | null
}) {
  const valueClass =
    tone === 'emerald'
      ? 'text-emerald-700 dark:text-emerald-300'
      : tone === 'amber'
        ? 'text-amber-700 dark:text-amber-300'
        : tone === 'rose'
          ? 'text-rose-700 dark:text-rose-300'
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
