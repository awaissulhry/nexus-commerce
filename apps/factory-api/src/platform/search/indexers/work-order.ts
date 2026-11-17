import { bySubjectIn, defineIndexer, idWhere } from '../indexer'

/**
 * Work orders (modules/production/work-orders; workorders.view): by number and batch number, the style's code and name.
 * Scope as the work-order list: company and site. Never a worker (Statuto art. 4) and never a cost. A style renamed
 * re-indexes its work orders. B-PR-08a: and its customer (the list's wall, B-PR-03).
 */
export default defineIndexer({
  recordType: 'WorkOrder',
  area: 'production',
  viewPermission: 'workorders.view',
  on: {
    'workorder.created': 'subject',
    'workorder.changed': 'subject',
    'workorder.released': 'subject',
    'workorder.status_changed': 'subject',
    'workorder.finished_to_stock': 'subject',
    'workorder.finished_reversed': 'subject',
    'style.updated': bySubjectIn((tx, styleId, take) => tx.workOrder.findMany({ where: { styleId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.workOrder.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, siteId: true, /* B-PR-08a */ partyId: true, number: true, batchNumber: true, status: true, style: { select: { code: true, name: true } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      // ---- B-PR-08a part 2 (B-TH-030 leaves this entry to the production lane): its customer (WorkOrder.partyId, B-PR-01: one per
      // work order); a work order of none (mixed before the rule, our own range) is every customer's: everyParty.
      partyId: row.partyId,
      everyParty: row.partyId === null,
      // ---- end B-PR-08a
      number: row.number,
      title: row.style.name,
      subtitle: row.style.code,
      status: row.status,
      words: [row.batchNumber],
    }))
  },
})
