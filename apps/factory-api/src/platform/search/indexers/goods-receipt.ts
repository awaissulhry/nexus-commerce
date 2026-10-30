import { defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Goods receipts (modules/inventory/receipts; inventory.stock.view; opens in Warehouse › Receipts): by number, the
 * supplier's delivery note (DDT) number, the purchase order's number, the supplier's name. Scope as the receipts list:
 * company and site.
 */
export default defineIndexer({
  recordType: 'GoodsReceipt',
  area: 'warehouse',
  viewPermission: 'inventory.stock.view',
  on: { 'inventory.receipt_posted': 'subject', 'inventory.receipt_reversed': 'subject' },
  async read(tx, filter, take) {
    const rows = await tx.goodsReceipt.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, siteId: true, number: true, supplierDdtNumber: true, status: true, supplier: { select: { code: true, legalName: true, tradeName: true } }, purchaseOrder: { select: { number: true } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      partyId: null,
      number: row.number,
      title: partyName(row.supplier) ?? row.number,
      subtitle: row.purchaseOrder?.number ?? null,
      status: row.status,
      words: [row.supplierDdtNumber, row.supplier.code],
    }))
  },
})
