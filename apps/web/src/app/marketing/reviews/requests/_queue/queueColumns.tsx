'use client'

/**
 * Reviews › Requests › Queue — the grid's columns. Order · Channel · Product · Next try / sent · Status · Reason show;
 * Delivered, Tries and Rule are in Customise (board). Every cell is words: the reason never shows a provider code, the
 * buyer is a first name and initial. The server sorts (Next try, Delivered, Tries, Status): AG keeps the server's
 * order (`comparator` 0) and the page reads the header click (`onSortChanged`).
 */
import { memo } from 'react'
import { IdentityCell, integerColumn, statusColumn, type ColDef, type ICellRendererParams } from '@/design-system/grid'
import Link from '@/lib/workspaces/Link'
import { channelMarketWords, productTypeWords } from '../../_lib/reviewWords'
import { rulePath } from '../requestsPaths'
import type { GridColumnSpec } from '../gridCustomise'
import type { QueueRow } from './queueDatasource'
import { STATUS_TONES, STATUS_WORDS } from './queueTiles'

/** "Thu 29 Oct 10:00" in the viewer's own clock. */
export function gridDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}`
}

const gridDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '')

type Cell = ICellRendererParams<QueueRow>

const OrderCell = memo(function OrderCell({ data }: Cell) {
  if (!data) return null
  return <IdentityCell noImage title={data.orderLabel} titleAttr={data.orderLabel} sub={<span>{data.buyer}</span>} />
})

const ProductCell = memo(function ProductCell({ data }: Cell) {
  if (!data) return null
  // One kind of label per row: the SKU, the product's name on hover (live audit D02); the product type in words (D01).
  const label = data.sku ?? data.product
  return <IdentityCell noImage title={label ?? 'No product on the order'} titleAttr={data.product ?? undefined} sub={data.productType ? <span>{productTypeWords(data.productType)}</span> : undefined} />
})

const NextCell = memo(function NextCell({ data }: Cell) {
  if (!data) return null
  const at = data.sentAt ?? data.nextTryAt
  const title = data.sentAt ? `Sent ${gridDateTime(data.sentAt)}` : at ? gridDateTime(at) : data.status === 'DUE' ? 'Next run' : '—'
  return <IdentityCell noImage title={title} sub={<span>{data.dayWords}</span>} />
})

const DeliveredCell = memo(function DeliveredCell({ data }: Cell) {
  if (!data) return null
  if (!data.deliveredAt) return <span>Not delivered yet</span>
  return <IdentityCell noImage title={gridDate(data.deliveredAt)} sub={data.deliveredEstimate ? <span>estimate</span> : undefined} />
})

const ReasonCell = memo(function ReasonCell({ data }: Cell) {
  if (!data) return null
  return <span title={data.reasonWords}>{data.reasonWords}</span>
})

const RuleCell = memo(function RuleCell({ data }: Cell) {
  if (!data) return null
  if (!data.ruleId) return <span>No rule (default timing)</span>
  return (
    <Link href={rulePath(data.ruleId)} onClick={(e) => e.stopPropagation()} title={`Open the rule “${data.ruleName ?? ''}”`}>
      {data.ruleName ?? 'Open the rule'}
    </Link>
  )
})

const serverOrder = () => 0

export const QUEUE_COLUMN_SPECS: readonly GridColumnSpec[] = [
  { key: 'order', label: 'Order', locked: true },
  { key: 'channel', label: 'Channel' },
  { key: 'product', label: 'Product' },
  { key: 'delivered', label: 'Delivered', hidden: true },
  { key: 'next', label: 'Next try / sent' },
  { key: 'status', label: 'Status' },
  { key: 'tries', label: 'Tries', hidden: true },
  { key: 'reason', label: 'Reason' },
  { key: 'rule', label: 'Rule', hidden: true },
]

const hidden = (key: string) => QUEUE_COLUMN_SPECS.find((c) => c.key === key)?.hidden === true

/** The columns, built once (no row data in them). */
export function queueColumns(): ColDef<QueueRow>[] {
  return [
    { colId: 'order', headerName: 'Order', field: 'orderLabel', cellRenderer: OrderCell, minWidth: 180, flex: 1.2, sortable: false, lockPosition: 'left' },
    { colId: 'channel', headerName: 'Channel', valueGetter: (p) => (p.data ? channelMarketWords(p.data.channel, p.data.market) : ''), minWidth: 140, flex: 0.9, sortable: false },
    { colId: 'product', headerName: 'Product', field: 'product', cellRenderer: ProductCell, minWidth: 200, flex: 1.5, sortable: false },
    { colId: 'delivered', headerName: 'Delivered', field: 'deliveredAt', cellRenderer: DeliveredCell, minWidth: 130, comparator: serverOrder, hide: hidden('delivered') },
    { colId: 'next', headerName: 'Next try / sent', valueGetter: (p) => p.data?.sentAt ?? p.data?.nextTryAt ?? null, cellRenderer: NextCell, minWidth: 170, flex: 1, comparator: serverOrder },
    {
      colId: 'status',
      headerName: 'Status',
      ...statusColumn<QueueRow>('status', { tones: Object.fromEntries(Object.entries(STATUS_WORDS).map(([k, label]) => [k, { tone: STATUS_TONES[k as keyof typeof STATUS_TONES], label }])) }),
      minWidth: 120,
      // Not sortable (audit A14): the cell shows a derived status ("Due now", "Retrying", "Blocked") the server cannot
      // sort by, so a sort by the stored status looked random. Filter by status with the tiles instead.
      sortable: false,
    },
    { colId: 'tries', headerName: 'Tries', ...integerColumn<QueueRow>('tries'), minWidth: 90, comparator: serverOrder, hide: hidden('tries') },
    { colId: 'reason', headerName: 'Reason', field: 'reasonWords', cellRenderer: ReasonCell, minWidth: 220, flex: 1.6, sortable: false },
    { colId: 'rule', headerName: 'Rule', field: 'ruleName', cellRenderer: RuleCell, minWidth: 160, flex: 1, sortable: false, hide: hidden('rule') },
  ]
}
