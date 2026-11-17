import type { RecordReverseFacts } from '../../../platform/approvals-out/adapter'
import type { Reader } from './store'

/**
 * B-PR-30b (production plan §3 "decide for a brand or undo"; 08-backend §4.6 "COUNTER_OFFER refused once applied"; rules
 * factory-domain production-brand/override reverseVerdict): what putting the customer's answer to our counter-offer back would
 * do. Once the change request was carried out with the counter (ACCEPTED: the customer's yes and our accept in one), the answer
 * stays — the verdict refuses in words (APPLIED); before that the answer is only marked put back.
 *
 * Read in the caller's office scope, about ONE request of ONE customer (the counter's own change request): nothing here reads
 * or names another customer. The COUNTER_OFFER adapter (B-PR-26) may give its own `reverseFacts`; platform/approvals-out
 * override.ts reads this one when it does not.
 */
export async function counterReverseFacts(client: Reader, requestId: string): Promise<RecordReverseFacts> {
  const carried = await client.orderChangeRequest.count({ where: { counterApprovalId: requestId, status: 'ACCEPTED' } })
  return { sampleKind: null, cut: null, passedGate: false, applied: carried > 0, held: null }
}
