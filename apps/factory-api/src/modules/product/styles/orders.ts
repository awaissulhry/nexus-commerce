import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import type { MeasurementSheetState, StyleOrderLine, StyleOrdersView } from '@nexus/factory-domain/product/styles/contracts'
import { orderLifeOf } from '@nexus/factory-domain/sales/order-life'
import type { CommandCaller } from '../../../core/command'
import { contextOf, readStyle } from './store'
import { OPEN_ORDER, orderReach } from './order-reach'

/**
 * GET /product/styles/:styleId/orders (owb-pd1 1.1; design § 5q "Where it is used", § 5r "Riders' measurement sheets", § 5zc
 * "Open orders need"): the open order lines of a product — orders not CANCELLED, CLOSED or DELIVERED, goods lines only (a fee
 * line is never made) — each with its order, customer, pieces, sizes in words, the revision it is made to, the measurement sheet
 * of a made-to-measure line and the order's life word (factory-domain sales/order-life).
 *
 *   who      product.styles.view (the route) over the style — another customer's private-label style is not found (404, the
 *            brand wall: readStyle) — AND orders.view over each order's company and customer, or with only orders.view.own the
 *            orders the person is on (./order-reach). Neither right: 403 in words.
 *   money    none: no price, cost or amount is read.
 *   size     `totals` counts every open line the person sees; `lines` lists the newest LINES_SHOWN of them.
 */

export const LINES_SHOWN = 500

const LINE_COLUMNS = {
  id: true,
  orderId: true,
  seq: true,
  kind: true,
  quantity: true,
  closedShortQuantity: true,
  styleRevisionId: true,
  measurementProfileId: true,
} as const satisfies Prisma.SalesOrderLineSelect

/** "50 × 2 · 52 × 4" in the style's range order (sizes outside the range last, by code). */
export function sizesInWords(range: readonly string[], sizes: readonly { readonly size: string; readonly quantity: number }[]): string | null {
  if (sizes.length === 0) return null
  const place = (size: string): number => {
    const at = range.indexOf(size)
    return at === -1 ? range.length : at
  }
  return [...sizes]
    .sort((a, b) => place(a.size) - place(b.size) || (a.size < b.size ? -1 : a.size > b.size ? 1 : 0))
    .map((entry) => `${entry.size} × ${entry.quantity}`)
    .join(' · ')
}

/** A made-to-measure line's sheet: a MEASUREMENTS file on the line first, then typed measurements, else not here yet. */
export function measurementOf(kind: string, hasFile: boolean, profileId: string | null): MeasurementSheetState | null {
  if (kind !== 'MADE_TO_MEASURE') return null
  if (hasFile) return 'FILE'
  return profileId !== null ? 'TYPED' : 'MISSING'
}

export async function styleOrders(caller: CommandCaller, styleId: string): Promise<StyleOrdersView> {
  const context = contextOf(caller)
  const style = await readStyle(caller, styleId)
  return caller.withClient(async (client) => {
    const reach = await orderReach(client, context)
    if (!reach) throw new ForbiddenError('Seeing where a product is used needs the right to see the orders (all of them, or the ones you are on).')
    const where: Prisma.SalesOrderLineWhereInput = { styleId, kind: { not: 'FEE' }, order: { is: { AND: [reach, OPEN_ORDER] } } }

    // One query after another on the one client: the totals, then the lines shown and what they name.
    const pieces = await client.salesOrderLine.aggregate({ where, _sum: { quantity: true, closedShortQuantity: true } })
    const orders = await client.salesOrderLine.groupBy({ by: ['orderId'], where })
    const totals = { openOrders: orders.length, openPieces: (pieces._sum.quantity ?? 0) - (pieces._sum.closedShortQuantity ?? 0) }

    const rows = await client.salesOrderLine.findMany({
      where,
      select: LINE_COLUMNS,
      orderBy: [{ order: { orderDate: 'desc' } }, { order: { number: 'desc' } }, { seq: 'asc' }],
      take: LINES_SHOWN,
    })
    if (rows.length === 0) return { lines: [], totals }
    const orderIds = [...new Set(rows.map((row) => row.orderId))]
    const lineIds = rows.map((row) => row.id)
    const heads = await client.salesOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true, status: true, partyId: true } })
    const parties = await client.party.findMany({ where: { id: { in: [...new Set(heads.map((head) => head.partyId))] } }, select: { id: true, code: true, legalName: true, tradeName: true } })
    const printed = await client.orderPrint.findMany({ where: { salesOrderId: { in: orderIds }, kind: 'FIRST' }, select: { salesOrderId: true }, distinct: ['salesOrderId'] })
    const sizes = await client.salesOrderLineSize.findMany({ where: { lineId: { in: lineIds } }, select: { lineId: true, size: true, quantity: true } })
    const revisionIds = [...new Set(rows.flatMap((row) => (row.styleRevisionId ? [row.styleRevisionId] : [])))]
    const revisions = revisionIds.length === 0 ? [] : await client.styleRevision.findMany({ where: { id: { in: revisionIds } }, select: { id: true, revision: true } })
    const measured = rows.filter((row) => row.kind === 'MADE_TO_MEASURE').map((row) => row.id)
    const sheets =
      measured.length === 0
        ? []
        : await client.storedFile.findMany({
            where: { recordType: 'SalesOrderLine', recordId: { in: measured }, category: 'MEASUREMENTS', status: 'AVAILABLE', supersededAt: null },
            select: { recordId: true },
            distinct: ['recordId'],
          })

    const headOf = new Map(heads.map((head) => [head.id, head]))
    const partyOf = new Map(parties.map((party) => [party.id, party]))
    const printedOrders = new Set(printed.map((row) => row.salesOrderId))
    const revisionOf = new Map(revisions.map((row) => [row.id, row.revision]))
    const withSheet = new Set(sheets.map((row) => row.recordId))
    const lines: StyleOrderLine[] = []
    for (const row of rows) {
      const head = headOf.get(row.orderId)
      if (!head) continue
      const party = partyOf.get(head.partyId)
      lines.push({
        orderId: head.id,
        orderNumber: head.number,
        customer: party ? { id: party.id, code: party.code, name: party.tradeName ?? party.legalName } : null,
        lineId: row.id,
        quantity: row.quantity - (row.closedShortQuantity ?? 0),
        sizes: row.kind === 'MADE_TO_MEASURE' ? null : sizesInWords(style.sizes, sizes.filter((size) => size.lineId === row.id)),
        revision: row.styleRevisionId ? (revisionOf.get(row.styleRevisionId) ?? null) : null,
        measurement: measurementOf(row.kind, withSheet.has(row.id), row.measurementProfileId),
        // Printed: an OrderPrint FIRST row; otherwise nothing is said (a site without the print, or not yet).
        life: orderLifeOf({ order: { status: head.status, printed: printedOrders.has(head.id) ? true : null } }).life,
      })
    }
    return { lines, totals }
  })
}
