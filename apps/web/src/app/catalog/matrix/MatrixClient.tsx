'use client'

/**
 * PIM C.1 — Catalog matrix (read-only first cut).
 *
 * Virtualized grid at /catalog/matrix. Renders every master/standalone
 * product with parent → variant expand. Click a row to drill into
 * /products/[id]/edit (existing route).
 *
 * Coexists with /products — operators choose density per task. C.2
 * adds saved views, C.3 inline cell edit, C.4 column picker, C.5
 * inheritance overlay.
 *
 * Pulls all rows in one shot today (Xavia ~279 SKUs). C.2 paginates
 * when we cross ~5k.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ChevronRight,
  ChevronDown,
  Loader2,
  AlertCircle,
  ExternalLink,
  Package,
  Search,
  CheckCircle2,
  XCircle,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/ui/Toast'
import { cn } from '@/lib/utils'
import EditableCell from './_shared/EditableCell'
import { useMatrixMutation, type RowStatus } from './_shared/useMatrixMutation'
import {
  BUILT_IN_COLUMNS,
  DEFAULT_VISIBLE_IDS,
  discoverDynamicColumns,
  dynamicAttrValue,
  formatDynamicValue,
  loadVisibleColumnIds,
  saveVisibleColumnIds,
  type ColumnDef,
} from './_shared/columnDefs'
import ColumnPicker from './_shared/ColumnPicker'
import { Columns as ColumnsIcon } from 'lucide-react'

const STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'INACTIVE', label: 'Inactive' },
]

interface ChannelCoverage {
  channel: string
  marketplace: string
  status: string
}

interface MatrixVariant {
  id: string
  sku: string
  name: string | null
  basePrice: number | null
  totalStock: number
  status: string
  channelCoverage: ChannelCoverage[]
  categoryAttributes: Record<string, unknown> | null
}

interface MatrixRow {
  id: string
  sku: string
  name: string | null
  brand: string | null
  isParent: boolean
  status: string
  basePrice: number | null
  totalStock: number
  variantCount: number
  channelCoverage: ChannelCoverage[]
  variants: MatrixVariant[]
  categoryAttributes: Record<string, unknown> | null
}

interface MatrixResponse {
  rows: MatrixRow[]
  totalRows: number
  totalVariants: number
}

/** Each visible row in the virtualizer is either a parent row or one
 *  of that parent's variant rows when the parent is expanded. We
 *  flatten on the client so the virtualizer only needs to know about
 *  one row type. */
interface FlatRow {
  kind: 'parent' | 'variant'
  parent: MatrixRow
  variant?: MatrixVariant
  /** Stable id for React keys. */
  key: string
}

const ROW_HEIGHT = 44

export default function MatrixClient() {
  const { toast } = useToast()
  const [data, setData] = useState<MatrixResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')

  // ── C.4 — column visibility state (localStorage-persisted) ──────
  const [pickerOpen, setPickerOpen] = useState(false)
  const [visibleIds, setVisibleIds] = useState<Set<string>>(() => {
    const stored = loadVisibleColumnIds()
    return new Set(stored ?? DEFAULT_VISIBLE_IDS)
  })
  const dynamicColumns = useMemo(
    () => (data ? discoverDynamicColumns(data.rows) : []),
    [data],
  )
  // Always include required built-ins regardless of stored state.
  const requiredIds = useMemo(
    () => new Set(BUILT_IN_COLUMNS.filter((c) => c.required).map((c) => c.id)),
    [],
  )
  const visibleColumns: ColumnDef[] = useMemo(() => {
    const allCols = [...BUILT_IN_COLUMNS, ...dynamicColumns]
    return allCols.filter((c) => c.required || visibleIds.has(c.id))
  }, [dynamicColumns, visibleIds])
  const gridCols = useMemo(
    () => visibleColumns.map((c) => c.width).join(' '),
    [visibleColumns],
  )

  const toggleColumn = useCallback(
    (id: string) => {
      setVisibleIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        saveVisibleColumnIds(Array.from(next))
        return next
      })
    },
    [],
  )
  const resetColumns = useCallback(() => {
    const next = new Set(DEFAULT_VISIBLE_IDS)
    saveVisibleColumnIds(Array.from(next))
    setVisibleIds(next)
  }, [])
  // Keep required columns always in the set so toggleColumn can't
  // accidentally remove them (the picker disables the row but defense
  // in depth here too).
  useEffect(() => {
    setVisibleIds((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const id of requiredIds) {
        if (!next.has(id)) {
          next.add(id)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [requiredIds])

  // ── C.3 — optimistic mutation pipeline ──────────────────────────
  // Rollback path: re-apply each pending change's `rollback` value
  // back onto the local row. Caller stays the source of truth.
  const mutation = useMatrixMutation({
    onError: (msg) => toast.error('Save failed', { description: msg }),
    onRollback: (changes) => {
      setData((d) => {
        if (!d) return d
        const next: MatrixResponse = {
          ...d,
          rows: d.rows.map((row) => {
            // Rollback both parent + variants in one pass.
            let nextRow = row
            for (const c of changes) {
              if (c.id === row.id) {
                nextRow = { ...nextRow, [c.field]: c.rollback as never }
              } else if (row.variants.some((v) => v.id === c.id)) {
                nextRow = {
                  ...nextRow,
                  variants: nextRow.variants.map((v) =>
                    v.id === c.id ? { ...v, [c.field]: c.rollback as never } : v,
                  ),
                }
              }
            }
            return nextRow
          }),
        }
        return next
      })
    },
  })

  /** Optimistic field-level setter — updates local state immediately,
   *  buffers a server PATCH via the mutation hook. The hook rolls
   *  back on error using the `rollback` snapshot. */
  const updateField = useCallback(
    (rowId: string, field: string, nextValue: unknown, currentValue: unknown) => {
      setData((d) => {
        if (!d) return d
        return {
          ...d,
          rows: d.rows.map((row) => {
            if (row.id === rowId) return { ...row, [field]: nextValue as never }
            if (row.variants.some((v) => v.id === rowId)) {
              return {
                ...row,
                variants: row.variants.map((v) =>
                  v.id === rowId ? { ...v, [field]: nextValue as never } : v,
                ),
              }
            }
            return row
          }),
        }
      })
      mutation.commit({ id: rowId, field, value: nextValue, rollback: currentValue })
    },
    [mutation],
  )

  // ── Fetch ───────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`${getBackendUrl()}/api/catalog/matrix`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as MatrixResponse
      })
      .then((d) => {
        if (cancelled) return
        setData(d)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.message ?? 'Failed to load')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // ── Filter + flatten ────────────────────────────────────────────
  const flatRows = useMemo<FlatRow[]>(() => {
    if (!data) return []
    const needle = search.trim().toLowerCase()
    const out: FlatRow[] = []
    for (const row of data.rows) {
      // Filter: parent matches if any of its own fields or any
      // variant's SKU/name matches. Variants don't filter independently
      // — they ride along with their parent for the hierarchical view.
      const parentMatches =
        needle === ''
        || row.sku.toLowerCase().includes(needle)
        || (row.name ?? '').toLowerCase().includes(needle)
        || (row.brand ?? '').toLowerCase().includes(needle)
        || row.variants.some(
          (v) =>
            v.sku.toLowerCase().includes(needle) ||
            (v.name ?? '').toLowerCase().includes(needle),
        )
      if (!parentMatches) continue

      out.push({ kind: 'parent', parent: row, key: row.id })
      if (expanded.has(row.id)) {
        for (const v of row.variants) {
          out.push({ kind: 'variant', parent: row, variant: v, key: `${row.id}/${v.id}` })
        }
      }
    }
    return out
  }, [data, expanded, search])

  // ── Virtualizer ─────────────────────────────────────────────────
  const parentRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })

  const toggleExpand = useCallback((parentId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(parentId)) next.delete(parentId)
      else next.add(parentId)
      return next
    })
  }, [])

  const expandAll = useCallback(() => {
    if (!data) return
    setExpanded(new Set(data.rows.filter((r) => r.variants.length > 0).map((r) => r.id)))
  }, [data])
  const collapseAll = useCallback(() => setExpanded(new Set()), [])

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)]">
      {/* Header */}
      <div className="px-6 py-4 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              Catalog Matrix
            </h1>
            <p className="text-xs text-zinc-500 mt-0.5">
              Every product, every variant. Click a parent to expand its variants. Click a row to
              edit.
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs text-zinc-500">
            {data && (
              <span>
                {data.totalRows} parents · {data.totalVariants} variants
              </span>
            )}
            <button
              type="button"
              onClick={expandAll}
              className="px-2 py-1 rounded text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Expand all
            </button>
            <button
              type="button"
              onClick={collapseAll}
              className="px-2 py-1 rounded text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Collapse all
            </button>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <ColumnsIcon className="w-3 h-3" />
              Columns
            </button>
          </div>
        </div>
        <div className="relative max-w-md">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search SKU, name, brand…"
            className="pl-7"
          />
        </div>
      </div>

      {/* Column header row */}
      <div
        className={cn(
          'grid items-center px-4 py-2 text-[11px] font-medium uppercase tracking-wide',
          'text-zinc-500 dark:text-zinc-400',
          'border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50',
        )}
        style={{ gridTemplateColumns: gridCols }}
      >
        {visibleColumns.map((c) => (
          <div
            key={c.id}
            className={cn(
              'truncate px-1',
              c.align === 'right' && 'text-right',
              c.align === 'center' && 'text-center',
            )}
          >
            {c.label}
          </div>
        ))}
      </div>

      {/* Body */}
      <div ref={parentRef} className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center py-16 text-zinc-500">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            Loading catalog…
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 p-4 m-4 rounded-md bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300">
            <AlertCircle className="w-4 h-4" />
            Failed to load: {error}
          </div>
        )}
        {!loading && !error && flatRows.length === 0 && (
          <div className="text-center py-16 text-zinc-500 text-sm">
            {search ? 'No products match your search.' : 'No products yet.'}
          </div>
        )}
        {!loading && !error && flatRows.length > 0 && (
          <div
            style={{
              height: rowVirtualizer.getTotalSize(),
              position: 'relative',
            }}
          >
            {rowVirtualizer.getVirtualItems().map((vr) => {
              const row = flatRows[vr.index]
              return (
                <div
                  key={row.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${vr.start}px)`,
                    height: ROW_HEIGHT,
                  }}
                >
                  {row.kind === 'parent' ? (
                    <ParentRow
                      row={row.parent}
                      expanded={expanded.has(row.parent.id)}
                      onToggle={() => toggleExpand(row.parent.id)}
                      onUpdate={updateField}
                      status={mutation.statusByRow[row.parent.id] ?? 'idle'}
                      visibleColumns={visibleColumns}
                      gridCols={gridCols}
                    />
                  ) : (
                    <VariantRow
                      parent={row.parent}
                      variant={row.variant!}
                      onUpdate={updateField}
                      status={mutation.statusByRow[row.variant!.id] ?? 'idle'}
                      visibleColumns={visibleColumns}
                      gridCols={gridCols}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <ColumnPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        builtIn={BUILT_IN_COLUMNS.filter((c) => !c.required)}
        dynamic={dynamicColumns}
        visibleIds={visibleIds}
        onToggle={toggleColumn}
        onResetToDefault={resetColumns}
      />
    </div>
  )
}

function ParentRow({
  row,
  expanded,
  onToggle,
  onUpdate,
  status,
  visibleColumns,
  gridCols,
}: {
  row: MatrixRow
  expanded: boolean
  onToggle: () => void
  onUpdate: (rowId: string, field: string, next: unknown, current: unknown) => void
  status: RowStatus
  visibleColumns: ColumnDef[]
  gridCols: string
}) {
  const hasVariants = row.variants.length > 0
  return (
    <div
      className={cn(
        'grid items-center px-4 text-sm border-b border-zinc-100 dark:border-zinc-800/60',
        'hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors',
        status === 'error' && 'bg-red-50/40 dark:bg-red-900/10',
      )}
      style={{ gridTemplateColumns: gridCols, height: ROW_HEIGHT }}
    >
      {visibleColumns.map((col) => (
        <ParentCell
          key={col.id}
          col={col}
          row={row}
          status={status}
          onUpdate={onUpdate}
          expanded={expanded}
          onToggle={onToggle}
          hasVariants={hasVariants}
        />
      ))}
    </div>
  )
}

function ParentCell({
  col,
  row,
  status,
  onUpdate,
  expanded,
  onToggle,
  hasVariants,
}: {
  col: ColumnDef
  row: MatrixRow
  status: RowStatus
  onUpdate: (rowId: string, field: string, next: unknown, current: unknown) => void
  expanded: boolean
  onToggle: () => void
  hasVariants: boolean
}) {
  switch (col.id) {
    case '__expand':
      return (
        <button
          type="button"
          onClick={onToggle}
          disabled={!hasVariants}
          className={cn(
            'flex items-center justify-center w-6 h-6 rounded',
            hasVariants
              ? 'text-zinc-600 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-700'
              : 'text-transparent',
          )}
          aria-label={expanded ? 'Collapse variants' : 'Expand variants'}
        >
          {hasVariants && (expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />)}
        </button>
      )
    case 'sku':
      return (
        <div className="font-mono text-xs text-zinc-900 dark:text-zinc-100 truncate flex items-center gap-1">
          {hasVariants && <Package className="w-3 h-3 text-zinc-400" />}
          {row.sku}
        </div>
      )
    case 'name':
      return (
        <div className="text-zinc-900 dark:text-zinc-100 truncate flex items-center gap-1.5">
          <span className="truncate">
            {row.name ?? <span className="italic text-zinc-400">unnamed</span>}
          </span>
          {row.variantCount > 0 && (
            <span className="text-[11px] text-zinc-500">({row.variantCount})</span>
          )}
        </div>
      )
    case 'brand':
      return (
        <EditableCell
          kind="text"
          cellKey={`${row.id}:brand`}
          value={row.brand}
          placeholder="brand…"
          onCommit={(next) => onUpdate(row.id, 'brand', next, row.brand)}
        />
      )
    case 'totalStock':
      return (
        <EditableCell
          kind="number"
          cellKey={`${row.id}:totalStock`}
          value={row.totalStock}
          min={0}
          step={1}
          onCommit={(next) =>
            onUpdate(row.id, 'totalStock', next == null ? 0 : Math.trunc(Number(next)), row.totalStock)
          }
          className="text-right tabular-nums"
        />
      )
    case 'basePrice':
      return (
        <EditableCell
          kind="number"
          cellKey={`${row.id}:basePrice`}
          value={row.basePrice}
          min={0}
          step={0.01}
          onCommit={(next) => onUpdate(row.id, 'basePrice', next, row.basePrice)}
          className="text-right tabular-nums"
        />
      )
    case 'status':
      return (
        <EditableCell
          kind="select"
          cellKey={`${row.id}:status`}
          value={row.status}
          options={STATUS_OPTIONS}
          onCommit={(next) => onUpdate(row.id, 'status', next, row.status)}
        />
      )
    case 'channelCoverage':
      return (
        <div className="flex items-center gap-1 flex-wrap overflow-hidden">
          {row.channelCoverage.length === 0 ? (
            <span className="text-[11px] text-zinc-400 italic">none</span>
          ) : (
            row.channelCoverage.map((c, i) => <ChannelChip key={i} coverage={c} />)
          )}
        </div>
      )
    case '__actions':
      return (
        <div className="flex items-center justify-center gap-1">
          <SaveIndicator status={status} />
          <Link
            href={`/products/${row.id}/edit`}
            className="flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            aria-label="Edit"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </Link>
        </div>
      )
    default:
      // C.4 — dynamic categoryAttributes column. Read-only display
      // for now; C.4b will add inline edit via the same EditableCell.
      if (col.dynamic) {
        const v = dynamicAttrValue(row, col.id)
        return (
          <div className="text-xs text-zinc-700 dark:text-zinc-300 truncate px-1">
            {v == null ? (
              <span className="italic text-zinc-400">—</span>
            ) : (
              formatDynamicValue(v)
            )}
          </div>
        )
      }
      return <div />
  }
}

function VariantRow({
  parent,
  variant,
  onUpdate,
  status,
  visibleColumns,
  gridCols,
}: {
  parent: MatrixRow
  variant: MatrixVariant
  onUpdate: (rowId: string, field: string, next: unknown, current: unknown) => void
  status: RowStatus
  visibleColumns: ColumnDef[]
  gridCols: string
}) {
  return (
    <div
      className={cn(
        'grid items-center px-4 text-sm border-b border-zinc-100 dark:border-zinc-800/60',
        'bg-zinc-50/40 dark:bg-zinc-900/30',
        'hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors',
        status === 'error' && 'bg-red-50/40 dark:bg-red-900/10',
      )}
      style={{ gridTemplateColumns: gridCols, height: ROW_HEIGHT }}
    >
      {visibleColumns.map((col) => (
        <VariantCell
          key={col.id}
          col={col}
          parent={parent}
          variant={variant}
          status={status}
          onUpdate={onUpdate}
        />
      ))}
    </div>
  )
}

function VariantCell({
  col,
  parent,
  variant,
  status,
  onUpdate,
}: {
  col: ColumnDef
  parent: MatrixRow
  variant: MatrixVariant
  status: RowStatus
  onUpdate: (rowId: string, field: string, next: unknown, current: unknown) => void
}) {
  switch (col.id) {
    case '__expand':
      return <div /> // no expand for variants
    case 'sku':
      return (
        <div className="font-mono text-xs text-zinc-700 dark:text-zinc-300 truncate pl-4 flex items-center gap-1.5">
          <span className="text-zinc-300 dark:text-zinc-600">└─</span>
          {variant.sku}
        </div>
      )
    case 'name':
      return (
        <div className="text-zinc-700 dark:text-zinc-300 truncate text-xs">
          {variant.name ?? <span className="italic text-zinc-400">inherits</span>}
        </div>
      )
    case 'brand':
      return (
        <div className="text-zinc-500 dark:text-zinc-400 text-xs truncate italic px-1">
          {parent.brand ?? '—'}
        </div>
      )
    case 'totalStock':
      return (
        <EditableCell
          kind="number"
          cellKey={`${variant.id}:totalStock`}
          value={variant.totalStock}
          min={0}
          step={1}
          compact
          inheritedFromValue={parent.totalStock}
          inheritedSourceLabel="parent"
          onCommit={(next) =>
            onUpdate(variant.id, 'totalStock', next == null ? 0 : Math.trunc(Number(next)), variant.totalStock)
          }
          onReset={() => onUpdate(variant.id, 'totalStock', parent.totalStock, variant.totalStock)}
          className="text-right tabular-nums"
        />
      )
    case 'basePrice':
      return (
        <EditableCell
          kind="number"
          cellKey={`${variant.id}:basePrice`}
          value={variant.basePrice}
          min={0}
          step={0.01}
          compact
          inheritedFromValue={parent.basePrice}
          inheritedSourceLabel="parent"
          onCommit={(next) => onUpdate(variant.id, 'basePrice', next, variant.basePrice)}
          onReset={() => onUpdate(variant.id, 'basePrice', parent.basePrice, variant.basePrice)}
          className="text-right tabular-nums"
        />
      )
    case 'status':
      return (
        <EditableCell
          kind="select"
          cellKey={`${variant.id}:status`}
          value={variant.status}
          options={STATUS_OPTIONS}
          compact
          inheritedFromValue={parent.status}
          inheritedSourceLabel="parent"
          onCommit={(next) => onUpdate(variant.id, 'status', next, variant.status)}
          onReset={() => onUpdate(variant.id, 'status', parent.status, variant.status)}
        />
      )
    case 'channelCoverage':
      return (
        <div className="flex items-center gap-1 flex-wrap overflow-hidden">
          {variant.channelCoverage.length === 0 ? (
            <span className="text-[11px] text-zinc-400 italic">—</span>
          ) : (
            variant.channelCoverage.map((c, i) => <ChannelChip key={i} coverage={c} />)
          )}
        </div>
      )
    case '__actions':
      return (
        <div className="flex items-center justify-center gap-1">
          <SaveIndicator status={status} compact />
          <Link
            href={`/products/${variant.id}/edit`}
            className="flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            aria-label="Edit"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </Link>
        </div>
      )
    default:
      if (col.dynamic) {
        // For variants, surface variant's own attr value; fall back
        // to parent's so inherited values still show.
        const own = dynamicAttrValue(variant, col.id)
        const inherited = own == null ? dynamicAttrValue(parent, col.id) : null
        const v = own ?? inherited
        return (
          <div
            className={cn(
              'text-xs truncate px-1',
              own == null && inherited != null
                ? 'italic text-zinc-400'
                : 'text-zinc-700 dark:text-zinc-300',
            )}
            title={
              own == null && inherited != null ? 'inherited from parent' : undefined
            }
          >
            {v == null ? (
              <span className="italic text-zinc-400">—</span>
            ) : (
              formatDynamicValue(v)
            )}
          </div>
        )
      }
      return <div />
  }
}

function SaveIndicator({ status, compact }: { status: RowStatus; compact?: boolean }) {
  if (status === 'idle') return null
  const size = compact ? 'w-2.5 h-2.5' : 'w-3 h-3'
  if (status === 'pending') {
    return <Loader2 className={cn(size, 'animate-spin text-zinc-400')} aria-label="Saving" />
  }
  if (status === 'saved') {
    return <CheckCircle2 className={cn(size, 'text-emerald-500')} aria-label="Saved" />
  }
  return <XCircle className={cn(size, 'text-red-500')} aria-label="Save failed" />
}

function ChannelChip({ coverage }: { coverage: ChannelCoverage }) {
  const tone =
    coverage.status === 'ACTIVE'
      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
      : coverage.status === 'ERROR'
      ? 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'
      : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
  const label =
    coverage.marketplace && coverage.marketplace !== 'GLOBAL' && coverage.marketplace !== 'DEFAULT'
      ? `${shortenChannel(coverage.channel)} ${coverage.marketplace}`
      : shortenChannel(coverage.channel)
  return (
    <span
      className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium', tone)}
      title={`${coverage.channel} ${coverage.marketplace} · ${coverage.status}`}
    >
      {label}
    </span>
  )
}

function shortenChannel(channel: string): string {
  if (channel === 'AMAZON') return 'AMZ'
  if (channel === 'EBAY') return 'EBY'
  if (channel === 'SHOPIFY') return 'SHP'
  return channel.slice(0, 3)
}
