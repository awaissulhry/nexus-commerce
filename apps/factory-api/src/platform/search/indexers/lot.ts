import { defineIndexer, idWhere, partyName, payloadIds } from '../indexer'

/**
 * Lots (modules/inventory; inventory.stock.view; opens in Warehouse › Lots & traceability): by lot code, the supplier's
 * lot reference and dye batch, the item's code and name, the supplier's name. Scope as the lots list: company and site.
 * Its quality state is its status. Made by a receipt or the opening stock; released, blocked or rejected by quality.
 */
export default defineIndexer({
  recordType: 'Lot',
  area: 'warehouse',
  viewPermission: 'inventory.stock.view',
  on: {
    'inventory.receipt_posted': payloadIds('lotIds'),
    'inventory.receipt_reversed': payloadIds('lotIds'),
    'inventory.opening_posted': (event) => {
      const id = (event.payload as { lotId?: unknown } | null)?.lotId
      return typeof id === 'string' ? [id] : []
    },
    'lot.released': 'subject',
    'lot.blocked': 'subject',
    'lot.rejected': 'subject',
    'lot.hold_cleared': 'subject',
    'lot.test_recorded': 'subject',
  },
  async read(tx, filter, take) {
    const rows = await tx.lot.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        companyId: true,
        siteId: true,
        code: true,
        supplierLotRef: true,
        dyeBatch: true,
        qualityStatus: true,
        item: { select: { code: true, name: true } },
        supplier: { select: { code: true, legalName: true, tradeName: true } },
      },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      partyId: null,
      number: row.code,
      title: row.item.name,
      subtitle: [partyName(row.supplier), row.supplierLotRef].filter(Boolean).join(' · ') || null,
      status: row.qualityStatus,
      words: [row.item.code, row.dyeBatch, row.supplier?.code],
    }))
  },
})
