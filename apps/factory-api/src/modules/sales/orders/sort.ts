/**
 * B-TH-057 (threads plan TH-4; SHEET-G15, feature SHEET.overall-F05 "Sort across all pages"): what Sales › Orders sorts by on
 * the server. The address term `sort` (so a saved view and its file keep it): `customer`, `brand`, `promise`, `daysLate`,
 * `ordered`; `-` in front: the other way round. None: newest first. The list's read is ./orders.ts listOrders.
 */
export const ORDER_SORT_KEYS = ['customer', 'brand', 'promise', 'daysLate', 'ordered'] as const
export type OrderSortKey = (typeof ORDER_SORT_KEYS)[number]
export const ORDER_SORTS = [...ORDER_SORT_KEYS, ...ORDER_SORT_KEYS.map((key) => `-${key}` as const)] as const
export type OrderSortTerm = (typeof ORDER_SORTS)[number]
export const isOrderSort = (value: unknown): value is OrderSortTerm => typeof value === 'string' && (ORDER_SORTS as readonly string[]).includes(value)
