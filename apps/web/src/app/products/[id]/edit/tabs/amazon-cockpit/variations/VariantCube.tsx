'use client'

// UC.6.2 — Variant Cube.
//
// A view switcher over the shared useVariantCube data:
//   • Axis grid   — the existing VariationMatrix (passed in via slot),
//                   so the proven color×size editor is preserved.
//   • By variant  — rows = variants, columns = child-fields, for the
//                   current (channel, market). [this phase]
//   • By market   — one field across markets (UC.6.3).
//
// Defaults to the axis grid so the operator's current experience is
// unchanged; the new pivots are opt-in tabs.

import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useVariantCube } from '../../../_shared/cockpit-shell'

type CubeView = 'axis' | 'variant' | 'market'

export interface VariantCubeProps {
  productId: string
  channel?: string
  activeMarket: string
  activeCurrency: string
  /** The existing VariationMatrix, rendered as the axis-grid view. */
  axisGrid: ReactNode
}

function variantLabel(axes: Record<string, string>, sku: string): string {
  const parts = Object.values(axes).filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : sku
}

export default function VariantCube({
  productId,
  channel = 'AMAZON',
  activeMarket,
  activeCurrency,
  axisGrid,
}: VariantCubeProps) {
  const [view, setView] = useState<CubeView>('axis')
  const { variants, marketCodes, loading, error } = useVariantCube(productId, channel)

  const tab = (v: CubeView, label: string) => (
    <button
      type="button"
      onClick={() => setView(v)}
      className={cn(
        'h-7 rounded-md px-2.5 text-xs font-medium',
        view === v
          ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
          : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
      )}
    >
      {label}
    </button>
  )

  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center gap-1">
        {tab('axis', 'Axis grid')}
        {tab('variant', 'By variant')}
        {tab('market', 'By market')}
        <span className="ml-2 text-xs text-slate-400">· {activeMarket}</span>
      </div>

      {view === 'axis' && axisGrid}

      {view === 'variant' && (
        <ByVariantView
          variants={variants}
          loading={loading}
          error={error}
          activeMarket={activeMarket}
          activeCurrency={activeCurrency}
        />
      )}

      {view === 'market' && (
        <ByMarketView
          variants={variants}
          marketCodes={marketCodes}
          loading={loading}
          error={error}
          activeCurrency={activeCurrency}
        />
      )}
    </div>
  )
}

type MarketField = 'price' | 'listedQty'

function ByMarketView({
  variants,
  marketCodes,
  loading,
  error,
  activeCurrency,
}: {
  variants: ReturnType<typeof useVariantCube>['variants']
  marketCodes: string[]
  loading: boolean
  error: string | null
  activeCurrency: string
}) {
  const [field, setField] = useState<MarketField>('price')

  if (loading) return <div className="py-8 text-center text-sm text-slate-400">Loading variants…</div>
  if (error) return <div className="py-8 text-center text-sm text-rose-500">{error}</div>
  if (variants.length === 0) return <div className="py-8 text-center text-sm text-slate-400">No variants.</div>
  if (marketCodes.length === 0)
    return <div className="py-8 text-center text-sm text-slate-400">No market data yet.</div>

  const cellValue = (
    v: ReturnType<typeof useVariantCube>['variants'][number],
    mp: string,
  ): string => {
    const cell = v.marketsByCode[mp]
    if (!cell) return '—'
    if (field === 'price') {
      const p = cell.price ?? v.basePrice
      return p == null ? '—' : `${activeCurrency} ${p.toFixed(2)}`
    }
    return cell.listedQty == null ? '—' : String(cell.listedQty)
  }

  const fieldBtn = (f: MarketField, label: string) => (
    <button
      type="button"
      onClick={() => setField(f)}
      className={cn(
        'h-6 rounded px-2 text-xs',
        field === f
          ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
          : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800',
      )}
    >
      {label}
    </button>
  )

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1">
        <span className="text-xs text-slate-400">Field:</span>
        {fieldBtn('price', 'Price')}
        {fieldBtn('listedQty', 'Listed qty')}
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
            <tr>
              <th className="px-3 py-2 font-medium">Variant</th>
              {marketCodes.map((mp) => (
                <th key={mp} className="px-3 py-2 font-medium">{mp}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {variants.map((v) => (
              <tr key={v.id} className="text-slate-700 dark:text-slate-300">
                <td className="px-3 py-1.5">
                  <span className="font-medium">{variantLabel(v.axes, v.sku)}</span>
                </td>
                {marketCodes.map((mp) => (
                  <td key={mp} className="px-3 py-1.5 tabular-nums">{cellValue(v, mp)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ByVariantView({
  variants,
  loading,
  error,
  activeMarket,
  activeCurrency,
}: {
  variants: ReturnType<typeof useVariantCube>['variants']
  loading: boolean
  error: string | null
  activeMarket: string
  activeCurrency: string
}) {
  if (loading) {
    return <div className="py-8 text-center text-sm text-slate-400">Loading variants…</div>
  }
  if (error) {
    return <div className="py-8 text-center text-sm text-rose-500">{error}</div>
  }
  if (variants.length === 0) {
    return <div className="py-8 text-center text-sm text-slate-400">No variants.</div>
  }

  const fmtPrice = (n: number | null) => (n == null ? '—' : `${activeCurrency} ${n.toFixed(2)}`)

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
      <table className="w-full min-w-[520px] text-sm">
        <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
          <tr>
            <th className="px-3 py-2 font-medium">Variant</th>
            <th className="px-3 py-2 font-medium">Price</th>
            <th className="px-3 py-2 font-medium">Listed qty</th>
            <th className="px-3 py-2 font-medium">Stock</th>
            <th className="px-3 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {variants.map((v) => {
            const cell = v.marketsByCode[activeMarket]
            const low =
              v.lowStockThreshold != null &&
              v.totalStock != null &&
              v.totalStock <= v.lowStockThreshold
            return (
              <tr key={v.id} className="text-slate-700 dark:text-slate-300">
                <td className="px-3 py-1.5">
                  <span className="font-medium">{variantLabel(v.axes, v.sku)}</span>
                  <span className="ml-1.5 font-mono text-[10px] text-slate-400">{v.sku}</span>
                </td>
                <td className="px-3 py-1.5">{fmtPrice(cell?.price ?? v.basePrice)}</td>
                <td className="px-3 py-1.5">{cell?.listedQty ?? '—'}</td>
                <td className={cn('px-3 py-1.5', low && 'text-amber-600 dark:text-amber-400')}>
                  {v.totalStock ?? '—'}
                  {low && <span className="ml-1 text-[10px]">⚠</span>}
                </td>
                <td className="px-3 py-1.5 text-xs text-slate-500">
                  {cell?.listingStatus || v.status || '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
