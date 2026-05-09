'use client'

/**
 * W3.11 — Channel Readiness lens (Salsify cornerstone UI).
 *
 * Matrix view: products × channels. Each cell shows the per-channel
 * readiness score (0-100) with a tone-coded badge:
 *   ≥ 90  — emerald  "ready to publish"
 *   ≥ 70  — amber    "almost there"
 *   < 70  — rose     "needs work"
 *
 * Click a cell → drawer at the Listings tab so the operator can
 * see + fix missing fields. Hovering surfaces the missing-fields
 * list inline as a tooltip.
 *
 * Headlined on top: aggregate "averaged across all visible
 * products" per channel — the operator's at-a-glance "where am I
 * weakest?" answer.
 *
 * Self-contained: takes the products[] from the workspace, hits
 * POST /api/products/channel-readiness/bulk for the per-product
 * scores. 200/page cap matches the existing /products page size.
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, Sparkles } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import { type ProductRow } from '../_types'

const CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY'] as const
type Channel = (typeof CHANNELS)[number]

interface ChannelReadinessRow {
  channel: Channel
  score: number
  filled: number
  totalRequired: number
  missing: Array<{
    key: string
    label: string
    source: 'family' | 'channel_minimum'
  }>
}

interface ReadinessResult {
  productId: string
  channels: ChannelReadinessRow[]
  averageScore: number
  familyDriven: boolean
}

interface BulkResponse {
  results: Record<string, ReadinessResult | { error: string }>
}

function tone(score: number): string {
  if (score >= 90)
    return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
  if (score >= 70)
    return 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
  return 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
}

export function ReadinessLens({
  products,
  loading: parentLoading,
}: {
  products: ProductRow[]
  loading: boolean
}) {
  const [byProduct, setByProduct] = useState<
    Record<string, ReadinessResult>
  >({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (products.length === 0) {
      setByProduct({})
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`${getBackendUrl()}/api/products/channel-readiness/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productIds: products.map((p) => p.id) }),
    })
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((data: BulkResponse) => {
        if (cancelled) return
        const map: Record<string, ReadinessResult> = {}
        for (const [id, v] of Object.entries(data.results ?? {})) {
          if (v && typeof v === 'object' && 'channels' in v) {
            map[id] = v as ReadinessResult
          }
        }
        setByProduct(map)
      })
      .catch((e) => !cancelled && setError(e?.message ?? String(e)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [products])

  // Per-channel aggregate across visible products.
  const channelAverages = useMemo(() => {
    const acc: Record<Channel, { sum: number; count: number }> = {
      AMAZON: { sum: 0, count: 0 },
      EBAY: { sum: 0, count: 0 },
      SHOPIFY: { sum: 0, count: 0 },
    }
    for (const p of products) {
      const r = byProduct[p.id]
      if (!r) continue
      for (const cr of r.channels) {
        const slot = acc[cr.channel]
        if (slot) {
          slot.sum += cr.score
          slot.count++
        }
      }
    }
    return CHANNELS.map((ch) => ({
      channel: ch,
      average: acc[ch].count > 0 ? Math.round(acc[ch].sum / acc[ch].count) : 0,
    }))
  }, [byProduct, products])

  if (parentLoading) {
    return (
      <div className="text-base text-slate-500 dark:text-slate-400">
        Loading products…
      </div>
    )
  }
  if (products.length === 0) {
    return (
      <EmptyState
        icon={Sparkles}
        title="No products to score"
        description="The Readiness matrix scores each product against per-channel publishability rules. Adjust filters so at least one product matches and the matrix appears here."
        action={{ label: 'Clear filters', href: '/products' }}
      />
    )
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="border border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-700 dark:text-rose-300 inline-flex items-start gap-1.5">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Per-channel aggregate card */}
      <div className="grid grid-cols-3 gap-3">
        {channelAverages.map((c) => (
          <Card key={c.channel} title={c.channel}>
            <div className="flex items-center justify-between">
              <span
                className={cn(
                  'inline-flex items-center px-2 py-0.5 text-base font-semibold rounded tabular-nums',
                  tone(c.average),
                )}
              >
                {c.average}%
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                avg across {products.length} product{products.length === 1 ? '' : 's'}
              </span>
            </div>
          </Card>
        ))}
      </div>

      {/* Per-product matrix */}
      <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <table className="w-full text-base">
          <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
            <tr className="text-left">
              <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
                Product
              </th>
              {CHANNELS.map((ch) => (
                <th
                  key={ch}
                  className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300 text-center w-32"
                >
                  {ch}
                </th>
              ))}
              <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300 w-24 text-right">
                Source
              </th>
            </tr>
          </thead>
          <tbody>
            {products.slice(0, 200).map((p) => {
              const r = byProduct[p.id]
              return (
                <tr
                  key={p.id}
                  className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-900/40"
                >
                  <td className="px-3 py-2">
                    <Link
                      href={`/products?drawer=${p.id}&drawerTab=listings`}
                      className="text-slate-900 dark:text-slate-100 hover:underline"
                    >
                      {p.name}
                    </Link>
                    <div className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate max-w-md">
                      {p.sku}
                      {p.brand && (
                        <span className="ml-1 text-slate-400 dark:text-slate-500">
                          · {p.brand}
                        </span>
                      )}
                    </div>
                  </td>
                  {CHANNELS.map((ch) => {
                    const cr = r?.channels.find((c) => c.channel === ch)
                    if (loading && !r) {
                      return (
                        <td key={ch} className="px-3 py-2 text-center">
                          <span className="inline-block w-12 h-4 bg-slate-100 dark:bg-slate-800 rounded animate-pulse" />
                        </td>
                      )
                    }
                    if (!cr) {
                      return (
                        <td key={ch} className="px-3 py-2 text-center text-xs text-slate-400">
                          —
                        </td>
                      )
                    }
                    const missingPreview = cr.missing
                      .slice(0, 5)
                      .map((m) => m.label)
                      .join(', ')
                    const moreCount = Math.max(cr.missing.length - 5, 0)
                    return (
                      <td key={ch} className="px-3 py-2 text-center">
                        <Link
                          href={`/products?drawer=${p.id}&drawerTab=listings`}
                          className={cn(
                            'inline-flex items-center px-2 py-0.5 text-sm font-medium rounded tabular-nums hover:opacity-80',
                            tone(cr.score),
                          )}
                          title={
                            cr.missing.length === 0
                              ? `Ready: ${cr.filled}/${cr.totalRequired} fields filled`
                              : `${cr.score}% · missing: ${missingPreview}${moreCount > 0 ? ` (+${moreCount} more)` : ''}`
                          }
                        >
                          {cr.score}%
                        </Link>
                      </td>
                    )
                  })}
                  <td className="px-3 py-2 text-right text-xs text-slate-500 dark:text-slate-400">
                    {r?.familyDriven ? 'family' : r ? 'min fields' : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
