/**
 * F-OS-101 (order SHIPMENTS tab, 10-design §2; 18-lead-settles L11) — one word of the tab's pure models (where.ts, rows.ts,
 * after-sales.ts, doors.ts): a catalogue key, its values, and the days, instants and inner words the view says in the page's
 * language (the models never format). The tab's own words are `order-shipments` (L11: a namespace of its own, not orders.json's end);
 * Warehouse's words are REUSED from their own catalogues, never a second word for one thing.
 */

/** The catalogues a word comes from: the tab's own (default), the order page's, and Warehouse's (shipments, its depth, deliveries). */
export type WordNs = 'os' | 'orders' | 'shipments' | 'depth' | 'dv' | 'complaints'

export interface ShipWord {
  /** Absent: the tab's own catalogue (`order-shipments`). */
  readonly ns?: WordNs
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
  /** A day (YYYY-MM-DD) said as a day. */
  readonly days?: Readonly<Record<string, string>>
  /** An instant (ISO) said as its day. */
  readonly instants?: Readonly<Record<string, string>>
  /** A value that is itself a word ("{garments} on {shipments}"). */
  readonly words?: Readonly<Record<string, ShipWord>>
}

/** The catalogue file of each source. */
export const NAMESPACE_OF: Readonly<Record<WordNs, string>> = Object.freeze({
  os: 'order-shipments',
  orders: 'orders',
  shipments: 'shipments',
  depth: 'warehouse-shipments-depth',
  dv: 'shipping-delivery',
  complaints: 'complaints',
})

/** The catalogues the tab brings beside the page's own (the page loads `orders` and `order-shipments`, RECORD_NAMESPACES). */
export const SHIPMENTS_TAB_NS = ['order-shipments', 'shipments', 'warehouse-shipments-depth', 'shipping-delivery', 'complaints'] as const

/** A word of the tab's own catalogue. */
export const word = (key: string, params?: Readonly<Record<string, string | number>>, more: Omit<ShipWord, 'key' | 'params' | 'ns'> = {}): ShipWord => ({ key, ...(params ? { params } : {}), ...more })

/** A word of another catalogue (the order page's, Warehouse's). */
export const wordOf = (ns: WordNs, key: string, params?: Readonly<Record<string, string | number>>, more: Omit<ShipWord, 'key' | 'params' | 'ns'> = {}): ShipWord => ({ ns, key, ...(params ? { params } : {}), ...more })
