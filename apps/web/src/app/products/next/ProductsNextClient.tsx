'use client'

// Design-system style sheets (must be imported explicitly per-page).
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'

import { usePolledList } from '@/lib/sync/use-polled-list'
import type { ProductRow } from '@/app/products/_types'
import { Thumbnail, DensityContext } from '@/app/_shared/grid-lens'
import type { Density } from '@/app/_shared/grid-lens'

import { Pill, Tooltip, type Tone } from '@/design-system/primitives'
import { ToastProvider, useToast } from '@/design-system/components'
import { PageHeader } from '@/design-system/patterns'

import { AdsDataGrid, type GridColumn, type GridFilter } from '@/app/marketing/ads/campaigns/_grid/AdsDataGrid'

import styles from './styles.module.css'

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

const POLL_URL =
  '/api/products?page=1&limit=200&includeCoverage=true&includeTags=true'

const CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY'] as const
type Channel = (typeof CHANNELS)[number]

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

function getCov(row: ProductRow, ch: Channel) {
  return row.coverage?.[ch] ?? null
}

/** Returns comma-separated channels where coverage.total > 0; used by anyOf channel filter. */
function rowChannels(row: ProductRow): string {
  return CHANNELS.filter((ch) => (getCov(row, ch)?.total ?? 0) > 0).join(',')
}

// ─────────────────────────────────────────────────────────────────
// Inner component (uses DS toast context)
// ─────────────────────────────────────────────────────────────────

function ProductsNextInner() {
  const { toast } = useToast()

  // ── KPI tile pre-filter ───────────────────────────────────────
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

  const needsAttentionCount = useMemo(
    () => products.filter((r) => r.photoCount === 0).length,
    [products],
  )

  // ── KPI pre-filter (orthogonal to AdsDataGrid's own filter panel) ──
  const filteredByTile = useMemo(() => {
    if (activeTile === 'active') return products.filter((r) => r.status === 'ACTIVE')
    if (activeTile === 'out-of-stock') return products.filter((r) => r.totalStock === 0)
    if (activeTile === 'attention') return products.filter((r) => r.photoCount === 0)
    return products
  }, [products, activeTile])

  const comingSoon = useCallback(() => toast('Coming soon', 'neutral'), [toast])

  // ── Derived filter options (computed from full product list) ──
  const typeOptions = useMemo(
    () =>
      Array.from(new Set(products.map((r) => r.productType).filter((t): t is string => !!t)))
        .sort()
        .map((t) => ({ value: t, label: t })),
    [products],
  )

  const brandOptions = useMemo(
    () =>
      Array.from(new Set(products.map((r) => r.brand).filter((b): b is string => !!b)))
        .sort()
        .map((b) => ({ value: b, label: b })),
    [products],
  )

  // ── AdsDataGrid columns ───────────────────────────────────────
  const columns = useMemo(
    (): GridColumn<ProductRow>[] => [
      {
        key: 'channels',
        label: 'Channels',
        metric: false,
        sortable: false,
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
                state === 'on' ? styles.chOn : state === 'iss' ? styles.chIss : styles.chOff
              const tipLabel = cov ? `${cov.live} live · ${cov.error} errors` : 'not listed'
              return (
                <Tooltip key={ch} label={`${ch}: ${tipLabel}`}>
                  <span className={`${styles.ch} ${stateClass}`}>{ch[0]}</span>
                </Tooltip>
              )
            })}
          </div>
        ),
      },
      {
        key: 'status',
        label: 'Status',
        metric: false,
        sortable: false,
        render: (row) => (
          <Pill tone={getStatusTone(row.status)}>{getStatusLabel(row.status)}</Pill>
        ),
      },
      {
        key: 'available',
        label: 'Available',
        metric: true,
        render: (row) => {
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
              .filter((v): v is string => v !== null)
              .join(' · ')
            return <Tooltip label={tip}>{stockEl}</Tooltip>
          }
          return stockEl
        },
        sortValue: (row) => row.totalStock,
        filterValue: (row) => row.totalStock,
      },
      {
        key: 'price',
        label: 'Price',
        metric: true,
        render: (row) => (
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtEur(row.basePrice)}</span>
        ),
        sortValue: (row) => row.basePrice,
        filterValue: (row) => row.basePrice,
      },
      {
        key: 'actions',
        label: 'Actions',
        metric: false,
        sortable: false,
        render: (row) => (
          <div className={styles.rowacts}>
            <Link href={`/products/${row.id}/edit`} className={styles.editLink}>
              Edit
            </Link>
          </div>
        ),
      },
    ],
    [],
  )

  // ── AdsDataGrid filters ───────────────────────────────────────
  // These appear in the expandable filter panel and REPLACE the old lens chips.
  // Status + Channel use multiselect; type + brand use single-select (derived from
  // loaded rows); Price + Stock use range fields that match the 'price'/'available'
  // column filterValue accessors by key.
  const filters = useMemo((): GridFilter[] => {
    const base: GridFilter[] = [
      {
        key: 'status',
        label: 'Status',
        kind: 'multiselect',
        options: [
          { value: 'ACTIVE', label: 'Active' },
          { value: 'DRAFT', label: 'Draft' },
          { value: 'INACTIVE', label: 'Inactive' },
        ],
        value: (row) => (row as ProductRow).status,
      },
      {
        key: 'channel',
        label: 'Channel',
        kind: 'multiselect',
        options: [
          { value: 'AMAZON', label: 'Amazon' },
          { value: 'EBAY', label: 'eBay' },
          { value: 'SHOPIFY', label: 'Shopify' },
        ],
        // value returns comma-separated channels; anyOf: true ⇒ ANY selected value passes
        value: (row) => rowChannels(row as ProductRow),
        anyOf: true,
      },
    ]

    if (typeOptions.length > 0) {
      base.push({
        key: 'type',
        label: 'Product Type',
        kind: 'select',
        options: typeOptions,
        value: (row) => (row as ProductRow).productType ?? '',
      })
    }

    if (brandOptions.length > 0) {
      base.push({
        key: 'brand',
        label: 'Brand',
        kind: 'select',
        options: brandOptions,
        value: (row) => (row as ProductRow).brand ?? '',
      })
    }

    base.push(
      {
        key: 'price',
        label: 'Price',
        kind: 'range',
        unit: '€',
        // key matches column key 'price' so AdsDataGrid uses column.filterValue
      },
      {
        key: 'available',
        label: 'Stock',
        kind: 'range',
        unit: '',
        // key matches column key 'available' so AdsDataGrid uses column.filterValue
      },
    )

    return base
  }, [typeOptions, brandOptions])

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

  // ── Render ────────────────────────────────────────────────────
  return (
    <div className={styles.wrap}>
      {/* Page header */}
      <PageHeader
        title="Products"
        subtitle={`${stats?.total ?? '—'} products · synced live across Amazon, eBay & Shopify`}
        actions={
          <div className={styles.acts}>
            <button type="button" className="h10-am-btn" onClick={comingSoon}>
              Import ▾
            </button>
            <button type="button" className="h10-am-btn" onClick={comingSoon}>
              ⋯
            </button>
            <Link href="/products/new" className="h10-am-btn primary">
              + New product
            </Link>
          </div>
        }
      />

      {/* KPI tiles — click to pre-filter rows passed to the grid */}
      <div className={styles.kpis}>
        {kpis.map((kpi) => (
          <div
            key={kpi.tileKey ?? '_total'}
            className={[styles.kpiTile, activeTile === kpi.tileKey ? styles.kpiTileActive : '']
              .filter(Boolean)
              .join(' ')}
            role="button"
            tabIndex={0}
            onClick={() =>
              setActiveTile((prev) => (prev === kpi.tileKey ? null : kpi.tileKey))
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setActiveTile((prev) => (prev === kpi.tileKey ? null : kpi.tileKey))
              }
            }}
          >
            <div className={styles.kpiLabel}>
              <span className={styles.kpiDot} style={{ background: kpi.color }} />
              {kpi.label}
            </div>
            <div className={styles.kpiValue}>{kpi.value}</div>
            <div className={styles.kpiHint}>{kpi.hint}</div>
          </div>
        ))}
      </div>

      {/*
       * AdsDataGrid — shared H10-fidelity grid.
       * DensityContext wraps it so Thumbnail renders at the 'comfortable'
       * image size (40px) without needing a density toggle.
       *
       * EXPANSION NOTE: AdsDataGrid has no parent/child expansion model
       * (campaigns grid doesn't need it). The variation-expand feature from
       * the previous custom grid has been DEFERRED here. Two options for the
       * next session:
       *   A) Extend AdsDataGrid with optional `expandable` / `getHasChildren`
       *      / `fetchChildren` props that inject child rows after their parent
       *      in the sort pipeline — requires modifying sorted+paged logic but
       *      can be done without touching default behavior.
       *   B) Variation drawer: clicking a parent row opens a slide-over that
       *      lists its children (reuses the AdsDataGrid in a drawer, no grid
       *      surgery needed).
       * For now, only top-level products (parentId === null are returned by
       * the API by default at /api/products) are shown flat.
       */}
      <DensityContext.Provider value={'comfortable' as Density}>
        <AdsDataGrid<ProductRow>
          rows={filteredByTile}
          loading={loading}
          rowId={(p) => p.id}
          noun="Product"
          firstColLabel="Product"
          renderFirst={(p) => (
            <div className={styles.productCell}>
              <Thumbnail src={p.imageUrl} photoCount={p.photoCount} alt={p.name} />
              <div className={styles.pmeta}>
                <div className={styles.ptitle}>{p.name}</div>
                <div className={styles.psub}>
                  <span className={styles.skuTag}>{p.sku}</span>
                  {p.productType && (
                    <span className={styles.typeTag}>{p.productType}</span>
                  )}
                  {(p.variantCount ?? 0) > 0 && (
                    <span className={styles.varCount}>{p.variantCount} variations</span>
                  )}
                </div>
              </div>
            </div>
          )}
          firstSortValue={(p) => p.name}
          columns={columns}
          filters={filters}
          filtersDefaultOpen
          selectable
          selectionActions={(_ids, clear) => (
            <>
              <button
                type="button"
                className="h10-am-btn"
                onClick={() => { comingSoon(); clear() }}
              >
                Publish
              </button>
              <button
                type="button"
                className="h10-am-btn"
                onClick={() => { comingSoon(); clear() }}
              >
                Activate
              </button>
              <button
                type="button"
                className="h10-am-btn"
                onClick={() => { comingSoon(); clear() }}
              >
                Draft
              </button>
              <button
                type="button"
                className="h10-am-btn"
                onClick={() => { comingSoon(); clear() }}
              >
                Tag
              </button>
            </>
          )}
          toolbarRight={
            <Link href="/products/new" className="h10-am-btn primary">
              + New product
            </Link>
          }
          storageKey="nexus-products-next-cols"
          defaultSort={{ key: '__first', dir: 'asc' }}
          exportable
          onExport={comingSoon}
        />
      </DensityContext.Provider>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// Exported wrapper — provides DS ToastProvider for this subtree
// ─────────────────────────────────────────────────────────────────

export function ProductsNextClient() {
  return (
    <ToastProvider>
      <ProductsNextInner />
    </ToastProvider>
  )
}
