import { bySubjectIn, defineIndexer, idWhere, partyName } from '../indexer'

/**
 * PPE register entries — complaints, non-conformities and recalls of a PPE garment (modules/compliance/register;
 * compliance.register.view; opens in Compliance › PPE register & recalls): by its reference, the style's code and name,
 * the batch numbers and serials it names, the authority's reference, the customer's name and code. Scope as the register:
 * company and customer (nullable: an entry about no customer reaches every grant). NEVER what happened, the
 * investigation or the action (people's words). Opened, changed and closed re-read it; a style or a customer renamed
 * re-indexes its entries.
 */
const WORDS = 50

export default defineIndexer({
  recordType: 'PpeRegisterEntry',
  area: 'compliance',
  viewPermission: 'compliance.register.view',
  on: {
    'compliance.register_entry_opened': 'subject',
    'compliance.register_entry_changed': 'subject',
    'compliance.register_entry_closed': 'subject',
    'style.updated': bySubjectIn((tx, styleId, take) => tx.ppeRegisterEntry.findMany({ where: { styleId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
    'party.updated': bySubjectIn((tx, partyId, take) => tx.ppeRegisterEntry.findMany({ where: { partyId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.ppeRegisterEntry.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        companyId: true,
        partyId: true,
        reference: true,
        batchNumbers: true,
        serials: true,
        authorityReference: true,
        status: true,
        style: { select: { code: true, name: true } },
        party: { select: { code: true, legalName: true, tradeName: true } },
      },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: null,
      partyId: row.partyId,
      number: row.reference,
      title: row.style.name,
      subtitle: [row.style.code, partyName(row.party)].filter(Boolean).join(' · '),
      status: row.status,
      words: [row.authorityReference, row.party?.code, row.party?.legalName, ...row.batchNumbers.slice(0, WORDS), ...row.serials.slice(0, WORDS)],
    }))
  },
})
