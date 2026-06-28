'use client'

// Design-system style sheets (must be imported explicitly per-page).
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronDown, ChevronRight, ChevronsUpDown, Search } from 'lucide-react'

import { getBackendUrl } from '@/lib/backend-url'
import { usePolledList } from '@/lib/sync/use-polled-list'
import type { ProductRow } from '@/app/products/_types'
import { Thumbnail, DensityContext, type Density } from '@/app/_shared/grid-lens'

// DS Primitives
import {
  Button,
  Input,
  Pill,
  SegmentedControl,
  Tooltip,
  type SegmentedOption,
  type Tone,
} from '@/design-system/primitives'
// DS Components
import {
  DataGrid,
  Menu,
  ToastProvider,
  useToast,
  type Column,
  type MenuItemDef,
} from '@/design-system/components'
// DS Patterns
import { BulkActionBar, PageHeader } from '@/design-system/patterns'

import styles from './styles.module.css'

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

const POLL_URL =
  '/api/products?page=1&limit=200&includeCoverage=true&includeTags=true'

const DENSITY_OPTIONS: SegmentedOption[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'cozy', label: 'Cozy' },
  { value: 'spacious', label: 'Spacious' },
]

const CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY'] as const
type Channel = (typeof CHANNELS)[number]

type DensityMode = 'compact' | 'cozy' | 'spacious'
type LensKey = 'all' | 'attention' | 'amazon' | 'ebay' | 'shopify'
type KpiTileKey = 'active' | 'out-of-stock' | 'attention' | null

// ─────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────

function getStockColor(totalStock: number, threshold: number): string {
  if (totalStock === 0) return 'var(--status-danger-line)'
  if (totalStock <= threshold) return 'var(--status-warning-line)'
  return 'var(--status-success-line)'
}

function getStatusTone(status: string): Tone {
  if (status === 'ACTIVE') return 'success'
  if (status === 'DRAFT') return 'neutral'
  return 'danger'
}

function getStatusLabel(status: string): string {
  if (status === 'ACTIVE') return 'Active'
  if (status === 'DRAFT') return 'Draft'
  return 'Inactive'
}

function fmtEur(price: number): string {
  return `€${price.toFixed(2)}`
}

/** Maps the page's local density modes to the shared DS Density type. */
function mapDensity(d: DensityMode): Density {
  if (d === 'compact') return 'compact'
  if (d === 'spacious') return 'spacious'
  return 'comfortable' // 'cozy' → 'comfortable'
}

function getCov(row: ProductRow, ch: Channel) {
  return row.coverage?.[ch] ?? null
}

function lensCount(rows: ProductRow[], key: LensKey): number {
  if (key === 'all') return rows.length
  if (key === 'attention') return rows.filter((r) => r.photoCount === 0).length
  if (key === 'amazon') return rows.filter((r) => (getCov(r, 'AMAZON')?.total ?? 0) > 0).length
  if (key === 'ebay') return rows.filter((r) => (getCov(r, 'EBAY')?.total ?? 0) > 0).length
  return rows.filter((r) => (getCov(r, 'SHOPIFY')?.total ?? 0) > 0).length
}

// ─────────────────────────────────────────────────────────────────
// Expansion helpers
// ─────────────────────────────────────────────────────────────────

/** Sentinel row inserted in displayRows while children are being fetched. */
function makeLoadingRow(parentId: string): ProductRow {
  return {
    id: `__loading_${parentId}`,
    sku: '',
    name: '__loading__',
    brand: null,
    basePrice: 0,
    totalStock: 0,
    lowStockThreshold: 0,
    status: 'ACTIVE',
    syncChannels: [],
    imageUrl: null,
    amazonAsin: null,
    isParent: false,
    parentId,
    productType: null,
    fulfillmentMethod: null,
    family: null,
    workflowStage: null,
    photoCount: 0,
    channelCount: 0,
    variantCount: 0,
    childCount: 0,
    coverage: null,
    updatedAt: '',
    createdAt: '',
  }
}

function isLoadingRow(row: ProductRow) {
  return row.id.startsWith('__loading_')
}

// ─────────────────────────────────────────────────────────────────
// Sort header (used as column label for manually-sorted columns)
// ─────────────────────────────────────────────────────────────────

interface SortHeaderProps {
  label: string
  colKey: string
  sortKey: string
  sortDir: 'asc' | 'desc'
  onSort: (key: string) => void
}

function SortHeader({ label, colKey, sortKey, sortDir, onSort }: SortHeaderProps) {
  const active = sortKey === colKey
  return (
    <button
      type="button"
      className={`${styles.sortHeaderBtn}${active ? ' ' + styles.sortHeaderBtnActive : ''}`}
      onClick={() => onSort(colKey)}
    >
      {label}
      {active ? (
        sortDir === 'asc' ? (
          <ChevronDown size={13} style={{ color: 'var(--color-primary)' }} />
        ) : (
          <ChevronDown size={13} style={{ color: 'var(--color-primary)', transform: 'rotate(180deg)' }} />
        )
      ) : (
        <ChevronsUpDown size={13} style={{ color: 'var(--text-disabled)' }} />
      )}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────
// Sub-components (module-level so they don't re-mount on each render)
// ─────────────────────────────────────────────────────────────────

/**
 * Centered SVG checkbox. Renders as an inline-flex button so the check
 * mark is guaranteed centred via flexbox — no browser-native checkbox
 * styling needed, no DS file edits required.
 */
interface CkbProps {
  checked: boolean
  indeterminate?: boolean
  onChange: () => void
  label?: string
}
function Ckb({ checked, indeterminate, onChange, label }: CkbProps) {
  const on = checked || indeterminate
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={label ?? 'Select row'}
      onClick={onChange}
      className={`${styles.ckb}${on ? ' ' + styles.ckbOn : ''}`}
    >
      {on && (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ display: 'block' }}>
          {indeterminate ? (
            <path d="M2.5 5h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          ) : (
            <path
              d="M2 5.2L4.2 7.4L8 3"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </svg>
      )}
    </button>
  )
}

/** Product column cell: chevron + thumb + name + sku + category tag + variation count */
interface ProductCellProps {
  row: ProductRow
  /** True when this row is a child (indents the whole cell) */
  isChild?: boolean
  /** True when this parent row has expandable children */
  hasChildren?: boolean
  /** True when this parent is currently expanded */
  isExpanded?: boolean
  /** True while children are being fetched (shows spinner instead of chevron) */
  isLoadingExpand?: boolean
  /** Called when the chevron is clicked */
  onExpand?: () => void
}

function ProductCell({
  row,
  isChild,
  hasChildren,
  isExpanded,
  isLoadingExpand,
  onExpand,
}: ProductCellProps) {
  return (
    <div
      className={[styles.productCell, isChild ? styles.productCellChild : '']
        .filter(Boolean)
        .join(' ')}
    >
      {/* Chevron affordance — only shown on parent rows */}
      {hasChildren ? (
        <button
          type="button"
          className={styles.expandBtn}
          onClick={onExpand}
          aria-label={isExpanded ? 'Collapse variations' : 'Expand variations'}
          aria-expanded={isExpanded}
        >
          {isLoadingExpand ? (
            <span className={styles.expandSpinner} />
          ) : isExpanded ? (
            <ChevronDown size={14} />
          ) : (
            <ChevronRight size={14} />
          )}
        </button>
      ) : (
        /* invisible placeholder keeps thumb column aligned across all rows */
        <span className={styles.expandPlaceholder} aria-hidden />
      )}
      <Thumbnail src={row.imageUrl} photoCount={row.photoCount} alt={row.name} />
      <div className={styles.pmeta}>
        <div className={styles.ptitle}>{row.name}</div>
        <div className={styles.psub}>
          <span className={styles.skuTag}>{row.sku}</span>
          {row.productType && (
            <span className={styles.typeTag}>{row.productType}</span>
          )}
          {!isChild && (row.variantCount ?? 0) > 0 && (
            <span className={styles.varCount}>{row.variantCount} variations</span>
          )}
        </div>
      </div>
    </div>
  )
}

/** Available (stock) cell: colour-coded unit count + optional FBA/FBM tooltip */
function AvailableCell({ row }: { row: ProductRow }) {
  const stockEl = (
    <div className={styles.availCell}>
      <span
        className={styles.availNum}
        style={{ color: getStockColor(row.totalStock, row.lowStockThreshold) }}
      >
        {row.totalStock}
      </span>
      <span className={styles.availUnit}>units</span>
    </div>
  )

  if (row.fbaStock != null || row.fbmStock != null) {
    const tip = [
      row.fbaStock != null ? `FBA ${row.fbaStock}` : null,
      row.fbmStock != null ? `FBM ${row.fbmStock}` : null,
    ]
      .filter(Boolean)
      .join(' · ')
    return <Tooltip label={tip}>{stockEl}</Tooltip>
  }

  return stockEl
}

/** Row action cluster: Edit link + ⋯ DS Menu */
function RowActions({ row, onMore }: { row: ProductRow; onMore: () => void }) {
  const router = useRouter()
  const menuItems: MenuItemDef[] = [
    {
      id: 'edit',
      label: 'Edit',
      onSelect: () => router.push(`/products/${row.id}/edit`),
    },
    { id: 'duplicate', label: 'Duplicate', onSelect: onMore },
    {
      id: 'open-new',
      label: 'Open in new tab',
      onSelect: () => window.open(`/products/${row.id}/edit`, '_blank'),
    },
  ]

  return (
    <div className={styles.rowacts}>
      <Link href={`/products/${row.id}/edit`} className={styles.editLink}>
        Edit
      </Link>
      <Menu
        label="⋯"
        items={menuItems}
        align="right"
        triggerProps={{ className: styles.menuTrigger }}
      />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// Inner component (uses DS toast context)
// ─────────────────────────────────────────────────────────────────

function ProductsNextInner() {
  const { toast } = useToast()

  // ── State ─────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [lens, setLens] = useState<LensKey>('all')
  const [density, setDensity] = useState<DensityMode>('cozy')
  const [activeTile, setActiveTile] = useState<KpiTileKey>(null)

  // Variation expansion — children are lazy-fetched on first expand and
  // cached; collapsing re-hides without evicting the cache.
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())
  const [childrenByParent, setChildrenByParent] = useState<Record<string, ProductRow[]>>({})
  const [loadingChildren, setLoadingChildren] = useState<Set<string>>(new Set())

  // Manual sort state (DataGrid re-sort is disabled so children stay grouped)
  const [sortKey, setSortKey] = useState<string>('product')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  // ── Data ──────────────────────────────────────────────────────
  const { data, loading } = usePolledList<{
    products: ProductRow[]
    stats: {
      total: number
      active: number
      draft: number
      inStock: number
      outOfStock: number
    }
    total: number
    totalPages: number
  }>({
    url: POLL_URL,
    intervalMs: 30_000,
    invalidationTypes: [
      'product.updated',
      'product.created',
      'product.deleted',
      'stock.adjusted',
      'listing.updated',
    ],
  })

  const products = data?.products ?? []
  const stats = data?.stats

  // ── Derived counts ─────────────────────────────────────────────
  const needsAttentionCount = useMemo(
    () => products.filter((r) => r.photoCount === 0).length,
    [products],
  )

  // ── Client-side filter (200 rows max — fits in memory) ─────────
  const filtered = useMemo(() => {
    let rows = products

    // KPI tile filter
    if (activeTile === 'active') rows = rows.filter((r) => r.status === 'ACTIVE')
    else if (activeTile === 'out-of-stock') rows = rows.filter((r) => r.totalStock === 0)
    else if (activeTile === 'attention') rows = rows.filter((r) => r.photoCount === 0)

    // Quick-lens filter
    if (lens === 'attention') rows = rows.filter((r) => r.photoCount === 0)
    else if (lens === 'amazon') rows = rows.filter((r) => (getCov(r, 'AMAZON')?.total ?? 0) > 0)
    else if (lens === 'ebay') rows = rows.filter((r) => (getCov(r, 'EBAY')?.total ?? 0) > 0)
    else if (lens === 'shopify') rows = rows.filter((r) => (getCov(r, 'SHOPIFY')?.total ?? 0) > 0)

    // Text search
    if (search.trim()) {
      const q = search.toLowerCase()
      rows = rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.sku.toLowerCase().includes(q) ||
          (r.productType?.toLowerCase().includes(q) ?? false),
      )
    }

    return rows
  }, [products, activeTile, lens, search])

  // ── Sorted + interleaved display rows ─────────────────────────
  // Only top-level rows (parentId === null) are shown by default.
  // When a parent is expanded, its fetched children are interleaved
  // immediately after it. DataGrid receives this pre-ordered array
  // WITHOUT initialSort so it never re-sorts and scatters children.
  const displayRows = useMemo(() => {
    const topLevel = filtered.filter((r) => r.parentId === null)

    // Sort parents by active sort key
    const sorted = [...topLevel].sort((a, b) => {
      let av: string | number
      let bv: string | number
      if (sortKey === 'available') {
        av = a.totalStock
        bv = b.totalStock
      } else if (sortKey === 'price') {
        av = a.basePrice
        bv = b.basePrice
      } else {
        // default: sort by name (product column)
        av = a.name.toLowerCase()
        bv = b.name.toLowerCase()
      }
      const dir = sortDir === 'asc' ? 1 : -1
      return av < bv ? -dir : av > bv ? dir : 0
    })

    // Interleave children / loading sentinels under each expanded parent
    const result: ProductRow[] = []
    for (const parent of sorted) {
      result.push(parent)
      if (expandedParents.has(parent.id)) {
        if (loadingChildren.has(parent.id)) {
          result.push(makeLoadingRow(parent.id))
        } else {
          result.push(...(childrenByParent[parent.id] ?? []))
        }
      }
    }
    return result
  }, [filtered, sortKey, sortDir, expandedParents, loadingChildren, childrenByParent])

  // ── Selection ─────────────────────────────────────────────────
  // allKeys includes visible children (when expanded) but excludes
  // loading sentinels so select-all doesn't try to select a phantom row.
  const allKeys = useMemo(
    () => displayRows.filter((r) => !isLoadingRow(r)).map((r) => r.id),
    [displayRows],
  )
  const allSelected = selected.size > 0 && allKeys.every((k) => selected.has(k))
  const someSelected = selected.size > 0 && !allSelected

  const toggleAll = useCallback(() => {
    setSelected(allSelected ? new Set() : new Set(allKeys))
  }, [allSelected, allKeys])

  const toggleRow = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  const comingSoon = useCallback(
    () => toast('Coming soon', 'neutral'),
    [toast],
  )

  // ── Variation expansion ───────────────────────────────────────
  const fetchChildrenFor = useCallback(async (parentId: string) => {
    if (childrenByParent[parentId] !== undefined) return // cache hit
    setLoadingChildren((prev) => {
      const next = new Set(prev)
      next.add(parentId)
      return next
    })
    try {
      const url = `${getBackendUrl()}/api/products?parentId=${encodeURIComponent(parentId)}&includeCoverage=true&includeTags=true`
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) throw new Error(`${res.status}`)
      const data = (await res.json()) as { products?: ProductRow[] }
      setChildrenByParent((prev) => ({ ...prev, [parentId]: data.products ?? [] }))
    } catch {
      // Mark as fetched but empty so re-expand shows nothing rather than spinning
      setChildrenByParent((prev) => ({ ...prev, [parentId]: [] }))
    } finally {
      setLoadingChildren((prev) => {
        const next = new Set(prev)
        next.delete(parentId)
        return next
      })
    }
  }, [childrenByParent])

  const toggleExpand = useCallback((parentId: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev)
      if (next.has(parentId)) {
        next.delete(parentId)
      } else {
        next.add(parentId)
        void fetchChildrenFor(parentId)
      }
      return next
    })
  }, [fetchChildrenFor])

  // ── Manual column sort (keeps children grouped under their parent) ─
  // DataGrid's built-in sort is disabled (no initialSort passed) so the
  // pre-ordered displayRows array is rendered as-is. Toggling a sort
  // header only updates local state which drives displayRows below.
  const handleColumnSort = useCallback((key: string) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
        return prev
      }
      setSortDir('asc')
      return key
    })
  }, [])

  // ── Column definitions ────────────────────────────────────────
  // NOTE: sortable/sortValue are intentionally omitted from all columns.
  // DataGrid's built-in sort is disabled (no initialSort) so the
  // pre-ordered displayRows array is not re-sorted. Sort headers are
  // custom SortHeader elements that update local sortKey/sortDir state.
  const columns = useMemo(
    (): Column<ProductRow>[] => [
      {
        key: '_sel',
        label: (
          <Ckb
            checked={allSelected}
            indeterminate={someSelected}
            onChange={toggleAll}
            label="Select all rows"
          />
        ),
        width: 40,
        align: 'center',
        render: (row) => {
          if (isLoadingRow(row)) return null
          return (
            <Ckb
              checked={selected.has(row.id)}
              onChange={() => toggleRow(row.id)}
            />
          )
        },
      },
      {
        key: 'product',
        label: (
          <SortHeader
            label="Product"
            colKey="product"
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleColumnSort}
          />
        ),
        render: (row) => {
          if (isLoadingRow(row)) {
            return (
              <div className={styles.childLoadingRow}>
                <span className={styles.expandSpinner} />
                Loading variations…
              </div>
            )
          }
          const isChild = row.parentId !== null
          const hasChildren = row.isParent || (row.childCount ?? 0) > 0
          return (
            <ProductCell
              row={row}
              isChild={isChild}
              hasChildren={!isChild && hasChildren}
              isExpanded={expandedParents.has(row.id)}
              isLoadingExpand={loadingChildren.has(row.id)}
              onExpand={() => toggleExpand(row.id)}
            />
          )
        },
      },
      {
        key: 'channels',
        label: 'Channels',
        width: 110,
        render: (row) => {
          if (isLoadingRow(row)) return null
          return (
            <div className={styles.chcell}>
              {CHANNELS.map((ch) => {
                const cov = getCov(row, ch)
                const state =
                  cov && cov.live > 0
                    ? 'on'
                    : cov && cov.error > 0
                      ? 'iss'
                      : 'off'
                const stateClass =
                  state === 'on'
                    ? styles.chOn
                    : state === 'iss'
                      ? styles.chIss
                      : styles.chOff
                const tipLabel = cov
                  ? `${cov.live} live · ${cov.error} errors`
                  : 'not listed'
                return (
                  <Tooltip key={ch} label={`${ch}: ${tipLabel}`}>
                    <span className={`${styles.ch} ${stateClass}`}>
                      {ch[0]}
                    </span>
                  </Tooltip>
                )
              })}
            </div>
          )
        },
      },
      {
        key: 'status',
        label: 'Status',
        width: 96,
        render: (row) => {
          if (isLoadingRow(row)) return null
          return (
            <Pill tone={getStatusTone(row.status)}>
              {getStatusLabel(row.status)}
            </Pill>
          )
        },
      },
      {
        key: 'available',
        label: (
          <SortHeader
            label="Available"
            colKey="available"
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleColumnSort}
          />
        ),
        width: 120,
        render: (row) => {
          if (isLoadingRow(row)) return null
          return <AvailableCell row={row} />
        },
      },
      {
        key: 'price',
        label: (
          <SortHeader
            label="Price"
            colKey="price"
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleColumnSort}
          />
        ),
        width: 96,
        align: 'right',
        render: (row) => {
          if (isLoadingRow(row)) return null
          return (
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              {fmtEur(row.basePrice)}
            </span>
          )
        },
      },
      {
        key: 'actions',
        label: '',
        width: 120,
        render: (row) => {
          if (isLoadingRow(row)) return null
          return <RowActions row={row} onMore={comingSoon} />
        },
      },
    ],
    [
      allSelected,
      someSelected,
      selected,
      toggleAll,
      toggleRow,
      comingSoon,
      sortKey,
      sortDir,
      handleColumnSort,
      expandedParents,
      loadingChildren,
      toggleExpand,
    ],
  )

  // ── KPI tile config ────────────────────────────────────────────
  const kpis: Array<{
    tileKey: KpiTileKey
    label: string
    value: number | string
    hint: string
    color: string
  }> = [
    {
      tileKey: null,
      label: 'Total',
      value: stats?.total ?? '—',
      hint: 'all statuses',
      color: 'var(--color-primary)',
    },
    {
      tileKey: 'active',
      label: 'Active',
      value: stats?.active ?? '—',
      hint: 'live & selling',
      color: 'var(--status-success-line)',
    },
    {
      tileKey: 'out-of-stock',
      label: 'Out of stock',
      value: stats?.outOfStock ?? '—',
      hint: 'no available units',
      color: 'var(--status-danger-line)',
    },
    {
      tileKey: 'attention',
      label: 'Needs attention',
      value: needsAttentionCount,
      hint: 'photos · GTIN · description',
      color: 'var(--status-warning-line)',
    },
  ]

  // ── Lens config ────────────────────────────────────────────────
  const mainLenses: Array<{
    key: LensKey
    label: string
    count: number
    warn?: boolean
  }> = [
    { key: 'all', label: 'All', count: products.length },
    {
      key: 'attention',
      label: 'Needs attention',
      count: needsAttentionCount,
      warn: true,
    },
  ]
  const channelLenses: Array<{ key: LensKey; label: string; count: number }> = [
    { key: 'amazon', label: 'Amazon', count: lensCount(products, 'amazon') },
    { key: 'ebay', label: 'eBay', count: lensCount(products, 'ebay') },
    { key: 'shopify', label: 'Shopify', count: lensCount(products, 'shopify') },
  ]

  // ── Render ────────────────────────────────────────────────────
  return (
    <div className={styles.wrap}>
      {/* Page header */}
      <PageHeader
        title="Products"
        subtitle={`${stats?.total ?? '—'} products · synced live across Amazon, eBay & Shopify`}
        actions={
          <div className={styles.acts}>
            <Button size="sm" onClick={comingSoon}>
              Import{' '}
              <span style={{ color: 'var(--text-tertiary)', fontWeight: 700 }}>
                ▾
              </span>
            </Button>
            <Button size="sm" aria-label="More options" onClick={comingSoon}>
              ⋯
            </Button>
            <Button size="sm" variant="primary" onClick={comingSoon}>
              + New product
            </Button>
          </div>
        }
      />

      {/* KPI tiles — click to filter rows client-side */}
      <div className={styles.kpis}>
        {kpis.map((kpi) => (
          <div
            key={kpi.tileKey ?? '_total'}
            className={[
              styles.kpiTile,
              activeTile === kpi.tileKey ? styles.kpiTileActive : '',
            ]
              .filter(Boolean)
              .join(' ')}
            role="button"
            tabIndex={0}
            onClick={() =>
              setActiveTile((prev) =>
                prev === kpi.tileKey ? null : kpi.tileKey,
              )
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setActiveTile((prev) =>
                  prev === kpi.tileKey ? null : kpi.tileKey,
                )
              }
            }}
          >
            <div className={styles.kpiLabel}>
              <span
                className={styles.kpiDot}
                style={{ background: kpi.color }}
              />
              {kpi.label}
            </div>
            <div className={styles.kpiValue}>{kpi.value}</div>
            <div className={styles.kpiHint}>{kpi.hint}</div>
          </div>
        ))}
      </div>

      {/* ONE toolbar row */}
      <div className={styles.tbar}>
        <span className={styles.searchField}>
          <Input
            leadingIcon={
              <Search size={13} style={{ color: 'var(--text-tertiary)' }} />
            }
            placeholder="Search products…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: '100%' }}
          />
        </span>
        <Button size="sm" onClick={comingSoon}>
          Filter
        </Button>
        <Button size="sm" onClick={comingSoon}>
          ↕ Sort
        </Button>
        <Button size="sm" onClick={comingSoon}>
          ▤ Views
        </Button>
        <span className={styles.spacer} />
        <SegmentedControl
          options={DENSITY_OPTIONS}
          value={density}
          onChange={(v) => setDensity(v as DensityMode)}
          size="sm"
        />
        <span className={styles.liveChip}>
          <span className={styles.liveDot} />
          {loading ? 'Syncing…' : 'Live'}
        </span>
      </div>

      {/* Quick-lens chips */}
      <div className={styles.lenses}>
        {mainLenses.map((item) => (
          <button
            key={item.key}
            type="button"
            className={[
              styles.chip,
              lens === item.key ? styles.chipActive : '',
              item.warn && lens !== item.key ? styles.chipWarn : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => setLens(item.key)}
          >
            {item.label}
            {item.count > 0 && (
              <span
                className={
                  item.warn && lens !== item.key
                    ? styles.chipWarnCount
                    : styles.chipCount
                }
              >
                {item.count}
              </span>
            )}
          </button>
        ))}
        <span className={styles.vline} role="separator" />
        {channelLenses.map((item) => (
          <button
            key={item.key}
            type="button"
            className={[
              styles.chip,
              lens === item.key ? styles.chipActive : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => setLens(item.key)}
          >
            {item.label}
            <span className={styles.chipCount}>{item.count}</span>
          </button>
        ))}
      </div>

      {/* Data grid — DensityContext.Provider makes the shared Thumbnail
          size-aware, matching /products exactly (compact 32 / comfortable 40 /
          spacious 56). mapDensity bridges the page's 'cozy' to 'comfortable'. */}
      <DensityContext.Provider value={mapDensity(density)}>
        <div
          className={
            density === 'compact'
              ? styles.densityCompact
              : density === 'spacious'
                ? styles.densitySpacious
                : undefined
          }
        >
          <DataGrid<ProductRow>
            columns={columns}
            rows={displayRows}
            rowKey={(r) => r.id}
            selected={selected}
            emptyState={
              loading ? (
                <span style={{ color: 'var(--text-tertiary)' }}>Loading…</span>
              ) : (
                <span style={{ color: 'var(--text-tertiary)' }}>
                  No products match this filter.
                </span>
              )
            }
          />
        </div>
      </DensityContext.Provider>

      {/*
       * Bulk staging bar.
       * "Preview diff" / "Apply all" are visually present but no-op today
       * (coming soon toast). Full diff wiring is a future task.
       * TODO: wire staging model (diff computation + apply mutations).
       * TODO: Sales 30d column — needs a backend field on ProductRow (no
       *       such field exists today; omitted to avoid fabricating data).
       */}
      <BulkActionBar
        count={selected.size}
        onClear={() => setSelected(new Set())}
      >
        <Button size="sm" onClick={comingSoon}>
          Set field ▾
        </Button>
        <Button size="sm" onClick={comingSoon}>
          Publish ▾
        </Button>
        <Button size="sm" onClick={comingSoon}>
          Activate
        </Button>
        <Button size="sm" onClick={comingSoon}>
          Tag ▾
        </Button>
        <span className={styles.stageExtra}>
          <Button size="sm" onClick={comingSoon}>
            Preview diff
          </Button>
          <Button size="sm" variant="primary" onClick={comingSoon}>
            Apply all
          </Button>
        </span>
      </BulkActionBar>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// Exported wrapper — provides DS ToastProvider for this subtree
// (the root layout's ToastProvider is from the old component
// library; DS toast needs its own context boundary).
// ─────────────────────────────────────────────────────────────────

export function ProductsNextClient() {
  return (
    <ToastProvider>
      <ProductsNextInner />
    </ToastProvider>
  )
}
