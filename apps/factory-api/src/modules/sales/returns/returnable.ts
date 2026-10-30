import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { SALES_RETURNS_MANAGE, SALES_RETURNS_VIEW } from '@nexus/factory-domain/sales/returns/permissions'
import { leftOf, valueOf, windowWarning, type ReturnPolicy } from '@nexus/factory-domain/sales/returns/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { mayOn, officeOf } from './access'
import { policyOf } from './policy'
import { dayOrNull, type Reader } from './store'

/**
 * What may come back (B-W2a-43; SAL-335 "Return lines from the invoiced order"; design returns.new "Lines and quantities
 * (never above sold)", rma.lines "Add lines by picking from the customer's invoiced lines"): for one customer of one
 * company, every line it was invoiced (GOODS lines of an issued TD01 or TD24, not a draft, not one SDI rejected) and
 * every order line and size that shipped (SHIPPED or DELIVERED shipments) and is not yet invoiced, with how many pieces
 * were sold, how many other live returns take back (an open one its pieces, a closed one what it received) and how many
 * may still come back — the same sums the …_sales_w2a_guards trigger counts under its advisory locks (a caller that
 * writes takes those locks first: `lockSold`).
 */

const INVOICED_TYPES = ['TD01', 'TD24'] as const
const NOT_INVOICED = ['DRAFT', 'REJECTED'] as const
const SHIPPED = ['SHIPPED', 'DELIVERED'] as const

export interface SoldKey {
  readonly invoiceLineId: string | null
  readonly salesOrderLineId: string | null
  readonly size: string | null
}

export interface ReturnableRow extends SoldKey {
  readonly kind: 'INVOICED' | 'SHIPPED'
  readonly description: string
  readonly order: { readonly id: string; readonly number: string; readonly lineSeq: number } | null
  readonly invoice: { readonly id: string; readonly number: string | null; readonly issueDate: BusinessDate | null; readonly lineSeq: number } | null
  readonly style: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly colourway: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly ppe: boolean
  readonly sold: number
  readonly taken: number
  readonly shippedLeft: number | null
  readonly left: number
  readonly currency: string
  /** As invoiced (the order line's for a line not yet invoiced). */
  readonly unitPrice: string | null
  readonly discountPct: string | null
  /** What one piece is worth, net, minor units. */
  readonly pieceValue: number | null
  /** When the goods reached the customer (the last shipment's delivery or shipping day; the invoice's day). */
  readonly deliveredOn: BusinessDate | null
  /** The work orders' batch numbers the shipped pieces came from. */
  readonly batchNumbers: readonly string[]
  readonly siteId: string | null
  readonly warning: string | null
}

export const soldKeyOf = (key: SoldKey): string => `${key.invoiceLineId ?? '-'}|${key.salesOrderLineId ?? '-'}|${key.size ?? '-'}`

const pieces = (value: { toString(): string }): number => Number.parseInt(new Dec(value.toString()).floor().toFixed(0), 10)

/** The advisory locks the line trigger takes, in its order, so the sums read under them hold until the commit. */
export async function lockSold(tx: Reader, tenantId: string, keys: readonly SoldKey[]): Promise<void> {
  const invoiced = [...new Set(keys.flatMap((key) => (key.invoiceLineId ? [key.invoiceLineId] : [])))].sort()
  const shipped = [...new Set(keys.flatMap((key) => (key.salesOrderLineId ? [`${key.salesOrderLineId}|${key.size ?? ''}`] : [])))].sort()
  for (const id of invoiced) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.return-invoiced', ${tenantId}::text, ${id}::text), 0))`
  for (const entry of shipped) {
    const [line, size] = entry.split('|') as [string, string]
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.return-shipped', ${tenantId}::text, ${line}::text, ${size}::text), 0))`
  }
}

export interface ReturnableQuery {
  readonly companyId: string
  readonly partyId: string
  readonly salesOrderId?: string | null | undefined
  readonly invoiceId?: string | null | undefined
  /** Lines of an RMA being changed: their own pieces are not "taken". */
  readonly exceptLineIds?: readonly string[] | undefined
}

/** Every line of the customer that may come back (or that came back in full), invoiced first. */
export async function returnableRows(db: Reader, query: ReturnableQuery, policy: ReturnPolicy, now: Date): Promise<ReturnableRow[]> {
  const today = businessDate(now)
  const except = new Set(query.exceptLineIds ?? [])
  const invoiceLines = await db.invoiceLine.findMany({
    where: {
      buyerPartyId: query.partyId,
      kind: 'GOODS',
      ...(query.salesOrderId ? { salesOrderLine: { orderId: query.salesOrderId } } : {}),
      invoice: { companyId: query.companyId, docType: { in: [...INVOICED_TYPES] }, status: { notIn: [...NOT_INVOICED] }, ...(query.invoiceId ? { id: query.invoiceId } : {}) },
    },
    select: { id: true, invoiceId: true, seq: true, description: true, quantity: true, unitPrice: true, discountPct: true, netAmount: true, salesOrderLineId: true, size: true },
    orderBy: [{ invoiceId: 'asc' }, { seq: 'asc' }],
  })
  const invoices = invoiceLines.length ? await db.invoice.findMany({ where: { id: { in: [...new Set(invoiceLines.map((line) => line.invoiceId))] } }, select: { id: true, number: true, issueDate: true, currency: true } }) : []
  const shipmentLines = await db.shipmentLine.findMany({
    where: { partyId: query.partyId, ...(query.salesOrderId ? { salesOrderLine: { orderId: query.salesOrderId } } : {}), shipment: { companyId: query.companyId, status: { in: [...SHIPPED] } } },
    select: { shipmentId: true, salesOrderLineId: true, size: true, quantity: true, workOrderId: true },
  })
  const shipments = shipmentLines.length ? await db.shipment.findMany({ where: { id: { in: [...new Set(shipmentLines.map((line) => line.shipmentId))] } }, select: { id: true, siteId: true, shippedAt: true, deliveredAt: true } }) : []
  const workOrders = shipmentLines.length ? await db.workOrder.findMany({ where: { id: { in: [...new Set(shipmentLines.map((line) => line.workOrderId))] } }, select: { id: true, batchNumber: true } }) : []
  const orderLineIds = [...new Set([...invoiceLines.flatMap((line) => (line.salesOrderLineId ? [line.salesOrderLineId] : [])), ...shipmentLines.map((line) => line.salesOrderLineId)])]
  const orderLines = orderLineIds.length ? await db.salesOrderLine.findMany({ where: { id: { in: orderLineIds } }, select: { id: true, orderId: true, seq: true, styleId: true, colourwayId: true, description: true, quantity: true, netAmount: true, unitPrice: true } }) : []
  const sizes = orderLineIds.length ? await db.salesOrderLineSize.findMany({ where: { lineId: { in: orderLineIds } }, select: { lineId: true, size: true, unitPrice: true } }) : []
  const orders = orderLines.length ? await db.salesOrder.findMany({ where: { id: { in: [...new Set(orderLines.map((line) => line.orderId))] } }, select: { id: true, number: true, currency: true } }) : []
  const styles = orderLines.length ? await db.style.findMany({ where: { id: { in: [...new Set(orderLines.map((line) => line.styleId))] } }, select: { id: true, code: true, name: true, ppeCategory: true } }) : []
  const colourways = orderLines.length ? await db.colourway.findMany({ where: { id: { in: [...new Set(orderLines.map((line) => line.colourwayId))] } }, select: { id: true, code: true, name: true } }) : []
  const taken = await db.returnLine.findMany({
    where: { partyId: query.partyId, rma: { status: { notIn: ['REJECTED', 'CANCELLED'] } } },
    select: { id: true, invoiceLineId: true, salesOrderLineId: true, size: true, quantity: true, receivedQuantity: true, returnId: true },
  })
  const closed = new Set(taken.length ? (await db.returnAuthorisation.findMany({ where: { id: { in: [...new Set(taken.map((line) => line.returnId))] }, status: 'CLOSED' }, select: { id: true } })).map((row) => row.id) : [])

  const invoiceOf = new Map(invoices.map((row) => [row.id, row]))
  const orderLineOf = new Map(orderLines.map((row) => [row.id, row]))
  const orderOf = new Map(orders.map((row) => [row.id, row]))
  const styleOf = new Map(styles.map((row) => [row.id, row]))
  const colourwayOf = new Map(colourways.map((row) => [row.id, row]))
  const shipmentOf = new Map(shipments.map((row) => [row.id, row]))
  const batchOf = new Map(workOrders.map((row) => [row.id, row.batchNumber]))
  const sizePrice = new Map(sizes.map((row) => [`${row.lineId}|${row.size}`, row.unitPrice]))
  const cell = (line: string, size: string | null) => `${line}|${size ?? ''}`

  // What shipped per order line and size, when it last left, from which batches and site.
  const shipped = new Map<string, { quantity: number; deliveredOn: BusinessDate | null; batches: Set<string>; siteId: string | null }>()
  for (const line of shipmentLines) {
    const entry = shipped.get(cell(line.salesOrderLineId, line.size)) ?? { quantity: 0, deliveredOn: null, batches: new Set<string>(), siteId: null }
    const shipment = shipmentOf.get(line.shipmentId)
    const day = dayOrNull(shipment?.deliveredAt ?? shipment?.shippedAt ?? null)
    entry.quantity += line.quantity
    if (day && (!entry.deliveredOn || day > entry.deliveredOn)) entry.deliveredOn = day
    const batch = batchOf.get(line.workOrderId)
    if (batch) entry.batches.add(batch)
    entry.siteId ??= shipment?.siteId ?? null
    shipped.set(cell(line.salesOrderLineId, line.size), entry)
  }
  const takenOf = (line: (typeof taken)[number]) => (closed.has(line.returnId) ? line.receivedQuantity : line.quantity)
  const takenByInvoice = new Map<string, number>()
  const takenByCell = new Map<string, number>()
  const takenByCellUninvoiced = new Map<string, number>()
  for (const line of taken) {
    if (except.has(line.id)) continue
    if (line.invoiceLineId) takenByInvoice.set(line.invoiceLineId, (takenByInvoice.get(line.invoiceLineId) ?? 0) + takenOf(line))
    if (line.salesOrderLineId) {
      const key = cell(line.salesOrderLineId, line.size)
      takenByCell.set(key, (takenByCell.get(key) ?? 0) + takenOf(line))
      if (!line.invoiceLineId) takenByCellUninvoiced.set(key, (takenByCellUninvoiced.get(key) ?? 0) + takenOf(line))
    }
  }
  const invoicedByCell = new Map<string, number>()
  for (const line of invoiceLines) if (line.salesOrderLineId) invoicedByCell.set(cell(line.salesOrderLineId, line.size), (invoicedByCell.get(cell(line.salesOrderLineId, line.size)) ?? 0) + pieces(line.quantity))

  const lineFacts = (orderLineId: string | null) => {
    const orderLine = orderLineId ? orderLineOf.get(orderLineId) : undefined
    const order = orderLine ? orderOf.get(orderLine.orderId) : undefined
    const style = orderLine ? styleOf.get(orderLine.styleId) : undefined
    return {
      orderLine,
      order: orderLine && order ? { id: order.id, number: order.number, lineSeq: orderLine.seq } : null,
      style: style ? { id: style.id, code: style.code, name: style.name } : null,
      colourway: orderLine ? (colourwayOf.get(orderLine.colourwayId) ?? null) : null,
      ppe: style ? style.ppeCategory !== 'NOT_PPE' : false,
      currency: order?.currency ?? null,
    }
  }

  const rows: ReturnableRow[] = []
  for (const line of invoiceLines) {
    const invoice = invoiceOf.get(line.invoiceId)!
    const facts = lineFacts(line.salesOrderLineId)
    const sold = pieces(line.quantity)
    const ship = line.salesOrderLineId ? shipped.get(cell(line.salesOrderLineId, line.size)) : undefined
    const shippedLeft = line.salesOrderLineId ? (ship?.quantity ?? 0) - (takenByCell.get(cell(line.salesOrderLineId, line.size)) ?? 0) : null
    const counted = { sold, taken: takenByInvoice.get(line.id) ?? 0, shippedLeft }
    const deliveredOn = ship?.deliveredOn ?? dayOrNull(invoice.issueDate)
    rows.push({
      kind: 'INVOICED',
      invoiceLineId: line.id,
      salesOrderLineId: line.salesOrderLineId,
      size: line.size,
      description: line.description,
      order: facts.order,
      invoice: { id: invoice.id, number: invoice.number, issueDate: dayOrNull(invoice.issueDate), lineSeq: line.seq },
      style: facts.style,
      colourway: facts.colourway,
      ppe: facts.ppe,
      ...counted,
      left: leftOf(counted),
      currency: invoice.currency,
      unitPrice: line.unitPrice.toString(),
      discountPct: line.discountPct === null ? null : line.discountPct.toString(),
      pieceValue: valueOf({ netAmount: line.netAmount, quantity: line.quantity.toString() }, 1, invoice.currency),
      deliveredOn,
      batchNumbers: [...(ship?.batches ?? [])].sort(),
      siteId: ship?.siteId ?? null,
      warning: windowWarning(deliveredOn, today, policy),
    })
  }
  if (!query.invoiceId) {
    for (const [key, ship] of shipped) {
      const [orderLineId, sizeText] = key.split('|') as [string, string]
      const size = sizeText === '' ? null : sizeText
      const uninvoiced = ship.quantity - (invoicedByCell.get(key) ?? 0)
      if (uninvoiced <= 0) continue
      const facts = lineFacts(orderLineId)
      if (!facts.orderLine || !facts.currency) continue
      const counted = { sold: uninvoiced, taken: takenByCellUninvoiced.get(key) ?? 0, shippedLeft: ship.quantity - (takenByCell.get(key) ?? 0) }
      const unit = sizePrice.get(`${orderLineId}|${size}`) ?? facts.orderLine.unitPrice
      rows.push({
        kind: 'SHIPPED',
        invoiceLineId: null,
        salesOrderLineId: orderLineId,
        size,
        description: [facts.orderLine.description ?? [facts.style?.name, facts.colourway?.name].filter(Boolean).join(', '), size ? `size ${size}` : null].filter(Boolean).join(', '),
        order: facts.order,
        invoice: null,
        style: facts.style,
        colourway: facts.colourway,
        ppe: facts.ppe,
        ...counted,
        left: leftOf(counted),
        currency: facts.currency,
        unitPrice: unit.toString(),
        discountPct: null,
        pieceValue: valueOf({ netAmount: facts.orderLine.netAmount, quantity: facts.orderLine.quantity }, 1, facts.currency),
        deliveredOn: ship.deliveredOn,
        batchNumbers: [...ship.batches].sort(),
        siteId: ship.siteId,
        warning: windowWarning(ship.deliveredOn, today, policy),
      })
    }
  }
  return rows
}

const rowView = (row: ReturnableRow) => ({ ...row, batchNumbers: [...row.batchNumbers], unitPrice: asMoney('price', row.unitPrice), discountPct: asMoney('price', row.discountPct), pieceValue: asMoney('price', row.pieceValue) })

/** GET /sales/returns/returnable (sales.returns.manage over the company and customer). */
export async function listReturnable(caller: CommandCaller, query: ReturnableQuery) {
  const context = officeOf(caller)
  const party = isUuid(query.partyId) && isUuid(query.companyId) ? await caller.withClient((client) => client.party.findUnique({ where: { id: query.partyId }, select: { id: true, companyId: true } })) : null
  if (!party || (party.companyId !== null && party.companyId !== query.companyId) || !mayOn(context, SALES_RETURNS_VIEW, { companyId: query.companyId, partyId: query.partyId })) throw new NotFoundError('Customer not found.')
  if (!mayOn(context, SALES_RETURNS_MANAGE, { companyId: query.companyId, partyId: query.partyId })) throw new NotFoundError('Customer not found.')
  return caller.withClient(async (client) => {
    const policy = await policyOf(client, query.companyId)
    const rows = await returnableRows(client, query, policy, serverClock.now())
    return { lines: rows.map(rowView), policy }
  })
}
