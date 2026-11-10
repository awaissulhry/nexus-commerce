import { defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Branding sets of private-label brands (B-W2b-247; modules/product/branding-sets; product.styles.view as the sets list;
 * opens in its DetailModal on Products › Colours & artwork): by code and name, and its brand's code and name. Scope as the
 * list: its company and its brand (party). branding_set.changed re-reads it.
 */
export default defineIndexer({
  recordType: 'BrandingSet',
  area: 'products',
  viewPermission: 'product.styles.view',
  on: { 'branding_set.changed': 'subject' },
  async read(tx, filter, take) {
    const rows = await tx.brandingSet.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, partyId: true, code: true, name: true, status: true, party: { select: { code: true, legalName: true, tradeName: true } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: null,
      partyId: row.partyId,
      number: row.code,
      title: row.name,
      subtitle: partyName(row.party),
      status: row.status,
      words: [row.party.code, row.party.legalName, row.party.tradeName],
    }))
  },
})
