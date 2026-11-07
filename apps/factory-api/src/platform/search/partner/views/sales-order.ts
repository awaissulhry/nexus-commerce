import { definePartnerView, equalsTyped, holdsTyped, idsOf } from '../view'

/**
 * A customer's orders (modules/sales/orders; the index's ../../indexers/sales-order.ts): their reference (their PO) first,
 * our order number second, the order date and status. Every order of the party (each was made from a quote it accepted),
 * read as the partner role reads it: never the cost or the internal note.
 */
export default definePartnerView({
  recordType: 'SalesOrder',
  group: 'orders',
  kinds: ['CUSTOMER'],
  async read(client, ids) {
    const rows = await client.salesOrder.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, companyId: true, number: true, customerRef: true, status: true, orderDate: true },
    })
    return rows.map((row) => ({ id: row.id, companyId: row.companyId, theirRef: row.customerRef, ourRef: row.number, subtitle: null, status: row.status, date: row.orderDate, words: [] }))
  },
  async lookup(client, typed, take) {
    return idsOf(await client.salesOrder.findMany({ where: { OR: [{ number: equalsTyped(typed) }, { customerRef: holdsTyped(typed) }] }, select: { id: true }, orderBy: { orderDate: 'desc' }, take }))
  },
})
