'use client'

/**
 * F6 — variant matrix workspace.
 *
 * Layout decision lives in `axes` derivation:
 *   1 axis  → flat table mode
 *   2 axes  → pivot mode (rows = axis[0], cols = axis[1])
 *   3+ axes → flat table with all axes as columns
 *
 * Edits go through PATCH /api/products/:id (atomic price/stock
 * cascade via MasterPriceService + applyStockMovement, see B4/B5
 * docs in products-catalog.routes.ts). Optimistic UI: cell flips
 * to the new value immediately, rolls back + flashes red on 4xx.
 *
 * Drag-fill (Excel pattern): every numeric cell renders a small
 * fill handle in its bottom-right. Mouse-down on the handle starts
 * a vertical drag; the cells in the same column under the cursor
 * get a "will receive value X" highlight. Mouse-up fires a parallel
 * PATCH for each one. Honours the same atomic write path so the
 * cascade lands per-child.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  ChevronLeft,
  ExternalLink,
  Loader2,
  AlertCircle,
  RefreshCw,
  CheckCircle2,
  Layers,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import {
  emitInvalidation,
  useInvalidationChannel,
} from '@/lib/sync/invalidation-channel'

interface ParentProduct {
  id: string
  sku: string
  name: string
  basePrice: number
  totalStock: number
  variationAxes?: string[] | null
}

interface ChildRow {
  id: string
  sku: string
  name?: string | null
  basePrice: number | string | null
  totalStock: number | null
  lowStockThreshold?: number | null
  status?: string | null
  variantAttributes?: Record<string, unknown> | null
  variations?: Record<string, string> | null
}

type EditableField = 'basePrice' | 'totalStock' | 'lowStockThreshold'

interface CellAddress {
  childId: string
  field: EditableField
}

function getAttr(
  child: ChildRow,
  axis: string,
): string | undefined {
  const raw =
    (child.variantAttributes as Record<string, unknown> | null)?.[axis] ??
    (child.variations as Record<string, string> | null)?.[axis]
  if (raw == null) return undefined
  return String(raw)
}

function readNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * Sort axis values in a stable, useful way:
 * - Apparel sizes ordered XS<S<M<L<XL<2XL<3XL etc.
 * - Numeric strings sort numerically
 * - Otherwise alphabetic
 */
const APPAREL_SIZE_ORDER = [
  'XXS',
  'XS',
  'S',
  'M',
  'L',
  'XL',
  'XXL',
  '2XL',
  '3XL',
  '4XL',
  '5XL',
]
function sortAxisValues(values: string[]): string[] {
  const allApparel = values.every((v) =>
    APPAREL_SIZE_ORDER.includes(v.toUpperCase()),
  )
  if (allApparel) {
    return [...values].sort(
      (a, b) =>
        APPAREL_SIZE_ORDER.indexOf(a.toUpperCase()) -
        APPAREL_SIZE_ORDER.indexOf(b.toUpperCase()),
    )
  }
  const allNumeric = values.every((v) => /^-?\d+(\.\d+)?$/.test(v))
  if (allNumeric) {
    return [...values].sort((a, b) => Number(a) - Number(b))
  }
  return [...values].sort((a, b) => a.localeCompare(b))
}

export default function MatrixWorkspace({
  product,
  initialChildren,
}: {
  product: ParentProduct
  initialChildren: ChildRow[]
}) {
  const [children, setChildren] = useState<ChildRow[]>(initialChildren)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Per-cell pending state: childId+field → 'saving' | 'flash' | 'error'
  // Drives the cell badge + revert UX.
  const [cellState, setCellState] = useState<
    Record<string, 'saving' | 'flash' | 'error'>
  >({})
  // Active edit cell (only one at a time, like a spreadsheet).
  const [activeEdit, setActiveEdit] = useState<CellAddress | null>(null)
  // Drag-fill state. When non-null, the user is dragging the fill
  // handle from `source` and `targets` is the list of cells that
  // will receive the source value on mouse-up.
  const [drag, setDrag] = useState<{
    source: CellAddress
    sourceValue: number
    targets: CellAddress[]
  } | null>(null)

  const cellKey = (a: CellAddress) => `${a.childId}:${a.field}`

  const refetchChildren = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${product.id}/children`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setChildren(json.children ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRefreshing(false)
    }
  }, [product.id])

  // Phase 10 — refresh when another tab edits a child of this parent.
  useInvalidationChannel(['product.updated'], (event) => {
    const ids = (event.meta?.productIds as string[] | undefined) ?? []
    const childIds = new Set(children.map((c) => c.id))
    if (ids.length === 0 || ids.some((id) => childIds.has(id))) {
      void refetchChildren()
    }
  })

  // Derive axes once. Prefer parent.variationAxes; fall back to
  // whatever the children's variantAttributes already use, which is
  // necessary when the parent row hasn't backfilled variationAxes
  // (legacy rows).
  const axes: string[] = useMemo(() => {
    if (
      Array.isArray(product.variationAxes) &&
      product.variationAxes.length > 0
    ) {
      return product.variationAxes
    }
    const seen = new Set<string>()
    for (const c of children) {
      const attrs =
        (c.variantAttributes as Record<string, unknown> | null) ??
        (c.variations as Record<string, string> | null) ??
        {}
      for (const k of Object.keys(attrs)) seen.add(k)
    }
    return Array.from(seen)
  }, [product.variationAxes, children])

  // Distinct sorted values per axis.
  const axisValues = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const axis of axes) {
      const set = new Set<string>()
      for (const c of children) {
        const v = getAttr(c, axis)
        if (v != null) set.add(v)
      }
      m.set(axis, sortAxisValues(Array.from(set)))
    }
    return m
  }, [axes, children])

  // Look up a child by axis-tuple key, e.g. axes=[Color,Size] →
  // childByAxes.get('BLK::M') = child row.
  const childByAxes = useMemo(() => {
    const m = new Map<string, ChildRow>()
    for (const c of children) {
      const key = axes
        .map((a) => getAttr(c, a) ?? '')
        .join('::')
      m.set(key, c)
    }
    return m
  }, [axes, children])

  const totals = useMemo(() => {
    const stockSum = children.reduce(
      (acc, c) => acc + readNumber(c.totalStock),
      0,
    )
    const liveCount = children.filter(
      (c) => (c.status ?? '').toUpperCase() === 'ACTIVE',
    ).length
    return { stockSum, liveCount }
  }, [children])

  // ── Edit machinery ──────────────────────────────────────────────────
  const patchCell = useCallback(
    async (addr: CellAddress, value: number): Promise<void> => {
      const key = cellKey(addr)
      setCellState((s) => ({ ...s, [key]: 'saving' }))
      // Optimistic: write locally first, revert on error.
      const before = children.find((c) => c.id === addr.childId)
      const beforeValue = before
        ? addr.field === 'basePrice'
          ? readNumber(before.basePrice)
          : addr.field === 'totalStock'
            ? readNumber(before.totalStock)
            : readNumber(before.lowStockThreshold)
        : 0
      setChildren((prev) =>
        prev.map((c) =>
          c.id === addr.childId ? { ...c, [addr.field]: value } : c,
        ),
      )
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/products/${addr.childId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [addr.field]: value }),
          },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        // F6 — Phase 10 broadcast so the grid + drawer + drift card
        // refresh inline.
        emitInvalidation({
          type: 'product.updated',
          meta: {
            productIds: [addr.childId],
            source: 'matrix-edit',
            field: addr.field,
          },
        })
        setCellState((s) => ({ ...s, [key]: 'flash' }))
        setTimeout(() => {
          setCellState((s) => {
            const next = { ...s }
            delete next[key]
            return next
          })
        }, 800)
      } catch (e) {
        // Revert optimistic write.
        setChildren((prev) =>
          prev.map((c) =>
            c.id === addr.childId ? { ...c, [addr.field]: beforeValue } : c,
          ),
        )
        setCellState((s) => ({ ...s, [key]: 'error' }))
        setError(e instanceof Error ? e.message : String(e))
        setTimeout(() => {
          setCellState((s) => {
            const next = { ...s }
            delete next[key]
            return next
          })
        }, 2500)
      }
    },
    [children],
  )

  // Drag-fill commit — fan out PATCHes in parallel for every target.
  const commitDragFill = useCallback(async () => {
    if (!drag || drag.targets.length === 0) {
      setDrag(null)
      return
    }
    const value = drag.sourceValue
    const tasks = drag.targets.map((t) => patchCell(t, value))
    setDrag(null)
    await Promise.all(tasks)
  }, [drag, patchCell])

  // ── Render branches ────────────────────────────────────────────────
  const isPivot = axes.length === 2

  return (
    <div className="px-6 py-5 space-y-4 max-w-[1400px] mx-auto">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/products/${product.id}`}
            className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 inline-flex items-center gap-1"
          >
            <ChevronLeft className="w-3 h-3" />
            Back to product
          </Link>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mt-1 truncate">
            {product.name}
          </h1>
          <div className="text-base text-slate-500 dark:text-slate-400 flex items-center gap-2 flex-wrap">
            <span className="font-mono">{product.sku}</span>
            <span className="text-slate-300 dark:text-slate-600">·</span>
            <span>{children.length} variants</span>
            <span className="text-slate-300 dark:text-slate-600">·</span>
            <span>{totals.stockSum.toLocaleString()} units in stock</span>
            <span className="text-slate-300 dark:text-slate-600">·</span>
            <span>{totals.liveCount} active</span>
            {axes.length > 0 && (
              <>
                <span className="text-slate-300 dark:text-slate-600">·</span>
                <span className="inline-flex items-center gap-1">
                  <Layers className="w-3 h-3" />
                  {axes.join(' × ')}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refetchChildren()}
            disabled={refreshing}
            className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            {refreshing ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            Refresh
          </button>
          <Link
            href={`/products/${product.id}/edit/bulk`}
            className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 inline-flex items-center gap-1.5"
          >
            <ExternalLink className="w-3 h-3" />
            Channel editor
          </Link>
        </div>
      </header>

      {error && (
        <div className="border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-800 dark:text-rose-300 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {axes.length === 0 ? (
        <div className="border border-slate-200 dark:border-slate-800 rounded-md px-4 py-8 text-center text-base text-slate-500 dark:text-slate-400">
          No variation axes set yet. Add a variant with{' '}
          <span className="font-mono">{`{ "Size": "M" }`}</span> on the
          product detail page and they&apos;ll appear here.
        </div>
      ) : isPivot ? (
        <PivotGrid
          axes={axes as [string, string]}
          axisValues={axisValues}
          childByAxes={childByAxes}
          activeEdit={activeEdit}
          setActiveEdit={setActiveEdit}
          patchCell={patchCell}
          cellState={cellState}
          drag={drag}
          setDrag={setDrag}
          commitDragFill={commitDragFill}
        />
      ) : (
        <FlatTable
          axes={axes}
          rows={children}
          activeEdit={activeEdit}
          setActiveEdit={setActiveEdit}
          patchCell={patchCell}
          cellState={cellState}
          drag={drag}
          setDrag={setDrag}
          commitDragFill={commitDragFill}
        />
      )}

      <div className="text-sm text-slate-500 dark:text-slate-400 pt-3 border-t border-slate-100 dark:border-slate-800">
        <div className="font-medium mb-1">Tips</div>
        <ul className="list-disc pl-4 space-y-0.5">
          <li>Click a price or stock cell to edit. Enter saves, Esc cancels.</li>
          <li>
            Drag the small dot in a cell&apos;s bottom-right to fill the
            same value down the column.
          </li>
          <li>
            Edits cascade through MasterPriceService — channel listings
            update inside the same transaction.
          </li>
        </ul>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// FlatTable — 1-axis or 3+-axis layout
// ────────────────────────────────────────────────────────────────────
function FlatTable({
  axes,
  rows,
  activeEdit,
  setActiveEdit,
  patchCell,
  cellState,
  drag,
  setDrag,
  commitDragFill,
}: {
  axes: string[]
  rows: ChildRow[]
  activeEdit: CellAddress | null
  setActiveEdit: (a: CellAddress | null) => void
  patchCell: (addr: CellAddress, value: number) => Promise<void>
  cellState: Record<string, 'saving' | 'flash' | 'error'>
  drag: { source: CellAddress; sourceValue: number; targets: CellAddress[] } | null
  setDrag: (
    d: { source: CellAddress; sourceValue: number; targets: CellAddress[] } | null,
  ) => void
  commitDragFill: () => Promise<void>
}) {
  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden">
      <table className="w-full text-base">
        <thead className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
          <tr>
            <th className="px-3 py-2 text-left text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide w-48">
              SKU
            </th>
            {axes.map((axis) => (
              <th
                key={axis}
                className="px-3 py-2 text-left text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide"
              >
                {axis}
              </th>
            ))}
            <th className="px-3 py-2 text-right text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide w-28">
              Price
            </th>
            <th className="px-3 py-2 text-right text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide w-24">
              Stock
            </th>
            <th className="px-3 py-2 text-right text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide w-24">
              Threshold
            </th>
            <th className="px-3 py-2 text-right text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide w-20">
              {''}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((child) => (
            <tr key={child.id} className="border-b border-slate-100 dark:border-slate-800">
              <td className="px-3 py-1.5 font-mono text-slate-700 dark:text-slate-300">
                {child.sku}
              </td>
              {axes.map((axis) => (
                <td key={axis} className="px-3 py-1.5 text-slate-700 dark:text-slate-300">
                  {getAttr(child, axis) ?? (
                    <span className="text-slate-300 dark:text-slate-600">—</span>
                  )}
                </td>
              ))}
              <NumericCell
                addr={{ childId: child.id, field: 'basePrice' }}
                value={readNumber(child.basePrice)}
                format={(n) => `€${n.toFixed(2)}`}
                step={0.5}
                activeEdit={activeEdit}
                setActiveEdit={setActiveEdit}
                patchCell={patchCell}
                cellState={cellState}
                drag={drag}
                setDrag={setDrag}
                commitDragFill={commitDragFill}
              />
              <NumericCell
                addr={{ childId: child.id, field: 'totalStock' }}
                value={readNumber(child.totalStock)}
                format={(n) => n.toLocaleString()}
                step={1}
                integer
                activeEdit={activeEdit}
                setActiveEdit={setActiveEdit}
                patchCell={patchCell}
                cellState={cellState}
                drag={drag}
                setDrag={setDrag}
                commitDragFill={commitDragFill}
              />
              <NumericCell
                addr={{ childId: child.id, field: 'lowStockThreshold' }}
                value={readNumber(child.lowStockThreshold)}
                format={(n) => n.toLocaleString()}
                step={1}
                integer
                activeEdit={activeEdit}
                setActiveEdit={setActiveEdit}
                patchCell={patchCell}
                cellState={cellState}
                drag={drag}
                setDrag={setDrag}
                commitDragFill={commitDragFill}
              />
              <td className="px-3 py-1.5 text-right">
                <Link
                  href={`/products?drawer=${child.id}`}
                  className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
                >
                  Open
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// PivotGrid — 2-axis layout
// ────────────────────────────────────────────────────────────────────
function PivotGrid({
  axes,
  axisValues,
  childByAxes,
  activeEdit,
  setActiveEdit,
  patchCell,
  cellState,
  drag,
  setDrag,
  commitDragFill,
}: {
  axes: [string, string]
  axisValues: Map<string, string[]>
  childByAxes: Map<string, ChildRow>
  activeEdit: CellAddress | null
  setActiveEdit: (a: CellAddress | null) => void
  patchCell: (addr: CellAddress, value: number) => Promise<void>
  cellState: Record<string, 'saving' | 'flash' | 'error'>
  drag: { source: CellAddress; sourceValue: number; targets: CellAddress[] } | null
  setDrag: (
    d: { source: CellAddress; sourceValue: number; targets: CellAddress[] } | null,
  ) => void
  commitDragFill: () => Promise<void>
}) {
  const [axisRow, axisCol] = axes
  const rowValues = axisValues.get(axisRow) ?? []
  const colValues = axisValues.get(axisCol) ?? []

  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden overflow-x-auto">
      <table className="text-base border-collapse">
        <thead>
          <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
            <th className="px-3 py-2 text-left text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide sticky left-0 bg-slate-50 dark:bg-slate-800 z-10">
              {axisRow} ↓ / {axisCol} →
            </th>
            {colValues.map((c) => (
              <th
                key={c}
                className="px-3 py-2 text-center text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide min-w-[140px]"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowValues.map((rv) => (
            <tr key={rv} className="border-b border-slate-100 dark:border-slate-800">
              <th className="px-3 py-2 text-left text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide bg-slate-50 dark:bg-slate-800 sticky left-0 z-10 align-top">
                {rv}
              </th>
              {colValues.map((cv) => {
                const key = `${rv}::${cv}`
                const child = childByAxes.get(key)
                if (!child) {
                  return (
                    <td
                      key={cv}
                      className="px-3 py-2 text-center text-slate-300 dark:text-slate-600 border-l border-slate-100 dark:border-slate-800"
                    >
                      —
                    </td>
                  )
                }
                const stock = readNumber(child.totalStock)
                const stockLow =
                  child.lowStockThreshold != null &&
                  stock <= readNumber(child.lowStockThreshold)
                return (
                  <td
                    key={cv}
                    className="px-2 py-1.5 border-l border-slate-100 dark:border-slate-800 align-top min-w-[140px]"
                  >
                    <div className="text-xs font-mono text-slate-400 dark:text-slate-500 truncate mb-1">
                      {child.sku}
                    </div>
                    <NumericCell
                      addr={{ childId: child.id, field: 'basePrice' }}
                      value={readNumber(child.basePrice)}
                      format={(n) => `€${n.toFixed(2)}`}
                      step={0.5}
                      compact
                      activeEdit={activeEdit}
                      setActiveEdit={setActiveEdit}
                      patchCell={patchCell}
                      cellState={cellState}
                      drag={drag}
                      setDrag={setDrag}
                      commitDragFill={commitDragFill}
                    />
                    <NumericCell
                      addr={{ childId: child.id, field: 'totalStock' }}
                      value={stock}
                      format={(n) => `${n.toLocaleString()} pcs`}
                      step={1}
                      integer
                      compact
                      tone={stockLow ? 'warn' : undefined}
                      activeEdit={activeEdit}
                      setActiveEdit={setActiveEdit}
                      patchCell={patchCell}
                      cellState={cellState}
                      drag={drag}
                      setDrag={setDrag}
                      commitDragFill={commitDragFill}
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

// ────────────────────────────────────────────────────────────────────
// NumericCell — inline-edit + drag-fill primitive
// ────────────────────────────────────────────────────────────────────
function NumericCell({
  addr,
  value,
  format,
  step,
  integer,
  compact,
  tone,
  activeEdit,
  setActiveEdit,
  patchCell,
  cellState,
  drag,
  setDrag,
  commitDragFill,
}: {
  addr: CellAddress
  value: number
  format: (n: number) => string
  step: number
  integer?: boolean
  compact?: boolean
  tone?: 'warn'
  activeEdit: CellAddress | null
  setActiveEdit: (a: CellAddress | null) => void
  patchCell: (addr: CellAddress, value: number) => Promise<void>
  cellState: Record<string, 'saving' | 'flash' | 'error'>
  drag: { source: CellAddress; sourceValue: number; targets: CellAddress[] } | null
  setDrag: (
    d: { source: CellAddress; sourceValue: number; targets: CellAddress[] } | null,
  ) => void
  commitDragFill: () => Promise<void>
}) {
  const [draft, setDraft] = useState(String(value))
  const cellRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const isEditing =
    activeEdit?.childId === addr.childId && activeEdit?.field === addr.field
  const key = `${addr.childId}:${addr.field}`
  const state = cellState[key]
  const isDragSource =
    drag &&
    drag.source.childId === addr.childId &&
    drag.source.field === addr.field
  const isDragTarget = drag?.targets.some(
    (t) => t.childId === addr.childId && t.field === addr.field,
  )

  // Sync draft to value when not editing (so external updates land).
  useEffect(() => {
    if (!isEditing) setDraft(String(value))
  }, [value, isEditing])

  // Auto-focus when entering edit.
  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isEditing])

  const commit = async () => {
    const n = Number(draft)
    if (!Number.isFinite(n) || n < 0) {
      setDraft(String(value))
      setActiveEdit(null)
      return
    }
    setActiveEdit(null)
    if (n !== value) {
      await patchCell(addr, integer ? Math.floor(n) : n)
    }
  }

  const cancel = () => {
    setDraft(String(value))
    setActiveEdit(null)
  }

  // Drag-fill mousedown on the handle.
  const onHandleDown = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDrag({ source: addr, sourceValue: value, targets: [] })
  }

  // Detect drag enter — when mouse passes over a sibling cell with the
  // same field, add it to targets. We use a single window-level
  // mousemove listener installed by the workspace; here we just paint
  // the highlight when our addr is in the targets list.
  useEffect(() => {
    if (!drag) return
    const onMove = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const cellEl = (el as HTMLElement | null)?.closest(
        '[data-cell-key]',
      ) as HTMLElement | null
      if (!cellEl) return
      const dataKey = cellEl.dataset.cellKey
      if (!dataKey) return
      const [childId, field] = dataKey.split(':') as [string, EditableField]
      if (field !== drag.source.field) return
      // Don't include the source cell itself in the target list.
      if (childId === drag.source.childId) return
      // Only add if not already present.
      if (
        drag.targets.some((t) => t.childId === childId && t.field === field)
      ) {
        return
      }
      setDrag({
        source: drag.source,
        sourceValue: drag.sourceValue,
        targets: [...drag.targets, { childId, field }],
      })
    }
    const onUp = () => {
      void commitDragFill()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [drag, commitDragFill, setDrag])

  const cellBg = isDragTarget
    ? 'bg-purple-50 dark:bg-purple-950/40'
    : isDragSource
      ? 'bg-purple-100 dark:bg-purple-900/40'
      : state === 'flash'
        ? 'bg-emerald-50 dark:bg-emerald-950/40'
        : state === 'error'
          ? 'bg-rose-50 dark:bg-rose-950/40'
          : ''

  const valueColor = tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-slate-900 dark:text-slate-100'

  if (compact) {
    return (
      <div
        ref={cellRef}
        data-cell-key={key}
        className={`relative group rounded px-1.5 py-0.5 text-sm tabular-nums ${cellBg} ${valueColor}`}
      >
        {isEditing ? (
          <input
            ref={inputRef}
            type="number"
            step={step}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void commit()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                cancel()
              }
            }}
            className="w-full h-5 px-1 text-sm border border-purple-300 dark:border-purple-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 tabular-nums text-right"
          />
        ) : (
          <button
            type="button"
            onClick={() => setActiveEdit(addr)}
            className="w-full text-right cursor-text hover:bg-slate-100 dark:hover:bg-slate-800 rounded px-1"
          >
            {format(value)}
          </button>
        )}
        {state === 'saving' && (
          <Loader2 className="w-2.5 h-2.5 animate-spin absolute top-0.5 right-0.5 text-purple-500 dark:text-purple-400" />
        )}
        {state === 'flash' && (
          <CheckCircle2 className="w-2.5 h-2.5 absolute top-0.5 right-0.5 text-emerald-600 dark:text-emerald-400" />
        )}
        {!isEditing && (
          <span
            onMouseDown={onHandleDown}
            className="absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 bg-slate-400 dark:bg-slate-500 rounded-full opacity-0 group-hover:opacity-100 cursor-crosshair hover:bg-purple-600 dark:hover:bg-purple-400"
            title="Drag to fill down column"
          />
        )}
      </div>
    )
  }

  return (
    <td
      data-cell-key={key}
      className={`px-3 py-1.5 text-right tabular-nums relative group ${cellBg} ${valueColor}`}
    >
      {isEditing ? (
        <input
          ref={inputRef}
          type="number"
          step={step}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void commit()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              cancel()
            }
          }}
          className="w-full h-7 px-2 text-base border border-purple-300 dark:border-purple-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 tabular-nums text-right"
        />
      ) : (
        <button
          type="button"
          onClick={() => setActiveEdit(addr)}
          className="w-full text-right cursor-text hover:bg-slate-100 dark:hover:bg-slate-800 rounded px-1 py-0.5"
        >
          {format(value)}
        </button>
      )}
      {state === 'saving' && (
        <Loader2 className="w-3 h-3 animate-spin absolute top-1.5 right-1 text-purple-500 dark:text-purple-400" />
      )}
      {state === 'flash' && (
        <CheckCircle2 className="w-3 h-3 absolute top-1.5 right-1 text-emerald-600 dark:text-emerald-400" />
      )}
      {!isEditing && (
        <span
          onMouseDown={onHandleDown}
          className="absolute bottom-0 right-0 w-2 h-2 bg-slate-400 dark:bg-slate-500 rounded-tl opacity-0 group-hover:opacity-100 cursor-crosshair hover:bg-purple-600 dark:hover:bg-purple-400"
          title="Drag to fill down column"
        />
      )}
    </td>
  )
}
