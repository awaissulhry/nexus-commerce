import { defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Customers and suppliers (one Party record; modules/parties; parties.view): found by code, legal and trade name and
 * VAT number or fiscal code. Named as every record names it (the trade name when it has one), the legal name under it. A customer (or brand) opens in Sales, a party that only supplies in Purchasing. Scope as the
 * parties list: its company (null: every company) and the party itself.
 */
export default defineIndexer({
  recordType: 'Party',
  area: 'sales',
  viewPermission: 'parties.view',
  on: { 'party.created': 'subject', 'party.updated': 'subject', 'party.status_changed': 'subject', 'party.tax_identity_changed': 'subject' },
  async read(tx, filter, take) {
    const rows = await tx.party.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, code: true, legalName: true, tradeName: true, roles: true, status: true, taxIdentities: { select: { vatNumber: true, fiscalCode: true } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: null,
      partyId: row.id,
      number: row.code,
      title: partyName(row) ?? row.legalName,
      subtitle: row.tradeName?.trim() ? row.legalName : null,
      status: row.status,
      area: row.roles.some((role) => role === 'CUSTOMER' || role === 'BRAND') || row.roles.length === 0 ? 'sales' : 'purchasing',
      words: row.taxIdentities.flatMap((identity) => [identity.vatNumber, identity.fiscalCode]),
    }))
  },
})
