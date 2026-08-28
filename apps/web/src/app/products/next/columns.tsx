'use client'

/**
 * The products grid's columns — what each one is, how it renders, and how it projects onto AG's
 * `ColDef`. The page composes these; nothing here knows about the page's state.
 */
import type { ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ExternalLink, MoreHorizontal } from 'lucide-react'

import type { ProductRow } from '@/app/products/_types'
import { Thumbnail } from '@/app/_shared/grid-lens'
import { Button, ExpandToggle, InfoTip, Pill, Tag, TagGlyph, type Tone } from '@/design-system/primitives'
import { CoverageSummary, Menu, type MenuItemDef } from '@/design-system/components'
import { eur0, num, formatDate } from '@/design-system/lib'
import { numericColumn, type ColDef, type ICellRendererParams } from '@/design-system/patterns/workspace-grid/engine/NexusGrid'
import { NULL_GROUP_KEY, type AggFunc, type ProductGroupRow } from '@/design-system/patterns/workspace-grid/engine/productsServerContract'

export type { ProductGroupRow }

import styles from './styles.module.css'
import { InventoryCell } from './InventoryCell'

/**
 * The Sales / Units window. ONE constant, so the two columns can never describe different
 * periods — they are the same fact counted two ways and must move together.
 *
 * Seven days. On this catalogue that is 4 products with sales out of 14 (31 orders, €2,255),
 * where 90 days shows 7 — a shorter window is a narrower truth, not a smaller number.
 */
export const SALES_WINDOW_DAYS = 7

export const CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY'] as const
export type Channel = (typeof CHANNELS)[number]

export const CHANNEL_OPTS = [
  { value: 'AMAZON', label: 'Amazon' },
  { value: 'EBAY', label: 'eBay' },
  { value: 'SHOPIFY', label: 'Shopify' },
]
export const STATUS_OPTS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'INACTIVE', label: 'Inactive' },
]

/** A page column: the renderer and the few facts the ColDef projection needs. */
export interface PageColumn {
  key: string
  label: ReactNode
  prefsLabel?: string
  group?: string
  width?: number
  numeric?: boolean
  /** The SERVER can order by this column (see the contract's `GRID_SORT_FIELD`). */
  sortable?: boolean
  /** Off until the operator switches it on in Customise; its FILTER is still a column filter. */
  defaultHidden?: boolean
  /** Rows can be grouped by this column (the server groups; see GRID_GROUP_COLUMNS). */
  groupable?: boolean
  /** A group row can show this aggregate of the column; the first is the default offered. */
  aggregate?: readonly AggFunc[]
  render: (row: ProductRow) => ReactNode
}

export const isGroupRow = (d: unknown): d is ProductGroupRow =>
  !!d && typeof d === 'object' && (d as { __group?: boolean }).__group === true

/** Where AG reads each column's value on a row; the server writes group aggregates there too. */
const GROUP_FIELD: Record<string, string> = { available: 'totalStock', price: 'basePrice', sales: 'sales.revenueCents', units: 'sales.units' }
const eur2 = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR' })

/** A column's cell on a GROUP row: the aggregate if the operator asked for one, else nothing. */
function renderGroupValue(c: PageColumn, g: ProductGroupRow): ReactNode {
  switch (c.key) {
    case 'available': return g.totalStock === undefined ? null : num(g.totalStock)
    case 'price': return g.basePrice === undefined ? null : eur2.format(g.basePrice)
    case 'sales': return g.sales === undefined ? null : c.render(g as unknown as ProductRow)
    case 'units': return g.units === undefined ? null : num(g.units)
    default: return null
  }
}

/** A group row's label: the key as the operator reads it, or "No brand" for the null group. */
export function groupRowLabel(g: ProductGroupRow, columns: readonly PageColumn[]): string {
  const col = columns.find((c) => c.key === g.groupColId)
  if (g.groupKey === NULL_GROUP_KEY) return `No ${(col?.prefsLabel ?? g.groupColId).toLowerCase()}`
  if (g.groupColId === 'status') return STATUS_OPTS.find((o) => o.value === g.groupKey)?.label ?? g.groupKey
  return g.groupKey
}

/** The auto column's cell on a group row: the key and how many products fold into it. */
export function GroupCell({ label, count }: { label: string; count: number }) {
  return (
    <span className={styles.groupCell}>
      <strong>{label}</strong>
      <span className={styles.groupCount}>{count === 1 ? '1 product' : `${num(count)} products`}</span>
    </span>
  )
}

// ── helpers ────────────────────────────────────────────────────────────────────────────────

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

/**
 * How many variations a parent has — from `childCount`, NOT `variantCount`.
 *
 * The API returns both and only one of them is real. `Product` carries TWO relations that both
 * sound like variations: `children Product[] @relation("ProductHierarchy")`, which is the
 * parent/child hierarchy this catalogue actually uses; and `variations ProductVariation[]`, a
 * separate table that is empty here. `variantCount` is filled from the empty one and reads 0 for
 * every product while `childCount` reads 40, 40, 10, 8, 8.
 */
export function variationCount(row: ProductRow): number {
  return row.childCount ?? 0
}

/** The family page for a parent: the same grid, scoped to its variations. */
export const familyHref = (parentId: string) => `/products/next?parent=${encodeURIComponent(parentId)}`

// ── cells ──────────────────────────────────────────────────────────────────────────────────

export interface ProductCellProps {
  row: ProductRow
  /** True when this row is a variation. */
  isChild?: boolean
  /** True when this parent row can expand its variations. */
  hasChildren?: boolean
  isExpanded?: boolean
  /** Called when the chevron is clicked. */
  onExpand?: () => void
}

/** Product column cell: chevron + thumb + name + sku + category tag + variation count. */
export function ProductCell({ row, isChild, hasChildren, isExpanded, onExpand }: ProductCellProps) {
  const n = variationCount(row)
  return (
    <div className={styles.productCell}>
      {hasChildren ? (
        <ExpandToggle
          expanded={!!isExpanded}
          label={isExpanded ? 'Collapse variations' : 'Expand variations'}
          onClick={(e) => { e.stopPropagation(); onExpand?.() }}
        />
      ) : (
        /* invisible placeholder keeps thumb column aligned across all rows */
        <span className={styles.expandPlaceholder} aria-hidden />
      )}
      <Thumbnail src={row.imageUrl} photoCount={row.photoCount} alt={row.name} />
      <div className={styles.pmeta}>
        {/* Title is a same-tab link to the editor; the "Open" pill (revealed on cell hover)
            opens the editor in a NEW tab. */}
        <div className={styles.ptitleRow}>
          <Link
            href={`/products/${row.id}/edit`}
            className={styles.ptitleLink}
            title={row.name}
            onClick={(e) => e.stopPropagation()}
          >
            {row.name}
          </Link>
          <a
            className={styles.openBtn}
            href={`/products/${row.id}/edit`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink size={11} /> Open
          </a>
        </div>
        <div className={styles.psub}>
          <span className={styles.skuTag}>{row.sku}</span>
          {row.productType && <Tag>{row.productType}</Tag>}
          {/* The count is the way to the family page — the same grid scoped to this family,
              paged and sorted like the catalogue. It opens in a new tab so the place in this
              list is kept. */}
          {!isChild && n > 0 && (
            <a
              className={styles.varCount}
              href={familyHref(row.id)}
              target="_blank"
              rel="noopener noreferrer"
              title="Open this family as its own page (new tab)"
              onClick={(e) => e.stopPropagation()}
            >
              {n} {n === 1 ? 'variation' : 'variations'} <ExternalLink size={10} aria-hidden />
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

/** Row action cluster: Edit link + ⋯ DS Menu. */
export function RowActions({ row, onDuplicate }: { row: ProductRow; onDuplicate: (id: string) => void }) {
  const router = useRouter()
  const menuItems: MenuItemDef[] = [
    { id: 'edit', label: 'Edit', onSelect: () => router.push(`/products/${row.id}/edit`) },
    { id: 'duplicate', label: 'Duplicate', onSelect: () => onDuplicate(row.id) },
    { id: 'open-new', label: 'Open in new tab', onSelect: () => window.open(`/products/${row.id}/edit`, '_blank') },
  ]
  return (
    <div className={styles.rowacts}>
      <Button asChild size="sm">
        <Link href={`/products/${row.id}/edit`}>Edit</Link>
      </Button>
      <Menu
        label={<MoreHorizontal size={15} />}
        items={menuItems}
        align="right"
        triggerProps={{ className: 'nds-btn sm icon', 'aria-label': `More actions for ${row.name}` }}
      />
    </div>
  )
}

// ── the registry ───────────────────────────────────────────────────────────────────────────

export interface ColumnDeps {
  /** The merchant's ACTIVE channels — the Channels cell reports each of these, and no other. */
  activeChannels: readonly string[]
  onDuplicate: (id: string) => void
  onOpenInventory: (row: ProductRow) => void
}

/**
 * Every page column, in canonical order:
 * [product] [...movable, in the operator's order...] [brand, product type — hidden by default] [actions]
 */
export function buildPageColumns({ activeChannels, onDuplicate, onOpenInventory }: ColumnDeps): PageColumn[] {
  const productCol: PageColumn = {
    key: 'product',
    group: 'Identity',
    label: 'Product',
    sortable: true,
    // Rendered by the tree column's own cell (ProductTreeCell); this renderer is the CSV/plain
    // fallback and is not what the grid draws.
    render: (row) => <ProductCell row={row} isChild={row.parentId !== null} />,
  }

  // Brand and Product type are columns because their filters are column filters. Off by
  // default (the live page never showed them); Customise switches them on.
  const brandCol: PageColumn = { key: 'brand', group: 'Identity', label: 'Brand', width: 140, sortable: true, defaultHidden: true, groupable: true, render: (row) => row.brand ?? null }
  const productTypeCol: PageColumn = { key: 'productType', group: 'Identity', label: 'Product type', width: 150, sortable: true, defaultHidden: true, groupable: true, render: (row) => row.productType ?? null }

  const actionsCol: PageColumn = {
    key: 'actions',
    group: 'Meta',
    label: '',
    prefsLabel: 'Actions',
    width: 120,
    render: (row) => <RowActions row={row} onDuplicate={onDuplicate} />,
  }

  const movable: PageColumn[] = [
    {
      key: 'channels',
      group: 'Identity',
      label: 'Channels',
      width: 130,
      render: (row) => {
        // Resolve each ACTIVE channel to one state. Order matters: an error outranks a live
        // listing on the same channel, because the error is the thing to act on. `draft` is
        // tested before falling through to missing — the column this replaces did not, and
        // reported 13 of 14 products as "not listed" while they held draft listings.
        const channels = activeChannels.map((ch) => {
          const cov = getCov(row, ch as Channel)
          if (!cov || cov.total === 0) return { channel: ch, state: 'missing' as const, detail: 'not listed' }
          if (cov.error > 0) return { channel: ch, state: 'issues' as const, detail: `${cov.error} error${cov.error > 1 ? 's' : ''}` }
          if (cov.live > 0) return { channel: ch, state: 'live' as const, detail: `${cov.live} live` }
          if (cov.draft > 0) return { channel: ch, state: 'draft' as const, detail: `${cov.draft} draft` }
          return { channel: ch, state: 'missing' as const, detail: 'not listed' }
        })
        return <CoverageSummary channels={channels} />
      },
    },
    {
      key: 'status',
      groupable: true,
      group: 'Identity',
      label: 'Status',
      width: 96,
      sortable: true,
      render: (row) => <Pill tone={getStatusTone(row.status)}>{getStatusLabel(row.status)}</Pill>,
    },
    {
      key: 'tags',
      group: 'Identity',
      label: 'Tags',
      width: 150,
      // Not sortable: a row can hold several tags, so there is no single value to order by.
      render: (row) => {
        const tags = row.tags ?? []
        if (tags.length === 0) return null
        // ONE tag gets its name; SEVERAL are glyphs alone — a row of glyphs identifies at 12px
        // where a clipped word cannot, and the tooltip names every one of them.
        const solo = tags.length === 1 ? tags[0] : null
        const glyphs = solo ? [] : tags.slice(0, 6)
        const spare = solo ? 0 : tags.length - glyphs.length
        return (
          <InfoTip tip={tags.map((t) => t.name).join(' · ')}>
            <span className={styles.tagCell}>
              {solo && (
                <span className={styles.tagChip}>
                  <TagGlyph icon={solo.icon} color={solo.color} size={12} />
                  <span className={styles.tagChipName}>{solo.name}</span>
                </span>
              )}
              {glyphs.map((t) => (
                <span key={t.id} className={styles.tagGlyphChip}>
                  <TagGlyph icon={t.icon} color={t.color} size={12} />
                </span>
              ))}
              {spare > 0 && <span className={styles.tagMore}>+{spare}</span>}
            </span>
          </InfoTip>
        )
      },
    },
    {
      key: 'available',
      aggregate: ['sum', 'avg', 'min', 'max'],
      group: 'Inventory',
      label: 'Available',
      width: 120,
      sortable: true,
      render: (row) => <InventoryCell row={row} onOpen={onOpenInventory} />,
    },
    {
      key: 'sales',
      aggregate: ['sum', 'avg', 'min', 'max'],
      group: 'Commerce',
      label: `Sales (${SALES_WINDOW_DAYS}d)`,
      prefsLabel: 'Sales',
      width: 110,
      numeric: true,
      sortable: true,
      render: (row) => {
        const sales = row.sales
        // Three distinct states, rendered as three distinct things. `undefined`/null means the
        // list was not asked for sales; zero means it was asked and the answer is none.
        if (!sales) return null
        if (sales.revenueCents === 0) return <span className={styles.noSales} title={`No sales in the last ${sales.days} days`}>—</span>
        return eur0(sales.revenueCents)
      },
    },
    {
      key: 'units',
      aggregate: ['sum', 'avg', 'min', 'max'],
      group: 'Commerce',
      label: `Units (${SALES_WINDOW_DAYS}d)`,
      prefsLabel: 'Units',
      width: 92,
      numeric: true,
      sortable: true,
      render: (row) => {
        const sales = row.sales
        if (!sales) return null
        if (sales.units === 0) return <span className={styles.noSales} title={`No units sold in the last ${sales.days} days`}>—</span>
        return num(sales.units)
      },
    },
    {
      key: 'price',
      aggregate: ['avg', 'min', 'max', 'sum'],
      group: 'Commerce',
      label: 'Price',
      width: 96,
      numeric: true,
      sortable: true,
      render: (row) => fmtEur(row.basePrice),
    },
    {
      key: 'updated',
      group: 'Meta',
      label: 'Last updated',
      // 118 truncated the header to "Last upd…" under AG's header font.
      width: 132,
      sortable: true,
      render: (row) => <span className={styles.updatedCell}>{formatDate(row.updatedAt)}</span>,
    },
  ]

  return [productCol, ...movable, brandCol, productTypeCol, actionsCol]
}

export const columnLabel = (c: PageColumn): string => c.prefsLabel ?? (typeof c.label === 'string' ? c.label : c.key)

/**
 * The page's columns projected onto AG's `ColDef` — every column but Product, which is the tree's
 * auto-group column and is defined by the page. This says which column is which, whether the
 * SERVER can sort it, which ones are padlocked, and which filter each carries.
 */
export function projectColDefs(
  columns: readonly PageColumn[],
  opts: { lockedColumns: readonly string[]; filterDefFor: (key: string) => Partial<ColDef<ProductRow>> },
): ColDef<ProductRow>[] {
  const locked = (key: string) => opts.lockedColumns.includes(key)
  return columns
    .filter((c) => c.key !== 'product')
    .map((c) => ({
      colId: c.key,
      headerName: columnLabel(c),
      width: c.width,
      // Sorting is the server's under SSRM; it owns which columns it can order by and reports one
      // it cannot in `unsupported`, so nothing is quietly ignored.
      sortable: !!c.sortable,
      // A padlocked column is neither draggable in the header nor hideable — the dialog's words,
      // now the grid's behaviour. The actions column additionally holds the right edge while it is
      // locked, so nothing can be dragged past it; unlock it and it is an ordinary column.
      lockPosition: c.key === 'actions' && locked('actions') ? ('right' as const) : undefined,
      lockVisible: locked(c.key),
      suppressMovable: locked(c.key),
      hide: c.defaultHidden || undefined,
      // The field AG reads a group key or an aggregate from; the server puts them there.
      field: (GROUP_FIELD[c.key] ?? c.key) as ColDef<ProductRow>['field'],
      enableRowGroup: !!c.groupable,
      enableValue: !!c.aggregate,
      allowedAggFuncs: c.aggregate ? [...c.aggregate] : undefined,
      cellRenderer: (p: ICellRendererParams<ProductRow>) =>
        !p.data ? null : isGroupRow(p.data) ? renderGroupValue(c, p.data) : c.render(p.data),
      ...(c.numeric ? numericColumn : {}),
      ...opts.filterDefFor(c.key),
    }))
}
