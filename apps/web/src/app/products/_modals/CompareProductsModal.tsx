'use client'

/**
 * P.17 — side-by-side product comparison.
 *
 * Triggered from the bulk-action bar when 2-4 products are selected.
 * Renders a column per product with the same field rows down the
 * left edge, highlighting any row where values differ. Useful for:
 *   - Spotting near-duplicates that should be merged or unified
 *   - Sanity-checking sibling variants under a parent (price/stock
 *     parity, image counts)
 *   - Cross-channel coverage gaps before a bulk publish
 *
 * No fetching: reads from the productLookup the parent already has
 * loaded (the grid's current page). Selecting an off-screen product
 * isn't supported because the grid's virtualization keeps off-page
 * rows out of memory; the operator can re-filter to bring them in.
 *
 * Click a column header → opens that product in the drawer (replaces
 * the compare modal). Click "Close" → returns to the grid.
 */

import { useMemo } from 'react'
import { X, ExternalLink, ChevronRight } from 'lucide-react'
import { CHANNEL_TONE } from '@/lib/products/theme'
import { IconButton } from '@/components/ui/IconButton'
import { Modal } from '@/components/ui/Modal'

export interface CompareProduct {
  id: string
  sku: string
  name: string
  brand?: string | null
  productType?: string | null
  basePrice?: number
  totalStock?: number
  lowStockThreshold?: number
  status?: string
  fulfillmentMethod?: string | null
  imageUrl?: string | null
  photoCount?: number
  channelCount?: number
  variantCount?: number
  isParent?: boolean
  parentId?: string | null
  updatedAt?: string
  coverage?: Record<
    string,
    { live: number; draft: number; error: number; total: number }
  > | null
}

const ALL_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'] as const

export default function CompareProductsModal({
  products,
  onClose,
}: {
  products: CompareProduct[]
  onClose: () => void
}) {
  // Field rows. Each row knows how to render a value per product +
  // detect whether the values differ across products (drives the
  // amber row tint that operators scan for).
  const rows = useMemo(() => {
    const fmtPrice = (n: number | undefined) =>
      n == null ? '—' : `€${Number(n).toFixed(2)}`
    const fmtNum = (n: number | undefined) => (n == null ? '—' : String(n))
    const fmtDate = (s: string | undefined) =>
      s ? new Date(s).toLocaleDateString() : '—'

    type Row = {
      label: string
      values: string[]
      differs: boolean
      tone?: 'numeric' | 'mono'
    }
    const make = (
      label: string,
      get: (p: CompareProduct) => string,
      tone?: 'numeric' | 'mono',
    ): Row => {
      const values = products.map(get)
      const distinct = new Set(values.filter((v) => v && v !== '—'))
      // "differs" = at least one non-empty value is different from the
      // others. Treat all-empty as "matches" so we don't flag rows
      // that simply have no data on either side.
      return { label, values, differs: distinct.size > 1, tone }
    }

    const rs: Row[] = [
      make('SKU', (p) => p.sku, 'mono'),
      make('Name', (p) => p.name),
      make('Brand', (p) => p.brand ?? '—'),
      make('Type', (p) => p.productType ?? '—'),
      make('Status', (p) => p.status ?? '—'),
      make('Price', (p) => fmtPrice(p.basePrice), 'numeric'),
      make('Stock', (p) => fmtNum(p.totalStock), 'numeric'),
      make('Low @', (p) => fmtNum(p.lowStockThreshold), 'numeric'),
      make('Fulfillment', (p) => p.fulfillmentMethod ?? '—'),
      make('Photos', (p) => fmtNum(p.photoCount), 'numeric'),
      make('Variants', (p) => fmtNum(p.variantCount), 'numeric'),
      make('Updated', (p) => fmtDate(p.updatedAt)),
    ]
    return rs
  }, [products])

  return (
    // U.3c — Modal primitive replaces hand-rolled overlay. placement="top"
    // matches the prior pt-[8vh] anchor; size="3xl" gives the same
    // ~768px panel width (was custom w-[920px], slight narrowing —
    // acceptable for the standard size scale; columns fit fine for
    // 2-4 products which is the eligible range).
    <Modal
      open
      onClose={onClose}
      placement="top"
      size="3xl"
      header={null}
      className="overflow-hidden"
    >
        <header className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
          <div className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Compare {products.length} products
          </div>
          <IconButton
            onClick={onClose}
            aria-label="Close"
            size="md"
            className="text-slate-400 dark:text-slate-500 hover:text-slate-600"
          >
            <X className="w-4 h-4" />
          </IconButton>
        </header>

        <div className="flex-1 overflow-auto">
          <table className="w-full text-base border-collapse">
            <thead className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 sticky top-0 z-10">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 w-32">
                  Field
                </th>
                {products.map((p) => (
                  <th
                    key={p.id}
                    className="px-3 py-2 text-left align-top border-l border-slate-200 dark:border-slate-700"
                  >
                    <div className="flex items-start gap-2">
                      {p.imageUrl ? (
                        <img
                          src={p.imageUrl}
                          alt=""
                          className="w-10 h-10 rounded object-cover bg-slate-100 dark:bg-slate-800 flex-shrink-0"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded bg-slate-100 dark:bg-slate-800 flex-shrink-0" />
                      )}
                      <div className="min-w-0">
                        <button
                          type="button"
                          onClick={() => {
                            // Replace this modal with the product
                            // drawer. Same custom-event channel the
                            // grid + Variations tab use.
                            window.dispatchEvent(
                              new CustomEvent('nexus:open-product-drawer', {
                                detail: { productId: p.id },
                              }),
                            )
                            onClose()
                          }}
                          className="text-left text-base font-semibold text-slate-900 dark:text-slate-100 hover:text-blue-700 dark:hover:text-blue-300 truncate block max-w-[220px]"
                          title={p.name}
                        >
                          {p.name}
                        </button>
                        <div className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate max-w-[220px]">
                          {p.sku}
                        </div>
                      </div>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.label}
                  className={
                    row.differs
                      ? 'border-b border-slate-100 dark:border-slate-800 bg-amber-50/40'
                      : 'border-b border-slate-100 dark:border-slate-800'
                  }
                  title={row.differs ? 'Values differ across products' : undefined}
                >
                  <td className="px-3 py-1.5 text-sm text-slate-500 dark:text-slate-400 uppercase tracking-wider font-semibold align-top">
                    {row.label}
                  </td>
                  {row.values.map((v, i) => (
                    <td
                      key={i}
                      className={
                        'px-3 py-1.5 align-top border-l border-slate-200 dark:border-slate-700 ' +
                        (row.tone === 'numeric'
                          ? 'text-right tabular-nums'
                          : row.tone === 'mono'
                          ? 'font-mono text-sm'
                          : '') +
                        (row.differs ? ' text-amber-900' : ' text-slate-800 dark:text-slate-200')
                      }
                    >
                      {v}
                    </td>
                  ))}
                </tr>
              ))}

              {/* Coverage row — per-channel chips per product so the
                  operator sees gap symmetry / asymmetry at a glance.
                  Differs check = at least one product has a different
                  set of covered channels than the others. */}
              {(() => {
                const coverageSig = (p: CompareProduct) =>
                  Object.keys(p.coverage ?? {}).sort().join(',')
                const sigs = new Set(products.map(coverageSig))
                const differs = sigs.size > 1
                return (
                  <tr
                    className={
                      differs
                        ? 'border-b border-slate-100 dark:border-slate-800 bg-amber-50/40'
                        : 'border-b border-slate-100 dark:border-slate-800'
                    }
                  >
                    <td className="px-3 py-1.5 text-sm text-slate-500 dark:text-slate-400 uppercase tracking-wider font-semibold align-top">
                      Channels
                    </td>
                    {products.map((p) => (
                      <td
                        key={p.id}
                        className="px-3 py-1.5 align-top border-l border-slate-200 dark:border-slate-700"
                      >
                        <div className="flex flex-wrap gap-1">
                          {ALL_CHANNELS.map((ch) => {
                            const c = p.coverage?.[ch]
                            if (!c) {
                              return (
                                <span
                                  key={ch}
                                  className="inline-flex items-center px-1.5 h-5 text-xs font-mono border border-dashed border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-400 dark:text-slate-500 rounded"
                                  title={`Not on ${ch}`}
                                >
                                  {ch.slice(0, 3)}
                                </span>
                              )
                            }
                            return (
                              <span
                                key={ch}
                                title={`${ch}: ${c.live} live, ${c.draft} draft, ${c.error} error / ${c.total}`}
                                className={`inline-flex items-center gap-0.5 px-1.5 h-5 text-xs font-mono border rounded ${CHANNEL_TONE[ch]}`}
                              >
                                {ch.slice(0, 3)}
                                <span className="opacity-60">{c.total}</span>
                              </span>
                            )
                          })}
                        </div>
                      </td>
                    ))}
                  </tr>
                )
              })()}
            </tbody>
          </table>
        </div>

        <footer className="flex items-center justify-between px-4 py-2.5 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 flex-shrink-0">
          <span className="text-sm text-slate-500 dark:text-slate-400">
            Amber rows differ across products. Click a header to open in drawer.
          </span>
          <div className="flex items-center gap-3">
            {products.map((p) => (
              <a
                key={p.id}
                href={`/products/${p.id}/edit`}
                className="text-sm text-blue-700 dark:text-blue-300 hover:underline inline-flex items-center gap-0.5"
                title={`Open ${p.sku} edit page`}
              >
                <ExternalLink className="w-3 h-3" /> {p.sku.slice(0, 12)}
                <ChevronRight className="w-3 h-3" />
              </a>
            ))}
          </div>
        </footer>
    </Modal>
  )
}
