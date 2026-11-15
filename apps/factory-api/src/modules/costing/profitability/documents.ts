import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { OrderDocumentsView } from '@nexus/factory-domain/costing/profitability/contracts'
import { counts, forOrderOf, invoiceKindOf, paidOf, sharedInvoice, totalsOf, type DocumentNote } from '@nexus/factory-domain/costing/profitability/documents'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { PAYABLES_VIEW } from '@nexus/factory-domain/payables/permissions'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf } from '../../product/materials/store'

/**
 * The order profitability report's documents (B-W2b-416; FIN-053; design finance.margins pop:order "Documents (W2b):
 * invoices, credit notes, cost entries, freight, payments — each a link"). Office read with costing.view over the order's
 * company and customer (as the order's margin, `GET /costing/margins/orders/:orderId`); each group besides needs the
 * reading permission of its documents over the order's place — invoices and credit notes invoices.view, payments
 * payments.view, freight shipping.view — and a group the reader may not see comes back empty with that permission
 * (`held`). The cost documents are costing.view's: the order's work orders (their cost so far, each opening its cost in
 * Standard vs actual), the cost of goods sold of its shipments, and the subcontract orders and supplier invoices whose
 * cost went onto those work orders (each listed only for a reader who may open it). Every amount by its grain (the
 * contract's marking): invoices, payments and the freight charged are prices, costs and the freight cost are costs.
 */

const DAY = (value: Date | null | undefined): string | null => (value ? value.toISOString().slice(0, 10) : null)
const romeDay = (value: Date | null | undefined): string | null => (value ? businessDate(value) : null)
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]

const PAYMENTS_VIEW = 'payments.view' satisfies Permission

/** GET /costing/margins/orders/:orderId/documents */
export async function orderDocuments(caller: CommandCaller, orderId: string): Promise<OrderDocumentsView> {
  const actor = actorOf(contextOf(caller))
  return caller.withClient(async (db) => {
    const order = isUuid(orderId) ? await db.salesOrder.findUnique({ where: { id: orderId }, select: { id: true, number: true, currency: true, companyId: true, partyId: true } }) : null
    if (!order || !can(actor, COSTING_VIEW, { companyId: order.companyId, partyId: order.partyId })) throw new NotFoundError('Sales order not found.')
    const place = { companyId: order.companyId, partyId: order.partyId }
    const sees = { invoices: can(actor, INVOICES_VIEW, place), payments: can(actor, PAYMENTS_VIEW, place), shipping: can(actor, SHIPPING_VIEW, place) }
    const notes = new Set<DocumentNote>()
    const lineIds = (await db.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true } })).map((line) => line.id)
    const mineLine = new Set(lineIds)

    // ---- invoices, deposit invoices, debit and credit notes ---------------------------------------------------------------
    const billedBy = lineIds.length === 0 ? [] : await db.invoiceLine.findMany({ where: { salesOrderLineId: { in: lineIds } }, select: { invoiceId: true } })
    const INVOICE = { id: true, docType: true, number: true, status: true, issueDate: true, currency: true, netTotal: true, grossTotal: true, salesOrderId: true, creditOfId: true, debitOfId: true } as const
    const first = await db.invoice.findMany({ where: { OR: [{ salesOrderId: order.id }, ...(billedBy.length > 0 ? [{ id: { in: unique(billedBy.map((line) => line.invoiceId)) } }] : [])] }, select: INVOICE })
    // A credit or debit note that names one of them (it may name no order line itself).
    const notesOf = first.length === 0 ? [] : await db.invoice.findMany({ where: { OR: [{ creditOfId: { in: first.map((row) => row.id) } }, { debitOfId: { in: first.map((row) => row.id) } }], id: { notIn: first.map((row) => row.id) } }, select: INVOICE })
    const invoices = [...first, ...notesOf].sort((a, b) => (DAY(a.issueDate) ?? '9999').localeCompare(DAY(b.issueDate) ?? '9999') || a.id.localeCompare(b.id))
    const allLines = invoices.length === 0 ? [] : await db.invoiceLine.findMany({ where: { invoiceId: { in: invoices.map((row) => row.id) } }, select: { invoiceId: true, netAmount: true, salesOrderLineId: true } })
    const numberOf = new Map(invoices.map((row) => [row.id, row.number]))
    const linesOf = (invoiceId: string) => allLines.filter((line) => line.invoiceId === invoiceId).map((line) => ({ netAmount: line.netAmount, mine: line.salesOrderLineId !== null && mineLine.has(line.salesOrderLineId), ofAnOrder: line.salesOrderLineId !== null }))
    const parts = new Map(invoices.map((row) => [row.id, { forOrder: forOrderOf(row, order.id, linesOf(row.id)), shared: sharedInvoice(linesOf(row.id)) }]))
    const invoiceRows = invoices.map((row) => {
      const ofId = row.creditOfId ?? row.debitOfId
      const own = parts.get(row.id)!
      // A note that names no order line: this order's part of the invoice it names, when that invoice is wholly this order's.
      const origin = ofId ? parts.get(ofId) : undefined
      const original = ofId ? invoices.find((entry) => entry.id === ofId) : undefined
      const forOrder = own.forOrder === 0 && origin && original && !origin.shared && origin.forOrder === original.netTotal ? row.netTotal : own.forOrder
      if (sees.invoices && own.shared) notes.add('SHARED_INVOICE')
      if (sees.invoices && !counts(row.status)) notes.add('NOT_ISSUED')
      if (sees.invoices && row.currency !== order.currency) notes.add('OTHER_CURRENCY')
      return {
        id: row.id,
        kind: invoiceKindOf(row.docType),
        docType: row.docType,
        number: row.number,
        status: row.status,
        issueDate: DAY(row.issueDate),
        currency: row.currency,
        netTotal: asMoney('price', row.netTotal),
        grossTotal: asMoney('price', row.grossTotal),
        forOrder: asMoney('price', forOrder),
        shared: own.shared,
        of: ofId ? { id: ofId, number: numberOf.get(ofId) ?? null } : null,
      }
    })

    // ---- payments placed on its invoices and deposit requests -----------------------------------------------------------
    const deposits = await db.depositRequest.findMany({ where: { orderId: order.id }, select: { id: true } })
    const targets = { invoices: invoices.map((row) => row.id), deposits: deposits.map((row) => row.id) }
    const allocations =
      targets.invoices.length + targets.deposits.length === 0
        ? []
        : await db.paymentAllocation.findMany({
            where: { OR: [...(targets.invoices.length > 0 ? [{ invoiceId: { in: targets.invoices } }] : []), ...(targets.deposits.length > 0 ? [{ depositRequestId: { in: targets.deposits } }] : [])] },
            select: { paymentId: true, invoiceId: true, depositRequestId: true, amount: true, reversalOfId: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          })
    const payments = allocations.length === 0 ? [] : await db.payment.findMany({ where: { id: { in: unique(allocations.map((row) => row.paymentId)) } }, select: { id: true, externalRef: true, method: true, status: true, receivedOn: true, currency: true, amount: true }, orderBy: [{ receivedOn: 'asc' }, { id: 'asc' }] })
    const paymentRows = payments.map((payment) => {
      const mine = allocations.filter((row) => row.paymentId === payment.id)
      const to = unique(mine.map((row) => (row.invoiceId ? `Invoice:${row.invoiceId}` : `DepositRequest:${row.depositRequestId}`))).map((key) => {
        const [type, id] = key.split(':') as ['Invoice' | 'DepositRequest', string]
        return { type, id, number: type === 'Invoice' ? (numberOf.get(id) ?? null) : null }
      })
      if (sees.payments && payment.currency !== order.currency) notes.add('OTHER_CURRENCY')
      return {
        id: payment.id,
        reference: payment.externalRef,
        method: payment.method,
        status: payment.status,
        receivedOn: DAY(payment.receivedOn)!,
        currency: payment.currency,
        amount: asMoney('price', payment.amount),
        paid: asMoney('price', paidOf(mine)),
        to,
        reversed: mine.some((row) => row.reversalOfId !== null),
      }
    })

    // ---- freight: charged to the customer and what the carrier charged us, per shipment -----------------------------------
    const shipments = await db.shipment.findMany({
      where: { salesOrderId: order.id, status: { not: 'CANCELLED' } },
      select: { id: true, number: true, status: true, shippedAt: true, carrierName: true, freightCharge: true, freightCost: true, freightCostCurrency: true },
      orderBy: [{ number: 'asc' }],
    })
    const freightRows = shipments.map((row) => {
      if (sees.shipping && row.freightCost !== null && row.freightCostCurrency !== order.currency) notes.add('OTHER_CURRENCY')
      if (sees.shipping && row.freightCost === null && (row.status === 'SHIPPED' || row.status === 'DELIVERED')) notes.add('FREIGHT_COST_MISSING')
      return {
        shipment: { id: row.id, number: row.number, status: row.status },
        date: romeDay(row.shippedAt),
        carrier: row.carrierName,
        chargeCurrency: order.currency,
        charge: asMoney('price', row.freightCharge),
        costCurrency: row.freightCostCurrency,
        cost: asMoney('cost', row.freightCost),
      }
    })

    // ---- cost documents: its work orders, the cost of goods sold of its shipments, what put cost on the work orders --------
    const cells = lineIds.length === 0 ? [] : await db.workOrderSize.findMany({ where: { salesOrderLineId: { in: lineIds } }, select: { workOrderId: true } })
    const workOrders = cells.length === 0 ? [] : await db.workOrder.findMany({ where: { id: { in: unique(cells.map((cell) => cell.workOrderId)) }, status: { not: 'DRAFT' } }, select: { id: true, number: true, status: true }, orderBy: { number: 'asc' } })
    const woIds = workOrders.map((row) => row.id)
    const allCells = woIds.length === 0 ? [] : await db.workOrderSize.findMany({ where: { workOrderId: { in: woIds } }, select: { workOrderId: true, salesOrderLineId: true, quantity: true } })
    const entries = woIds.length === 0 ? [] : await db.workOrderCostEntry.findMany({ where: { workOrderId: { in: woIds } }, select: { workOrderId: true, amount: true, currency: true, occurredAt: true, reversalOfId: true, subcontractOrderId: true, supplierInvoiceLineId: true } })
    const latest = (rows: readonly { occurredAt: Date }[]) => rows.reduce<Date | null>((max, row) => (max === null || row.occurredAt > max ? row.occurredAt : max), null)
    const currencyOf = (rows: readonly { currency: string }[]) => rows[0]?.currency ?? order.currency
    const costRows: OrderDocumentsView['costs']['rows'] = []
    for (const workOrder of workOrders) {
      const mine = entries.filter((row) => row.workOrderId === workOrder.id)
      const cellsOf = allCells.filter((cell) => cell.workOrderId === workOrder.id)
      const pieces = cellsOf.filter((cell) => cell.salesOrderLineId !== null && mineLine.has(cell.salesOrderLineId)).reduce((sum, cell) => sum + cell.quantity, 0)
      const ofPieces = cellsOf.reduce((sum, cell) => sum + cell.quantity, 0)
      if (pieces < ofPieces) notes.add('SHARED_WORK_ORDER')
      if (currencyOf(mine) !== order.currency) notes.add('OTHER_CURRENCY')
      costRows.push({ kind: 'WORK_ORDER', record: { type: 'WorkOrder', id: workOrder.id, number: workOrder.number }, status: workOrder.status, date: romeDay(latest(mine)), currency: currencyOf(mine), amount: asMoney('cost', mine.reduce((sum, row) => sum + row.amount, 0)), entries: mine.length, pieces, ofPieces, reversed: mine.some((row) => row.reversalOfId !== null) })
    }
    // The cost of goods sold of its shipments' lines (B-W2b-407), one row per shipment.
    const shipmentLines = shipments.length === 0 ? [] : await db.shipmentLine.findMany({ where: { shipmentId: { in: shipments.map((row) => row.id) } }, select: { id: true, shipmentId: true } })
    const sold = shipmentLines.length === 0 ? [] : await db.costOfSalesEntry.findMany({ where: { shipmentLineId: { in: shipmentLines.map((row) => row.id) } }, select: { shipmentLineId: true, amount: true, currency: true, postedAt: true, reversalOfId: true } })
    for (const shipment of shipments) {
      const ids = new Set(shipmentLines.filter((line) => line.shipmentId === shipment.id).map((line) => line.id))
      const mine = sold.filter((row) => row.shipmentLineId !== null && ids.has(row.shipmentLineId))
      if (mine.length === 0) continue
      if (currencyOf(mine) !== order.currency) notes.add('OTHER_CURRENCY')
      costRows.push({
        kind: 'COST_OF_SALES',
        record: { type: 'Shipment', id: shipment.id, number: shipment.number },
        status: shipment.status,
        date: romeDay(mine.reduce<Date | null>((max, row) => (max === null || row.postedAt > max ? row.postedAt : max), null)),
        currency: currencyOf(mine),
        amount: asMoney('cost', mine.reduce((sum, row) => sum + row.amount, 0)),
        entries: mine.length,
        pieces: null,
        ofPieces: null,
        reversed: mine.some((row) => row.reversalOfId !== null),
      })
    }
    // The documents whose cost went onto those work orders: subcontract orders and supplier invoices (each for who may open it).
    const bySubcontract = unique(entries.map((row) => row.subcontractOrderId).filter((value): value is string => value !== null))
    const subcontracts = bySubcontract.length === 0 ? [] : await db.subcontractOrder.findMany({ where: { id: { in: bySubcontract } }, select: { id: true, number: true, status: true, companyId: true, partyId: true }, orderBy: { number: 'asc' } })
    for (const row of subcontracts.filter((entry) => can(actor, PURCHASING_VIEW, { companyId: entry.companyId, partyId: entry.partyId }))) {
      const mine = entries.filter((entry) => entry.subcontractOrderId === row.id)
      costRows.push({ kind: 'SUBCONTRACT_ORDER', record: { type: 'SubcontractOrder', id: row.id, number: row.number }, status: row.status, date: romeDay(latest(mine)), currency: currencyOf(mine), amount: asMoney('cost', mine.reduce((sum, entry) => sum + entry.amount, 0)), entries: mine.length, pieces: null, ofPieces: null, reversed: mine.some((entry) => entry.reversalOfId !== null) })
    }
    const byInvoiceLine = unique(entries.map((row) => row.supplierInvoiceLineId).filter((value): value is string => value !== null))
    const supplierLines = byInvoiceLine.length === 0 ? [] : await db.supplierInvoiceLine.findMany({ where: { id: { in: byInvoiceLine } }, select: { id: true, invoiceId: true } })
    const supplierInvoices = supplierLines.length === 0 ? [] : await db.supplierInvoice.findMany({ where: { id: { in: unique(supplierLines.map((row) => row.invoiceId)) } }, select: { id: true, number: true, status: true, companyId: true, partyId: true }, orderBy: { number: 'asc' } })
    for (const row of supplierInvoices.filter((entry) => can(actor, PAYABLES_VIEW, { companyId: entry.companyId, partyId: entry.partyId }))) {
      const lines = new Set(supplierLines.filter((line) => line.invoiceId === row.id).map((line) => line.id))
      const mine = entries.filter((entry) => entry.supplierInvoiceLineId !== null && lines.has(entry.supplierInvoiceLineId))
      costRows.push({ kind: 'SUPPLIER_INVOICE', record: { type: 'SupplierInvoice', id: row.id, number: row.number }, status: row.status, date: romeDay(latest(mine)), currency: currencyOf(mine), amount: asMoney('cost', mine.reduce((sum, entry) => sum + entry.amount, 0)), entries: mine.length, pieces: null, ofPieces: null, reversed: mine.some((entry) => entry.reversalOfId !== null) })
    }

    const totals = totalsOf({
      currency: order.currency,
      invoices: sees.invoices ? invoiceRows.map((row) => ({ kind: row.kind, status: row.status, currency: row.currency, forOrder: row.forOrder as number })) : [],
      payments: sees.payments ? paymentRows.map((row) => ({ currency: row.currency, paid: row.paid as number })) : [],
      freight: sees.shipping ? freightRows.map((row) => ({ chargeCurrency: row.chargeCurrency, charge: row.charge as number | null, costCurrency: row.costCurrency, cost: row.cost as number | null })) : [],
    })
    const shown = (seen: boolean, value: number) => (seen ? value : null)
    const heldFor = (seen: boolean, permission: Permission) => (seen ? null : permission)
    return {
      order: { id: order.id, number: order.number, currency: order.currency },
      invoices: { held: heldFor(sees.invoices, INVOICES_VIEW), rows: sees.invoices ? invoiceRows.filter((row) => row.kind !== 'CREDIT_NOTE') : [] },
      creditNotes: { held: heldFor(sees.invoices, INVOICES_VIEW), rows: sees.invoices ? invoiceRows.filter((row) => row.kind === 'CREDIT_NOTE') : [] },
      costs: { held: null, rows: costRows },
      freight: { held: heldFor(sees.shipping, SHIPPING_VIEW), rows: sees.shipping ? freightRows : [] },
      payments: { held: heldFor(sees.payments, PAYMENTS_VIEW), rows: sees.payments ? paymentRows : [] },
      totals: {
        invoiced: asMoney('price', shown(sees.invoices, totals.invoiced)),
        credited: asMoney('price', shown(sees.invoices, totals.credited)),
        net: asMoney('price', shown(sees.invoices, totals.net)),
        deposits: asMoney('price', shown(sees.invoices, totals.deposits)),
        paid: asMoney('price', shown(sees.payments, totals.paid)),
        freightCharged: asMoney('price', shown(sees.shipping, totals.freightCharged)),
        freightCost: asMoney('cost', shown(sees.shipping, totals.freightCost)),
        otherCurrency: totals.otherCurrency,
      },
      notes: [...notes].sort(),
    }
  })
}
