'use client'

/**
 * Reviews › Insights › Products — the grid's rows and columns (the Products board): families with their sizes and
 * colours as a tree (the chevron, or → / ←, opens a family), then Rating · Reviews · Change · Top complaint · Return
 * rate · 6 weeks (+ Open alert in Customise). A product's name opens its pop-up over the page (a plain click; a ⌘-click
 * opens the same pop-up in a new tab through `?product=`). Rating, Reviews, Change and Return rate sort on the server
 * (a header click is the API's `sort`): the grid keeps the API's order. Every word comes from the API or the models.
 */
import { memo, type MouseEvent } from 'react'
import { Sparkline, StarRating } from '@/design-system/components'
import {
  ExpandButton,
  ExpandSlot,
  IdentityCell,
  SkuTag,
  useExpanded,
  type ColDef,
  type ICellRendererParams,
} from '@/design-system/grid'
import { Pill, Tag } from '@/design-system/primitives'
import Link from '@/lib/workspaces/Link'
import type { GridColumnSpec } from '../../requests/gridCustomise'
import shared from '../_shared/insights.module.css'

// ── The API's rows ──────────────────────────────────────────────────

export interface ReturnRateCell {
  rate: number | null
  returns: number
  orders: number
}

export interface ProductMetrics {
  productId: string
  name: string
  sku: string
  variant: string | null
  rating: number | null
  ratingWords: string
  count: number
  change: number | null
  spark: Array<number | null> | null
  tooFew: boolean
  topNegativeTheme: { key: string; label: string; count: number; from: 'reviews' | 'amazon_topic' } | null
  returnRate: ReturnRateCell | null
  openAlert: { count: number; id: string; theme: string; market: string } | null
}

export interface ProductFamilyRow extends ProductMetrics {
  familyId: string
  variants: ProductMetrics[]
}

export interface ProductsAnswer {
  scope: { channel: string | null; market: string | null; period: string }
  tiles: {
    productsWithReviews: number
    families: number
    below4: number
    dropped: number
    topReturnReason: { reason: string; share: number; returns: number; product: { id: string; name: string } | null } | null
  }
  families: ProductFamilyRow[]
  total: { families: number; products: number }
  /** The pop-up's walk (families and their variants): this page's start in it and its length. */
  nav?: { offset: number; total: number }
  page: number
  pageSize: number
  generatedAt: string
}

/** A grid row: a family (level 0) or one of its sizes and colours (level 1). */
export interface ProductGridRow extends ProductMetrics {
  rowId: string
  path: string[]
  level: 0 | 1
  familyId: string
  /** A family's sizes and colours on this page (0 for a variant, or a product on its own). */
  variantCount: number
}

/** The API's families as tree rows: each family, then its variants under it. */
export function gridRows(families: readonly ProductFamilyRow[]): ProductGridRow[] {
  const rows: ProductGridRow[] = []
  for (const f of families) {
    const { variants, familyId, ...metrics } = f
    rows.push({ ...metrics, rowId: `f:${familyId}`, path: [familyId], level: 0, familyId, variantCount: variants.length })
    for (const v of variants) rows.push({ ...v, rowId: `v:${v.productId}`, path: [familyId, v.productId], level: 1, familyId, variantCount: 0 })
  }
  return rows
}

/** What the cells ask of the page (AG `context`; the page keeps it current). */
export interface ProductsGridContext {
  /** Open a product's pop-up. */
  open: (productId: string) => void
  /** The address of a product's pop-up (for ⌘-click and a copied link). */
  hrefOf: (productId: string) => string
}

type Cell = ICellRendererParams<ProductGridRow, unknown, { current: ProductsGridContext }>

const signed = (n: number, digits = 1) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(digits)}`

/** "−0.3" coloured: a drop is bad news. */
export function changeText(change: number | null): { text: string; tone: 'good' | 'bad' | null } {
  if (change == null) return { text: '—', tone: null }
  if (change === 0) return { text: 'Same', tone: null }
  return { text: signed(change), tone: change < 0 ? 'bad' : 'good' }
}

/** "12%" with "4 of 33 orders"; no orders → "—". */
export function returnText(cell: ReturnRateCell | null): { text: string; sub: string | null } {
  if (!cell || cell.rate == null) return { text: '—', sub: cell && cell.orders === 0 ? 'no orders' : null }
  return { text: `${cell.rate % 1 === 0 ? cell.rate : cell.rate.toFixed(1)}%`, sub: `${cell.returns} of ${cell.orders} orders` }
}

/** "Average stars a week, last 6 weeks: 4.2, 4.1 …". */
export function sparkLabel(row: Pick<ProductMetrics, 'name' | 'spark'>): string {
  if (!row.spark) return `${row.name}: average rating, too few to trend`
  return `${row.name}, average stars a week over the last 6 weeks: ${row.spark.map((v) => (v == null ? 'none' : v.toFixed(1))).join(', ')}`
}

export const ProductTreeCell = memo(function ProductTreeCell(p: Cell) {
  // Before any early return: the order of hooks is the same on every render.
  const expanded = useExpanded(p.node)
  const data = p.data
  if (!data) return null
  const ctx = p.context.current
  const expandable = data.level === 0 && data.variantCount > 0
  const label = data.level === 1 && data.variant ? data.variant : data.name
  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    e.stopPropagation()
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    ctx.open(data.productId)
  }
  return (
    <IdentityCell
      noImage
      leading={expandable ? (
        <ExpandButton expanded={expanded} onToggle={() => p.node.setExpanded(!expanded)} labels={[`Show the sizes and colours of ${data.name}`, `Hide the sizes and colours of ${data.name}`]} />
      ) : data.level === 1 ? <><ExpandSlot /><ExpandSlot /></> : <ExpandSlot />}
      title={(
        <Link href={ctx.hrefOf(data.productId)} className="nds-cell-title-link" title={`Open ${label}: its reviews, themes and returns`} onClick={open}>
          {label}
        </Link>
      )}
      sub={(
        <>
          <SkuTag>{data.sku}</SkuTag>
          {expandable && <span className={shared.sub}>{data.variantCount} {data.variantCount === 1 ? 'size or colour' : 'sizes and colours'}</span>}
        </>
      )}
    />
  )
})

const RatingCell = memo(function RatingCell({ data }: Cell) {
  if (!data) return null
  if (data.rating == null) {
    return (
      <span className={shared.stack} title={data.ratingWords}>
        <span className={shared.main}>—</span>
        <span className={shared.sub}>{data.count > 0 ? 'too few to rate' : data.ratingWords}</span>
      </span>
    )
  }
  return (
    <span className={shared.line} title={data.ratingWords}>
      <b className={shared.num}>{data.rating.toFixed(1)}</b>
      <StarRating value={data.rating} size="sm" />
    </span>
  )
})

const ReviewsCell = memo(function ReviewsCell({ data }: Cell) {
  if (!data) return null
  return <span className={shared.num}>{data.count.toLocaleString('en-IE')}</span>
})

const ChangeCell = memo(function ChangeCell({ data }: Cell) {
  if (!data) return null
  const c = changeText(data.change)
  return <span className={`${shared.num} ${c.tone === 'bad' ? shared.bad : c.tone === 'good' ? shared.good : ''}`}>{c.text}</span>
})

const ComplaintCell = memo(function ComplaintCell({ data }: Cell) {
  if (!data) return null
  const t = data.topNegativeTheme
  if (!t) return <span className={shared.sub}>No complaints</span>
  return (
    <span title={`${t.count} negative ${t.from === 'amazon_topic' ? 'Amazon topic mentions' : t.count === 1 ? 'review' : 'reviews'}`}>
      <Tag tone="danger" truncate title={t.label}>{t.label}</Tag>
    </span>
  )
})

const ReturnCell = memo(function ReturnCell({ data }: Cell) {
  if (!data) return null
  const r = returnText(data.returnRate)
  return (
    <span className={shared.stack}>
      <span className={shared.num}>{r.text}</span>
      {r.sub && <span className={shared.sub}>{r.sub}</span>}
    </span>
  )
})

const SparkCell = memo(function SparkCell({ data }: Cell) {
  if (!data) return null
  return <Sparkline values={data.spark ?? []} label={sparkLabel(data)} emptyLabel="no changes yet" width={96} height={24} />
})

const AlertCell = memo(function AlertCell({ data }: Cell) {
  if (!data) return null
  if (!data.openAlert) return <span className={shared.sub}>None</span>
  const a = data.openAlert
  return <Pill tone="warning">{a.count === 1 ? `${a.theme} · ${a.market}` : `${a.count} open`}</Pill>
})

/** Keep the API's order: the server sorts (a header click asks it to). */
const KEEP_ORDER = () => 0

export const PRODUCT_COLUMN_SPECS: GridColumnSpec[] = [
  { key: 'product', label: 'Product', locked: true },
  { key: 'rating', label: 'Rating' },
  { key: 'reviews', label: 'Reviews' },
  { key: 'change', label: 'Change' },
  { key: 'complaint', label: 'Top complaint' },
  { key: 'returnRate', label: 'Return rate' },
  { key: 'spark', label: '6 weeks' },
  { key: 'alert', label: 'Open alert', hidden: true },
]

const SORTING = { sortable: true, comparator: KEEP_ORDER, sortingOrder: ['desc', 'asc'] as Array<'asc' | 'desc'> }

export const PRODUCT_TREE_COLUMN: ColDef<ProductGridRow> = {
  colId: 'product',
  headerName: 'Product',
  width: 300,
  minWidth: 240,
  pinned: 'left',
  lockPinned: true,
  lockPosition: 'left',
  lockVisible: true,
  suppressMovable: true,
  ...SORTING,
  sortingOrder: ['asc', 'desc'],
  cellClass: 'nds-ag-cell',
  valueGetter: (v) => v.data?.name ?? null,
  cellRenderer: ProductTreeCell,
}

export const PRODUCT_COLUMNS: ColDef<ProductGridRow>[] = [
  { colId: 'rating', headerName: 'Rating', width: 150, minWidth: 130, ...SORTING, sortingOrder: ['asc', 'desc'], cellRenderer: RatingCell, cellClass: 'nds-ag-cell', valueGetter: (v) => v.data?.rating ?? null },
  { colId: 'reviews', headerName: 'Reviews', width: 120, minWidth: 110, ...SORTING, cellRenderer: ReviewsCell, cellClass: 'nds-ag-cell', valueGetter: (v) => v.data?.count ?? null },
  { colId: 'change', headerName: 'Change', headerTooltip: 'Average stars against the period before.', width: 100, minWidth: 90, ...SORTING, cellRenderer: ChangeCell, cellClass: 'nds-ag-cell', valueGetter: (v) => v.data?.change ?? null },
  { colId: 'complaint', headerName: 'Top complaint', width: 160, minWidth: 130, sortable: false, cellRenderer: ComplaintCell, cellClass: 'nds-ag-cell' },
  { colId: 'returnRate', headerName: 'Return rate', headerTooltip: 'Returns with a reason, over orders, last 30 days.', width: 124, minWidth: 110, ...SORTING, cellRenderer: ReturnCell, cellClass: 'nds-ag-cell', valueGetter: (v) => v.data?.returnRate?.rate ?? null },
  { colId: 'spark', headerName: '6 weeks', headerTooltip: 'Average stars a week, last 6 weeks.', width: 124, minWidth: 110, sortable: false, cellRenderer: SparkCell, cellClass: 'nds-ag-cell' },
  { colId: 'alert', headerName: 'Open alert', width: 150, minWidth: 120, sortable: false, initialHide: true, cellRenderer: AlertCell, cellClass: 'nds-ag-cell' },
]
