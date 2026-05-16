'use client'

import { useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface FeedSummary {
  total: number
  inStock: number
  outOfStock: number
  channel: string
  generatedAt: string
}

export function FeedsClient() {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ gmc: FeedSummary; meta: FeedSummary } | null>(null)

  async function triggerGeneration() {
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/feed-export/trigger`, { method: 'POST' })
      const json = (await res.json()) as { gmc: FeedSummary; meta: FeedSummary }
      setResult(json)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        type="button"
        onClick={triggerGeneration}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded ring-1 ring-inset ring-violet-300 dark:ring-violet-700 bg-white dark:bg-slate-900 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950/40 disabled:opacity-40"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        Regenerate feeds
      </button>

      {result && (
        <div className="text-xs text-slate-500 dark:text-slate-400">
          GMC: {result.gmc.total} products ({result.gmc.inStock} in stock, {result.gmc.outOfStock} suppressed) ·
          Meta: {result.meta.total} products ({result.meta.inStock} in stock, {result.meta.outOfStock} suppressed)
        </div>
      )}
    </div>
  )
}
