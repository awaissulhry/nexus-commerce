// OX.4 — column registry overhauled to mirror Amazon Seller Central's
// row layout. The Amazon-parity cells are:
//
//   orderDate     · relative + absolute + time
//   orderDetails  · Order ID + Buyer + Fulfilment method + Sales channel
//   image         · Product thumbnail
//   productName   · Title + ASIN + SKU + Qty + Item subtotal
//   orderType     · Standard/Prime/Business badge + Ship-by + Deliver-by
//   status        · Status badge + secondary line
//   actions       · Manage invoice · Print packing slip · Refund + More
//
// Legacy keys (channel, orderId, customer, items, total, fulfillment,
// returnRefund, review, repeat, tags) are kept available as optional
// columns so operators with saved column preferences don't lose
// anything — but the default view is the Amazon-parity set.
//
// Locked columns can't be hidden from the picker; label="" is treated
// as no-display (the column-picker filters them out). Width values
// feed inline style + the thead+tbody min-width so the table doesn't
// reflow on toggle.

export type OrderColumn = {
  key: string
  label: string
  width: number
  locked?: boolean
}

export const ALL_COLUMNS: OrderColumn[] = [
  { key: 'select', label: '', width: 32, locked: true },
  // Amazon-parity cells (default visible)
  { key: 'orderDate', label: 'Order date', width: 130 },
  { key: 'orderDetails', label: 'Order details', width: 240, locked: true },
  { key: 'image', label: 'Image', width: 60 },
  { key: 'productName', label: 'Product name', width: 320 },
  { key: 'orderType', label: 'Order type', width: 180 },
  { key: 'status', label: 'Order status', width: 130 },
  // OX.4 follow-up: vertically-stacked action buttons + sticky right
  // edge → matches Amazon Seller Central's right-pinned action column.
  { key: 'actions', label: 'Action', width: 170, locked: true },
  // Legacy / optional cells (off by default; opt-in via column picker)
  { key: 'channel', label: 'Channel', width: 100 },
  { key: 'orderId', label: 'Order ID (raw)', width: 160 },
  { key: 'date', label: 'Date (legacy)', width: 110 },
  { key: 'customer', label: 'Customer (legacy)', width: 200 },
  { key: 'items', label: 'Items', width: 70 },
  { key: 'total', label: 'Total', width: 110 },
  { key: 'fulfillment', label: 'FBA/FBM', width: 80 },
  { key: 'returnRefund', label: 'R/R', width: 80 },
  { key: 'review', label: 'Review', width: 100 },
  { key: 'repeat', label: 'Repeat', width: 70 },
  { key: 'tags', label: 'Tags', width: 140 },
]

export const DEFAULT_VISIBLE = [
  'select',
  'orderDate',
  'orderDetails',
  'image',
  'productName',
  'orderType',
  'status',
  'actions',
]
