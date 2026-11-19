import { definePartnerView, equalsTyped, holdsTyped, idsOf } from '../view'
// B-OP-044 (order page N6, lines-derived): the orders a shipment carries.
import { orderRefsOfShipments } from '../../../../modules/shipping/shipments/orders-of'

/**
 * Transport documents (DDT; modules/shipping/ddt; the index's ../../indexers/ddt.ts) addressed to the partner: a
 * customer's with its delivery (their PO first), a workshop's with the job its kit went with, a supplier's return. Our
 * number, the document date, ISSUED or CANCELLED. Never the internal note.
 */
export default definePartnerView({
  recordType: 'Ddt',
  group: 'documents',
  kinds: ['CUSTOMER', 'SUPPLIER', 'SUBCONTRACTOR'],
  async read(client, ids) {
    const rows = await client.ddt.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        companyId: true,
        number: true,
        documentDate: true,
        sourceType: true,
        sourceId: true,
        shipmentId: true, // B-OP-044
        shipment: { select: { number: true, salesOrderId: true, salesOrder: { select: { number: true, customerRef: true } } } },
        cancellations: { select: { id: true }, take: 1 },
      },
    })
    // A workshop's kit went with its job: the job's number (the partner reads its own subcontract orders).
    const jobIds = [...new Set(rows.filter((row) => row.sourceType === 'SubcontractOrder' && row.sourceId).map((row) => row.sourceId!))]
    const jobs = new Map(jobIds.length > 0 ? (await client.subcontractOrder.findMany({ where: { id: { in: jobIds } }, select: { id: true, number: true } })).map((job) => [job.id, job.number]) : [])
    // B-OP-044 (order page N6): the other orders a DDT's shipment carries are matched too (the partner's own).
    const ordersOf = await orderRefsOfShipments(client, rows.flatMap((row) => (row.shipmentId && row.shipment ? [{ id: row.shipmentId, salesOrderId: row.shipment.salesOrderId }] : [])))
    return rows.map((row) => {
      const job = row.sourceType === 'SubcontractOrder' && row.sourceId ? (jobs.get(row.sourceId) ?? null) : null
      return {
        id: row.id,
        companyId: row.companyId,
        theirRef: row.shipment?.salesOrder.customerRef ?? null,
        ourRef: row.number,
        subtitle: row.shipment?.number ?? job,
        status: row.cancellations.length > 0 ? 'CANCELLED' : 'ISSUED',
        date: row.documentDate,
        words: [row.shipment?.number, row.shipment?.salesOrder.number, job, ...(row.shipmentId ? (ordersOf.get(row.shipmentId) ?? []).slice(1).flatMap((ref) => [ref.number, ref.customerRef]) : [])],
      }
    })
  },
  async lookup(client, typed, take) {
    return idsOf(
      await client.ddt.findMany({
        where: {
          OR: [
            { number: equalsTyped(typed) },
            { shipment: { is: { salesOrder: { customerRef: holdsTyped(typed) } } } },
            // B-OP-044: the PO of any order its shipment carries.
            { shipment: { is: { lines: { some: { salesOrderLine: { order: { customerRef: holdsTyped(typed) } } } } } } },
          ],
        },
        select: { id: true },
        orderBy: { documentDate: 'desc' },
        take,
      }),
    )
  },
})
