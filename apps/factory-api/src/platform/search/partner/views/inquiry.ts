import { customerRefOf } from '@nexus/factory-domain/sales/customer-numbers'
import type { InquiryStatus } from '@nexus/factory-domain/sales/inquiries/rules'
import { subjectOf } from '@nexus/factory-domain/sales/portal-requests/rules'
import { requestStateOf } from '@nexus/factory-domain/sales/portal-requests/state'
import { definePartnerView, equalsTyped, holdsTyped, idsOf, type PartnerReader, type PartnerRecord } from '../view'

// ---- follow-up th-backend-d (Not an order → Closed): a closed request reads with the customer's own word, as the portal's request
// page and list say it (factory-domain sales/portal-requests/state.ts requestStateOf): LOST reads CLOSED; WITHDRAWN reads WITHDRAWN
// ("Withdrawn", the customer's own act, B-TH-095 — th3-web-c follow-up); DECLINED reads
// DECLINED, or CLOSED when it was declined as "Not an order" (B-TH-043) — the decline reason is an office column the partner role
// never reads, so it is read through the reader's `inTenant` (../view PartnerReader, B-TH-073's one way to read a tenant column for a
// portal person): only the ids the partner read gave, of the session's own party. Every other state keeps its code as before.
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
 * order" and LOST read CLOSED, never the office's DECLINED or LOST; th3-web-c: WITHDRAWN reads WITHDRAWN, "Withdrawn").
 */
export default definePartnerView({
  recordType: 'Inquiry',
  group: 'orders',
  kinds: ['CUSTOMER'],
  async read(client, ids, reader?: PartnerReader): Promise<PartnerRecord[]> {
    const rows = await client.inquiry.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, companyId: true, number: true, customerRef: true, customerSeq: true, status: true, receivedAt: true, request: true },
    })
    // ---- follow-up th-backend-d (Not an order → Closed): the declined ones of the session's own party, read for the person in the tenant.
    const declined = rows.filter((row) => row.status === 'DECLINED').map((row) => row.id)
    let notAnOrder = new Set<string>()
    if (declined.length > 0 && reader) {
      const own = await client.party.findMany({ select: { id: true }, take: 2 })
      if (own.length === 1) notAnOrder = new Set(idsOf(await reader.inTenant((tenant) => tenant.inquiry.findMany({ where: { id: { in: declined }, partyId: own[0]!.id, declineReason: 'NOT_AN_ORDER' }, select: { id: true } }))))
    }
    // ---- end follow-up th-backend-d
    return rows.map((row) => ({ id: row.id, companyId: row.companyId, theirRef: row.customerRef, ourRef: customerRefOf('REQUEST', row.customerSeq), subtitle: subjectOf(null, row.request), status: partnerStatusOf(row.status, notAnOrder.has(row.id) ? 'NOT_AN_ORDER' : null), date: row.receivedAt, words: [subjectOf(null, row.request)] }))
  },
  async lookup(client, typed, take) {
    return idsOf(await client.inquiry.findMany({ where: { OR: [{ number: equalsTyped(typed) }, { customerRef: holdsTyped(typed) }] }, select: { id: true }, orderBy: { receivedAt: 'desc' }, take }))
  },
})
