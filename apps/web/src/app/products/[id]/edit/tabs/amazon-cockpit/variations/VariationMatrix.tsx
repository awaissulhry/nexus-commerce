'use client'

// AC.6 — Variation matrix card.
//
// Replaces the placeholder Variations card with a real per-child grid:
//
//   * Axes detected from `variations` (legacy) or `variantAttributes`
//     (canonical) on each child product. The first two distinct axes
//     become the matrix rows + columns; beyond 2 axes we fall back to
//     a flat row list (rare for apparel/gear).
//   * Per-cell preview: SKU, primary-image thumb, basePrice in the
//     active market currency, totalStock with low-stock chip, and a
//     status dot derived from the child's listing on the active
//     market (when known) or 'unlisted' otherwise.
//   * Theme picker is read-only in AC.6 — the cockpit surfaces the
//     detected theme as a chip + Amazon-suggested theme value from
//     the manifest. The actual write happens in AC.6.2 once the
//     per-cell editor lands.
//   * Sibling-market summary row: per other-market chip showing how
//     many children are published there.
//   * Click any cell → jump to the transitional pass-through (where
//     the AG-series ChannelFieldEditor still owns variant editing).
//
// Per-cell inline editing, color-locked images, and bulk row/col
// apply are AC.6.2 deliverables — this phase lands the grid + data
// flow first so operators can SEE the variation state at a glance.

import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { Layers, Package, AlertTriangle, ImageIcon } from 'lucide-react'
import {
  classifyStatus,
  marketFlag,
} from '../../../_shared/market-switch/types'

interface ChildProduct {
  id: string
  sku: string
  name?: string | null
  variantLabel?: string | null
  basePrice?: number | string | null
  totalStock?: number | null
  lowStockThreshold?: number | null
  status?: string | null
  variations?: Record<string, string> | null
  variantAttributes?: Record<string, unknown> | null
  images?: Array<{ url: string; type?: string; sortOrder?: number; isPrimary?: boolean }>
}

interface ListingLike {
  id: string
  productId?: string | null
  marketplace: string
  isPublished: boolean
  listingStatus: string
  externalListingId?: string | null
}

interface SiblingMarketInfo {
  code: string
  name: string
  currency: string
}

interface Props {
  children: ChildProduct[]
  /** All listings on the channel for THIS product family, across every
   *  marketplace. Used to derive the per-cell status dot for the active
   *  market and the sibling-market summary row. */
  channelListings: ListingLike[]
  activeMarketplace: string
  activeCurrency: string
  siblingMarkets: SiblingMarketInfo[]
  /** Theme detected from the manifest (e.g. "SizeColor"). Read-only
   *  display in AC.6; AC.6.2 promotes to a picker. */
  variationTheme?: string | null
  /** Click-to-jump back to the transitional pass-through where the
   *  AG-series field editor owns variant editing for now. */
  onJumpToClassic?: () => void
}

const PRICE_SYMBOL: Record<string, string> = {
  EUR: '€',
  GBP: '£',
  USD: '$',
  JPY: '¥',
}

function formatPrice(value: number | null, currency: string): string {
  if (value == null) return '—'
  const sym = PRICE_SYMBOL[currency] ?? `${currency} `
  return `${sym}${value.toFixed(2)}`
}

function readAxes(c: ChildProduct): Record<string, string> {
  // `variations` (legacy categoryAttributes.variations) is preferred —
  // it's the API-normalised flat axis map. Fall back to
  // `variantAttributes` (raw categoryAttributes) for older payloads.
  const vs = c.variations
  if (vs && typeof vs === 'object') return vs
  const va = c.variantAttributes
  if (!va || typeof va !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(va)) {
    if (typeof v === 'string') out[k] = v
    else if (typeof v === 'number') out[k] = String(v)
  }
  return out
}

function pickPrimaryImage(images: ChildProduct['images']): string | null {
  if (!images || images.length === 0) return null
  const explicit = images.find((i) => i.isPrimary)
  if (explicit) return explicit.url
  const main = [...images]
    .filter((i) => (i.type ?? '').toUpperCase() === 'MAIN')
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))[0]
  if (main) return main.url
  return images[0]?.url ?? null
}

export default function VariationMatrix({
  children,
  channelListings,
  activeMarketplace,
  activeCurrency,
  siblingMarkets,
  variationTheme,
  onJumpToClassic,
}: Props) {
  // Detect the axis universe across all children. Order: axes that
  // appear most often come first, with deterministic alphabetical
  // tie-break.
  const { axes, byAxis } = useMemo(() => {
    const counts = new Map<string, number>()
    const valuesByAxis = new Map<string, Set<string>>()
    for (const c of children) {
      const axesOnChild = readAxes(c)
      for (const [k, v] of Object.entries(axesOnChild)) {
        counts.set(k, (counts.get(k) ?? 0) + 1)
        const set = valuesByAxis.get(k) ?? new Set()
        set.add(v)
        valuesByAxis.set(k, set)
      }
    }
    const sortedAxes = Array.from(counts.entries())
      .sort(
        (a, b) =>
          b[1] - a[1] || a[0].localeCompare(b[0]),
      )
      .map(([k]) => k)
    const byAxis: Record<string, string[]> = {}
    for (const a of sortedAxes) {
      byAxis[a] = Array.from(valuesByAxis.get(a) ?? []).sort((x, y) =>
        x.localeCompare(y, undefined, { numeric: true }),
      )
    }
    return { axes: sortedAxes, byAxis }
  }, [children])

  // Index children by axis tuple for fast cell lookup.
  const childByAxis = useMemo(() => {
    const m = new Map<string, ChildProduct>()
    for (const c of children) {
      const a = readAxes(c)
      const key = axes.map((ax) => a[ax] ?? '').join('|')
      m.set(key, c)
    }
    return m
  }, [children, axes])

  // Per-child listing on the active marketplace.
  const activeListingByProduct = useMemo(() => {
    const m = new Map<string, ListingLike>()
    for (const l of channelListings) {
      if (l.marketplace !== activeMarketplace) continue
      if (l.productId) m.set(l.productId, l)
    }
    return m
  }, [channelListings, activeMarketplace])

  // Sibling-market totals — published / total children per market.
  const siblingTotals = useMemo(() => {
    const childIds = new Set(children.map((c) => c.id))
    const out: Record<
      string,
      { published: number; total: number }
    > = {}
    for (const m of siblingMarkets) {
      const list = channelListings.filter(
        (l) =>
          l.marketplace === m.code && l.productId && childIds.has(l.productId),
      )
      const pub = list.filter(
        (l) =>
          l.isPublished ||
          /ACTIVE|PUBLISHED|BUYABLE/i.test(l.listingStatus ?? ''),
      ).length
      out[m.code] = { published: pub, total: childIds.size }
    }
    return out
  }, [channelListings, siblingMarkets, children])

  // Three render modes:
  //   0 axes  → "no variations" fallback (parent shouldn't even mount us)
  //   1 axis  → vertical list
  //   2 axes  → 2D grid
  //   3+ axes → flat list with concatenated axis label
  if (axes.length === 0 || children.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-white/60 dark:bg-slate-900/40 p-3.5">
        <div className="text-sm font-semibold text-slate-800 dark:text-slate-200 inline-flex items-center gap-2">
          <Layers className="w-4 h-4 text-slate-400" />
          Variations
        </div>
        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          No child variants modelled. Add variants on the Variations tab.
        </div>
      </div>
    )
  }

  return (
    <div
      data-jump-target="variations"
      className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 space-y-3"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Layers className="w-4 h-4 text-slate-500 flex-shrink-0" />
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Variations
          </span>
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            {children.length} children · axes {axes.join(' × ') || '—'}
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <ThemeBadge axes={axes} suggested={variationTheme} />
          <button
            type="button"
            onClick={onJumpToClassic}
            className="inline-flex items-center gap-1 h-6 px-2 rounded text-[10.5px] border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            title="Edit a child — opens the classic field editor"
          >
            Edit children →
          </button>
        </div>
      </div>

      {/* Matrix body */}
      {axes.length === 1 ? (
        <OneAxisList
          axis={axes[0]!}
          values={byAxis[axes[0]!] ?? []}
          childByAxis={childByAxis}
          activeListingByProduct={activeListingByProduct}
          activeCurrency={activeCurrency}
          onJumpToClassic={onJumpToClassic}
        />
      ) : axes.length === 2 ? (
        <TwoAxisGrid
          rowAxis={axes[0]!}
          colAxis={axes[1]!}
          rowValues={byAxis[axes[0]!] ?? []}
          colValues={byAxis[axes[1]!] ?? []}
          childByAxis={childByAxis}
          activeListingByProduct={activeListingByProduct}
          activeCurrency={activeCurrency}
          onJumpToClassic={onJumpToClassic}
        />
      ) : (
        <MultiAxisList
          axes={axes}
          byAxis={byAxis}
          children={children}
          activeListingByProduct={activeListingByProduct}
          activeCurrency={activeCurrency}
          onJumpToClassic={onJumpToClassic}
        />
      )}

      {/* Sibling-market summary — only render when we have at least one
          child listing on file for any sibling market. Without child
          listing data the per-market totals would all be 0/N which
          would lie about reality. AC.6.2 plumbs the per-child listings
          through (currently /api/products/:id/all-listings only
          returns the parent's listings, not its children's). */}
      {siblingMarkets.length > 0 &&
        channelListings.some((l) =>
          children.some((c) => c.id === l.productId),
        ) && (
        <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
          <div className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">
            Sibling markets
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {siblingMarkets.map((m) => {
              const t = siblingTotals[m.code]
              const pct = t && t.total > 0 ? t.published / t.total : 0
              return (
                <span
                  key={m.code}
                  className={cn(
                    'inline-flex items-center gap-1 h-6 px-2 rounded border text-[11px] font-medium',
                    pct === 0
                      ? 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400'
                      : pct < 1
                      ? 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300'
                      : 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300',
                  )}
                  title={`${m.name}: ${t?.published ?? 0}/${t?.total ?? 0} children published`}
                >
                  <span className="text-[10.5px]">{marketFlag(m.code)}</span>
                  <span className="font-mono">{m.code}</span>
                  <span>
                    {t?.published ?? 0}/{t?.total ?? 0}
                  </span>
                </span>
              )
            })}
          </div>
        </div>
      )}

      <div className="text-[10.5px] text-slate-400 italic">
        AC.6 — read-only matrix. Inline cell editing, color-locked images,
        and bulk row/col apply land in AC.6.2.
      </div>
    </div>
  )
}

// ── Theme detection chip ───────────────────────────────────────────────
function ThemeBadge({
  axes,
  suggested,
}: {
  axes: string[]
  suggested?: string | null
}) {
  // Auto-derive a theme name from the axes (Amazon's enum-style
  // SizeColor / Color / Size). Tag with "auto" so the operator knows
  // it's heuristic; AC.6.2 promotes this to a real picker.
  const detected = useMemo(() => {
    if (axes.length === 0) return null
    // Title-case + join.
    return axes
      .map((a) =>
        a
          .split(/[\s_-]+/)
          .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
          .join(''),
      )
      .join('')
  }, [axes])
  const themeStr = suggested && suggested.length > 0 ? suggested : detected
  if (!themeStr) return null
  return (
    <span
      className="inline-flex items-center gap-1 h-6 px-2 rounded border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 text-blue-800 dark:text-blue-300 text-[10.5px] font-medium"
      title={
        suggested
          ? 'Theme from manifest'
          : 'Detected from variant axes — AC.6.2 promotes this to a real picker'
      }
    >
      <span className="opacity-70 uppercase tracking-wide text-[9px]">
        Theme
      </span>
      <span className="font-mono">{themeStr}</span>
      {!suggested && (
        <span className="text-[9px] opacity-70 uppercase tracking-wide">auto</span>
      )}
    </span>
  )
}

// ── One-axis row list ──────────────────────────────────────────────────
function OneAxisList({
  axis,
  values,
  childByAxis,
  activeListingByProduct,
  activeCurrency,
  onJumpToClassic,
}: {
  axis: string
  values: string[]
  childByAxis: Map<string, ChildProduct>
  activeListingByProduct: Map<string, ListingLike>
  activeCurrency: string
  onJumpToClassic?: () => void
}) {
  return (
    <div>
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">
        {axis}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {values.map((v) => {
          const child = childByAxis.get(v)
          if (!child) return null
          return (
            <CellTile
              key={v}
              label={v}
              child={child}
              listing={activeListingByProduct.get(child.id)}
              currency={activeCurrency}
              onClick={onJumpToClassic}
            />
          )
        })}
      </div>
    </div>
  )
}

// ── Two-axis grid ──────────────────────────────────────────────────────
function TwoAxisGrid({
  rowAxis,
  colAxis,
  rowValues,
  colValues,
  childByAxis,
  activeListingByProduct,
  activeCurrency,
  onJumpToClassic,
}: {
  rowAxis: string
  colAxis: string
  rowValues: string[]
  colValues: string[]
  childByAxis: Map<string, ChildProduct>
  activeListingByProduct: Map<string, ListingLike>
  activeCurrency: string
  onJumpToClassic?: () => void
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] border-separate border-spacing-1">
        <thead>
          <tr>
            <th className="font-semibold uppercase tracking-wide text-[10px] text-slate-500 dark:text-slate-400 text-left pl-1 pb-1 align-bottom">
              {rowAxis} ↓ / {colAxis} →
            </th>
            {colValues.map((c) => (
              <th
                key={c}
                className="font-medium text-[10.5px] text-slate-700 dark:text-slate-200 px-1 pb-1 align-bottom whitespace-nowrap"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowValues.map((r) => (
            <tr key={r}>
              <td className="font-medium text-[11px] text-slate-700 dark:text-slate-200 pr-2 align-middle whitespace-nowrap">
                {r}
              </td>
              {colValues.map((c) => {
                const child = childByAxis.get(`${r}|${c}`)
                if (!child) {
                  return (
                    <td
                      key={c}
                      className="align-top w-[140px]"
                    >
                      <div className="rounded border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/40 h-[88px] flex items-center justify-center text-[10.5px] text-slate-400 italic">
                        Not modelled
                      </div>
                    </td>
                  )
                }
                return (
                  <td key={c} className="align-top w-[140px]">
                    <CellTile
                      compact
                      label={`${r} · ${c}`}
                      child={child}
                      listing={activeListingByProduct.get(child.id)}
                      currency={activeCurrency}
                      onClick={onJumpToClassic}
                    />
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Many-axis flat list ────────────────────────────────────────────────
function MultiAxisList({
  axes,
  byAxis,
  children,
  activeListingByProduct,
  activeCurrency,
  onJumpToClassic,
}: {
  axes: string[]
  byAxis: Record<string, string[]>
  children: ChildProduct[]
  activeListingByProduct: Map<string, ListingLike>
  activeCurrency: string
  onJumpToClassic?: () => void
}) {
  // 3+ axes: prevent visual explosion by rendering children as a flat
  // labelled list ordered by sku. Operators with 3+ axes typically
  // resolve specific cells via search anyway.
  void byAxis
  return (
    <div className="space-y-1">
      <div className="text-[10.5px] text-slate-500 dark:text-slate-400">
        {axes.length} axes · flat list mode
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {[...children]
          .sort((a, b) => a.sku.localeCompare(b.sku))
          .map((child) => {
            const axisVals = readAxes(child)
            const label = axes.map((a) => axisVals[a] ?? '—').join(' · ')
            return (
              <CellTile
                key={child.id}
                label={label}
                child={child}
                listing={activeListingByProduct.get(child.id)}
                currency={activeCurrency}
                onClick={onJumpToClassic}
              />
            )
          })}
      </div>
    </div>
  )
}

// ── Single cell tile (shared 1D / 2D / 3+ axis renderer) ───────────────
function CellTile({
  label,
  child,
  listing,
  currency,
  compact = false,
  onClick,
}: {
  label: string
  child: ChildProduct
  listing: ListingLike | undefined
  currency: string
  compact?: boolean
  onClick?: () => void
}) {
  const img = pickPrimaryImage(child.images)
  const price = (() => {
    const raw = child.basePrice
    if (raw == null || raw === '') return null
    const n = typeof raw === 'string' ? parseFloat(raw) : raw
    return Number.isFinite(n) ? n : null
  })()
  const stock = child.totalStock ?? 0
  const lowStockAt = child.lowStockThreshold ?? 0
  const isLowStock = stock > 0 && lowStockAt > 0 && stock <= lowStockAt
  // Per-child listing status is only shown when the parent actually
  // passed listing data for this child. Without it we'd be drawing a
  // misleading "draft" dot on every child, so the dot is omitted.
  const hasListingData = listing !== undefined
  const cls = hasListingData
    ? classifyStatus(true, listing!.listingStatus ?? null)
    : null
  const dotTone =
    cls === 'published'
      ? 'bg-emerald-500'
      : cls === 'suppressed'
      ? 'bg-rose-500'
      : cls === 'draft'
      ? 'bg-slate-300 dark:bg-slate-600'
      : null

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left rounded border bg-white dark:bg-slate-900 hover:border-blue-400 dark:hover:border-blue-500 transition-colors group',
        'border-slate-200 dark:border-slate-700',
        compact ? 'p-1.5' : 'p-2',
      )}
      title={`${child.sku} · ${label}`}
    >
      <div className={cn('flex items-start gap-2', compact && 'gap-1.5')}>
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={img}
            alt=""
            className={cn(
              'object-contain rounded border border-slate-100 dark:border-slate-800 bg-white flex-shrink-0',
              compact ? 'w-10 h-10' : 'w-12 h-12',
            )}
          />
        ) : (
          <div
            className={cn(
              'rounded border border-dashed border-slate-200 dark:border-slate-700 grid place-items-center text-slate-300 flex-shrink-0',
              compact ? 'w-10 h-10' : 'w-12 h-12',
            )}
          >
            <ImageIcon className="w-3.5 h-3.5" />
          </div>
        )}
        <div className="min-w-0 flex-1 leading-snug">
          <div className="flex items-center gap-1">
            {dotTone && (
              <span
                aria-hidden
                className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', dotTone)}
              />
            )}
            <span className="font-mono text-[10.5px] text-slate-700 dark:text-slate-300 truncate">
              {child.sku}
            </span>
          </div>
          <div
            className={cn(
              'text-[10.5px] text-slate-600 dark:text-slate-400 truncate',
              compact ? 'mt-0' : 'mt-0.5',
            )}
          >
            {label}
          </div>
          <div className="flex items-baseline gap-1.5 mt-0.5">
            <span className="text-[11px] font-semibold text-slate-900 dark:text-slate-100">
              {formatPrice(price, currency)}
            </span>
            <span
              className={cn(
                'inline-flex items-center gap-0.5 text-[10px]',
                stock === 0
                  ? 'text-rose-600 dark:text-rose-400 font-medium'
                  : isLowStock
                  ? 'text-amber-600 dark:text-amber-400 font-medium'
                  : 'text-slate-500 dark:text-slate-400',
              )}
              title={
                stock === 0
                  ? 'Out of stock'
                  : isLowStock
                  ? `Low — threshold ${lowStockAt}`
                  : 'In stock'
              }
            >
              {(stock === 0 || isLowStock) && (
                <AlertTriangle className="w-2.5 h-2.5" />
              )}
              <Package className="w-2.5 h-2.5" /> {stock}
            </span>
          </div>
        </div>
      </div>
    </button>
  )
}
