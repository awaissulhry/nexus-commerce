import type { RecordReverseFacts } from '../../../platform/approvals-out/adapter'
import type { Reader } from './store'

/**
 * B-PR-30b (production plan §3 "decide for a brand or undo"; 08-backend §4.6 "COUNTER_OFFER refused once applied"; rules
 * factory-domain production-brand/override reverseVerdict): what putting the customer's answer to our counter-offer back would
 * do. Once the change request was carried out with the counter (ACCEPTED: the customer's yes and our accept in one), the answer
 * stays — the verdict refuses in words (APPLIED); before that the answer is only marked put back. B-PR-40 (schema wave 5/5, the
 * guard line of B-PR-26): a yes still waiting for our accept is put back too — it is no yes any more: the counter lapses
 * (factory-domain counterStateOf), the database refuses the request's accept and lets the office refuse it in words; a no is
 * put back freely (its request was withdrawn already).
 *
 * Read in the caller's office scope, about ONE request of ONE customer (the counter's own change request): nothing here reads
 * or names another customer. The COUNTER_OFFER adapter (B-PR-26) may give its own `reverseFacts`; platform/approvals-out
 * override.ts reads this one when it does not.
 */
export async function counterReverseFacts(client: Reader, requestId: string): Promise<RecordReverseFacts> {
  const carried = await client.orderChangeRequest.count({ where: { counterApprovalId: requestId, status: 'ACCEPTED' } })
  return { sampleKind: null, cut: null, passedGate: false, applied: carried > 0, held: null }
}
