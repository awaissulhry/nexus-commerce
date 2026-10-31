import { bySubjectIn, defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Stock locations (modules/inventory/locations; inventory.locations.view; opens in Settings › Locations): by code (the
 * code on its label), name, the location it sits in, and a workshop's stock location by its workshop's name and code.
 * Scope as the locations list: company and site. Made, renamed, moved and archived re-read it
 * (`inventory.location_changed`, B-W2b-23, also from a sheet's import); a workshop renamed re-indexes its locations.
 */
export default defineIndexer({
  recordType: 'Location',
  area: 'warehouse',
  viewPermission: 'inventory.locations.view',
  on: {
    'inventory.location_changed': 'subject',
    'party.updated': bySubjectIn((tx, partyId, take) => tx.location.findMany({ where: { partyId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.location.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        companyId: true,
        siteId: true,
        code: true,
        name: true,
        status: true,
        parent: { select: { code: true } },
        party: { select: { code: true, legalName: true, tradeName: true } },
      },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      partyId: null,
      number: row.code,
      title: row.name,
      // Inside which location, or whose workshop it is.
      subtitle: row.parent?.code ?? partyName(row.party),
      status: row.status,
      words: [partyName(row.party), row.party?.code, row.party?.legalName],
    }))
  },
})
