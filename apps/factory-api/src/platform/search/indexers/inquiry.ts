import { bySubjectIn, defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Inquiries and requests for quotation (modules/sales/inquiries, B-W2b-295; sales.inquiries.view; opens in Sales › Inquiries,
 * B-W2b-322, until then in the record panels): by number, with the customer it is from, or the prospect's company, and how it
 * came. Scope as the inquiries list: company and customer (a prospect's inquiry names no party: null reaches every grant), no
 * site. Never what is asked (free words a customer wrote may hold a price), never the target price, never the prospect's name,
 * e-mail or phone (personal data stays in the record). Received, changed and closed re-read it; a customer renamed re-indexes
 * its inquiries.
 */
const SOURCE_WORDS: Readonly<Record<string, string>> = { OFFICE: 'Office inquiry', MAIL: 'E-mail inquiry', PORTAL: 'Portal inquiry', PHONE: 'Phone inquiry', FAIR: 'Fair inquiry' }
/** A prospect's company as typed, unless it looks like an amount (search text never holds one). */
const AMOUNT = /(^|\s)(€|eur|usd|gbp|chf)\s?\d|\d\s?(€|eur|usd|gbp|chf)(\s|$)/i
const safe = (words: string | null): string | null => (words !== null && !AMOUNT.test(words) ? words : null)

export default defineIndexer({
  recordType: 'Inquiry',
  area: 'sales',
  viewPermission: 'sales.inquiries.view',
  on: {
    'inquiry.received': 'subject',
    'inquiry.changed': 'subject',
    'inquiry.closed': 'subject',
    'party.updated': bySubjectIn((tx, partyId, take) => tx.inquiry.findMany({ where: { partyId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.inquiry.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        companyId: true,
        partyId: true,
        number: true,
        status: true,
        source: true,
        prospectCompany: true,
        party: { select: { code: true, legalName: true, tradeName: true } },
      },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: null,
      partyId: row.partyId,
      number: row.number,
      title: (row.party ? partyName(row.party) : null) ?? safe(row.prospectCompany) ?? row.number,
      subtitle: SOURCE_WORDS[row.source] ?? null,
      status: row.status,
      words: row.party ? [row.party.code, row.party.legalName, row.party.tradeName] : [safe(row.prospectCompany)],
    }))
  },
})
