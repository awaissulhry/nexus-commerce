import { customerRefOf } from '@nexus/factory-domain/sales/customer-numbers'
import type { InquiryStatus } from '@nexus/factory-domain/sales/inquiries/rules'
import { subjectOf } from '@nexus/factory-domain/sales/portal-requests/rules'
import { requestStateOf } from '@nexus/factory-domain/sales/portal-requests/state'
import { definePartnerView, equalsTyped, holdsTyped, idsOf } from '../view'

// ---- follow-up th-backend-d (Not an order → Closed): a closed request reads with the customer's own word, as the portal's request
// page and list say it (factory-domain sales/portal-requests/state.ts requestStateOf): LOST and WITHDRAWN read CLOSED; DECLINED reads
// DECLINED, or CLOSED when it was declined as "Not an order" (B-TH-043) — the decline reason is an office column the partner role
// never reads, so `refine` reads it in the tenant's system scope. Every other state keeps its code as before.
const CLOSING = new Set<string>(['DECLINED', 'LOST', 'WITHDRAWN'])
const partnerStatusOf = (status: string, declineReason: string | null = null): string => (CLOSING.has(status) ? requestStateOf({ status: status as InquiryStatus, quoteStatus: null, orderStatus: null, declineReason }) : status)
// ---- end follow-up th-backend-d

/**
 * A customer's requests (B-TH-103; threads plan G1, PR-20; modules/sales/portal-requests; the office index's
 * ../../indexers/inquiry.ts): every inquiry of its party, from any door (the portal, a mail, a call), read in the PARTNER scope
 * (the party's row-level security and column grants of factory-db's sales-intake wave B-TH-009: never the assignee, the office
 * note, the close words, the target price, the prospect, the mail or the tech pack). Their reference first, then — th2-backend
 * step 7 (threads plan §0.5, counts do not leak) — the customer's OWN number "#7" (never the office's INQ-… series), its subject
 * (the request's first line) under it and as words the partner may type. Its thread opens on it (platform/threads/partner): the
 * customer's request words are its first message. A closed request carries the customer's own word (follow-up th-backend-d: "Not an
 * order", LOST and WITHDRAWN read CLOSED, never the office's DECLINED or LOST).
 */
export default definePartnerView({
  recordType: 'Inquiry',
  group: 'orders',
  kinds: ['CUSTOMER'],
  async read(client, ids) {
    const rows = await client.inquiry.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, companyId: true, number: true, customerRef: true, customerSeq: true, status: true, receivedAt: true, request: true },
    })
    return rows.map((row) => ({ id: row.id, companyId: row.companyId, theirRef: row.customerRef, ourRef: customerRefOf('REQUEST', row.customerSeq), subtitle: subjectOf(null, row.request), status: partnerStatusOf(row.status), date: row.receivedAt, words: [subjectOf(null, row.request)] }))
  },
  // ---- follow-up th-backend-d (Not an order → Closed): the declined ones of the person's own party, read in the system scope.
  async refine(system, records, partyId) {
    const declined = records.filter((record) => record.status === 'DECLINED').map((record) => record.id)
    if (declined.length === 0) return [...records]
    const notAnOrder = new Set(idsOf(await system.inquiry.findMany({ where: { id: { in: declined }, partyId, declineReason: 'NOT_AN_ORDER' }, select: { id: true } })))
    return records.map((record) => (notAnOrder.has(record.id) ? { ...record, status: partnerStatusOf('DECLINED', 'NOT_AN_ORDER') } : record))
  },
  // ---- end follow-up th-backend-d
  async lookup(client, typed, take) {
    return idsOf(await client.inquiry.findMany({ where: { OR: [{ number: equalsTyped(typed) }, { customerRef: holdsTyped(typed) }] }, select: { id: true }, orderBy: { receivedAt: 'desc' }, take }))
  },
})
