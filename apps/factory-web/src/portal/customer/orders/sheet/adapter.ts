import type { OrderLife } from '@nexus/factory-domain/sales/order-life'
import type { OrderRow, OrdersRead, PortalCell, SheetLine, SheetWaitKind } from '../api'
import { lifeOf, pageOf, rowTitleOf, waitChipsOf, type RowPage, type WaitChip } from './model'
// owb-po7b: S2's ONE sheet part's fixed types (no index.ts: imported from its files), the base's status → life map, the own columns.
import type { OrdersSheetOrder, SheetChip, SheetColumnId } from '../../../../lib/orders-sheet/model'
import { lifeOfStatus, type OrderStatusCode } from '../../../../lib/order-cells/model'
import type { OwnColumn } from '../../../../lib/order-lines/schema'

/**
 * owb-po7.1 — the portal sheet read → the sheet's rows: ONE P row per order (an ORDER, a sent REQUEST or a DRAFT) and ONE C row per line
 * under it. The shape the ONE sheet part (S2's `lib/orders-sheet`, kind `portal`) is fed; until that part is on main the rows are this
 * page's own, and the mount maps them one to one. NEVER a price: no price, amount, net or currency key leaves here (the orders sheet has
 * no price column for anybody). The office-ticked portal columns (`values`) are kept on the P row, as the list and the Excel keep them.
 */

export type SheetRowKind = 'ORDER' | 'REQUEST' | 'DRAFT'

export interface SheetParentRow {
  readonly row: 'P'
  readonly key: string
  readonly id: string
  readonly kind: SheetRowKind
  readonly page: RowPage | null
  /** The subject, else the PO; null: the host says "No subject". */
  readonly subject: string | null
  /** The customer's own number ("Your order 12") once confirmed; never an office series. */
  readonly yourNumber: string | null
  /** The first line's model in words (Product). */
  readonly product: string | null
  readonly wanted: string | null
  readonly promised: string | null
  readonly life: OrderLife | null
  readonly waits: readonly WaitChip[]
  readonly pieces: number
  readonly ownColumnIds: readonly string[]
  /** The office-ticked portal columns' cells, by column id (kept as today). */
  readonly values: Readonly<Record<string, PortalCell>>
  readonly may: NonNullable<OrderRow['may']> | null
  readonly version: number | null
}

export interface SheetChildRow {
  readonly row: 'C'
  readonly key: string
  readonly parentId: string
  readonly lineId: string
  readonly seq: number
  readonly model: SheetLine['model']
  readonly material: string | null
  readonly sizes: string | null
  readonly pieces: number
  readonly ownValues: SheetLine['ownValues']
}

export type SheetRow = SheetParentRow | SheetChildRow

/** One order's P row and its C rows. */
export function sheetRowsOfOrder(order: OrderRow, locale: 'it' | 'en'): SheetRow[] {
  const lines = order.lines ?? []
  const first = lines[0]
  const parent: SheetParentRow = {
    row: 'P',
    key: `P:${order.id}`,
    id: order.id,
    kind: order.kind,
    page: pageOf(order),
    subject: rowTitleOf(order),
    yourNumber: order.yourNumber ? order.yourNumber.words[locale] : null,
    product: first ? first.model.words : null,
    wanted: order.requestedDate,
    promised: order.promiseDate,
    life: lifeOf(order),
    waits: waitChipsOf(order.waits),
    pieces: order.pieces.ordered,
    ownColumnIds: order.ownColumnIds ?? [],
    values: order.values ?? {},
    may: order.may ?? null,
    version: order.version ?? null,
  }
  const children: SheetChildRow[] = lines.map((line) => ({
    row: 'C',
    key: `C:${order.id}:${line.id}`,
    parentId: order.id,
    lineId: line.id,
    seq: line.seq,
    model: line.model,
    material: line.material,
    sizes: line.sizes,
    pieces: line.pieces,
    ownValues: line.ownValues,
  }))
  return [parent, ...children]
}

/** Every row of the read, in its order (the drafts where the read puts them; the host hides withdrawn rows behind their chip). */
export const sheetRowsOf = (read: Pick<OrdersRead, 'items'>, locale: 'it' | 'en'): SheetRow[] => read.items.flatMap((order) => sheetRowsOfOrder(order, locale))

// ---- owb-po7b (po7.1, the mount): the read → S2's ONE sheet part (`lib/orders-sheet`, kind `portal`) ------------------------------
// The part's types are FIXED (lib/orders-sheet/model.ts): an order (ORDER, or a Draft / Sent request) with its lines; no price field
// anywhere. Each "Waits · news" chip is a door the page resolves (`chat:` / `design:` / `open:` + the row's key). A draft's own lines are
// typed in place (DRAFT); every other row reads (the order page asks for a change after Confirm).

/** The portal sheet's columns, in the design's order (§ 5b): no Customer, no price column for anybody. */
export const PORTAL_SHEET_COLUMNS: readonly SheetColumnId[] = Object.freeze(['what', 'wanted', 'promised', 'where', 'news', 'material', 'sizes', 'pieces', 'details', 'act'])

/** The filter tabs and the server's chip each one reads (today's chips): All · In work · Shipped · Delivered. */
export const PORTAL_SHEET_FILTERS = ['ALL', 'OPEN', 'SHIPPED', 'DELIVERED'] as const
export type PortalSheetFilter = (typeof PORTAL_SHEET_FILTERS)[number]
export const isPortalSheetFilter = (value: string | null | undefined): value is PortalSheetFilter => (PORTAL_SHEET_FILTERS as readonly string[]).includes(value ?? '')

const WAIT_ICON: Readonly<Record<SheetWaitKind, string>> = { NEW_MESSAGES: 'message-circle', DESIGN_APPROVAL: 'image', SEND_LABEL: 'truck', ASKED: 'hourglass', OPEN_DETAILS: 'alert-triangle', LATE: 'clock' }

/** A door target of a chip, as the page reads it back (`parseTarget` of lib/orders-sheet/rows). */
export const waitTargetOf = (door: WaitChip['door'], key: string): string => `${door === 'chat' ? 'chat' : door === 'design' ? 'design' : 'open'}:${key}`

/** The line's key in the sheet (unique across the grid): the order's id and the line's. */
export const sheetLineKeyOf = (orderId: string, lineId: string): string => `${orderId}:${lineId}`
/** The line's id back from its key. */
export const lineIdOfKey = (key: string): string => key.slice(key.indexOf(':') + 1)

export interface SheetOrdersContext {
  readonly locale: 'it' | 'en'
  /** The page's words (`portal-ordering` › `ordersSheet`). */
  readonly t: (key: string, params?: Readonly<Record<string, string | number>>) => string
  /** The own columns the page's rows use (the read's `ownColumns`). */
  readonly ownColumns: readonly OwnColumn[]
}

/** One row of the read as the part's order (an older answer without a life word: from its customer status). */
export function sheetOrderOf(order: OrderRow, ctx: SheetOrdersContext): OrdersSheetOrder {
  const page = pageOf(order)
  const key = order.id
  const draft = order.kind === 'DRAFT'
  const columns = new Map(ctx.ownColumns.map((column) => [column.id, column]))
  const chips: SheetChip[] = waitChipsOf(order.waits).map((chip) => ({
    tone: chip.tone,
    icon: WAIT_ICON[chip.kind],
    words: ctx.t(`ordersSheet.${chip.key}`, { count: chip.count ?? 1 }),
    door: page ? { kind: chip.door === 'design' ? 'window' : 'page', target: waitTargetOf(chip.door, key) } : null,
  }))
  return {
    key,
    record: { kind: order.kind === 'ORDER' ? 'ORDER' : 'REQUEST', id: page?.id ?? order.id, version: order.version ?? 0 },
    number: order.yourNumber ? order.yourNumber.words[ctx.locale] : null,
    subject: rowTitleOf(order),
    customer: null,
    life: lifeOf(order) ?? lifeOfStatus(order.status as OrderStatusCode).life,
    wantedFor: order.requestedDate,
    promised: order.promiseDate,
    daysLate: null,
    where: null,
    picture: null,
    chips,
    pieces: order.pieces.ordered,
    may: {
      open: page !== null,
      send: draft && (order.may?.send ?? false),
      deleteDraft: draft && (order.may?.delete ?? false),
      withdraw: false,
      askCancel: false,
      editLines: draft && (order.may?.edit ?? false) ? 'DRAFT' : null,
    },
    lines: (order.lines ?? []).map((line) => ({
      key: sheetLineKeyOf(order.id, line.id),
      id: line.id,
      seq: line.seq,
      kind: line.model.kind === 'OWN' || line.model.kind === 'RANGE' ? 'CATALOGUE' : 'DESCRIBED',
      product: null,
      text: line.model.words,
      material: line.material,
      sizes: line.sizes,
      sizeFileId: null,
      pieces: line.pieces,
      own: Object.values(line.ownValues).flatMap((value) => {
        const column = columns.get(value.columnId)
        return column ? [{ columnId: column.id, name: column.name, kind: column.kind, value: value.value }] : []
      }),
      asks: [],
    })),
  }
}

/** Every row of the read as the part's orders (withdrawn ones only when their chip is on). */
export const sheetOrdersOf = (items: readonly OrderRow[], ctx: SheetOrdersContext, showWithdrawn: boolean): OrdersSheetOrder[] =>
  items.filter((order) => showWithdrawn || order.life !== 'WITHDRAWN').map((order) => sheetOrderOf(order, ctx))
