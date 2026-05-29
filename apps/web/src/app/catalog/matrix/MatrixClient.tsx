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
  ArrowUpDown,
  Download,
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
import SavedViewsMenu from './_shared/SavedViewsMenu'
import SelectionBar from './_shared/SelectionBar'
import BulkApplyDialog, { type FieldKey } from './_shared/BulkApplyDialog'
import AuditDrawer from './_shared/AuditDrawer'
import { History } from 'lucide-react'
import {
  BUILTIN_VIEWS,
  loadActiveViewId,
  saveActiveViewId,
  type SavedView,
} from './_shared/savedViews'
import { Columns as ColumnsIcon } from 'lucide-react'
import { MatrixSortPanel, type MatrixSortLevel, type MatrixSortField } from '@/app/_shared/grid-lens'

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
  // C.2 — pagination metadata
  totalParents: number
  nextCursor: string | null
  hasMore: boolean
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

// CC.1.1 — sort helpers over a MatrixRow. Structural columns aren't sortable.
const SORTABLE_SKIP = new Set(['__select', '__expand', '__actions'])
function rowSortStr(row: MatrixRow, colId: string): string {
  switch (colId) {
    case 'sku': return row.sku ?? ''
    case 'name': return row.name ?? ''
    case 'brand': return row.brand ?? ''
    case 'status': return row.status ?? ''
    case 'basePrice': return row.basePrice == null ? '' : String(row.basePrice)
    case 'totalStock': return String(row.totalStock ?? 0)
    case 'channelCoverage': return String(row.channelCoverage?.length ?? 0)
    default:
      if (colId.startsWith('attr:')) return formatDynamicValue(dynamicAttrValue(row, colId))
      return ''
  }
}
function rowCmpAsc(a: MatrixRow, b: MatrixRow, colId: string): number {
  if (colId === 'basePrice') return (a.basePrice ?? 0) - (b.basePrice ?? 0)
  if (colId === 'totalStock') return (a.totalStock ?? 0) - (b.totalStock ?? 0)
  if (colId === 'channelCoverage') return (a.channelCoverage?.length ?? 0) - (b.channelCoverage?.length ?? 0)
  return rowSortStr(a, colId).localeCompare(rowSortStr(b, colId), undefined, { numeric: true })
}
// CC.1.3 — display value for export (parent or variant; brand inherits).
function exportCellValue(e: MatrixRow | MatrixVariant, colId: string, parentBrand: string | null): string {
  switch (colId) {
    case 'sku': return e.sku ?? ''
    case 'name': return e.name ?? ''
    case 'brand': return (('brand' in e ? (e as MatrixRow).brand : parentBrand) ?? '')
    case 'status': return e.status ?? ''
    case 'basePrice': return e.basePrice == null ? '' : String(e.basePrice)
    case 'totalStock': return String(e.totalStock ?? 0)
    case 'channelCoverage': return (e.channelCoverage ?? []).map((c) => `${c.channel}:${c.marketplace}=${c.status}`).join('; ')
    default:
      if (colId.startsWith('attr:')) return formatDynamicValue(dynamicAttrValue(e, colId))
      return ''
  }
}
function csvField(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}
function applySortConfig(rows: MatrixRow[], cfg: MatrixSortLevel[]): MatrixRow[] {
  if (cfg.length === 0) return rows
  return [...rows].sort((a, b) => {
    for (const lvl of cfg) {
      let r = 0
      if (lvl.mode === 'custom') {
        const ia = lvl.customOrder.indexOf(rowSortStr(a, lvl.colId))
        const ib = lvl.customOrder.indexOf(rowSortStr(b, lvl.colId))
        r = (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib)
      } else {
        r = rowCmpAsc(a, b, lvl.colId)
        if (lvl.mode === 'desc') r = -r
      }
      if (r !== 0) return r
    }
    return 0
  })
}

export default function MatrixClient() {
  const { toast } = useToast()
  const [data, setData] = useState<MatrixResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')

  // ── CC.1.1 — multi-level sort (flat-file-style MatrixSortPanel) ──
  const SORT_KEY = 'catalog-matrix:sort:v1'
  const [sortConfig, setSortConfig] = useState<MatrixSortLevel[]>(() => {
    if (typeof window === 'undefined') return []
    try { const raw = window.localStorage.getItem(SORT_KEY); return raw ? (JSON.parse(raw) as MatrixSortLevel[]) : [] } catch { return [] }
  })
  const [sortPanelOpen, setSortPanelOpen] = useState(false)
  useEffect(() => {
    try {
      if (sortConfig.length) window.localStorage.setItem(SORT_KEY, JSON.stringify(sortConfig))
      else window.localStorage.removeItem(SORT_KEY)
    } catch { /* ignore */ }
  }, [sortConfig])

  // ── CC.1.2 — faceted filters (client-side; all rows are loaded) ──
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set())
  const [stockFilter, setStockFilter] = useState<'all' | 'in' | 'low' | 'out'>('all')
  const LOW_STOCK = 10
  const toggleStatus = useCallback((s: string) => {
    setStatusFilter((prev) => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n })
  }, [])
  const filtersActive = statusFilter.size > 0 || stockFilter !== 'all'

  // ── C.4 — column visibility state (localStorage-persisted) ──────
  const [pickerOpen, setPickerOpen] = useState(false)
  const [visibleIds, setVisibleIds] = useState<Set<string>>(() => {
    // Prefer last active saved view; otherwise stored visibility;
    // otherwise the hardcoded defaults.
    const activeId = loadActiveViewId()
    if (activeId) {
      const view = [...BUILTIN_VIEWS].find((v) => v.id === activeId)
      if (view) return new Set(view.columnIds)
    }
    const stored = loadVisibleColumnIds()
    return new Set(stored ?? DEFAULT_VISIBLE_IDS)
  })
  const [activeViewId, setActiveViewId] = useState<string | null>(() => loadActiveViewId())
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

  // CC.1.1 — sortable-field catalog for the MatrixSortPanel (grouped:
  // built-in Fields vs dynamic Attributes). Structural cols excluded.
  const sortFields: MatrixSortField[] = useMemo(
    () =>
      visibleColumns
        .filter((c) => !SORTABLE_SKIP.has(c.id))
        .map((c) => ({ id: c.id, label: c.label || c.id, group: c.dynamic ? 'Attributes' : 'Fields' })),
    [visibleColumns],
  )
  const valuesFor = useCallback(
    (colId: string): string[] => {
      const seen = new Set<string>()
      for (const row of data?.rows ?? []) {
        const v = rowSortStr(row, colId).trim()
        if (v) seen.add(v)
      }
      return [...seen].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    },
    [data],
  )
  // Header click = single primary sort; flips dir if already primary.
  const toggleSort = useCallback((colId: string) => {
    if (SORTABLE_SKIP.has(colId)) return
    setSortConfig((prev) => {
      const sole = prev.length === 1 && prev[0].colId === colId ? prev[0] : null
      const mode: MatrixSortLevel['mode'] = sole ? (sole.mode === 'asc' ? 'desc' : 'asc') : 'asc'
      return [{ id: `hdr-${colId}`, colId, mode, customOrder: [] }]
    })
  }, [])

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

  // ── C.6 — apply a saved view (columns + search) ─────────────────
  const applyView = useCallback((view: SavedView) => {
    setVisibleIds(new Set(view.columnIds))
    saveVisibleColumnIds(view.columnIds)
    setSearch(view.search ?? '')
    setActiveViewId(view.id)
    saveActiveViewId(view.id)
  }, [])

  // ── C.7 — bulk row selection ────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkOpen, setBulkOpen] = useState(false)

  // ── B.5 — audit drawer state (open per-row on demand) ───────────
  const [auditOpen, setAuditOpen] = useState<{ productId: string; label: string } | null>(null)

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])

  // handleBulkApply declared below, after updateField.

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
   *  back on error using the `rollback` snapshot.
   *
   *  C.4b — attr_* prefix routes the write into categoryAttributes
   *  on the local row (server side, /products/bulk already understands
   *  attr_* — see products.routes.ts D.3e batched attr writes).
   */
  const updateField = useCallback(
    (rowId: string, field: string, nextValue: unknown, currentValue: unknown) => {
      const isAttr = field.startsWith('attr_')
      const attrKey = isAttr ? field.slice('attr_'.length) : null

      const patchRow = <T extends { categoryAttributes: Record<string, unknown> | null }>(
        target: T,
      ): T => {
        if (isAttr && attrKey) {
          const base = target.categoryAttributes ?? {}
          return { ...target, categoryAttributes: { ...base, [attrKey]: nextValue } }
        }
        return { ...target, [field]: nextValue as never }
      }

      setData((d) => {
        if (!d) return d
        return {
          ...d,
          rows: d.rows.map((row) => {
            if (row.id === rowId) return patchRow(row)
            if (row.variants.some((v) => v.id === rowId)) {
              return {
                ...row,
                variants: row.variants.map((v) => (v.id === rowId ? patchRow(v) : v)),
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

  // C.7 — bulk apply uses updateField under the hood so optimistic +
  // rollback semantics match single-cell editing exactly. Declared
  // here (after updateField) so the closure captures a stable ref.
  const handleBulkApply = useCallback(
    (field: FieldKey, value: string | number) => {
      if (!data) return
      for (const row of data.rows) {
        if (selectedIds.has(row.id)) {
          const current = (row as unknown as Record<string, unknown>)[field]
          updateField(row.id, field, value, current)
        }
        for (const v of row.variants) {
          if (selectedIds.has(v.id)) {
            const current = (v as unknown as Record<string, unknown>)[field]
            updateField(v.id, field, value, current)
          }
        }
      }
      setBulkOpen(false)
    },
    [data, selectedIds, updateField],
  )

  // ── Fetch + paginate ────────────────────────────────────────────
  const [loadingMore, setLoadingMore] = useState(false)
  const loadMore = useCallback(async () => {
    if (!data?.nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const url = new URL(`${getBackendUrl()}/api/catalog/matrix`)
      url.searchParams.set('cursor', data.nextCursor)
      const r = await fetch(url.toString(), { cache: 'no-store' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const next = (await r.json()) as MatrixResponse
      setData((prev) =>
        prev
          ? {
              ...prev,
              rows: [...prev.rows, ...next.rows],
              totalRows: prev.totalRows + next.rows.length,
              totalVariants: prev.totalVariants + next.totalVariants,
              totalParents: next.totalParents,
              nextCursor: next.nextCursor,
              hasMore: next.hasMore,
            }
          : next,
      )
    } catch (err: any) {
      toast.error('Load more failed', { description: err?.message })
    } finally {
      setLoadingMore(false)
    }
  }, [data?.nextCursor, loadingMore, toast])

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
    // CC.1.1 — sort parents by the configured stack; variants ride along.
    const orderedRows = applySortConfig(data.rows, sortConfig)
    for (const row of orderedRows) {
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

      // CC.1.2 — status + stock facets (parent-level).
      if (statusFilter.size > 0 && !statusFilter.has(row.status)) continue
      if (stockFilter !== 'all') {
        const s = row.totalStock ?? 0
        if (stockFilter === 'out' && s > 0) continue
        if (stockFilter === 'in' && s <= 0) continue
        if (stockFilter === 'low' && !(s > 0 && s <= LOW_STOCK)) continue
      }

      out.push({ kind: 'parent', parent: row, key: row.id })
      if (expanded.has(row.id)) {
        for (const v of row.variants) {
          out.push({ kind: 'variant', parent: row, variant: v, key: `${row.id}/${v.id}` })
        }
      }
    }
    return out
  }, [data, expanded, search, sortConfig, statusFilter, stockFilter])

  // CC.1.3 — export the current view (visible columns × filtered/sorted
  // rows, parents + expanded variants) to CSV, client-side.
  const exportCsv = useCallback(() => {
    const cols = visibleColumns.filter((c) => !['__select', '__expand', '__actions'].includes(c.id))
    const header = ['Level', ...cols.map((c) => c.label || c.id)]
    const lines = [header.map(csvField).join(',')]
    for (const fr of flatRows) {
      const isParent = fr.kind === 'parent'
      const entity = isParent ? fr.parent : fr.variant!
      const row = [isParent ? 'Parent' : 'Variant', ...cols.map((c) => exportCellValue(entity, c.id, fr.parent.brand))]
      lines.push(row.map(csvField).join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `catalog-matrix-${flatRows.length}-rows.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('Exported', { description: `${flatRows.length} rows · ${cols.length} columns` })
  }, [flatRows, visibleColumns, toast])

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
                {data.totalRows}
                {data.totalRows < data.totalParents && (
                  <span className="text-zinc-400"> of {data.totalParents}</span>
                )}{' '}
                parents · {data.totalVariants} variants
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
            {/* CC.1.1 — flat-file-style multi-level sort */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setSortPanelOpen((o) => !o)}
                className={cn(
                  'inline-flex items-center gap-1.5 px-2 py-1 rounded',
                  sortConfig.length > 0
                    ? 'text-blue-700 bg-blue-50 dark:text-blue-300 dark:bg-blue-950/30'
                    : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800',
                )}
              >
                <ArrowUpDown className="w-3 h-3" />
                Sort{sortConfig.length > 0 ? ` (${sortConfig.length})` : ''}
              </button>
              {sortPanelOpen && (
                <MatrixSortPanel
                  fields={sortFields}
                  valuesFor={valuesFor}
                  initial={sortConfig}
                  onApply={(levels) => { setSortConfig(levels); setSortPanelOpen(false) }}
                  onClose={() => setSortPanelOpen(false)}
                />
              )}
            </div>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <ColumnsIcon className="w-3 h-3" />
              Columns
            </button>
            {/* CC.1.3 — export current view to CSV */}
            <button
              type="button"
              onClick={exportCsv}
              disabled={flatRows.length === 0}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800 disabled:opacity-40"
              title="Export the current filtered/sorted view to CSV"
            >
              <Download className="w-3 h-3" />
              Export
            </button>
            <SavedViewsMenu
              activeViewId={activeViewId}
              onApply={applyView}
              currentState={{
                columnIds: Array.from(visibleIds),
                search,
              }}
            />
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative max-w-md flex-1 min-w-[220px]">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search SKU, name, brand…"
              className="pl-7"
            />
          </div>
          {/* CC.1.2 — status facet chips */}
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => toggleStatus(s.value)}
              className={cn(
                'px-2 py-1 text-xs rounded border transition-colors',
                statusFilter.has(s.value)
                  ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-400 text-blue-700 dark:text-blue-300'
                  : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-zinc-400',
              )}
            >
              {s.label}
            </button>
          ))}
          {/* CC.1.2 — stock facet */}
          <select
            value={stockFilter}
            onChange={(e) => setStockFilter(e.target.value as typeof stockFilter)}
            className="px-2 py-1 text-xs rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300"
          >
            <option value="all">All stock</option>
            <option value="in">In stock</option>
            <option value="low">Low (≤{LOW_STOCK})</option>
            <option value="out">Out of stock</option>
          </select>
          {filtersActive && (
            <button
              type="button"
              onClick={() => { setStatusFilter(new Set()); setStockFilter('all') }}
              className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 underline-offset-2 hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      <SelectionBar
        count={selectedIds.size}
        onClear={clearSelection}
        onOpenBulkApply={() => setBulkOpen(true)}
      />

      {/* Column header row */}
      <div
        className={cn(
          'grid items-center px-4 py-2 text-[11px] font-medium uppercase tracking-wide',
          'text-zinc-500 dark:text-zinc-400',
          'border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50',
        )}
        style={{ gridTemplateColumns: gridCols }}
      >
        {visibleColumns.map((c) => {
          const sortable = !SORTABLE_SKIP.has(c.id)
          const active = sortConfig.some((l) => l.colId === c.id)
          return (
            <div
              key={c.id}
              onClick={sortable ? () => toggleSort(c.id) : undefined}
              className={cn(
                'truncate px-1 flex items-center gap-0.5',
                c.align === 'right' && 'justify-end text-right',
                c.align === 'center' && 'justify-center text-center',
                sortable && 'cursor-pointer hover:text-zinc-800 dark:hover:text-zinc-200 select-none',
              )}
            >
              {c.label}
              {sortable && c.label && (
                <ArrowUpDown className={cn('w-3 h-3 opacity-30', active && 'opacity-100 text-blue-500')} />
              )}
            </div>
          )
        })}
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
                      selected={selectedIds.has(row.parent.id)}
                      onToggleSelect={toggleSelect}
                      onOpenAudit={(id, label) => setAuditOpen({ productId: id, label })}
                    />
                  ) : (
                    <VariantRow
                      parent={row.parent}
                      variant={row.variant!}
                      onUpdate={updateField}
                      status={mutation.statusByRow[row.variant!.id] ?? 'idle'}
                      visibleColumns={visibleColumns}
                      gridCols={gridCols}
                      selected={selectedIds.has(row.variant!.id)}
                      onToggleSelect={toggleSelect}
                      onOpenAudit={(id, label) => setAuditOpen({ productId: id, label })}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
        {/* C.2 — Load more affordance, only when server has more rows. */}
        {data && data.hasMore && (
          <div className="flex items-center justify-center py-4 border-t border-zinc-100 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30">
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 disabled:opacity-50"
            >
              {loadingMore ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
              Load more ({data.totalParents - data.totalRows} remaining)
            </button>
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

      <BulkApplyDialog
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        selectedCount={selectedIds.size}
        onApply={handleBulkApply}
      />

      {auditOpen && (
        <AuditDrawer
          open={true}
          onClose={() => setAuditOpen(null)}
          productId={auditOpen.productId}
          productLabel={auditOpen.label}
        />
      )}
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
  selected,
  onToggleSelect,
  onOpenAudit,
}: {
  row: MatrixRow
  expanded: boolean
  onToggle: () => void
  onUpdate: (rowId: string, field: string, next: unknown, current: unknown) => void
  status: RowStatus
  visibleColumns: ColumnDef[]
  gridCols: string
  selected: boolean
  onToggleSelect: (id: string) => void
  onOpenAudit: (productId: string, label: string) => void
}) {
  const hasVariants = row.variants.length > 0
  return (
    <div
      className={cn(
        'grid items-center px-4 text-sm border-b border-zinc-100 dark:border-zinc-800/60',
        'hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors',
        status === 'error' && 'bg-red-50/40 dark:bg-red-900/10',
        selected && 'bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/30',
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
          selected={selected}
          onToggleSelect={onToggleSelect}
          onOpenAudit={onOpenAudit}
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
  selected,
  onToggleSelect,
  onOpenAudit,
}: {
  col: ColumnDef
  row: MatrixRow
  status: RowStatus
  onUpdate: (rowId: string, field: string, next: unknown, current: unknown) => void
  expanded: boolean
  onToggle: () => void
  hasVariants: boolean
  selected: boolean
  onToggleSelect: (id: string) => void
  onOpenAudit: (productId: string, label: string) => void
}) {
  switch (col.id) {
    case '__select':
      return (
        <div className="flex items-center justify-center">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(row.id)}
            aria-label={`Select ${row.sku}`}
            className="rounded border-zinc-300 dark:border-zinc-600 text-blue-600 focus:ring-blue-500"
          />
        </div>
      )
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
        <div className="flex items-center justify-center gap-0.5">
          <SaveIndicator status={status} />
          <button
            type="button"
            onClick={() => onOpenAudit(row.id, `${row.sku} — ${row.name ?? 'unnamed'}`)}
            className="flex items-center justify-center w-5 h-5 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label="View activity"
            title="View activity"
          >
            <History className="w-3 h-3" />
          </button>
          <Link
            href={`/products/${row.id}/edit`}
            className="flex items-center justify-center w-5 h-5 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label="Edit"
          >
            <ExternalLink className="w-3 h-3" />
          </Link>
        </div>
      )
    default:
      // C.4b — dynamic categoryAttributes column with inline edit.
      // Routes writes through `attr_<key>` so /products/bulk lands the
      // value in categoryAttributes[key] (D.3e batched attr writes).
      if (col.dynamic) {
        const attrKey = col.id.slice('attr:'.length)
        const v = dynamicAttrValue(row, col.id)
        return (
          <EditableCell
            kind="text"
            cellKey={`${row.id}:${col.id}`}
            value={v == null ? null : (typeof v === 'string' || typeof v === 'number' ? v : formatDynamicValue(v))}
            placeholder="—"
            onCommit={(next) => onUpdate(row.id, `attr_${attrKey}`, next, v)}
            className="text-xs"
          />
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
  selected,
  onToggleSelect,
  onOpenAudit,
}: {
  parent: MatrixRow
  variant: MatrixVariant
  onUpdate: (rowId: string, field: string, next: unknown, current: unknown) => void
  status: RowStatus
  visibleColumns: ColumnDef[]
  gridCols: string
  selected: boolean
  onToggleSelect: (id: string) => void
  onOpenAudit: (productId: string, label: string) => void
}) {
  return (
    <div
      className={cn(
        'grid items-center px-4 text-sm border-b border-zinc-100 dark:border-zinc-800/60',
        'bg-zinc-50/40 dark:bg-zinc-900/30',
        'hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors',
        status === 'error' && 'bg-red-50/40 dark:bg-red-900/10',
        selected && 'bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/30',
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
          selected={selected}
          onToggleSelect={onToggleSelect}
          onOpenAudit={onOpenAudit}
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
  selected,
  onToggleSelect,
  onOpenAudit,
}: {
  col: ColumnDef
  parent: MatrixRow
  variant: MatrixVariant
  status: RowStatus
  onUpdate: (rowId: string, field: string, next: unknown, current: unknown) => void
  selected: boolean
  onToggleSelect: (id: string) => void
  onOpenAudit: (productId: string, label: string) => void
}) {
  switch (col.id) {
    case '__select':
      return (
        <div className="flex items-center justify-center">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(variant.id)}
            aria-label={`Select ${variant.sku}`}
            className="rounded border-zinc-300 dark:border-zinc-600 text-blue-600 focus:ring-blue-500"
          />
        </div>
      )
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
        <div className="flex items-center justify-center gap-0.5">
          <SaveIndicator status={status} compact />
          <button
            type="button"
            onClick={() => onOpenAudit(variant.id, `${variant.sku} — ${variant.name ?? 'unnamed'}`)}
            className="flex items-center justify-center w-5 h-5 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label="View activity"
            title="View activity"
          >
            <History className="w-3 h-3" />
          </button>
          <Link
            href={`/products/${variant.id}/edit`}
            className="flex items-center justify-center w-5 h-5 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label="Edit"
          >
            <ExternalLink className="w-3 h-3" />
          </Link>
        </div>
      )
    default:
      if (col.dynamic) {
        // C.4b — editable dynamic attribute on variant rows. Variant
        // value wins; parent value shows as inherited ghost (matches
        // C.5 inheritance treatment for built-in editable columns).
        const attrKey = col.id.slice('attr:'.length)
        const own = dynamicAttrValue(variant, col.id)
        const parentVal = dynamicAttrValue(parent, col.id)
        const inheritedVal =
          parentVal == null
            ? null
            : typeof parentVal === 'string' || typeof parentVal === 'number'
              ? parentVal
              : formatDynamicValue(parentVal)
        const ownVal =
          own == null
            ? null
            : typeof own === 'string' || typeof own === 'number'
              ? own
              : formatDynamicValue(own)
        return (
          <EditableCell
            kind="text"
            cellKey={`${variant.id}:${col.id}`}
            value={ownVal}
            compact
            inheritedFromValue={inheritedVal}
            inheritedSourceLabel={parentVal != null ? 'parent' : undefined}
            onCommit={(next) => onUpdate(variant.id, `attr_${attrKey}`, next, own)}
            onReset={
              parentVal != null
                ? () => onUpdate(variant.id, `attr_${attrKey}`, parentVal, own)
                : undefined
            }
            className="text-xs"
          />
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
