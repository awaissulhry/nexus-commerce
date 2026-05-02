'use client'

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type CellContext,
  type ColumnDef,
  type Row,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { produce } from 'immer'
import { AlertCircle, CheckCircle2, WifiOff } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { EditableCell, type EditableMeta } from './EditableCell'
import PreviewChangesModal from './PreviewChangesModal'
import { cn } from '@/lib/utils'

export interface BulkProduct {
  id: string
  sku: string
  name: string
  basePrice: number
  costPrice: number | null
  minMargin: number | null
  minPrice: number | null
  maxPrice: number | null
  totalStock: number
  lowStockThreshold: number
  brand: string | null
  manufacturer: string | null
  upc: string | null
  ean: string | null
  weightValue: number | null
  weightUnit: string | null
  status: string
  fulfillmentChannel: 'FBA' | 'FBM' | null
  isParent: boolean
  parentId: string | null
  amazonAsin: string | null
  ebayItemId: string | null
  syncChannels: string[]
  variantAttributes: unknown
  updatedAt: string
}

interface CellChange {
  rowId: string
  columnId: string
  oldValue: unknown
  newValue: unknown
  timestamp: number
}

interface ApiError {
  id: string
  field: string
  error: string
}

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'saved'; count: number; at: number }
  | { kind: 'partial'; saved: number; failed: number }
  | { kind: 'error'; message: string }

const ROW_HEIGHT = 36
const HEADER_HEIGHT = 36

// ── Editable column metas ─────────────────────────────────────────────
const META_NAME: EditableMeta = { editable: true, fieldType: 'text' }
const META_BRAND: EditableMeta = { editable: true, fieldType: 'text' }
const META_STATUS: EditableMeta = {
  editable: true,
  fieldType: 'select',
  options: ['ACTIVE', 'DRAFT', 'INACTIVE'],
}
const META_CHANNEL: EditableMeta = {
  editable: true,
  fieldType: 'select',
  options: ['FBA', 'FBM'],
}
const META_PRICE: EditableMeta = {
  editable: true,
  fieldType: 'number',
  numeric: true,
  prefix: '€',
  format: (v) =>
    v === null || v === undefined ? '' : Number(v).toFixed(2),
}
const META_STOCK: EditableMeta = {
  editable: true,
  fieldType: 'number',
  numeric: true,
  format: (v) =>
    v === null || v === undefined ? '' : String(Math.floor(Number(v))),
  parse: (raw) => {
    if (raw === '' || raw === null) return null
    const n = parseInt(raw, 10)
    return Number.isNaN(n) ? raw : n
  },
}

// ── Helpers passed to all editable cells via closure ──────────────────
interface EditCtx {
  onCommit: (rowId: string, columnId: string, value: unknown) => void
  cellErrors: Map<string, string>
}

function fmtMargin(cost: number | null, price: number): string {
  if (cost == null || price <= 0) return ''
  return `${((1 - cost / price) * 100).toFixed(0)}%`
}

const editCtxRef: { current: EditCtx } = {
  current: {
    onCommit: () => {
      /* no-op until parent wires it */
    },
    cellErrors: new Map(),
  },
}

function makeEditableRenderer(meta: EditableMeta) {
  return function EditableCellRenderer(ctx: CellContext<BulkProduct, unknown>) {
    const value = ctx.getValue()
    const cellKey = `${ctx.row.original.id}:${ctx.column.id}`
    return (
      <EditableCell
        rowId={ctx.row.original.id}
        columnId={ctx.column.id}
        initialValue={value}
        meta={meta}
        onCommit={editCtxRef.current.onCommit}
        cellError={editCtxRef.current.cellErrors.get(cellKey)}
      />
    )
  }
}

const columns: ColumnDef<BulkProduct>[] = [
  {
    id: 'sku',
    accessorKey: 'sku',
    header: 'SKU',
    size: 220,
    cell: ({ getValue }) => (
      <span className="font-mono text-[12px] text-slate-900 px-2">
        {getValue<string>()}
      </span>
    ),
  },
  {
    id: 'name',
    accessorKey: 'name',
    header: 'Name',
    size: 380,
    cell: makeEditableRenderer(META_NAME),
  },
  {
    id: 'brand',
    accessorKey: 'brand',
    header: 'Brand',
    size: 160,
    cell: makeEditableRenderer(META_BRAND),
  },
  {
    id: 'status',
    accessorKey: 'status',
    header: 'Status',
    size: 110,
    cell: makeEditableRenderer(META_STATUS),
  },
  {
    id: 'fulfillmentChannel',
    accessorKey: 'fulfillmentChannel',
    header: 'Channel',
    size: 100,
    cell: makeEditableRenderer(META_CHANNEL),
  },
  {
    id: 'basePrice',
    accessorKey: 'basePrice',
    header: 'Price',
    size: 100,
    cell: makeEditableRenderer(META_PRICE),
  },
  {
    id: 'costPrice',
    accessorKey: 'costPrice',
    header: 'Cost',
    size: 100,
    cell: makeEditableRenderer(META_PRICE),
  },
  {
    id: 'margin',
    header: 'Margin',
    size: 80,
    accessorFn: (row) => fmtMargin(row.costPrice, row.basePrice),
    cell: ({ getValue }) => {
      const v = getValue<string>()
      return v ? (
        <span className="text-[13px] tabular-nums text-slate-700 px-2">{v}</span>
      ) : (
        <span className="text-slate-300 px-2">—</span>
      )
    },
  },
  {
    id: 'totalStock',
    accessorKey: 'totalStock',
    header: 'Stock',
    size: 90,
    cell: makeEditableRenderer(META_STOCK),
  },
  {
    id: 'amazonAsin',
    accessorKey: 'amazonAsin',
    header: 'ASIN',
    size: 110,
    cell: ({ getValue }) => {
      const v = getValue<string | null>()
      return v ? (
        <span className="font-mono text-[11px] text-slate-700 px-2">{v}</span>
      ) : (
        <span className="text-slate-300 px-2">—</span>
      )
    },
  },
]

const TABLE_MIN_WIDTH = columns.reduce((sum, c) => sum + (c.size ?? 100), 0)

const TableRow = memo(
  function TableRow({ row, top }: { row: Row<BulkProduct>; top: number }) {
    return (
      <div
        className="absolute left-0 right-0 flex border-b border-slate-100 hover:bg-slate-50/70"
        style={{
          height: ROW_HEIGHT,
          transform: `translateY(${top}px)`,
          willChange: 'transform',
        }}
      >
        {row.getVisibleCells().map((cell) => (
          <div
            key={cell.id}
            className="overflow-hidden border-r border-slate-100/60 last:border-r-0"
            style={{ width: cell.column.getSize(), flexShrink: 0 }}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </div>
        ))}
      </div>
    )
  },
  (prev, next) => prev.row.original === next.row.original && prev.top === next.top
)

function SkeletonRow({ top }: { top: number }) {
  return (
    <div
      className="absolute left-0 right-0 flex border-b border-slate-100 animate-pulse"
      style={{ height: ROW_HEIGHT, transform: `translateY(${top}px)` }}
    >
      {columns.map((c) => (
        <div
          key={c.id}
          className="flex items-center px-3"
          style={{ width: c.size ?? 100, flexShrink: 0 }}
        >
          <div className="h-3 bg-slate-200 rounded w-3/4" />
        </div>
      ))}
    </div>
  )
}

export default function BulkOperationsClient() {
  const [products, setProducts] = useState<BulkProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fetchMs, setFetchMs] = useState<number | null>(null)

  const [changes, setChanges] = useState<Map<string, CellChange>>(new Map())
  const [cellErrors, setCellErrors] = useState<Map<string, string>>(new Map())
  const [previewOpen, setPreviewOpen] = useState(false)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' })
  const [online, setOnline] = useState(true)

  // Refs for stable callbacks
  const productsRef = useRef(products)
  const changesRef = useRef(changes)
  useEffect(() => {
    productsRef.current = products
  }, [products])
  useEffect(() => {
    changesRef.current = changes
  }, [changes])

  // Online / offline
  useEffect(() => {
    if (typeof navigator !== 'undefined') setOnline(navigator.onLine)
    const onOnline = () => setOnline(true)
    const onOffline = () => setOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  const handleCommit = useCallback(
    (rowId: string, columnId: string, newValue: unknown) => {
      const key = `${rowId}:${columnId}`
      const product = productsRef.current.find((p) => p.id === rowId)
      if (!product) return
      const oldValue = (product as unknown as Record<string, unknown>)[columnId]

      setChanges((prev) => {
        const next = new Map(prev)
        if (looselyEqual(newValue, oldValue)) {
          next.delete(key)
        } else {
          next.set(key, {
            rowId,
            columnId,
            oldValue,
            newValue,
            timestamp: Date.now(),
          })
        }
        return next
      })

      // Clear any previous error for this cell when user re-edits it
      setCellErrors((prev) => {
        if (!prev.has(key)) return prev
        const next = new Map(prev)
        next.delete(key)
        return next
      })

      // Reset saved-pulse if user starts editing again
      if (saveStatus.kind === 'saved' || saveStatus.kind === 'partial') {
        setSaveStatus({ kind: 'dirty' })
      } else if (saveStatus.kind === 'idle') {
        setSaveStatus({ kind: 'dirty' })
      }
    },
    [saveStatus.kind]
  )

  // Push latest commit handler + cellErrors snapshot into the
  // module-level ref so cell renderers see them.
  editCtxRef.current = { onCommit: handleCommit, cellErrors }

  // ── Save flow ──────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    const currentChanges = changesRef.current
    if (currentChanges.size === 0) return
    if (saveStatus.kind === 'saving') return

    setSaveStatus({ kind: 'saving' })
    setCellErrors(new Map()) // clear previous errors before retrying

    const changesArray = Array.from(currentChanges.values()).map((c) => ({
      id: c.rowId,
      field: c.columnId,
      value: c.newValue,
    }))

    try {
      const res = await fetch(`${getBackendUrl()}/api/products/bulk`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: changesArray }),
      })

      const result = (await res.json().catch(() => ({}))) as {
        success?: boolean
        updated?: number
        errors?: ApiError[]
        error?: string
        message?: string
      }

      if (!res.ok) {
        // Total failure — keep all changes in UI for retry
        setSaveStatus({
          kind: 'error',
          message: result.error ?? result.message ?? `HTTP ${res.status}`,
        })
        if (Array.isArray(result.errors)) {
          // Validation-only failure: mark each rejected cell
          const map = new Map<string, string>()
          for (const e of result.errors) {
            map.set(`${e.id}:${e.field}`, e.error)
          }
          setCellErrors(map)
        }
        return
      }

      const errs: ApiError[] = result.errors ?? []
      const failedKeys = new Set(errs.map((e) => `${e.id}:${e.field}`))
      const succeededChanges = changesArray.filter(
        (c) => !failedKeys.has(`${c.id}:${c.field}`)
      )

      // Apply successful changes to products[] via immer — gives us
      // O(saved rows) object-identity changes. Cells in unchanged rows
      // skip re-render.
      if (succeededChanges.length > 0) {
        setProducts((prev) =>
          produce(prev, (draft) => {
            for (const c of succeededChanges) {
              const product = draft.find((p) => p.id === c.id)
              if (product) {
                ;(product as unknown as Record<string, unknown>)[c.field] = c.value
              }
            }
          })
        )
      }

      // Drop only the saved entries from the changesMap. Failed ones
      // stay so the user can fix or retry.
      setChanges((prev) => {
        if (succeededChanges.length === 0) return prev
        const next = new Map(prev)
        for (const c of succeededChanges) {
          next.delete(`${c.id}:${c.field}`)
        }
        return next
      })

      // Mark failed cells with red borders + tooltips
      if (errs.length > 0) {
        const map = new Map<string, string>()
        for (const e of errs) {
          map.set(`${e.id}:${e.field}`, e.error)
        }
        setCellErrors(map)
        setSaveStatus({
          kind: 'partial',
          saved: succeededChanges.length,
          failed: errs.length,
        })
      } else {
        setSaveStatus({
          kind: 'saved',
          count: succeededChanges.length,
          at: Date.now(),
        })
        // Auto-fade saved status after 3s
        setTimeout(() => {
          setSaveStatus((s) => (s.kind === 'saved' ? { kind: 'idle' } : s))
        }, 3000)
      }
    } catch (err: any) {
      setSaveStatus({ kind: 'error', message: err?.message ?? String(err) })
    }
  }, [saveStatus.kind])

  // Cmd/Ctrl+S to save
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleSave])

  // Initial fetch
  useEffect(() => {
    let cancelled = false
    const start = performance.now()
    fetch(`${getBackendUrl()}/api/products/bulk-fetch`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (cancelled) return
        setProducts(Array.isArray(data.products) ? data.products : [])
        setFetchMs(Math.round(performance.now() - start))
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.message ?? String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const table = useReactTable({
    data: products,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  const rows = table.getRowModel().rows

  const containerRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: loading ? 20 : rows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  })

  const headerCells = useMemo(() => table.getHeaderGroups()[0]?.headers ?? [], [table])
  const totalSize = rowVirtualizer.getTotalSize()
  const pendingCount = changes.size

  const saveLabel =
    saveStatus.kind === 'saving'
      ? 'Saving…'
      : pendingCount === 0
      ? 'No changes'
      : `Save ${pendingCount} change${pendingCount === 1 ? '' : 's'}`

  return (
    <div className="flex-1 min-h-0 px-6 pb-6 flex flex-col">
      {/* Offline banner */}
      {!online && (
        <div className="flex-shrink-0 mb-3 flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md text-[12px] text-amber-800">
          <WifiOff className="w-3.5 h-3.5 flex-shrink-0" />
          <span>You're offline. Changes are kept locally and will save when you reconnect.</span>
        </div>
      )}

      {/* Action bar — pending count, preview, save */}
      <div className="flex-shrink-0 mb-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="text-[12px] text-slate-500">
          {loading
            ? 'Loading…'
            : `${products.length.toLocaleString()} rows · click any cell to edit · Tab/Enter/Esc · Cmd+S to save`}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={pendingCount === 0}
            onClick={() => setPreviewOpen(true)}
          >
            Preview
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={pendingCount === 0 || saveStatus.kind === 'saving' || !online}
            loading={saveStatus.kind === 'saving'}
            onClick={handleSave}
          >
            {saveLabel}
          </Button>
        </div>
      </div>

      {/* Table container */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-auto bg-white border border-slate-200 rounded-lg"
        style={{ contain: 'strict' }}
      >
        <div
          className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200 flex"
          style={{ height: HEADER_HEIGHT, minWidth: TABLE_MIN_WIDTH }}
        >
          {headerCells.map((header) => (
            <div
              key={header.id}
              className="flex items-center px-3 text-[11px] font-semibold text-slate-700 uppercase tracking-wider"
              style={{ width: header.getSize(), flexShrink: 0 }}
            >
              {flexRender(header.column.columnDef.header, header.getContext())}
            </div>
          ))}
        </div>

        <div className="relative" style={{ height: totalSize, minWidth: TABLE_MIN_WIDTH }}>
          {rowVirtualizer.getVirtualItems().map((vRow) => {
            if (loading) return <SkeletonRow key={vRow.key} top={vRow.start} />
            const row = rows[vRow.index]
            return <TableRow key={row.id} row={row} top={vRow.start} />
          })}
        </div>

        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/90">
            <div className="text-[13px] text-red-700 bg-red-50 border border-red-200 rounded-md px-4 py-2">
              Failed to load: {error}
            </div>
          </div>
        )}
      </div>

      {/* Status bar */}
      <StatusBar
        status={saveStatus}
        pendingCount={pendingCount}
        fetchMs={fetchMs}
        loading={loading}
      />

      <PreviewChangesModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        changes={changes}
        products={products}
      />
    </div>
  )
}

function StatusBar({
  status,
  pendingCount,
  fetchMs,
  loading,
}: {
  status: SaveStatus
  pendingCount: number
  fetchMs: number | null
  loading: boolean
}) {
  const left = (() => {
    if (loading) return <span>Fetching…</span>
    if (status.kind === 'saving') return <span>Saving {pendingCount} change{pendingCount === 1 ? '' : 's'}…</span>
    if (status.kind === 'saved')
      return (
        <span className="flex items-center gap-1.5 text-green-700">
          <CheckCircle2 className="w-3 h-3" />
          Saved {status.count} change{status.count === 1 ? '' : 's'}
        </span>
      )
    if (status.kind === 'partial')
      return (
        <span className="flex items-center gap-1.5 text-amber-700">
          <AlertCircle className="w-3 h-3" />
          Saved {status.saved}, {status.failed} failed — see red cells
        </span>
      )
    if (status.kind === 'error')
      return (
        <span className="flex items-center gap-1.5 text-red-700">
          <AlertCircle className="w-3 h-3" />
          Save failed: {status.message}
        </span>
      )
    if (pendingCount > 0)
      return (
        <span>
          {pendingCount} unsaved change{pendingCount === 1 ? '' : 's'} ·{' '}
          <kbd className="text-[10px] bg-slate-100 px-1 rounded">Cmd+S</kbd> to save
        </span>
      )
    return <span>All changes saved</span>
  })()

  return (
    <div
      className={cn(
        'flex-shrink-0 mt-2 flex items-center justify-between text-[11px] px-1',
        status.kind === 'saved' && 'text-green-700',
        status.kind === 'partial' && 'text-amber-700',
        status.kind === 'error' && 'text-red-700',
        status.kind !== 'saved' &&
          status.kind !== 'partial' &&
          status.kind !== 'error' &&
          'text-slate-500'
      )}
    >
      <span className="flex items-center gap-1.5">{left}</span>
      <span className="text-slate-500">
        {fetchMs != null ? `Initial fetch: ${fetchMs}ms` : ''}
      </span>
    </div>
  )
}

function looselyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  if (typeof a === 'number' && typeof b === 'number') return a === b
  return String(a) === String(b)
}
