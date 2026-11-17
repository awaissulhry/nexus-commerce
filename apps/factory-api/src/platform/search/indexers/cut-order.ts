import type { CommandTx } from '../../../core/command'
import { defineIndexer, idWhere } from '../indexer'

/**
 * Cut orders (modules/production/cutorders, B-W2b-112; production.cutting.view; opens in Production › Cutting room): by number,
 * with the material cut (code, name and colour), the marker and the work orders it groups. Scope as the cut order list: company
 * and site. Never a worker, never money. Every change of a cut order emits cut_order.changed about it, which re-reads it.
 * B-PR-08a: and its customers (the customers of every work order it cuts; the production lane's wall).
 * (The web's RECORD_PAGES and search words for CutOrder come with the screens, B-W2b-129.)
 */
// ---- B-PR-08a part 2 (the brand wall; cut orders may mix customers inside the factory, plan §2): the customers of each cut order —
// of EVERY work order it cuts (all its lines, not only the 60 its name reads). One: it; several, or a work order of none (mixed
// before the rule): every customer only. No line yet: no customer.
async function customersOf(tx: CommandTx, cutOrderIds: readonly string[]): Promise<Map<string, { partyId: string | null; everyParty: boolean }>> {
  const lines = cutOrderIds.length === 0 ? [] : await tx.cutOrderLine.findMany({ where: { cutOrderId: { in: [...cutOrderIds] } }, select: { cutOrderId: true, workOrderId: true }, distinct: ['cutOrderId', 'workOrderId'] })
  const workOrders = new Map((await tx.workOrder.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.workOrderId))] } }, select: { id: true, partyId: true } })).map((row) => [row.id, row.partyId]))
  const out = new Map<string, { partyId: string | null; everyParty: boolean }>()
  for (const id of cutOrderIds) {
    const parties = new Set(lines.filter((line) => line.cutOrderId === id).map((line) => workOrders.get(line.workOrderId) ?? null))
    const named = [...parties].filter((party): party is string => party !== null)
    out.set(id, parties.has(null) || named.length > 1 ? { partyId: null, everyParty: true } : { partyId: named[0] ?? null, everyParty: false })
  }
  return out
}
// ---- end B-PR-08a

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
    const customers = await customersOf(tx, rows.map((row) => row.id)) // B-PR-08a part 2
    return rows.map((row) => {
      const workOrders = [...new Set(row.lines.map((line) => line.workOrderSize.workOrder.number))]
      return {
        recordId: row.id,
        companyId: row.companyId,
        siteId: row.siteId,
        ...(customers.get(row.id) ?? { partyId: null, everyParty: false }), // B-PR-08a part 2
        number: row.number,
        title: [row.item.name, row.itemColour?.code].filter((part) => part).join(' '),
        subtitle: workOrders.slice(0, 3).join(', ') + (workOrders.length > 3 ? ` +${workOrders.length - 3}` : ''),
        status: row.status,
        words: [row.item.code, row.markerName, row.kind === 'FABRIC' ? 'fabric' : 'leather', ...workOrders],
      }
    })
  },
})
