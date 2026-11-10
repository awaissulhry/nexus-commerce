import { bySubjectIn, defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Sample rounds (modules/sales/samples, B-W2b-246; sales.samples.view; opens in Products › Development › Samples &
 * prototypes, B-W2b-261): by number, with the style's code and name and the customer it is for; the kind and round in
 * plain words. Scope as the rounds list: company and customer (an internal round names no party: null reaches every
 * grant), no site. Never the instructions, the charge (a price) or a person. Asked, changed, moved, cancelled and decided
 * re-read it; a customer renamed or a style renamed re-indexes their rounds.
 */
const KIND_WORDS: Readonly<Record<string, string>> = { PROTO: 'Proto', FIT: 'Fit', SALESMAN: 'Salesman', PRE_PRODUCTION: 'Pre-production', CERTIFICATION: 'CE test sample', BRAND: 'Brand sample' }

export default defineIndexer({
  recordType: 'SampleRound',
  area: 'products',
  viewPermission: 'sales.samples.view',
  on: {
    'sample_round.requested': 'subject',
    'sample_round.changed': 'subject',
    'sample_round.decided': 'subject',
    'party.updated': bySubjectIn((tx, partyId, take) => tx.sampleRound.findMany({ where: { partyId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
    'style.updated': bySubjectIn((tx, styleId, take) => tx.sampleRound.findMany({ where: { styleId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.sampleRound.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        companyId: true,
        partyId: true,
        number: true,
        kind: true,
        roundNo: true,
        stage: true,
        style: { select: { code: true, name: true } },
        party: { select: { code: true, legalName: true, tradeName: true } },
      },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: null,
      partyId: row.partyId,
      number: row.number,
      title: `${row.style.code} · ${KIND_WORDS[row.kind] ?? row.kind} · round ${row.roundNo}`,
      subtitle: row.party ? partyName(row.party) : row.style.name,
      status: row.stage,
      words: [row.style.code, row.style.name, ...(row.party ? [row.party.code, row.party.legalName, row.party.tradeName] : [])],
    }))
  },
})
