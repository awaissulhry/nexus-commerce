import { definePartnerView, equalsTyped, holdsTyped, idsOf } from '../view'

/**
 * A customer's invoices, deposit invoices and credit notes (modules/invoicing; the index's ../../indexers/invoice.ts),
 * once issued: our number, the order it bills (their PO first when the order has one), the issue date and the status.
 * Found only by a person who holds the price grain (Buyer, Finance, Admin: the design's "invoices (finance role)"), though
 * no amount is ever shown here. Never the internal note or who issued it.
 */
export default definePartnerView({
  recordType: 'Invoice',
  group: 'documents',
  kinds: ['CUSTOMER'],
  grain: 'price',
  async read(client, ids) {
    const rows = await client.invoice.findMany({
      where: { id: { in: [...ids] }, number: { not: null } },
      select: { id: true, companyId: true, number: true, docType: true, status: true, issueDate: true, salesOrder: { select: { number: true, customerRef: true } } },
    })
    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      theirRef: row.salesOrder?.customerRef ?? null,
      ourRef: row.number,
      subtitle: row.salesOrder?.number ?? null,
      status: row.status,
      date: row.issueDate,
      words: [row.salesOrder?.number],
    }))
  },
  async lookup(client, typed, take) {
    return idsOf(
      await client.invoice.findMany({
        where: { number: { not: null }, OR: [{ number: equalsTyped(typed) }, { salesOrder: { is: { customerRef: holdsTyped(typed) } } }] },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
        take,
      }),
    )
  },
})
