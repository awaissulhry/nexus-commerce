import { defineIndexer, idWhere } from '../indexer'

/**
 * Transfers between sites (modules/inventory/transfers, B-W2b-326; inventory.stock.view, as the transfers list; opens in
 * Warehouse › Transfers; B-W2b-383, follow-up XF8:06): by number, the DDT number it travelled with, and the two sites' codes.
 * Scope: the sending company and site (one scope per entry; the list shows a transfer at either end, so someone whose grant
 * covers only the receiving site finds it in the list, not in search). Never a quantity of goods, never a person. Every
 * change of the transfer (`inventory.transfer_changed`: made, edited, shipped, received, settled, cancelled) re-reads it.
 */
export default defineIndexer({
  recordType: 'TransferOrder',
  area: 'warehouse',
  viewPermission: 'inventory.stock.view',
  on: {
    'inventory.transfer_changed': 'subject',
  },
  async read(tx, filter, take) {
    const rows = await tx.transferOrder.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, fromSiteId: true, number: true, status: true, ddtNumber: true, fromSite: { select: { code: true, name: true } }, toSite: { select: { code: true, name: true } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.fromSiteId,
      partyId: null,
      number: row.number,
      title: `${row.fromSite.code} → ${row.toSite.code}`,
      subtitle: row.ddtNumber,
      status: row.status,
      words: [row.ddtNumber, row.fromSite.code, row.toSite.code, row.fromSite.name, row.toSite.name],
    }))
  },
})
