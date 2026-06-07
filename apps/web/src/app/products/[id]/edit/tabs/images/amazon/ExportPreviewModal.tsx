'use client'

// Export-ZIP preview + completeness report. Fetches the per-market manifest
// (ASINs, ~images, skipped-no-ASIN, validation-blocked) BEFORE generating, so
// the operator sees exactly what's included/excluded — nothing silently missing.

import { useEffect, useState } from 'react'
import { X, Download, Loader2, AlertTriangle } from 'lucide-react'
import { beFetch } from '../api'

interface ManifestMarket {
  market: string
  asinCount: number
  estimatedFiles: number
  skippedNoAsin: string[]
  blocked: Array<{ asin: string; sku: string; reasons: string[] }>
}
interface Manifest {
  perMarket: ManifestMarket[]
  totalEstimatedFiles: number
  totalBlocked: number
  totalSkippedNoAsin: number
}

export function ExportPreviewModal({
  productId,
  marketplace,
  activeAxis,
  onExport,
  onClose,
}: {
  productId: string
  marketplace: string
  activeAxis: string | null
  onExport: (marketplace: string) => void
  onClose: () => void
}) {
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const isAll = marketplace.toUpperCase() === 'ALL'

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const q = new URLSearchParams({ marketplace, ...(activeAxis ? { activeAxis } : {}) })
        const res = await beFetch(`/api/products/${productId}/amazon-images/export-zip/manifest?${q.toString()}`)
        if (!res.ok) throw new Error(`Preview failed (${res.status})`)
        const data = (await res.json()) as Manifest
        if (!cancelled) setManifest(data)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load preview')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [productId, marketplace, activeAxis])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-700 p-4 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">Export {isAll ? 'all markets' : `Amazon ${marketplace}`} — preview</span>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"><X className="w-4 h-4" /></button>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
          {isAll
            ? 'One download containing a ready-to-upload ZIP per market (IT.zip, DE.zip, …) — drop each into that market’s Seller Central bulk upload.'
            : 'A flat ZIP for this market’s Seller Central bulk upload.'}{' '}
          Files: <span className="font-mono">{'{ASIN}.{SLOT}.jpg'}</span>.
        </p>

        {loading ? (
          <div className="py-8 text-center text-sm text-slate-400"><Loader2 className="w-4 h-4 animate-spin inline mr-1" /> Computing coverage…</div>
        ) : error ? (
          <div className="py-4 text-sm text-rose-600 dark:text-rose-400">{error}</div>
        ) : manifest ? (
          <>
            <div className="space-y-1.5 mb-3">
              {manifest.perMarket.map((m) => (
                <div key={m.market} className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-slate-700 dark:text-slate-200">{m.market}</span>
                    <span className="text-slate-600 dark:text-slate-300">{m.asinCount} ASIN{m.asinCount === 1 ? '' : 's'} · ~{m.estimatedFiles} image{m.estimatedFiles === 1 ? '' : 's'}</span>
                  </div>
                  {(m.blocked.length > 0 || m.skippedNoAsin.length > 0) && (
                    <div className="mt-1 text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1">
                      <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                      <span>
                        {m.blocked.length > 0 && <>{m.blocked.length} blocked ({[...new Set(m.blocked.flatMap((b) => b.reasons))].join(', ')})</>}
                        {m.blocked.length > 0 && m.skippedNoAsin.length > 0 && ' · '}
                        {m.skippedNoAsin.length > 0 && <>{m.skippedNoAsin.length} without ASIN</>}
                        {' '}— excluded.
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 mb-3">
              Total: <b className="text-slate-700 dark:text-slate-200">~{manifest.totalEstimatedFiles}</b> images
              {manifest.totalBlocked > 0 && <> · <span className="text-amber-600 dark:text-amber-400">{manifest.totalBlocked} blocked</span></>}
              {manifest.totalSkippedNoAsin > 0 && <> · <span className="text-amber-600 dark:text-amber-400">{manifest.totalSkippedNoAsin} no-ASIN</span></>}
            </div>
            <button
              type="button"
              disabled={manifest.totalEstimatedFiles === 0}
              onClick={() => { onExport(marketplace); onClose() }}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              <Download className="w-4 h-4" />
              {manifest.totalEstimatedFiles === 0 ? 'Nothing to export' : `Export ${manifest.totalEstimatedFiles} image${manifest.totalEstimatedFiles === 1 ? '' : 's'}${isAll ? ' (per-market ZIPs)' : ''}`}
            </button>
          </>
        ) : null}
      </div>
    </div>
  )
}
