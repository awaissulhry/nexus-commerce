import { defineIndexer, idWhere } from '../indexer'

/**
 * Cut orders (modules/production/cutorders, B-W2b-112; production.cutting.view; opens in Production › Cutting room): by number,
 * with the material cut (code, name and colour), the marker and the work orders it groups. Scope as the cut order list: company
 * and site. Never a worker, never money. Every change of a cut order emits cut_order.changed about it, which re-reads it.
 * (The web's RECORD_PAGES and search words for CutOrder come with the screens, B-W2b-129.)
 */
export default defineIndexer({
  recordType: 'CutOrder',
  area: 'production',
  viewPermission: 'production.cutting.view',
  on: { 'cut_order.changed': 'subject' },
  async read(tx, filter, take) {
    const rows = await tx.cutOrder.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        companyId: true,
        siteId: true,
        number: true,
        kind: true,
        status: true,
        markerName: true,
        item: { select: { code: true, name: true } },
        itemColour: { select: { code: true } },
        lines: { select: { workOrderSize: { select: { workOrder: { select: { number: true } } } } }, orderBy: { seq: 'asc' }, take: 60 },
      },
    })
    return rows.map((row) => {
      const workOrders = [...new Set(row.lines.map((line) => line.workOrderSize.workOrder.number))]
      return {
        recordId: row.id,
        companyId: row.companyId,
        siteId: row.siteId,
        partyId: null,
        number: row.number,
        title: [row.item.name, row.itemColour?.code].filter((part) => part).join(' '),
        subtitle: workOrders.slice(0, 3).join(', ') + (workOrders.length > 3 ? ` +${workOrders.length - 3}` : ''),
        status: row.status,
        words: [row.item.code, row.markerName, row.kind === 'FABRIC' ? 'fabric' : 'leather', ...workOrders],
      }
    })
  },
})
