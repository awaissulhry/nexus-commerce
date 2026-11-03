import { bySubjectIn, defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Corrective actions, CAPA and 8D (modules/quality/capa, B-W2b-108; quality.capa.view; opens in Quality › Problems ›
 * Corrective actions): by number and title, with the customer an 8D is written for (name and code) and its type. Scope as
 * the CAPA list: company and customer (an internal CAPA no party: null reaches every grant), no site. Never the problem
 * statement, an action's words or a person. Opened, changed and moved re-read it; a customer renamed re-indexes its 8Ds.
 * (The web's RECORD_PAGES and search words for Capa come with the screens, B-W2b-119.)
 */
export default defineIndexer({
  recordType: 'Capa',
  area: 'quality',
  viewPermission: 'quality.capa.view',
  on: {
    'capa.opened': 'subject',
    'capa.changed': 'subject',
    'capa.stage_changed': 'subject',
    'party.updated': bySubjectIn((tx, partyId, take) => tx.capa.findMany({ where: { customerId: partyId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.capa.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, customerId: true, number: true, title: true, type: true, status: true, customer: { select: { code: true, legalName: true, tradeName: true } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: null,
      partyId: row.customerId,
      number: row.number,
      title: row.title,
      subtitle: row.customer ? partyName(row.customer) : row.type === 'EIGHT_D' ? '8D' : 'CAPA',
      status: row.status,
      words: [row.customer?.code, row.customer?.legalName, row.customer?.tradeName, row.type === 'EIGHT_D' ? '8D' : 'CAPA'],
    }))
  },
})
