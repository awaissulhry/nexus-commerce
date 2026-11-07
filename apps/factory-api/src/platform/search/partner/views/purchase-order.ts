import { definePartnerView, equalsTyped, holdsTyped, idsOf } from '../view'

/**
 * A supplier's purchase orders (modules/purchasing; the index's ../../indexers/purchase-order.ts), once sent to them: their
 * reference (their order confirmation) first, our PO number second, their article codes on its lines, the order date and
 * status. NEVER a price or an amount (Owner answer C2), the internal note or who in the office sent or decided.
 */
const SENT = { sentAt: { not: null } } as const
const ARTICLES = 50

export default definePartnerView({
  recordType: 'PurchaseOrder',
  group: 'pos',
  kinds: ['SUPPLIER'],
  async read(client, ids) {
    const rows = await client.purchaseOrder.findMany({
      where: { id: { in: [...ids] }, ...SENT },
      select: {
        id: true,
        companyId: true,
        number: true,
        supplierRef: true,
        status: true,
        orderDate: true,
        lines: { where: { supplierArticleCode: { not: null } }, select: { supplierArticleCode: true }, orderBy: { seq: 'asc' }, take: ARTICLES },
      },
    })
    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      theirRef: row.supplierRef,
      ourRef: row.number,
      subtitle: null,
      status: row.status,
      date: row.orderDate,
      words: row.lines.map((line) => line.supplierArticleCode),
    }))
  },
  async lookup(client, typed, take) {
    return idsOf(
      await client.purchaseOrder.findMany({
        where: { ...SENT, OR: [{ number: equalsTyped(typed) }, { supplierRef: holdsTyped(typed) }, { lines: { some: { supplierArticleCode: equalsTyped(typed) } } }] },
        select: { id: true },
        orderBy: { orderDate: 'desc' },
        take,
      }),
    )
  },
})
