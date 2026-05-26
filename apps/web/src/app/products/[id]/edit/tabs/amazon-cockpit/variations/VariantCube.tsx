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
import { getBackendUrl } from '@/lib/backend-url'
import { useVariantCube } from '../../../_shared/cockpit-shell'

// CUBE.1 — single editable numeric cell. Click → input; Enter/blur saves
// via the provided onSave; Esc cancels. Shows a saving/error state. Used
// for the per-variant master fields (base price, stock).
function EditableNumberCell({
  value,
  onSave,
  prefix,
  decimals = 0,
  readOnly = false,
  readOnlyHint,
}: {
  value: number | null
  onSave: (next: number) => Promise<boolean>
  prefix?: string
  decimals?: number
  /** Disable editing (e.g. FBA quantity is Amazon-managed). */
  readOnly?: boolean
  readOnlyHint?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle')

  const display =
    value == null ? '—' : `${prefix ? prefix + ' ' : ''}${value.toFixed(decimals)}`

  if (readOnly) {
    return (
      <span
        className="inline-flex items-center gap-1 px-1 py-0.5 tabular-nums text-slate-500 dark:text-slate-400"
        title={readOnlyHint}
      >
        {display}
        {readOnlyHint && <span aria-hidden className="text-[10px] text-slate-400">🔒</span>}
      </span>
    )
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(value == null ? '' : String(value))
          setEditing(true)
          setState('idle')
        }}
        className={cn(
          'w-full rounded px-1 py-0.5 text-left tabular-nums hover:bg-slate-100 dark:hover:bg-slate-800',
          state === 'error' && 'text-rose-500',
        )}
        title="Click to edit"
      >
        {display}
        {state === 'error' && <span className="ml-1 text-[10px]">retry</span>}
      </button>
    )
  }

  const commit = async () => {
    const n = parseFloat(draft)
    if (!Number.isFinite(n) || n === value) {
      setEditing(false)
      return
    }
    setState('saving')
    const ok = await onSave(n)
    setEditing(false)
    setState(ok ? 'idle' : 'error')
  }

  return (
    <input
      autoFocus
      type="number"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commit()
        if (e.key === 'Escape') setEditing(false)
      }}
      className="w-20 rounded border border-blue-300 px-1 py-0.5 text-sm tabular-nums dark:border-blue-700 dark:bg-slate-900"
    />
  )
}

async function patchChild(id: string, field: 'basePrice' | 'totalStock', value: number): Promise<boolean> {
  try {
    const r = await fetch(`${getBackendUrl()}/api/products/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    })
    return r.ok
  } catch {
    return false
  }
}

type CubeView = 'axis' | 'variant' | 'market'

export interface VariantCubeProps {
  productId: string
  channel?: string
  activeMarket: string
  activeCurrency: string
  /** Active market's fulfilment. When 'FBA', quantity/stock is Amazon-
   *  managed and not editable. */
  activeFulfillment?: 'FBA' | 'FBM' | null
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
  activeFulfillment,
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
          activeFulfillment={activeFulfillment}
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
  activeFulfillment,
}: {
  variants: ReturnType<typeof useVariantCube>['variants']
  loading: boolean
  error: string | null
  activeMarket: string
  activeCurrency: string
  activeFulfillment?: 'FBA' | 'FBM' | null
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

  return (
    <ByVariantTable
      variants={variants}
      activeMarket={activeMarket}
      activeCurrency={activeCurrency}
      activeFulfillment={activeFulfillment}
    />
  )
}

type VariantEdit = { basePrice?: number; totalStock?: number }

function ByVariantTable({
  variants,
  activeMarket,
  activeCurrency,
  activeFulfillment,
}: {
  variants: ReturnType<typeof useVariantCube>['variants']
  activeMarket: string
  activeCurrency: string
  activeFulfillment?: 'FBA' | 'FBM' | null
}) {
  const isFba = activeFulfillment === 'FBA'
  const [query, setQuery] = useState('')
  const [lowOnly, setLowOnly] = useState(false)
  // CUBE.1 — optimistic overlay of edited values (kept after a successful
  // save so the cell doesn't flip back before the next cube refetch).
  const [edits, setEdits] = useState<Record<string, VariantEdit>>({})

  type Variant = ReturnType<typeof useVariantCube>['variants'][number]
  const effBase = (v: Variant) => edits[v.id]?.basePrice ?? v.basePrice
  const effStock = (v: Variant) => edits[v.id]?.totalStock ?? v.totalStock
  const lowEff = (v: Variant) => {
    const s = effStock(v)
    return v.lowStockThreshold != null && s != null && s <= v.lowStockThreshold
  }

  const saveField = async (id: string, field: 'basePrice' | 'totalStock', n: number) => {
    const ok = await patchChild(id, field, n)
    if (ok) setEdits((e) => ({ ...e, [id]: { ...e[id], [field]: n } }))
    return ok
  }

  const q = query.trim().toLowerCase()
  const rows = variants.filter((v) => {
    if (lowOnly && !lowEff(v)) return false
    if (q) {
      const hay = `${variantLabel(v.axes, v.sku)} ${v.sku}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search variants…"
          className="h-7 w-48 rounded border border-slate-200 px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
        />
        <button
          type="button"
          onClick={() => setLowOnly((s) => !s)}
          className={cn(
            'h-7 rounded border px-2 text-xs',
            lowOnly
              ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
              : 'border-slate-200 text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
          )}
        >
          Low stock only
        </button>
        <span className="text-xs text-slate-400">
          {rows.length} / {variants.length}
        </span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
      <table className="w-full min-w-[520px] text-sm">
        <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
          <tr>
            <th className="px-3 py-2 font-medium">Variant</th>
            <th className="px-3 py-2 font-medium">Base price</th>
            <th className="px-3 py-2 font-medium">Listed qty</th>
            <th className="px-3 py-2 font-medium">Stock</th>
            <th className="px-3 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((v) => {
            const cell = v.marketsByCode[activeMarket]
            const low = lowEff(v)
            // Per-SKU fulfilment (from /channel-inventory); fall back to the
            // active market's default when this variant has no listing yet.
            const rowFba = (cell?.fulfillmentChannel ?? (isFba ? 'FBA' : null)) === 'FBA'
            return (
              <tr key={v.id} className="text-slate-700 dark:text-slate-300">
                <td className="px-3 py-1.5">
                  <span className="font-medium">{variantLabel(v.axes, v.sku)}</span>
                  <span className="ml-1.5 font-mono text-[10px] text-slate-400">{v.sku}</span>
                </td>
                <td className="px-3 py-1">
                  <EditableNumberCell
                    value={effBase(v)}
                    prefix={activeCurrency}
                    decimals={2}
                    onSave={(n) => saveField(v.id, 'basePrice', n)}
                  />
                </td>
                <td className="px-3 py-1.5">{cell?.listedQty ?? '—'}</td>
                <td className={cn('px-3 py-1', low && 'text-amber-600 dark:text-amber-400')}>
                  <span className="inline-flex items-center">
                    <EditableNumberCell
                      value={effStock(v)}
                      decimals={0}
                      readOnly={rowFba}
                      readOnlyHint={
                        rowFba ? 'Quantity is managed by Amazon for FBA offers' : undefined
                      }
                      onSave={(n) => saveField(v.id, 'totalStock', n)}
                    />
                    {low && !rowFba && <span className="ml-1 text-[10px]">⚠</span>}
                  </span>
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
    </div>
  )
}
