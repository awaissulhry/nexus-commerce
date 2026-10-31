import { bySubjectIn, defineIndexer, idWhere } from '../indexer'

/**
 * Garment label templates (modules/compliance/labels; their list asks compliance.certificates.view; opens in Compliance ›
 * Labels & marking): by code (one entry per revision: the code typed whole finds each revision), name, the style it is
 * made for (code and name). Scope as the labels list: company, nullable (a template of no company reaches every company).
 * Saved, activated and retired re-read it; a style renamed re-indexes its templates.
 */
export default defineIndexer({
  recordType: 'LabelTemplate',
  area: 'compliance',
  viewPermission: 'compliance.certificates.view',
  on: {
    'compliance.label_template_saved': 'subject',
    'compliance.label_template_activated': 'subject',
    'compliance.label_template_retired': 'subject',
    'style.updated': bySubjectIn((tx, styleId, take) => tx.labelTemplate.findMany({ where: { styleId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.labelTemplate.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, code: true, revision: true, name: true, status: true, style: { select: { code: true, name: true } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: null,
      partyId: null,
      number: row.code,
      title: row.name,
      // Its revision ("Rev. 2", read alike in Italian and English), then the style it is made for.
      subtitle: [`Rev. ${row.revision}`, row.style ? `${row.style.code} ${row.style.name}` : null].filter(Boolean).join(' · '),
      status: row.status,
      words: [row.style?.code, row.style?.name],
    }))
  },
})
