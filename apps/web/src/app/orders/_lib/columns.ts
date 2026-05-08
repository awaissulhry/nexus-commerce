// O.8e — column registry shared by GridLens + ColumnPickerMenu.
// Extracted from OrdersWorkspace.tsx as part of the monolith
// decomposition. Locked columns can't be hidden from the picker;
// label="" is treated as no-display (the column-picker filters
// them out). Width values feed inline style + the
// thead+tbody min-width so the table doesn't reflow on toggle.

export type OrderColumn = {
  key: string
  label: string
  width: number
  locked?: boolean
}

export const ALL_COLUMNS: OrderColumn[] = [
  { key: 'select', label: '', width: 32, locked: true },
  { key: 'channel', label: 'Channel', width: 100, locked: true },
  { key: 'orderId', label: 'Order ID', width: 160, locked: true },
  { key: 'date', label: 'Date', width: 110 },
  { key: 'customer', label: 'Customer', width: 200 },
  { key: 'items', label: 'Items', width: 70 },
  { key: 'total', label: 'Total', width: 110 },
  { key: 'status', label: 'Status', width: 110 },
  { key: 'fulfillment', label: 'FBA/FBM', width: 80 },
  { key: 'returnRefund', label: 'R/R', width: 80 },
  { key: 'review', label: 'Review', width: 100 },
  { key: 'repeat', label: 'Repeat', width: 70 },
  { key: 'tags', label: 'Tags', width: 140 },
  { key: 'actions', label: '', width: 90, locked: true },
]

export const DEFAULT_VISIBLE = [
  'select',
  'channel',
  'orderId',
  'date',
  'customer',
  'items',
  'total',
  'status',
  'fulfillment',
  'returnRefund',
  'review',
  'actions',
]
