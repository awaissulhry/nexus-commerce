import { customerRefOf } from '@nexus/factory-domain/sales/customer-numbers'
import { definePartnerView, equalsTyped, holdsTyped, idsOf } from '../view'

/**
 * A customer's orders (modules/sales/orders; the index's ../../indexers/sales-order.ts): their reference (their PO) first,
 * our order number second, the order date and status. Every order of the party (each was made from a quote it accepted),
 * read as the partner role reads it: never the cost or the internal note. th2-backend step 7 (threads plan §0.5): "ours" is the
 * customer's OWN order number ("#12"); the office's SO-… number is only matched (it is printed on the order confirmation the
 * customer holds), never shown.
 */
export default definePartnerView({
  recordType: 'SalesOrder',
  group: 'orders',
  kinds: ['CUSTOMER'],
  async read(client, ids) {
    const rows = await client.salesOrder.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, companyId: true, number: true, customerRef: true, status: true, orderDate: true, customerSeq: true },
    })
    return rows.map((row) => ({ id: row.id, companyId: row.companyId, theirRef: row.customerRef, ourRef: customerRefOf('ORDER', row.customerSeq), subtitle: null, status: row.status, date: row.orderDate, words: [row.number] }))
  },
  async lookup(client, typed, take) {
    return idsOf(await client.salesOrder.findMany({ where: { OR: [{ number: equalsTyped(typed) }, { customerRef: holdsTyped(typed) }] }, select: { id: true }, orderBy: { orderDate: 'desc' }, take }))
  },
})
