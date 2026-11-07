import { definePartnerView } from '../view'

/**
 * The partner's own account (modules/parties; the record "Ask a question" uses on a page with no record of its own, design
 * portal.frame › thread): its thread only, never a search result. Our code for them and their name. Never the internal
 * note.
 */
export default definePartnerView({
  recordType: 'Party',
  group: null,
  kinds: ['CUSTOMER', 'SUPPLIER', 'SUBCONTRACTOR', 'GUEST'],
  async read(client, ids) {
    const rows = await client.party.findMany({ where: { id: { in: [...ids] } }, select: { id: true, companyId: true, code: true, legalName: true, tradeName: true, status: true } })
    return rows.map((row) => ({ id: row.id, companyId: row.companyId, theirRef: null, ourRef: row.code, subtitle: row.tradeName?.trim() || row.legalName, status: row.status, date: null, words: [] }))
  },
})
