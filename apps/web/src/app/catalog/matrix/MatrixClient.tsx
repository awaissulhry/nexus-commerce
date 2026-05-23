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
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/utils'

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
  const [data, setData] = useState<MatrixResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')

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
        style={{ gridTemplateColumns: GRID_COLS }}
      >
        <div className="pl-1" /> {/* expand chevron col */}
        <div>SKU</div>
        <div>Name</div>
        <div>Brand</div>
        <div className="text-right">Stock</div>
        <div className="text-right">Price</div>
        <div>Status</div>
        <div>Channels</div>
        <div /> {/* link col */}
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
                    <ParentRow row={row.parent} expanded={expanded.has(row.parent.id)} onToggle={() => toggleExpand(row.parent.id)} />
                  ) : (
                    <VariantRow parent={row.parent} variant={row.variant!} />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// 9 cols: chevron · sku · name · brand · stock · price · status · channels · link
const GRID_COLS =
  '36px 160px minmax(200px, 1.5fr) 140px 90px 110px 100px minmax(160px, 1fr) 36px'

function ParentRow({
  row,
  expanded,
  onToggle,
}: {
  row: MatrixRow
  expanded: boolean
  onToggle: () => void
}) {
  const hasVariants = row.variants.length > 0
  return (
    <div
      className={cn(
        'grid items-center px-4 text-sm border-b border-zinc-100 dark:border-zinc-800/60',
        'hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors',
      )}
      style={{ gridTemplateColumns: GRID_COLS, height: ROW_HEIGHT }}
    >
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
      <div className="font-mono text-xs text-zinc-900 dark:text-zinc-100 truncate flex items-center gap-1">
        {hasVariants && <Package className="w-3 h-3 text-zinc-400" />}
        {row.sku}
      </div>
      <div className="text-zinc-900 dark:text-zinc-100 truncate">
        {row.name ?? <span className="italic text-zinc-400">unnamed</span>}
        {row.variantCount > 0 && (
          <span className="ml-1.5 text-[11px] text-zinc-500">({row.variantCount})</span>
        )}
      </div>
      <div className="text-zinc-700 dark:text-zinc-300 text-xs truncate">
        {row.brand ?? <span className="italic text-zinc-400">—</span>}
      </div>
      <div className="text-right text-zinc-700 dark:text-zinc-300 tabular-nums">
        {row.totalStock}
      </div>
      <div className="text-right text-zinc-700 dark:text-zinc-300 tabular-nums">
        {row.basePrice == null ? '—' : `€${row.basePrice.toFixed(2)}`}
      </div>
      <div>
        <StatusPill status={row.status} />
      </div>
      <div className="flex items-center gap-1 flex-wrap overflow-hidden">
        {row.channelCoverage.length === 0 ? (
          <span className="text-[11px] text-zinc-400 italic">none</span>
        ) : (
          row.channelCoverage.map((c, i) => (
            <ChannelChip key={i} coverage={c} />
          ))
        )}
      </div>
      <Link
        href={`/products/${row.id}/edit`}
        className="flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
        aria-label="Edit"
      >
        <ExternalLink className="w-3.5 h-3.5" />
      </Link>
    </div>
  )
}

function VariantRow({
  parent,
  variant,
}: {
  parent: MatrixRow
  variant: MatrixVariant
}) {
  return (
    <div
      className={cn(
        'grid items-center px-4 text-sm border-b border-zinc-100 dark:border-zinc-800/60',
        'bg-zinc-50/40 dark:bg-zinc-900/30',
        'hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors',
      )}
      style={{ gridTemplateColumns: GRID_COLS, height: ROW_HEIGHT }}
    >
      <div /> {/* no expand for variants */}
      <div className="font-mono text-xs text-zinc-700 dark:text-zinc-300 truncate pl-4 flex items-center gap-1.5">
        <span className="text-zinc-300 dark:text-zinc-600">└─</span>
        {variant.sku}
      </div>
      <div className="text-zinc-700 dark:text-zinc-300 truncate text-xs">
        {variant.name ?? <span className="italic text-zinc-400">inherits</span>}
      </div>
      <div className="text-zinc-500 dark:text-zinc-400 text-xs truncate italic">
        {parent.brand ?? '—'}
      </div>
      <div className="text-right text-zinc-700 dark:text-zinc-300 tabular-nums text-xs">
        {variant.totalStock}
      </div>
      <div className="text-right text-zinc-700 dark:text-zinc-300 tabular-nums text-xs">
        {variant.basePrice == null ? '—' : `€${variant.basePrice.toFixed(2)}`}
      </div>
      <div>
        <StatusPill status={variant.status} compact />
      </div>
      <div className="flex items-center gap-1 flex-wrap overflow-hidden">
        {variant.channelCoverage.length === 0 ? (
          <span className="text-[11px] text-zinc-400 italic">—</span>
        ) : (
          variant.channelCoverage.map((c, i) => <ChannelChip key={i} coverage={c} />)
        )}
      </div>
      <Link
        href={`/products/${variant.id}/edit`}
        className="flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
        aria-label="Edit"
      >
        <ExternalLink className="w-3.5 h-3.5" />
      </Link>
    </div>
  )
}

function StatusPill({ status, compact }: { status: string; compact?: boolean }) {
  const tone =
    status === 'ACTIVE'
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
      : status === 'DRAFT'
      ? 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
      : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300'
  return (
    <span
      className={cn(
        'inline-flex items-center rounded font-medium',
        compact ? 'px-1 py-0 text-[9px]' : 'px-1.5 py-0.5 text-[10px]',
        tone,
      )}
    >
      {status}
    </span>
  )
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
