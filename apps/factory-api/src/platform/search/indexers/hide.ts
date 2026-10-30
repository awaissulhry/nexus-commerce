import { CASCADE_MAX, defineIndexer, idWhere, type RecordsOf } from '../indexer'

/**
 * Hides (modules/inventory; inventory.stock.view; opens in Warehouse › Hides): by the hide's tag (the scanned label
 * `HD-…`, so a scan in the palette opens it) and the tannery's own code, the item and the lot. Scope as the hides list:
 * the lot's company and the hide's site. Made with their lot (a receipt, the opening stock); their state is not kept
 * here (it changes with every cut: the record shows it).
 */
const hidesOfLots =
  (key: 'lotIds' | 'lotId'): RecordsOf =>
  async (event, tx) => {
    const value = (event.payload as Record<string, unknown> | null)?.[key]
    const lotIds = (Array.isArray(value) ? value : [value]).filter((entry): entry is string => typeof entry === 'string')
    if (lotIds.length === 0) return []
    return (await tx.hide.findMany({ where: { lotId: { in: lotIds } }, select: { id: true }, orderBy: { id: 'asc' }, take: CASCADE_MAX })).map((row) => row.id)
  }

export default defineIndexer({
  recordType: 'Hide',
  area: 'warehouse',
  viewPermission: 'inventory.stock.view',
  on: { 'inventory.receipt_posted': hidesOfLots('lotIds'), 'inventory.opening_posted': hidesOfLots('lotId') },
  async read(tx, filter, take) {
    const rows = await tx.hide.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, siteId: true, code: true, supplierCode: true, lot: { select: { code: true, companyId: true, item: { select: { code: true, name: true } } } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.lot.companyId,
      siteId: row.siteId,
      partyId: null,
      number: row.code,
      title: row.lot.item.name,
      subtitle: row.lot.code,
      status: null,
      words: [row.supplierCode, row.lot.item.code],
    }))
  },
})
