import type { RecordReverseFacts } from '../../../platform/approvals-out/adapter'
import type { Reader } from './store'

/**
 * B-PR-30b (production plan §3 "decide for a brand or undo"; 08-backend §4.6 "COUNTER_OFFER refused once applied"; rules
 * factory-domain production-brand/override reverseVerdict): what putting the customer's answer to our counter-offer back would
 * do. Once the change request was carried out with the counter (ACCEPTED: the customer's yes and our accept in one), the answer
 * stays — the verdict refuses in words (APPLIED); before that the answer is only marked put back (B-PR-26: but a yes waiting for
 * our accept is kept in words, AGREED — the database moves such a request on only by that accept; a no is put back freely).
 *
 * Read in the caller's office scope, about ONE request of ONE customer (the counter's own change request): nothing here reads
 * or names another customer. The COUNTER_OFFER adapter (B-PR-26) may give its own `reverseFacts`; platform/approvals-out
 * override.ts reads this one when it does not.
 */
export async function counterReverseFacts(client: Reader, requestId: string): Promise<RecordReverseFacts> {
  const carried = await client.orderChangeRequest.count({ where: { counterApprovalId: requestId, status: 'ACCEPTED' } })
  // B-PR-26: the customer said yes and we have not carried it out yet (the request stays COUNTERED until the kind's accept): the
  // database moves such a request on only by that accept (COUNTERED → ACCEPTED exactly when the counter was approved), so the yes
  // is kept, in words (a no is put back freely: its request was withdrawn already).
  const agreed = carried > 0 ? 0 : await client.orderChangeRequest.count({ where: { counterApprovalId: requestId, status: 'COUNTERED' } })
  return { sampleKind: null, cut: null, passedGate: false, applied: carried > 0, held: agreed > 0 ? COUNTER_AGREED_KEPT : null }
}

/** B-PR-26: the customer's yes to our counter-offer, not carried out yet, is kept (the office's words). */
const COUNTER_AGREED_KEPT = Object.freeze({
  code: 'AGREED',
  words: {
    it: "Il sì del cliente alla nostra controproposta resta com'è: accetta la richiesta per eseguirla, oppure scrivi al cliente nella conversazione dell'ordine.",
    en: "The customer's yes to our counter-offer stays as it is: accept the request to carry it out, or write to the customer in the order's thread.",
  },
})
