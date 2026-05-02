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
import { AlertCircle, CheckCircle2, Lock, WifiOff } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { EditableCell, type EditableMeta } from './EditableCell'
import PreviewChangesModal from './PreviewChangesModal'
import ColumnSelector, { type FieldDef } from './components/ColumnSelector'
import {
  loadAllViews,
  saveUserView,
  deleteUserView,
  isDefaultView,
  setActiveViewId,
  getActiveViewId,
  DEFAULT_VIEWS,
  type SavedView,
} from './lib/saved-views'
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
  productType?: string | null
  buyBoxPrice?: number | null
  competitorPrice?: number | null
  parentAsin?: string | null
  shippingTemplate?: string | null
  dimLength?: number | null
  dimWidth?: number | null
  dimHeight?: number | null
  dimUnit?: string | null
  [k: string]: unknown
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

// ── Editable cell ctx ─────────────────────────────────────────────────
interface EditCtx {
  onCommit: (rowId: string, columnId: string, value: unknown) => void
  cellErrors: Map<string, string>
}

const editCtxRef: { current: EditCtx } = {
  current: {
    onCommit: () => {},
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

// ── FieldDef → ColumnDef conversion ───────────────────────────────────
const PRICE_FIELDS = new Set([
  'basePrice',
  'costPrice',
  'minPrice',
  'maxPrice',
  'buyBoxPrice',
  'competitorPrice',
])
const MONO_FIELDS = new Set([
  'sku',
  'amazonAsin',
  'parentAsin',
  'ebayItemId',
  'upc',
  'ean',
])

function fieldToMeta(field: FieldDef): EditableMeta {
  if (field.type === 'select') {
    return {
      editable: true,
      fieldType: 'select',
      options: field.options ?? [],
    }
  }
  if (field.type === 'number') {
    const isPrice = PRICE_FIELDS.has(field.id)
    const isInt = field.id === 'totalStock' || field.id === 'lowStockThreshold'
    return {
      editable: true,
      fieldType: 'number',
      numeric: true,
      prefix: isPrice ? '€' : undefined,
      format: isPrice
        ? (v) => (v === null || v === undefined ? '' : Number(v).toFixed(2))
        : isInt
        ? (v) =>
            v === null || v === undefined
              ? ''
              : String(Math.floor(Number(v)))
        : (v) => (v === null || v === undefined ? '' : String(v)),
      parse: isInt
        ? (raw) => {
            if (raw === '' || raw === null) return null
            const n = parseInt(raw, 10)
            return Number.isNaN(n) ? raw : n
          }
        : undefined,
    }
  }
  return { editable: true, fieldType: 'text' }
}

function ReadOnlyCell({
  value,
  field,
}: {
  value: unknown
  field: FieldDef
}) {
  if (value === null || value === undefined || value === '') {
    return <span className="text-slate-300 px-2">—</span>
  }
  if (MONO_FIELDS.has(field.id)) {
    return (
      <span className="font-mono text-[11px] text-slate-700 px-2 truncate">
        {String(value)}
      </span>
    )
  }
  if (field.type === 'number') {
    const n = Number(value)
    if (Number.isNaN(n)) {
      return <span className="text-slate-300 px-2">—</span>
    }
    const formatted = PRICE_FIELDS.has(field.id) ? `€${n.toFixed(2)}` : String(n)
    return (
      <span className="text-[12px] tabular-nums text-slate-700 px-2">
        {formatted}
      </span>
    )
  }
  return (
    <span className="text-[12px] text-slate-700 px-2 truncate">
      {String(value)}
    </span>
  )
}

function buildColumnFromField(field: FieldDef): ColumnDef<BulkProduct> {
  const size = field.width ?? 120
  if (field.editable) {
    const meta = fieldToMeta(field)
    return {
      id: field.id,
      accessorKey: field.id as string,
      header: field.label,
      size,
      cell: makeEditableRenderer(meta),
    }
  }
  return {
    id: field.id,
    accessorKey: field.id as string,
    header: () => (
      <span className="flex items-center gap-1">
        <span>{field.label}</span>
        <Lock
          className="w-2.5 h-2.5 text-slate-400"
          aria-label="Read-only"
        />
      </span>
    ),
    size,
    cell: ({ getValue }) => <ReadOnlyCell value={getValue()} field={field} />,
  }
}

// ── Memoized row ──────────────────────────────────────────────────────
const TableRow = memo(
  function TableRow({
    row,
    top,
  }: {
    row: Row<BulkProduct>
    top: number
    /** Bumped when the visible-column set changes; forces a row
     * re-render so cells map onto the new columns. */
    columnsKey: string
  }) {
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
  (prev, next) =>
    prev.row.original === next.row.original &&
    prev.top === next.top &&
    (prev as any).columnsKey === (next as any).columnsKey
)

function SkeletonRow({ top, colCount }: { top: number; colCount: number }) {
  return (
    <div
      className="absolute left-0 right-0 flex border-b border-slate-100 animate-pulse"
      style={{ height: ROW_HEIGHT, transform: `translateY(${top}px)` }}
    >
      {Array.from({ length: colCount }).map((_, i) => (
        <div key={i} className="flex items-center px-3" style={{ width: 120, flexShrink: 0 }}>
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

  // ── Dynamic columns state ───────────────────────────────────────────
  const [allFields, setAllFields] = useState<FieldDef[]>([])
  const [enabledChannels, setEnabledChannels] = useState<string[]>([])
  const [enabledProductTypes, setEnabledProductTypes] = useState<string[]>([])
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => [...DEFAULT_VIEWS])
  const [activeViewIdState, setActiveViewIdState] = useState<string>(
    DEFAULT_VIEWS[0].id
  )
  const [visibleColumnIds, setVisibleColumnIds] = useState<string[]>(
    DEFAULT_VIEWS[0].columnIds
  )

  // Hydrate localStorage state on mount
  useEffect(() => {
    setSavedViews(loadAllViews())
    const id = getActiveViewId()
    setActiveViewIdState(id)
    const view =
      loadAllViews().find((v) => v.id === id) ?? DEFAULT_VIEWS[0]
    setVisibleColumnIds(view.columnIds)
    if (view.channels) setEnabledChannels(view.channels)
    if (view.productTypes) setEnabledProductTypes(view.productTypes)
    const onChange = () => setSavedViews(loadAllViews())
    window.addEventListener('nexus:views-changed', onChange)
    return () => window.removeEventListener('nexus:views-changed', onChange)
  }, [])

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

      setCellErrors((prev) => {
        if (!prev.has(key)) return prev
        const next = new Map(prev)
        next.delete(key)
        return next
      })

      setSaveStatus((prev) =>
        prev.kind === 'saving' ? prev : { kind: 'dirty' }
      )
    },
    []
  )

  editCtxRef.current = { onCommit: handleCommit, cellErrors }

  // ── Save flow ──────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    const currentChanges = changesRef.current
    if (currentChanges.size === 0) return
    if (saveStatus.kind === 'saving') return

    setSaveStatus({ kind: 'saving' })
    setCellErrors(new Map())

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
        setSaveStatus({
          kind: 'error',
          message: result.error ?? result.message ?? `HTTP ${res.status}`,
        })
        if (Array.isArray(result.errors)) {
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

      setChanges((prev) => {
        if (succeededChanges.length === 0) return prev
        const next = new Map(prev)
        for (const c of succeededChanges) {
          next.delete(`${c.id}:${c.field}`)
        }
        return next
      })

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
        setTimeout(() => {
          setSaveStatus((s) => (s.kind === 'saved' ? { kind: 'idle' } : s))
        }, 3000)
      }
    } catch (err: any) {
      setSaveStatus({ kind: 'error', message: err?.message ?? String(err) })
    }
  }, [saveStatus.kind])

  // Cmd/Ctrl+S
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

  // ── Initial fetch (products + fields in parallel) ─────────────────
  useEffect(() => {
    let cancelled = false
    const start = performance.now()
    const backend = getBackendUrl()
    Promise.all([
      fetch(`${backend}/api/products/bulk-fetch`, { cache: 'no-store' }).then(
        async (res) => {
          if (!res.ok) throw new Error(`products: HTTP ${res.status}`)
          return res.json()
        }
      ),
      fetch(`${backend}/api/pim/fields`, { cache: 'no-store' }).then(
        async (res) => {
          if (!res.ok) throw new Error(`fields: HTTP ${res.status}`)
          return res.json()
        }
      ),
    ])
      .then(([productsData, fieldsData]) => {
        if (cancelled) return
        setProducts(
          Array.isArray(productsData.products) ? productsData.products : []
        )
        setAllFields(Array.isArray(fieldsData.fields) ? fieldsData.fields : [])
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

  // Refetch fields when channels/productTypes change
  useEffect(() => {
    const params = new URLSearchParams()
    if (enabledChannels.length) params.set('channels', enabledChannels.join(','))
    if (enabledProductTypes.length)
      params.set('productTypes', enabledProductTypes.join(','))
    const qs = params.toString()
    const url = `${getBackendUrl()}/api/pim/fields${qs ? `?${qs}` : ''}`

    let cancelled = false
    fetch(url, { cache: 'no-store' })
      .then(async (res) => (res.ok ? res.json() : { fields: [] }))
      .then((data) => {
        if (cancelled) return
        setAllFields(Array.isArray(data.fields) ? data.fields : [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [enabledChannels, enabledProductTypes])

  // ── Build columns dynamically from registry + visibility ──────────
  const fieldsById = useMemo(() => {
    const m = new Map<string, FieldDef>()
    for (const f of allFields) m.set(f.id, f)
    return m
  }, [allFields])

  const dynamicColumns = useMemo<ColumnDef<BulkProduct>[]>(() => {
    const out: ColumnDef<BulkProduct>[] = []
    for (const id of visibleColumnIds) {
      const field = fieldsById.get(id)
      if (!field) continue
      out.push(buildColumnFromField(field))
    }
    return out
  }, [visibleColumnIds, fieldsById])

  // Bumped whenever the column set actually changes; passed to TableRow
  // so memoized rows know to re-render on column changes. We use a
  // stable string key — when it changes, the memo comparator sees a
  // different value and re-runs.
  const columnsKey = useMemo(() => visibleColumnIds.join('|'), [visibleColumnIds])

  const tableMinWidth = useMemo(
    () => dynamicColumns.reduce((sum, c) => sum + (c.size ?? 120), 0),
    [dynamicColumns]
  )

  const table = useReactTable({
    data: products,
    columns: dynamicColumns,
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

  const headerCells = useMemo(
    () => table.getHeaderGroups()[0]?.headers ?? [],
    [table]
  )
  const totalSize = rowVirtualizer.getTotalSize()
  const pendingCount = changes.size

  const saveLabel =
    saveStatus.kind === 'saving'
      ? 'Saving…'
      : pendingCount === 0
      ? 'No changes'
      : `Save ${pendingCount} change${pendingCount === 1 ? '' : 's'}`

  // ── View handlers ────────────────────────────────────────────────
  const handleSelectView = useCallback(
    (id: string) => {
      const view = savedViews.find((v) => v.id === id)
      if (!view) return
      setActiveViewIdState(id)
      setActiveViewId(id)
      setVisibleColumnIds(view.columnIds)
      setEnabledChannels(view.channels ?? [])
      setEnabledProductTypes(view.productTypes ?? [])
    },
    [savedViews]
  )

  const handleSaveAsView = useCallback(
    (name: string) => {
      const id = `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      const view = saveUserView({
        id,
        name,
        columnIds: visibleColumnIds,
        channels: enabledChannels,
        productTypes: enabledProductTypes,
      })
      setSavedViews(loadAllViews())
      setActiveViewIdState(view.id)
      setActiveViewId(view.id)
    },
    [visibleColumnIds, enabledChannels, enabledProductTypes]
  )

  const handleDeleteView = useCallback(
    (id: string) => {
      if (isDefaultView(id)) return
      deleteUserView(id)
      setSavedViews(loadAllViews())
      if (activeViewIdState === id) {
        handleSelectView(DEFAULT_VIEWS[0].id)
      }
    },
    [activeViewIdState, handleSelectView]
  )

  return (
    <div className="flex-1 min-h-0 px-6 pb-6 flex flex-col">
      {!online && (
        <div className="flex-shrink-0 mb-3 flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md text-[12px] text-amber-800">
          <WifiOff className="w-3.5 h-3.5 flex-shrink-0" />
          <span>You're offline. Changes are kept locally and will save when you reconnect.</span>
        </div>
      )}

      <div className="flex-shrink-0 mb-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="text-[12px] text-slate-500">
          {loading
            ? 'Loading…'
            : `${products.length.toLocaleString()} rows · Showing ${visibleColumnIds.length} of ${allFields.length} columns · click any cell to edit · Cmd+S to save`}
        </div>
        <div className="flex items-center gap-2">
          <ColumnSelector
            allFields={allFields}
            visibleColumnIds={visibleColumnIds}
            onVisibleChange={setVisibleColumnIds}
            enabledChannels={enabledChannels}
            onEnabledChannelsChange={setEnabledChannels}
            enabledProductTypes={enabledProductTypes}
            onEnabledProductTypesChange={setEnabledProductTypes}
            views={savedViews}
            activeViewId={activeViewIdState}
            onSelectView={handleSelectView}
            onSaveAsView={handleSaveAsView}
            onDeleteView={handleDeleteView}
          />
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

      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-auto bg-white border border-slate-200 rounded-lg"
        style={{ contain: 'strict' }}
      >
        <div
          className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200 flex"
          style={{ height: HEADER_HEIGHT, minWidth: tableMinWidth }}
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

        <div className="relative" style={{ height: totalSize, minWidth: tableMinWidth }}>
          {rowVirtualizer.getVirtualItems().map((vRow) => {
            if (loading)
              return (
                <SkeletonRow
                  key={vRow.key}
                  top={vRow.start}
                  colCount={dynamicColumns.length || 7}
                />
              )
            const row = rows[vRow.index]
            return (
              <TableRow
                key={row.id}
                row={row}
                top={vRow.start}
                columnsKey={columnsKey}
              />
            )
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
    if (status.kind === 'saving')
      return (
        <span>
          Saving {pendingCount} change{pendingCount === 1 ? '' : 's'}…
        </span>
      )
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
