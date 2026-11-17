import { defineIndexer, idWhere } from '../indexer'

/**
 * Styles (modules/product/styles; product.styles.view): by code and name, the season and the brand's name. Scope as the
 * style library: its company (null: every company); B-TH-030: a private-label style also its brand (Style.brandPartyId).
 */
export default defineIndexer({
  recordType: 'Style',
  area: 'products',
  viewPermission: 'product.styles.view',
  // B-W2b-227: a name in another language (style.texts_changed) is one more word to find the style by.
  on: { 'style.created': 'subject', 'style.updated': 'subject', 'style.status_changed': 'subject', 'style.duplicated': 'subject', 'style.texts_changed': 'subject' },
  async read(tx, filter, take) {
    const rows = await tx.style.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, code: true, name: true, season: true, status: true, brandPartyId: true, brandParty: { select: { code: true, legalName: true, tradeName: true } } },
    })
    // B-W2b-227: the style's names in every language (StyleText), beside its code and its brand's.
    const texts = rows.length === 0 ? [] : await tx.styleText.findMany({ where: { styleId: { in: rows.map((row) => row.id) } }, select: { styleId: true, name: true } })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: null,
      // B-TH-030 (WALL-G12): a private-label style is its brand's: only people who reach that customer find it (and its brand's
      // name); our own collection (no brand) stays open to every grant.
      partyId: row.brandPartyId,
      number: row.code,
      title: row.name,
      subtitle: [row.season, row.brandParty ? (row.brandParty.tradeName?.trim() || row.brandParty.legalName) : null].filter(Boolean).join(' · ') || null,
      status: row.status,
      words: [...(row.brandParty ? [row.brandParty.code] : []), ...texts.filter((text) => text.styleId === row.id && text.name !== row.name).map((text) => text.name)],
    }))
  },
})
