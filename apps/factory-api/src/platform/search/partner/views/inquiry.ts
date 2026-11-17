import { customerRefOf } from '@nexus/factory-domain/sales/customer-numbers'
import { subjectOf } from '@nexus/factory-domain/sales/portal-requests/rules'
import { definePartnerView, equalsTyped, holdsTyped, idsOf } from '../view'

/**
 * A customer's requests (B-TH-103; threads plan G1, PR-20; modules/sales/portal-requests; the office index's
 * ../../indexers/inquiry.ts): every inquiry of its party, from any door (the portal, a mail, a call), read in the PARTNER scope
 * (the party's row-level security and column grants of factory-db's sales-intake wave B-TH-009: never the assignee, the office
 * note, the close words, the target price, the prospect, the mail or the tech pack). Their reference first, then — th2-backend
 * step 7 (threads plan §0.5, counts do not leak) — the customer's OWN number "#7" (never the office's INQ-… series), its subject
 * (the request's first line) under it and as words the partner may type. Its thread opens on it (platform/threads/partner): the
 * customer's request words are its first message.
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
    return rows.map((row) => ({ id: row.id, companyId: row.companyId, theirRef: row.customerRef, ourRef: customerRefOf('REQUEST', row.customerSeq), subtitle: subjectOf(null, row.request), status: row.status, date: row.receivedAt, words: [subjectOf(null, row.request)] }))
  },
  async lookup(client, typed, take) {
    return idsOf(await client.inquiry.findMany({ where: { OR: [{ number: equalsTyped(typed) }, { customerRef: holdsTyped(typed) }] }, select: { id: true }, orderBy: { receivedAt: 'desc' }, take }))
  },
})
