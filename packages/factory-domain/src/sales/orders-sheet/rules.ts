import type { SalesOrderStatus } from '../orders/orders'
import type { RequestStatus } from '../portal-ordering/rules'

/**
 * owb-of1 (order workflow, plan.md § 5b "the orders sheet", § 5c "no loophole"; design prototype sheet.js sheetRows, newsChips,
 * office.js O_FILTERS, officeKpis): the office's ONE orders sheet lists the Draft and Sent orders (PortalOrderRequest) beside the
 * confirmed ones (SalesOrder). These are its pure rules: which records each filter keeps, how a line says its sizes and its
 * material, the line kind it shows, and the customer's open asks per line and column. No price, ever (the design: prices are
 * Finance's page). The API's `GET /sales/orders/sheet` (apps/factory-api modules/sales/orders/sheet.ts) reads the rows.
 */

/** The sheet's filters (the design's O_FILTERS, + withdrawn on ask). `all` keeps every order but drafts and withdrawn ones. */
export const SHEET_LIVES = ['all', 'drafts', 'incoming', 'confirmed', 'production', 'ready', 'shipped', 'delivered', 'withdrawn'] as const
export type SheetLife = (typeof SHEET_LIVES)[number]

/**
 * What each filter keeps of the two records, by their status codes. `shipped` and `delivered` split SHIPPED and CLOSED orders by
 * their shipments (`split`): delivered once every shipment that left was delivered (factory-domain portal-orders customerStatusOf)
 * and none waits at our warehouse; the API writes that split in SQL.
 */
export interface SheetLifeKeeps {
  readonly requests: readonly RequestStatus[]
  readonly orders: readonly SalesOrderStatus[]
  /** SHIPPED and CLOSED orders kept only while not delivered (`shipped`), or only once delivered (`delivered`). */
  readonly split: 'NOT_DELIVERED' | 'DELIVERED' | null
}

const NOT_WITHDRAWN: readonly SalesOrderStatus[] = ['PENDING_APPROVAL', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED', 'CLOSED', 'DELIVERED']

export const SHEET_LIFE_KEEPS: Readonly<Record<SheetLife, SheetLifeKeeps>> = Object.freeze({
  all: { requests: ['SENT'], orders: NOT_WITHDRAWN, split: null },
  drafts: { requests: ['DRAFT'], orders: [], split: null },
  // Incoming = the life word SENT: a Sent request, and an order that waits for the office's yes (orderLifeOf WAITS_FOR_APPROVAL).
  incoming: { requests: ['SENT'], orders: ['PENDING_APPROVAL'], split: null },
  confirmed: { requests: [], orders: ['CONFIRMED'], split: null },
  production: { requests: [], orders: ['IN_PRODUCTION'], split: null },
  ready: { requests: [], orders: ['READY'], split: null },
  shipped: { requests: [], orders: ['PARTLY_SHIPPED', 'SHIPPED', 'CLOSED'], split: 'NOT_DELIVERED' },
  delivered: { requests: [], orders: ['DELIVERED', 'SHIPPED', 'CLOSED'], split: 'DELIVERED' },
  withdrawn: { requests: ['WITHDRAWN', 'REFUSED'], orders: ['CANCELLED'], split: null },
})

/** The line kinds the sheet shows: a catalogue product, a product described in words, a made-to-measure piece. */
export const SHEET_LINE_KINDS = ['CATALOGUE', 'DESCRIBED', 'CUSTOM'] as const
export type SheetLineKind = (typeof SHEET_LINE_KINDS)[number]

/** A request line's kind (CATALOGUE · DESCRIBED · MADE_TO_MEASURE) or an order line's (SIZE_GRID · MADE_TO_MEASURE; FEE is no product). */
export function sheetLineKindOf(kind: string): SheetLineKind | null {
  switch (kind) {
    case 'CATALOGUE':
    case 'SIZE_GRID':
      return 'CATALOGUE'
    case 'DESCRIBED':
      return 'DESCRIBED'
    case 'MADE_TO_MEASURE':
      return 'CUSTOM'
    default:
      return null
  }
}

/** The sizes of a line in the sheet's few words — "48×2 · 50×1" in the stored order; none: null (a total or people say pieces). */
export function sizesWords(sizes: readonly { readonly size: string; readonly quantity: number }[]): string | null {
  const shown = sizes.filter((entry) => entry.quantity > 0)
  return shown.length === 0 ? null : shown.map((entry) => `${entry.size}×${entry.quantity}`).join(' · ')
}

/** A line's material in words: its colour (ours by name, else the customer's words), then each picked choice "Topic: picked". */
export function materialWords(colour: string | null, choices: readonly { readonly topic: string; readonly picked: string | null }[] | null): string | null {
  const parts = [...(colour && colour.trim() !== '' ? [colour.trim()] : []), ...(choices ?? []).flatMap((choice) => (choice.picked ? [`${choice.topic}: ${choice.picked}`] : []))]
  return parts.length === 0 ? null : parts.join(' · ')
}

// ---- the customer's open asks, per line and column (§ 5c: the official value stays; the asked one shows beside it) ----------

export const SHEET_ASK_COLUMNS = ['product', 'material', 'sizes', 'pieces', 'cancel'] as const
export type SheetAskColumn = (typeof SHEET_ASK_COLUMNS)[number]

export interface SheetAsk {
  readonly requestId: string
  readonly column: SheetAskColumn
  readonly from: string
  readonly to: string
}

/** An order line as the asks compare it: its product code, its colour by name, its pieces and sizes. */
export interface AskedLine {
  readonly id: string
  readonly styleId: string
  readonly styleCode: string
  readonly colourwayId: string
  readonly colourName: string
  readonly pieces: number
}

/** An OPEN change request of the order (CHANGE or CANCEL), with its lines and the names of what they ask. */
export interface OpenChange {
  readonly id: string
  readonly kind: 'CHANGE' | 'CANCEL'
  readonly lines: readonly {
    readonly orderLineId: string
    readonly size: string | null
    readonly quantityBefore: number
    readonly quantity: number
    readonly styleId: string | null
    readonly styleCode: string | null
    readonly colourwayId: string | null
    readonly colourName: string | null
  }[]
}

/**
 * Each line's open asks: a CANCEL asks "cancel" on the lines it names (none named: every line), from its pieces to 0; a CHANGE
 * asks the product when it names another style, the material when another colour, the sizes per size whose pieces move, the
 * pieces when no size is named. Oldest change first, as given.
 */
export function asksOfLines(lines: readonly AskedLine[], changes: readonly OpenChange[]): Map<string, SheetAsk[]> {
  const out = new Map<string, SheetAsk[]>(lines.map((line) => [line.id, []]))
  const lineOf = new Map(lines.map((line) => [line.id, line]))
  const add = (lineId: string, ask: SheetAsk): void => {
    const list = out.get(lineId)
    if (list && !list.some((entry) => entry.requestId === ask.requestId && entry.column === ask.column && entry.from === ask.from && entry.to === ask.to)) list.push(ask)
  }
  for (const change of changes) {
    if (change.kind === 'CANCEL') {
      const named = change.lines.length > 0 ? [...new Set(change.lines.map((entry) => entry.orderLineId))] : lines.map((line) => line.id)
      for (const lineId of named) {
        const line = lineOf.get(lineId)
        if (line) add(lineId, { requestId: change.id, column: 'cancel', from: String(line.pieces), to: '0' })
      }
      continue
    }
    for (const entry of change.lines) {
      const line = lineOf.get(entry.orderLineId)
      if (!line) continue
      if (entry.styleId !== null && entry.styleId !== line.styleId) add(line.id, { requestId: change.id, column: 'product', from: line.styleCode, to: entry.styleCode ?? '' })
      if (entry.colourwayId !== null && entry.colourwayId !== line.colourwayId) add(line.id, { requestId: change.id, column: 'material', from: line.colourName, to: entry.colourName ?? '' })
      if (entry.quantity !== entry.quantityBefore) {
        if (entry.size !== null) add(line.id, { requestId: change.id, column: 'sizes', from: `${entry.size}×${entry.quantityBefore}`, to: `${entry.size}×${entry.quantity}` })
        else add(line.id, { requestId: change.id, column: 'pieces', from: String(entry.quantityBefore), to: String(entry.quantity) })
      }
    }
  }
  return out
}

/** The sheet's cursor: newest change first across both records (the change time, then the id, both descending). */
export interface SheetCursor {
  /** The row's change time, in milliseconds (the columns keep milliseconds). */
  readonly at: number
  readonly id: string
}

/** The cursor of a page's last row, as the log's (factory-domain sales/order-log encodeLogCursor): `<ms>_<id>`. */
export const encodeSheetCursor = (cursor: SheetCursor): string => `${cursor.at}_${cursor.id}`

/** The cursor read back, or null when it is not one of ours. */
export function decodeSheetCursor(text: string | null | undefined): SheetCursor | null {
  const match = /^(\d{1,15})_([0-9a-f-]{36})$/i.exec(text ?? '')
  if (!match) return null
  const at = Number(match[1])
  return Number.isFinite(at) ? { at, id: match[2]!.toLowerCase() } : null
}

/** Two rows in the sheet's order: the newer change first, then the greater id. */
export const sheetOrder = (a: SheetCursor, b: SheetCursor): number => (a.at === b.at ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : b.at - a.at)
