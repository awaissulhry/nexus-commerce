import type { OrderLife } from '@nexus/factory-domain/sales/order-life'
import type { OrderRow, OrdersRead, PortalCell, SheetLine } from '../api'
import { lifeOf, pageOf, rowTitleOf, waitChipsOf, type RowPage, type WaitChip } from './model'

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
