import { defineIndexer, idWhere } from '../indexer'

/**
 * Stock counts and year-end inventories (modules/inventory/counts; inventory.counts.view; opens in Warehouse › Counts): by
 * number, and what a cycle count is limited to — its location's code and name, its material's code and name, its lot.
 * Scope as the counts list: company and site. NEVER the difference's value (a cost) and never the count team (people).
 * Made, started, edited, submitted, approved, sent back, cancelled, applied and signed off re-read it.
 */
export default defineIndexer({
  recordType: 'StockCount',
  area: 'warehouse',
  viewPermission: 'inventory.counts.view',
  on: {
    'inventory.count_changed': 'subject',
    'inventory.count_applied': 'subject',
    'inventory.count_signed_off': 'subject',
  },
  async read(tx, filter, take) {
    const rows = await tx.stockCount.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        companyId: true,
        siteId: true,
        number: true,
        status: true,
        location: { select: { code: true, name: true } },
        item: { select: { code: true, name: true } },
        lot: { select: { code: true } },
      },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      partyId: null,
      number: row.number,
      // What it counts: its location, else its material, else its lot; a whole site's count (a year-end inventory) has
      // no name but its number.
      title: row.location?.name ?? row.item?.name ?? row.lot?.code ?? row.number,
      subtitle: [row.location?.code, row.item?.code, row.lot?.code].filter(Boolean).join(' · ') || null,
      status: row.status,
      words: [row.location?.code, row.item?.code, row.lot?.code],
    }))
  },
})
