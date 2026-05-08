'use client'

/**
 * P.1c — extracted from ProductsWorkspace.tsx as part of the
 * file-decomposition sweep. Self-contained: takes no props, owns
 * its own channel-tab state, fetches /api/listings/drafts.
 *
 * Two cards per channel: drafts ready to publish + products
 * uncovered on that channel. Channel tabs (AMAZON / EBAY /
 * SHOPIFY / WOOCOMMERCE / ETSY) gate the fetch.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Sparkles, CheckCircle2 } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { getBackendUrl } from '@/lib/backend-url'
import { CHANNEL_TONE } from '@/lib/products/theme'

interface DraftRow {
  id: string
  productId: string
  channel: string
  marketplace: string
  product: { name: string; sku: string }
}

interface UncoveredRow {
  id: string
  name: string
  sku: string
}

interface DraftsData {
  draftCount: number
  drafts: DraftRow[]
  uncoveredCount: number
  uncovered: UncoveredRow[]
}

export function DraftsLens() {
  const [channel, setChannel] = useState('AMAZON')
  const [data, setData] = useState<DraftsData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`${getBackendUrl()}/api/listings/drafts?channel=${channel}`, {
      cache: 'no-store',
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch((e) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [channel])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1">
        <span className="text-sm uppercase tracking-wider text-slate-500 mr-2">
          Channel:
        </span>
        {['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'].map((c) => (
          <button
            key={c}
            onClick={() => setChannel(c)}
            className={`h-7 px-3 text-sm border rounded inline-flex items-center transition-colors ${
              channel === c
                ? `${CHANNEL_TONE[c]} font-semibold`
                : 'bg-white text-slate-600 border-slate-200'
            }`}
          >
            {c}
          </button>
        ))}
      </div>
      {loading && (
        <Card>
          <div
            role="status"
            aria-live="polite"
            className="text-md text-slate-500 py-8 text-center"
          >
            Loading drafts…
          </div>
        </Card>
      )}
      {!loading && error && (
        <Card>
          <div
            role="alert"
            className="text-md text-rose-600 py-8 text-center"
          >
            Failed to load drafts: {error}
          </div>
        </Card>
      )}
      {!loading && !error && data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card title={`Drafts (${data.draftCount})`}>
            {data.drafts.length === 0 ? (
              <div className="py-8 text-center text-base text-slate-500">
                <Sparkles className="w-6 h-6 mx-auto text-slate-300 mb-2" />
                No drafts on {channel}.
                <div className="text-sm text-slate-400 mt-1">
                  Drafts appear here when wizards leave content
                  unpublished — usually pending review or marketplace
                  validation.
                </div>
              </div>
            ) : (
              <ul className="space-y-1 -my-1">
                {data.drafts.slice(0, 30).map((d) => (
                  <li
                    key={d.id}
                    className="flex items-center justify-between gap-3 py-1.5 px-2 -mx-2 rounded hover:bg-slate-50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-base text-slate-900 truncate">
                        {d.product.name}
                      </div>
                      <div className="text-sm text-slate-500 font-mono">
                        {d.product.sku} · {d.marketplace}
                      </div>
                    </div>
                    <Link
                      href={`/products/${d.productId}/list-wizard?channel=${d.channel}`}
                      className="h-7 px-3 text-sm bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100"
                    >
                      Publish
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={`Uncovered (${data.uncoveredCount})`}>
            {data.uncovered.length === 0 ? (
              <div className="py-8 text-center text-base text-slate-500">
                <CheckCircle2 className="w-6 h-6 mx-auto text-emerald-400 mb-2" />
                Every product is listed on {channel}.
                <div className="text-sm text-slate-400 mt-1">
                  No coverage gaps to fix on this marketplace.
                </div>
              </div>
            ) : (
              <ul className="space-y-1 -my-1">
                {data.uncovered.slice(0, 30).map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-3 py-1.5 px-2 -mx-2 rounded hover:bg-slate-50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-base text-slate-900 truncate">
                        {p.name}
                      </div>
                      <div className="text-sm text-slate-500 font-mono">
                        {p.sku}
                      </div>
                    </div>
                    <Link
                      href={`/products/${p.id}/list-wizard?channel=${channel}`}
                      className="h-7 px-3 text-sm bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100"
                    >
                      List
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}
