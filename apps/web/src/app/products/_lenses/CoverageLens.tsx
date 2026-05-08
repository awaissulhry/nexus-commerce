'use client'

/**
 * P.1d — extracted from ProductsWorkspace.tsx as part of the
 * file-decomposition sweep. Channel × marketplace matrix per
 * product. Reads coverage maps already attached to each product
 * row (the workspace's products[] is fetched with coverage
 * pre-computed via /api/products?include=coverage).
 *
 * Top section: per-channel coverage % header strip.
 * Body: virtualization-free table (capped at 100 rows visible)
 *       with sticky-left product column + cells per channel
 *       linking to /listings/<channel>?search=<sku>.
 *
 * P.10 was the original feature; this is a pure file extract.
 */

import Link from 'next/link'
import { Network } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { CHANNEL_TONE } from '@/lib/products/theme'

// Minimal shape — subset of ProductRow that this lens actually
// reads. Defined locally so the lens doesn't need to import the
// full ProductRow type from ProductsWorkspace.tsx during the
// decomposition sweep. A shared _types.ts file consolidates these
// in a follow-up commit.
const CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY']

interface CoverageProduct {
  id: string
  sku: string
  name: string
  coverage: Record<
    string,
    { live: number; draft: number; error: number; total: number }
  > | null
}

export function CoverageLens({
  products,
  loading,
}: {
  products: CoverageProduct[]
  loading: boolean
}) {
  if (loading)
    return (
      <Card>
        <div
          role="status"
          aria-live="polite"
          className="text-md text-slate-500 dark:text-slate-400 py-8 text-center"
        >
          Loading coverage…
        </div>
      </Card>
    )
  // P.6 — richer empty state. Coverage matrix needs products to
  // visualize; explain *why* it's empty + give an action.
  if (products.length === 0)
    return (
      <EmptyState
        icon={Network}
        title="No products to map across channels"
        description="The Coverage matrix shows which products are listed on which channel × marketplace. Once your filter matches at least one product, the matrix renders here."
        action={{ label: 'Clear filters', href: '/products' }}
      />
    )

  // U.30 — Active channel scope is Amazon + eBay + Shopify only
  // (per project decision; WooCommerce + Etsy intentionally skipped).
  // Was rendering 5 columns; the last two were always empty.
  // U.33 — hoisted outside component to avoid recreating each render.
  const channels = CHANNELS

  // P.10 — top-line per-channel coverage. Counted across the visible
  // slice (products.slice(0, 100) below) so the header's percentage
  // matches what the operator can see + scroll. Three buckets per
  // channel: live (any ChannelListing in ACTIVE+isPublished),
  // listed-but-not-live (DRAFT or ERROR), and missing entirely.
  const visible = products.slice(0, 100)
  const channelStats = channels.map((ch) => {
    let live = 0
    let listed = 0
    for (const p of visible) {
      const c = p.coverage?.[ch]
      if (!c) continue
      listed++
      if (c.live > 0) live++
    }
    const missing = visible.length - listed
    const pct =
      visible.length === 0 ? 0 : Math.round((live / visible.length) * 100)
    return { channel: ch, live, listed, missing, pct }
  })

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex items-center gap-3 flex-wrap text-base">
          <span className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
            Coverage across {visible.length} product
            {visible.length === 1 ? '' : 's'}
          </span>
          <div className="flex items-center gap-2 flex-wrap ml-auto">
            {channelStats.map((s) => {
              const pctTone =
                s.pct >= 80
                  ? 'text-emerald-700 dark:text-emerald-300'
                  : s.pct >= 40
                    ? 'text-amber-700 dark:text-amber-300'
                    : 'text-rose-700 dark:text-rose-300'
              return (
                <span
                  key={s.channel}
                  className={`inline-flex items-center gap-1.5 px-2 py-1 border rounded ${CHANNEL_TONE[s.channel]}`}
                  title={`${s.live} live, ${s.listed - s.live} listed but not live, ${s.missing} missing`}
                >
                  <span className="font-semibold text-xs">
                    {s.channel.slice(0, 3)}
                  </span>
                  <span className={`tabular-nums font-semibold ${pctTone}`}>
                    {s.pct}%
                  </span>
                  <span className="text-xs opacity-70 tabular-nums">
                    {s.live}/{visible.length}
                  </span>
                </span>
              )
            })}
          </div>
        </div>
      </Card>
      <Card noPadding>
        <div className="overflow-x-auto">
          <table className="w-full text-base">
            <thead className="bg-slate-50 border-b border-slate-200 dark:bg-slate-800 dark:border-slate-800">
              <tr>
                <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700 sticky left-0 bg-slate-50 z-10 min-w-[260px] dark:text-slate-300 dark:bg-slate-800">
                  Product
                </th>
                {channels.map((c) => (
                  <th
                    key={c}
                    className="px-3 py-2 text-center text-xs font-semibold uppercase text-slate-500 dark:text-slate-400"
                  >
                    <span
                      className={`inline-block px-1.5 py-0.5 rounded border ${CHANNEL_TONE[c]}`}
                    >
                      {c}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {products.slice(0, 100).map((p) => (
                <tr
                  key={p.id}
                  className="border-b border-slate-100 hover:bg-slate-50/50 dark:border-slate-800 dark:hover:bg-slate-800/50"
                >
                  <td className="px-3 py-2 sticky left-0 bg-white border-r border-slate-100 dark:bg-slate-900 dark:border-slate-800">
                    <Link
                      href={`/products/${p.id}/edit`}
                      className="block hover:text-blue-600 dark:hover:text-blue-400"
                    >
                      <div className="text-md font-medium text-slate-900 dark:text-slate-100 truncate max-w-xs">
                        {p.name}
                      </div>
                      <div className="text-sm text-slate-500 dark:text-slate-400 font-mono">
                        {p.sku}
                      </div>
                    </Link>
                  </td>
                  {channels.map((ch) => {
                    const c = p.coverage?.[ch]
                    if (!c)
                      return (
                        <td
                          key={ch}
                          className="px-3 py-2 text-center text-slate-300 dark:text-slate-600"
                        >
                          —
                        </td>
                      )
                    const tone =
                      c.error > 0
                        ? 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800'
                        : c.live > 0
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'
                          : c.draft > 0
                            ? 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-800'
                            : 'bg-white text-slate-400 border-slate-200 dark:bg-slate-900 dark:text-slate-500 dark:border-slate-800'
                    return (
                      <td key={ch} className="px-2 py-2 text-center">
                        <Link
                          href={`/listings/${ch.toLowerCase()}?search=${encodeURIComponent(p.sku)}`}
                          className={`inline-flex items-center px-2 py-1 border rounded text-sm hover:opacity-80 ${tone}`}
                        >
                          <span className="font-semibold tabular-nums">
                            {c.live}
                          </span>
                          <span className="opacity-60 mx-0.5">/</span>
                          <span className="opacity-70 tabular-nums">
                            {c.total}
                          </span>
                        </Link>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
