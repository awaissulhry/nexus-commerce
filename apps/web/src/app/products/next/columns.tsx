'use client'

/**
 * /products/next — the page's column registry, on the GDS cell library.
 *
 * The page owns its column IDS, labels, widths, groups and what each column's VALUE is (including
 * the aggregate a group row carries). The CELL — how a money, a date, a status, a tag list, an
 * actions cluster is drawn, and what a null looks like next to a measured zero — is the design
 * system's (`design-system/grid/renderers`, `columns/presets`). Two cells stay page-specific
 * because they are the page: the product identity cell (expander + family link) and the Available
 * cell (the button that opens the inventory editor).
 */
import type { ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'

import type { ProductRow } from '@/app/products/_types'
import { Tag, type Tone } from '@/design-system/primitives'
import type { CoverageChannel } from '@/design-system/components'
import {
  CoverageCell,
  ExpandButton,
  ExpandSlot,
  IdentityCell,
  NumericCell,
  SkuTag,
  TagsCell,
  actionsColumn,
  dateColumn,
  euroColumn,
  integerColumn,
  moneyColumn,
  statusColumn,
  textColumn,
  type ColDef,
  type ICellRendererParams,
} from '@/design-system/grid'
import { NULL_GROUP_KEY, type AggFunc, type ProductGroupRow } from './productsServerContract'
export type { ProductGroupRow }

import styles from './styles.module.css'
import { InventoryCell } from './InventoryCell'

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

const STATUS_TONES: Record<string, { tone: Tone; label: string }> = {
  ACTIVE: { tone: 'success', label: 'Active' },
  DRAFT: { tone: 'neutral', label: 'Draft' },
  INACTIVE: { tone: 'danger', label: 'Inactive' },
}

export interface PageColumn {
  key: string
  label: ReactNode
  prefsLabel?: string
  group?: string
  width?: number
  sortable?: boolean
  defaultHidden?: boolean
  groupable?: boolean
  aggregate?: readonly AggFunc[]
  /** The value AG sorts, aggregates and hands the cell (a data row). Default: the `field`. */
  value?: (row: ProductRow) => unknown
  /** The aggregate a GROUP row carries for this column. */
  groupValue?: (g: ProductGroupRow) => unknown
  /** The DS cell: a preset's renderer + alignment. */
  preset?: Partial<ColDef<ProductRow>>
  /** A page-specific DATA cell; group rows still go through `preset`/`groupValue`. */
  render?: (row: ProductRow) => ReactNode
}

export const isGroupRow = (d: unknown): d is ProductGroupRow =>
  !!d && typeof d === 'object' && (d as { __group?: boolean }).__group === true

/** The server's aggregate field per column — the `valueCols` AG sends under a grouping. */
const GROUP_FIELD: Record<string, string> = { available: 'totalStock', price: 'basePrice', sales: 'sales.revenueCents', units: 'sales.units' }

export function groupRowLabel(g: ProductGroupRow, columns: readonly PageColumn[]): string {
  const col = columns.find((c) => c.key === g.groupColId)
  if (g.groupKey === NULL_GROUP_KEY) return `No ${(col?.prefsLabel ?? g.groupColId).toLowerCase()}`
  if (g.groupColId === 'status') return STATUS_OPTS.find((o) => o.value === g.groupKey)?.label ?? g.groupKey
  return g.groupKey
}

function channelsOf(row: ProductRow, activeChannels: readonly string[]): CoverageChannel[] {
  return activeChannels.map((ch) => {
    const cov = row.coverage?.[ch as Channel] ?? null
    if (!cov || cov.total === 0) return { channel: ch, state: 'missing' as const, detail: 'not listed' }
    if (cov.error > 0) return { channel: ch, state: 'issues' as const, detail: `${cov.error} error${cov.error > 1 ? 's' : ''}` }
    if (cov.live > 0) return { channel: ch, state: 'live' as const, detail: `${cov.live} live` }
    if (cov.draft > 0) return { channel: ch, state: 'draft' as const, detail: `${cov.draft} draft` }
    return { channel: ch, state: 'missing' as const, detail: 'not listed' }
  })
}

export function variationCount(row: ProductRow): number {
  return row.childCount ?? 0
}

export const familyHref = (parentId: string) => `/products/next?parent=${encodeURIComponent(parentId)}`
const editHref = (row: ProductRow) => `/products/${row.id}/edit`

export interface ProductCellProps {
  row: ProductRow
  isChild?: boolean
  hasChildren?: boolean
  isExpanded?: boolean
  onExpand?: () => void
}

/** The identity cell: expander · photo · title (same-tab link, hover "Open" pill) · SKU · type · family link. */
export function ProductCell({ row, isChild, hasChildren, isExpanded, onExpand }: ProductCellProps) {
  const n = variationCount(row)
  return (
    <IdentityCell
      leading={
        hasChildren ? (
          <ExpandButton expanded={!!isExpanded} onToggle={() => onExpand?.()} labels={['Expand variations', 'Collapse variations']} />
        ) : (
          <ExpandSlot />
        )
      }
      image={row.imageUrl}
      photoCount={row.photoCount}
      title={row.name}
      titleAttr={row.name}
      href={editHref(row)}
      openPill
      sub={
        <>
          <SkuTag>{row.sku}</SkuTag>
          {row.productType && <Tag>{row.productType}</Tag>}
          {/* The count is the way to the family page — the same grid scoped to this family, paged
              and sorted like the catalogue. It opens in a new tab so the place in this list is kept. */}
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
        </>
      }
    />
  )
}

export interface ColumnDeps {
  activeChannels: readonly string[]
  onDuplicate: (id: string) => void
  onOpenInventory: (row: ProductRow) => void
  /** Same-tab navigation for the row menu's Edit. */
  navigate: (href: string) => void
}

export function buildPageColumns({ activeChannels, onDuplicate, onOpenInventory, navigate }: ColumnDeps): PageColumn[] {
  const productCol: PageColumn = {
    key: 'product',
    group: 'Identity',
    label: 'Product',
    sortable: true,
    render: (row) => <ProductCell row={row} isChild={row.parentId !== null} />,
  }
  const brandCol: PageColumn = { key: 'brand', group: 'Identity', label: 'Brand', width: 140, sortable: true, defaultHidden: true, groupable: true, preset: textColumn('brand') }
  const productTypeCol: PageColumn = { key: 'productType', group: 'Identity', label: 'Product type', width: 150, sortable: true, defaultHidden: true, groupable: true, preset: textColumn('productType') }
  const actionsCol: PageColumn = {
    key: 'actions',
    group: 'Meta',
    label: '',
    prefsLabel: 'Actions',
    width: 120,
    preset: actionsColumn<ProductRow>({
      primary: { label: 'Edit', href: editHref },
      items: (row) => [
        { id: 'edit', label: 'Edit', onSelect: () => navigate(editHref(row)) },
        { id: 'duplicate', label: 'Duplicate', onSelect: () => onDuplicate(row.id) },
        { id: 'open-new', label: 'Open in new tab', onSelect: () => window.open(editHref(row), '_blank') },
      ],
      menuLabel: (row) => `More actions for ${row.name}`,
    }),
  }
  const noSalesTitle = (data: unknown) => `No sales in the last ${(data as ProductRow | undefined)?.sales?.days ?? SALES_WINDOW_DAYS} days`
  const noUnitsTitle = (data: unknown) => `No units sold in the last ${(data as ProductRow | undefined)?.sales?.days ?? SALES_WINDOW_DAYS} days`
  const movable: PageColumn[] = [
    {
      key: 'channels',
      group: 'Identity',
      label: 'Channels',
      width: 130,
      value: (row) => channelsOf(row, activeChannels),
      preset: { cellClass: 'nds-ag-cell', cellRenderer: CoverageCell },
    },
    { key: 'status', groupable: true, group: 'Identity', label: 'Status', width: 96, sortable: true, preset: statusColumn('status', { tones: STATUS_TONES }) },
    { key: 'tags', group: 'Identity', label: 'Tags', width: 150, value: (row) => row.tags ?? [], preset: { cellClass: 'nds-ag-cell', cellRenderer: TagsCell } },
    {
      key: 'available',
      aggregate: ['sum', 'avg', 'min', 'max'],
      group: 'Inventory',
      label: 'Available',
      width: 120,
      sortable: true,
      groupValue: (g) => g.totalStock ?? null,
      preset: { cellClass: 'nds-ag-cell' },
      render: (row) => <InventoryCell row={row} onOpen={onOpenInventory} />,
    },
    {
      key: 'sales',
      aggregate: ['sum', 'avg', 'min', 'max'],
      group: 'Commerce',
      label: `Sales (${SALES_WINDOW_DAYS}d)`,
      prefsLabel: 'Sales',
      width: 110,
      sortable: true,
      value: (row) => row.sales?.revenueCents ?? null,
      groupValue: (g) => g.sales?.revenueCents ?? null,
      preset: moneyColumn<ProductRow>('sales.revenueCents', { zero: 'dash', zeroTitle: noSalesTitle }),
    },
    {
      key: 'units',
      aggregate: ['sum', 'avg', 'min', 'max'],
      group: 'Commerce',
      label: `Units (${SALES_WINDOW_DAYS}d)`,
      prefsLabel: 'Units',
      width: 92,
      sortable: true,
      value: (row) => row.sales?.units ?? null,
      groupValue: (g) => g.units ?? null,
      preset: integerColumn<ProductRow>('sales.units', { zero: 'dash', zeroTitle: noUnitsTitle }),
    },
    {
      key: 'price',
      aggregate: ['avg', 'min', 'max', 'sum'],
      group: 'Commerce',
      label: 'Price',
      width: 96,
      sortable: true,
      groupValue: (g) => g.basePrice ?? null,
      preset: euroColumn<ProductRow>('basePrice'),
    },
    { key: 'updated', group: 'Meta', label: 'Last updated', width: 132, sortable: true, preset: dateColumn<ProductRow>('updatedAt') },
  ]
  return [productCol, ...movable, brandCol, productTypeCol, actionsCol]
}

export const columnLabel = (c: PageColumn): string => c.prefsLabel ?? (typeof c.label === 'string' ? c.label : c.key)

/** A group row's aggregate, drawn as the column's number. */
function GroupAggregate(p: ICellRendererParams<ProductRow>) {
  return <NumericCell {...p} kind="integer" />
}

export function projectColDefs(
  columns: readonly PageColumn[],
  opts: { lockedColumns: readonly string[]; filterDefFor: (key: string) => Partial<ColDef<ProductRow>> },
): ColDef<ProductRow>[] {
  const locked = (key: string) => opts.lockedColumns.includes(key)
  return columns
    .filter((c) => c.key !== 'product')
    .map((c) => {
      const field = (c.preset?.field as string | undefined) ?? GROUP_FIELD[c.key] ?? c.key
      const byField = (row: ProductRow): unknown => field.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), row)
      const def: ColDef<ProductRow> = {
        ...c.preset,
        colId: c.key,
        headerName: columnLabel(c),
        width: c.width,
        sortable: !!c.sortable,
        // The operator's padlock, not the preset's: a locked end column cannot move or hide.
        lockPosition: c.key === 'actions' && locked('actions') ? ('right' as const) : undefined,
        lockVisible: locked(c.key),
        suppressMovable: locked(c.key),
        hide: c.defaultHidden || undefined,
        field: field as ColDef<ProductRow>['field'],
        enableRowGroup: !!c.groupable,
        enableValue: !!c.aggregate,
        allowedAggFuncs: c.aggregate ? [...c.aggregate] : undefined,
        valueGetter: (p) => (!p.data ? null : isGroupRow(p.data) ? (c.groupValue ? c.groupValue(p.data) : null) : c.value ? c.value(p.data) : byField(p.data)),
        ...opts.filterDefFor(c.key),
      }
      if (c.render) {
        const render = c.render
        def.cellRenderer = (p: ICellRendererParams<ProductRow>) => (!p.data ? null : isGroupRow(p.data) ? <GroupAggregate {...p} /> : render(p.data))
      }
      return def
    })
}
