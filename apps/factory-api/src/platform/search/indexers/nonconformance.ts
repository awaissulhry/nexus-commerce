import { bySubjectIn, defineIndexer, idWhere, partyName } from '../indexer'
import { EVERY_PARTY_MARKER, ncrCustomersOf, NO_CUSTOMER, partyOfCustomers } from '../../../modules/quality/wall' // B-PR-08a part 2

/**
 * Nonconformances, NCR (modules/quality/ncr; quality.ncr.view; opens in Quality › Nonconformances): by number, its title,
 * and what it is about — the work order, the lot, the material, the style (code and name), the garment's serial, the
 * supplier's name and code. Scope as the NCR list: company and site. NEVER who found it (a worker, Statuto art. 4), its
 * description or a decision's words, and never a cost. Raised, changed and moved along its stages re-read it; a style or
 * a supplier renamed re-indexes its NCRs. B-PR-08a: and the customers it names (the quality wall, B-PR-06).
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
        style: { select: { code: true, name: true, brandPartyId: true } },
        workOrder: { select: { number: true } },
        item: { select: { code: true, name: true } },
        lot: { select: { code: true } },
        supplier: { select: { code: true, legalName: true, tradeName: true } },
        // B-PR-08a part 2: what it names a customer through (modules/quality/wall.ts NCR_FACTS).
        workOrderId: true,
        styleId: true,
        sourceType: true,
        sourceId: true,
        links: { select: { recordType: true, recordId: true } },
      },
    })
    const customers = await ncrCustomersOf(tx, rows) // B-PR-08a part 2
    return rows.map((row) => {
      // B-TH-030 (WALL-G12): an NCR about a private-label style is its brand's (a supplier is never a brand). B-PR-08a part 2: the
      // customers of everything it names — its work order's, its style's brand, its source's, its links' (one: it; several, or
      // customer work of none: every customer only).
      const party = partyOfCustomers(customers.get(row.id) ?? NO_CUSTOMER)
      return {
        recordId: row.id,
        companyId: row.companyId,
        siteId: row.siteId,
        partyId: party === EVERY_PARTY_MARKER ? null : party,
        everyParty: party === EVERY_PARTY_MARKER,
        number: row.number,
        title: row.title,
        // What it is about: its work order, else its lot, else the garment's serial.
        subtitle: row.workOrder?.number ?? row.lot?.code ?? row.serial ?? null,
        status: row.stage,
        words: [row.style?.code, row.style?.name, row.item?.code, row.item?.name, row.lot?.code, row.serial, partyName(row.supplier), row.supplier?.code, row.supplier?.legalName],
      }
    })
  },
})
