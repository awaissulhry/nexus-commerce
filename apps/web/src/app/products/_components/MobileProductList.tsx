'use client'

/**
 * P.1k — extracted from ProductsWorkspace.tsx as part of the
 * file-decomposition sweep. C.4 was the original feature.
 *
 * Renders the same product set as the desktop grid, but as one
 * tap-friendly card per row. Image thumbnail + name + SKU + price /
 * stock + status pill. Tap anywhere on the card opens the product
 * drawer via the same custom event the grid uses; tap the checkbox
 * in the corner toggles selection.
 *
 * Parents render their chevron-expand exactly like the desktop
 * grid; children appear inline indented below their parent. The
 * 30s polling layer + invalidation channel are unaffected — this is
 * purely a presentation swap.
 *
 * Not virtualized: pageSize caps at 500, real mobile sessions
 * scroll at most a few dozen rows before tapping in. The cost of
 * windowing here is more code than it saves.
 */

import { CheckCircle2, ChevronRight, Package } from 'lucide-react'

// Minimal shape — subset of ProductRow that the mobile cards
// actually read. Defined locally so the module doesn't depend on
// the workspace's full ProductRow type during the decomposition
// sweep. A shared _types.ts consolidates these in a follow-up.
interface MobileProductRow {
  id: string
  sku: string
  name: string
  basePrice: number
  totalStock: number
  status: string
  imageUrl: string | null
  isParent: boolean
  childCount?: number
}

interface MobileProductListProps {
  products: MobileProductRow[]
  selected: Set<string>
  toggleSelect: (id: string, shiftKey: boolean) => void
  expandedParents: Set<string>
  childrenByParent: Record<string, MobileProductRow[]>
  loadingChildren: Set<string>
  onToggleExpand: (parentId: string) => void
}

export function MobileProductList({
  products,
  selected,
  toggleSelect,
  expandedParents,
  childrenByParent,
  loadingChildren,
  onToggleExpand,
}: MobileProductListProps) {
  const openDrawer = (id: string) => {
    window.dispatchEvent(
      new CustomEvent('nexus:open-product-drawer', {
        detail: { productId: id },
      }),
    )
  }
  if (products.length === 0) {
    return (
      <div className="border border-slate-200 dark:border-slate-800 rounded-md py-12 text-center text-md text-slate-400 dark:text-slate-500">
        No products match these filters
      </div>
    )
  }
  return (
    <div className="space-y-1.5">
      {products.map((p) => {
        const isExpanded = expandedParents.has(p.id)
        const childCount = p.childCount ?? 0
        const canExpand = p.isParent && childCount > 0
        const isLoading = loadingChildren.has(p.id)
        const kids = childrenByParent[p.id] ?? []
        return (
          <div key={p.id} className="space-y-1.5">
            <MobileProductCard
              p={p}
              isChild={false}
              selected={selected.has(p.id)}
              toggleSelect={() => toggleSelect(p.id, false)}
              onOpen={() => openDrawer(p.id)}
              chevron={
                canExpand
                  ? {
                      isExpanded,
                      onClick: () => onToggleExpand(p.id),
                      childCount,
                    }
                  : undefined
              }
            />
            {isExpanded && (
              <div className="ml-6 space-y-1 border-l-2 border-slate-200 dark:border-slate-800 pl-2">
                {isLoading ? (
                  <div className="text-base text-slate-500 dark:text-slate-400 italic px-2 py-1.5 bg-slate-50/60 dark:bg-slate-800/60 rounded">
                    Loading variants…
                  </div>
                ) : kids.length === 0 ? (
                  <div className="text-base text-slate-500 dark:text-slate-400 italic px-2 py-1.5 bg-slate-50/60 dark:bg-slate-800/60 rounded">
                    No variants found
                  </div>
                ) : (
                  kids.map((c) => (
                    <MobileProductCard
                      key={c.id}
                      p={c}
                      isChild
                      selected={selected.has(c.id)}
                      toggleSelect={() => toggleSelect(c.id, false)}
                      onOpen={() => openDrawer(c.id)}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function MobileProductCard({
  p,
  isChild,
  selected,
  toggleSelect,
  onOpen,
  chevron,
}: {
  p: MobileProductRow
  isChild: boolean
  selected: boolean
  toggleSelect: () => void
  onOpen: () => void
  chevron?: { isExpanded: boolean; onClick: () => void; childCount: number }
}) {
  const stock = Number(p.totalStock ?? 0)
  const stockTone =
    stock === 0
      ? 'text-rose-600 dark:text-rose-400'
      : stock <= 5
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-emerald-700 dark:text-emerald-300'
  const status = p.status ?? 'DRAFT'
  const statusColor: Record<string, string> = {
    ACTIVE: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
    DRAFT: 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-800',
    INACTIVE: 'bg-slate-50 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-800',
  }
  return (
    <div
      onClick={onOpen}
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border bg-white cursor-pointer active:bg-slate-50 dark:bg-slate-900 dark:active:bg-slate-800 ${
        isChild
          ? 'border-slate-100 bg-slate-50/40 dark:border-slate-800 dark:bg-slate-800/40'
          : selected
            ? 'border-blue-300 bg-blue-50/40 dark:border-blue-700 dark:bg-blue-950/40'
            : 'border-slate-200 dark:border-slate-800'
      }`}
    >
      {/* U.22 — 44×44 mobile target. Visible swatch stays w-5/h-5 via
          inner <span>; the button itself expands to satisfy WCAG 2.5.5. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          toggleSelect()
        }}
        aria-label={selected ? 'Deselect' : 'Select'}
        aria-pressed={selected}
        className="min-h-11 min-w-11 -m-3 p-3 flex-shrink-0 inline-flex items-center justify-center"
      >
        <span
          className={`w-5 h-5 rounded border-2 inline-flex items-center justify-center ${
            selected
              ? 'bg-blue-600 border-blue-600 text-white dark:bg-blue-500 dark:border-blue-500'
              : 'border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-900'
          }`}
        >
          {selected && <CheckCircle2 className="w-3 h-3" />}
        </span>
      </button>
      {p.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={p.imageUrl}
          alt=""
          className="w-12 h-12 rounded object-cover bg-slate-100 dark:bg-slate-800 flex-shrink-0"
        />
      ) : (
        <div className="w-12 h-12 rounded bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500 flex-shrink-0">
          <Package className="w-5 h-5" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-md text-slate-900 dark:text-slate-100 font-medium truncate">
          {p.name ?? '—'}
        </div>
        <div className="text-sm text-slate-500 dark:text-slate-400 font-mono truncate flex items-center gap-1.5">
          <span>{p.sku}</span>
          {chevron && (
            <span className="text-slate-300 dark:text-slate-600">
              · {chevron.childCount} variant
              {chevron.childCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-1 text-sm">
          <span className="tabular-nums text-slate-700 dark:text-slate-300">
            €{Number(p.basePrice ?? 0).toFixed(2)}
          </span>
          <span className="text-slate-300 dark:text-slate-600">·</span>
          <span className={`tabular-nums ${stockTone}`}>
            {stock.toLocaleString()} pcs
          </span>
          <span
            className={`ml-auto inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border ${
              statusColor[status] ?? statusColor.DRAFT
            }`}
          >
            {status}
          </span>
        </div>
      </div>
      {chevron && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            chevron.onClick()
          }}
          aria-label={
            chevron.isExpanded ? 'Collapse variants' : 'Expand variants'
          }
          aria-expanded={chevron.isExpanded}
          // U.22 — 44×44 mobile target. The visible chevron stays w-4/h-4
          // for the same compact look; the button itself expands so a
          // near-miss tap doesn't hit the surrounding card and open the
          // drawer instead.
          className="min-h-11 min-w-11 -m-3 p-3 inline-flex items-center justify-center text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-300 flex-shrink-0"
        >
          {/* E.22 — single ChevronRight that rotates 90° instead of
              swapping icons. Same smoothness as the desktop ProductRow. */}
          <ChevronRight
            className={`w-4 h-4 transition-transform duration-150 ${chevron.isExpanded ? 'rotate-90' : ''}`}
          />
        </button>
      )}
    </div>
  )
}
