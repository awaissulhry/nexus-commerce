import type { Prisma } from '@nexus/factory-db'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import { inCompanyCurrency, lineSpendOf, monthOf, SPEND_LIMITS, SPEND_STATUSES, spendKindOf, type SpendKind, type SpendRow } from '@nexus/factory-domain/purchasing/reports/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import { PRODUCTION_ORDER_KINDS } from '@nexus/factory-domain/purchasing/sample-orders/rules'
import { companyRef, type Place, type Ref } from './access'
import type { Reader } from '../store'

/**
 * What the spend counts (B-W2b-350; the rules: factory-domain purchasing/reports/rules.ts): the lines (not cancelled) of the
 * orders the caller reaches that were PLACED in the period — first sent (revision 1) inside it, an order sent before the
 * revisions were kept by its own sentAt — and are still placed (sent, confirmed, with changes proposed, received in part or in
 * full, closed). Each line at its value now, a closed-short one at what came (posted receipts), in the company's currency at the
 * rate of the order. Reads only; at most SPEND_LIMITS.read lines (`complete`).
 */

export interface SpendLine extends SpendRow {
  readonly seq: number
  readonly purchaseOrderId: string
  readonly number: string
  readonly status: PurchaseOrderStatus
  readonly placedOn: string
  readonly partyId: string
  readonly itemId: string
  readonly category: string
  readonly itemColourId: string | null
  readonly quantity: string
  readonly uom: Uom
  readonly closedShort: boolean
}

export interface SpendRead {
  readonly lines: SpendLine[]
  readonly complete: boolean
  readonly suppliers: Map<string, Ref>
  readonly items: Map<string, Ref & { readonly kind: string }>
  readonly colours: Map<string, { readonly code: string; readonly name: string }>
  readonly companies: Map<string, Ref & { readonly currency: string }>
}

/** Orders placed in the span: first sent (revision 1) inside it; an order with no revision 1 kept, by its own send. */
export function placedIn(span: { readonly start: Date; readonly end: Date }): Prisma.PurchaseOrderWhereInput {
  const inside = { gte: span.start, lt: span.end }
  return { OR: [{ revisions: { some: { revision: 1, sentAt: inside } } }, { revisions: { none: { revision: 1 } }, sentAt: inside }] }
}

const unique = <T>(values: readonly (T | null | undefined)[]): T[] => [...new Set(values.filter((value): value is T => value !== null && value !== undefined))]

/** The spend lines of a read, with the names its groups need. */
export async function spendLinesOf(db: Reader, place: Place, extra: Prisma.PurchaseOrderLineWhereInput = {}, kind?: SpendKind): Promise<SpendRead> {
  const empty: SpendRead = { lines: [], complete: true, suppliers: new Map(), items: new Map(), colours: new Map(), companies: new Map() }
  if (!place.sight.orders) return empty
  const orderWhere: Prisma.PurchaseOrderWhereInput = {
    AND: [place.orders, { status: { in: [...SPEND_STATUSES] } }, placedIn(place.span), kind === 'samples' ? { kind: { notIn: [...PRODUCTION_ORDER_KINDS] } } : kind === 'production' ? { kind: { in: [...PRODUCTION_ORDER_KINDS] } } : {}],
  }
  const rows = await db.purchaseOrderLine.findMany({
    where: { AND: [{ cancelledAt: null, purchaseOrder: orderWhere }, extra] },
    orderBy: [{ purchaseOrderId: 'asc' }, { seq: 'asc' }, { id: 'asc' }],
    take: SPEND_LIMITS.read + 1,
    select: { id: true, seq: true, purchaseOrderId: true, itemId: true, itemColourId: true, quantity: true, uom: true, baseQuantity: true, netAmount: true, closedShortAt: true },
  })
  const page = rows.slice(0, SPEND_LIMITS.read)
  if (page.length === 0) return empty
  const orderIds = unique(page.map((row) => row.purchaseOrderId))
  const orders = new Map(
    (
      await db.purchaseOrder.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, number: true, status: true, kind: true, companyId: true, partyId: true, currency: true, netAmount: true, companyNetAmount: true, sentAt: true, revisions: { where: { revision: 1 }, select: { sentAt: true } } },
      })
    ).map((row) => [row.id, row]),
  )
  const shortIds = page.filter((row) => row.closedShortAt !== null).map((row) => row.id)
  const sums = shortIds.length === 0 ? [] : await db.goodsReceiptLine.groupBy({ by: ['purchaseOrderLineId'], where: { purchaseOrderLineId: { in: shortIds }, receipt: { status: 'POSTED' } }, _sum: { baseQuantity: true } })
  const received = new Map(sums.map((row) => [row.purchaseOrderLineId!, new Dec(row._sum.baseQuantity?.toString() ?? '0').toFixed(4)]))
  const companies = new Map(
    (await db.company.findMany({ where: { id: { in: unique([...orders.values()].map((order) => order.companyId)) } }, select: { id: true, code: true, legalName: true, tradeName: true, currency: true } })).map((row) => [row.id, { ...companyRef(row), currency: row.currency }]),
  )
  const items = new Map(
    (await db.item.findMany({ where: { id: { in: unique(page.map((row) => row.itemId)) } }, select: { id: true, code: true, name: true, kind: true } })).map((row) => [row.id, { id: row.id, code: row.code, name: row.name, kind: row.kind as string }]),
  )
  const colourIds = unique(page.map((row) => row.itemColourId))
  const colours = new Map((colourIds.length === 0 ? [] : await db.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, { code: row.code, name: row.name }]))
  const suppliers = new Map(
    (await db.party.findMany({ where: { id: { in: unique([...orders.values()].map((order) => order.partyId)) } }, select: { id: true, code: true, legalName: true, tradeName: true } })).map((row) => [row.id, { id: row.id, code: row.code, name: row.tradeName ?? row.legalName }]),
  )
  const lines = page.flatMap((row): SpendLine[] => {
    const order = orders.get(row.purchaseOrderId)
    const item = items.get(row.itemId)
    const company = order ? companies.get(order.companyId) : undefined
    const placedAt = order?.revisions[0]?.sentAt ?? order?.sentAt ?? null
    if (!order || !item || !company || !placedAt) return []
    const own = lineSpendOf({ netAmount: row.netAmount, cancelled: false, closedShort: row.closedShortAt !== null, baseQuantity: row.baseQuantity.toFixed(4), receivedBase: received.get(row.id) ?? '0.0000' })
    const money = inCompanyCurrency(own, { currency: order.currency, companyCurrency: company.currency, netAmount: order.netAmount, companyNetAmount: order.companyNetAmount })
    const placedOn = businessDate(placedAt)
    const month = monthOf(placedOn)
    return [
      {
        lineId: row.id,
        orderId: order.id,
        kind: spendKindOf(order.kind),
        keys: { supplier: order.partyId, category: item.kind, material: item.id, company: order.companyId, month },
        month,
        currency: money.currency,
        spend: money.spend,
        seq: row.seq,
        purchaseOrderId: order.id,
        number: order.number,
        status: order.status as PurchaseOrderStatus,
        placedOn,
        partyId: order.partyId,
        itemId: item.id,
        category: item.kind,
        itemColourId: row.itemColourId,
        quantity: row.quantity.toFixed(4),
        uom: row.uom as Uom,
        closedShort: row.closedShortAt !== null,
      },
    ]
  })
  return { lines, complete: rows.length <= SPEND_LIMITS.read, suppliers, items, colours, companies }
}
