import { bySubjectIn, defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Nonconformances, NCR (modules/quality/ncr; quality.ncr.view; opens in Quality › Nonconformances): by number, its title,
 * and what it is about — the work order, the lot, the material, the style (code and name), the garment's serial, the
 * supplier's name and code. Scope as the NCR list: company and site. NEVER who found it (a worker, Statuto art. 4), its
 * description or a decision's words, and never a cost. Raised, changed and moved along its stages re-read it; a style or
 * a supplier renamed re-indexes its NCRs.
 */
export default defineIndexer({
  recordType: 'Nonconformance',
  area: 'quality',
  viewPermission: 'quality.ncr.view',
  on: {
    'ncr.created': 'subject',
    'ncr.changed': 'subject',
    'ncr.stage_changed': 'subject',
    'style.updated': bySubjectIn((tx, styleId, take) => tx.nonconformance.findMany({ where: { styleId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
    'party.updated': bySubjectIn((tx, partyId, take) => tx.nonconformance.findMany({ where: { supplierId: partyId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.nonconformance.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        companyId: true,
        siteId: true,
        number: true,
        title: true,
        serial: true,
        stage: true,
        style: { select: { code: true, name: true } },
        workOrder: { select: { number: true } },
        item: { select: { code: true, name: true } },
        lot: { select: { code: true } },
        supplier: { select: { code: true, legalName: true, tradeName: true } },
      },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      partyId: null,
      number: row.number,
      title: row.title,
      // What it is about: its work order, else its lot, else the garment's serial.
      subtitle: row.workOrder?.number ?? row.lot?.code ?? row.serial ?? null,
      status: row.stage,
      words: [row.style?.code, row.style?.name, row.item?.code, row.item?.name, row.lot?.code, row.serial, partyName(row.supplier), row.supplier?.code, row.supplier?.legalName],
    }))
  },
})
