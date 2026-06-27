'use client'

// Design-system style sheets (must be imported explicitly per-page).
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Search } from 'lucide-react'

import { usePolledList } from '@/lib/sync/use-polled-list'
import type { ProductRow } from '@/app/products/_types'

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

function getInitials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
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

/** Product column cell: thumb + name + sku + category tag + variation count */
function ProductCell({ row }: { row: ProductRow }) {
  return (
    <div className={styles.productCell}>
      <div className={styles.thumb}>
        {row.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={row.imageUrl} alt="" className={styles.thumbImg} />
        ) : (
          getInitials(row.name)
        )}
      </div>
      <div className={styles.pmeta}>
        <div className={styles.ptitle}>{row.name}</div>
        <div className={styles.psub}>
          <span className={styles.skuTag}>{row.sku}</span>
          {row.productType && (
            <span className={styles.typeTag}>{row.productType}</span>
          )}
          {(row.variantCount ?? 0) > 0 && (
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

  // ── Selection ─────────────────────────────────────────────────
  const allKeys = useMemo(() => filtered.map((r) => r.id), [filtered])
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

  // ── Column definitions ────────────────────────────────────────
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
        render: (row) => (
          <Ckb
            checked={selected.has(row.id)}
            onChange={() => toggleRow(row.id)}
          />
        ),
      },
      {
        key: 'product',
        label: 'Product',
        sortable: true,
        sortValue: (r) => r.name,
        render: (row) => <ProductCell row={row} />,
      },
      {
        key: 'channels',
        label: 'Channels',
        width: 110,
        render: (row) => (
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
        ),
      },
      {
        key: 'status',
        label: 'Status',
        width: 96,
        render: (row) => (
          <Pill tone={getStatusTone(row.status)}>
            {getStatusLabel(row.status)}
          </Pill>
        ),
      },
      {
        key: 'available',
        label: 'Available',
        width: 120,
        sortable: true,
        sortValue: (r) => r.totalStock,
        render: (row) => <AvailableCell row={row} />,
      },
      {
        key: 'price',
        label: 'Price',
        width: 96,
        align: 'right',
        sortable: true,
        sortValue: (r) => r.basePrice,
        render: (row) => (
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {fmtEur(row.basePrice)}
          </span>
        ),
      },
      {
        key: 'actions',
        label: '',
        width: 120,
        render: (row) => <RowActions row={row} onMore={comingSoon} />,
      },
    ],
    [allSelected, someSelected, selected, toggleAll, toggleRow, comingSoon],
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

      {/* Data grid */}
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
          rows={filtered}
          rowKey={(r) => r.id}
          selected={selected}
          initialSort={{ key: 'product', dir: 'asc' }}
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
