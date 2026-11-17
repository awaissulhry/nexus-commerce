import { bySubjectIn, defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Projects (modules/product/projects, B-TH-066; threads plan TH-5, PROJ-G02, PROJ.home-F05; opens in Products › Development ›
 * Projects): by number (PRJ-26-012) and name, with its outside company's name (none: office only). Scope as the projects list
 * reads it: company and outside company (an office-only project names no party: null reaches every grant), no site; read with
 * threads.read, as its thread. Never the goal, the outcome's words, the lead or any person (the office's own fields; a project
 * holds no money). Made, changed and moved re-read it; its outside company renamed re-indexes its projects. The portal finds a
 * project only through its partner view (platform/search/partner/views/project.ts: members only).
 */
export default defineIndexer({
  recordType: 'Project',
  area: 'products',
  viewPermission: 'threads.read',
  on: {
    'project.created': 'subject',
    'project.changed': 'subject',
    'project.status_changed': 'subject',
    'party.updated': bySubjectIn((tx, partyId, take) => tx.project.findMany({ where: { partyId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.project.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, partyId: true, number: true, name: true, status: true, seasonCode: true, party: { select: { code: true, legalName: true, tradeName: true } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: null,
      partyId: row.partyId,
      number: row.number,
      title: row.name,
      subtitle: row.party ? partyName(row.party) : null,
      status: row.status,
      words: [row.seasonCode, ...(row.party ? [row.party.code, row.party.legalName, row.party.tradeName] : [])],
    }))
  },
})
