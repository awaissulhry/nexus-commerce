import { bySubjectIn, defineIndexer, idWhere } from '../indexer'

/**
 * Final inspections (modules/quality/final; quality.inspections.view; opens in Quality › Inspections): by number (an
 * inspection of the W1 history has none: found by its work order), the work order's number and batch number, the style's
 * code and name. Scope as the inspections list: company and site. NEVER the inspector (a worker, Statuto art. 4) and
 * never a defect's words. Opened, assigned, decided and cancelled re-read it; a style renamed re-indexes the inspections
 * of its work orders.
 */
export default defineIndexer({
  recordType: 'Inspection',
  area: 'quality',
  viewPermission: 'quality.inspections.view',
  on: {
    'quality.inspection_opened': 'subject',
    'quality.inspection_assigned': 'subject',
    'quality.inspection_decided': 'subject',
    'quality.inspection_cancelled': 'subject',
    'style.updated': bySubjectIn((tx, styleId, take) => tx.inspection.findMany({ where: { workOrder: { styleId } }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.inspection.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, siteId: true, number: true, status: true, workOrder: { select: { number: true, batchNumber: true, style: { select: { code: true, name: true } } } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      partyId: null,
      number: row.number,
      title: row.workOrder.style.name,
      subtitle: row.workOrder.number,
      status: row.status,
      words: [row.workOrder.style.code, row.workOrder.batchNumber],
    }))
  },
})
