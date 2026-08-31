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
import type { CoverageChannel, MenuItemDef } from '@/design-system/components'
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
  /**
   * The CSV value, when the cell's own value is not a scalar.
   *
   * A column drawn by a renderer either carries no `value` at all (Product: the cell IS the
   * renderer) or carries a shape the renderer understands (Channels: `CoverageChannel[]`, Tags:
   * a tag array). Neither has an honest CSV form, and `csvField` writes an object as empty rather
   * than inventing "[object Object]" — measured 2026-08-31: Product, Channels and Tags all
   * exported blank. This is where such a column says what it means in a file.
   */
  exportValue?: (row: ProductRow) => string | number | null
}

export const isGroupRow = (d: unknown): d is ProductGroupRow =>
  !!d && typeof d === 'object' && (d as { __group?: boolean }).__group === true

/** The server's aggregate field per column — the `valueCols` AG sends under a grouping. */
const GROUP_FIELD: Record<string, string> = { available: 'totalStock', price: 'basePrice', sales: 'sales.revenueCents', units: 'sales.units' }

/**
 * A column's value for a DATA row — the one definition the grid's `valueGetter` and the CSV export
 * both read. Exported because a second implementation is how an export starts disagreeing with the
 * screen: coverage roll-ups, channel states and variation counts live in `c.value`, and nothing
 * else can re-derive them without becoming a copy that drifts.
 */
export const pageColumnField = (c: PageColumn): string => (c.preset?.field as string | undefined) ?? GROUP_FIELD[c.key] ?? c.key

export const readField = (field: string, row: unknown): unknown =>
  field.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), row)

export const pageColumnValue = (c: PageColumn, row: ProductRow): unknown =>
  c.value ? c.value(row) : readField(pageColumnField(c), row)

/** What the CSV writes: a column's own `exportValue` when it has one, else what the grid shows. */
export const pageColumnExportValue = (c: PageColumn, row: ProductRow): unknown =>
  c.exportValue ? c.exportValue(row) : pageColumnValue(c, row)

/** Channels, as the cell reads it — the same counts `CoverageSummary` draws, in the same order. */
export function coverageText(channels: readonly CoverageChannel[]): string {
  const count = (s: CoverageChannel['state']) => channels.filter((c) => c.state === s).length
  const parts: string[] = []
  const live = count('live')
  const issues = count('issues')
  const draft = count('draft')
  if (live > 0) parts.push(`${live} live`)
  if (issues > 0) parts.push(`${issues} ${issues === 1 ? 'issue' : 'issues'}`)
  if (draft > 0) parts.push(`${draft} draft`)
  return parts.length ? parts.join(' \u00b7 ') : 'Not listed'
}

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

/**
 * What you can do to one product — the ONE list.
 *
 * The `⋯` column and the right-click context menu offer the same actions, so they read the same
 * list rather than each declaring its own. Two menus that agree today and drift tomorrow is the
 * shape of defect this file has already been bitten by: `MultiSelect` and `GridSetFilter` shared a
 * stylesheet and diverged in behaviour, and no guard could see it.
 *
 * Labels are plain strings on purpose. AG's context menu takes `name: string`, so a ReactNode label
 * would render as nothing there while looking correct in the DS menu.
 */
export function rowActions(row: ProductRow, deps: Pick<ColumnDeps, 'onDuplicate' | 'navigate'>): MenuItemDef[] {
  return [
    { id: 'edit', label: 'Edit', onSelect: () => deps.navigate(editHref(row)) },
    { id: 'duplicate', label: 'Duplicate', onSelect: () => deps.onDuplicate(row.id) },
    { id: 'open-new', label: 'Open in new tab', onSelect: () => window.open(editHref(row), '_blank') },
  ]
}

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
    exportValue: (row) => row.name,
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
      items: (row) => rowActions(row, { onDuplicate, navigate }),
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
      exportValue: (row) => coverageText(channelsOf(row, activeChannels)),
      preset: { cellClass: 'nds-ag-cell', cellRenderer: CoverageCell },
    },
    { key: 'status', groupable: true, group: 'Identity', label: 'Status', width: 96, sortable: true, preset: statusColumn('status', { tones: STATUS_TONES }) },
    { key: 'tags', group: 'Identity', label: 'Tags', width: 150, value: (row) => row.tags ?? [], exportValue: (row) => (row.tags ?? []).map((t) => t.name).join(', '), preset: { cellClass: 'nds-ag-cell', cellRenderer: TagsCell } },
    {
      key: 'available',
      aggregate: ['sum', 'avg', 'min', 'max'],
      group: 'Inventory',
      label: 'Available',
      width: 120,
      sortable: true,
      groupValue: (g) => g.totalStock ?? null,
      /**
       * Mirror the CELL, which is the only thing the operator saw: FBA + FBM when the row carries a
       * split, else the units total.
       *
       * `totalStock` is the same number now — the API row carries the stock-level roll-up (self plus
       * EVERY variation, not the ten previewed) rather than the stale `Product.totalStock` column,
       * which read 0 on prod rows holding 105 and 16 FBM units. This still mirrors the cell rather
       * than reading the field, because the cell is what the file promises to reproduce.
       */
      exportValue: (row) =>
        row.fbaStock != null || row.fbmStock != null ? (row.fbaStock ?? 0) + (row.fbmStock ?? 0) : row.totalStock,
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
      // CENTS on the wire, euros on screen (`moneyColumn`). Without this the file says 15900 where
      // the grid says €159.00 — the unit trap this codebase has been bitten by before.
      exportValue: (row) => (row.sales?.revenueCents == null ? null : row.sales.revenueCents / 100),
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
      // Resolved once per column, not per cell: this runs inside a valueGetter on every render.
      const field = pageColumnField(c)
      const byField = (row: ProductRow): unknown => readField(field, row)
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
