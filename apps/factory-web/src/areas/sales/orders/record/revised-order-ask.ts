import type { ApiClient } from '../../../../lib/api/client'
import { askApproval, type AskBody } from '../../../../record-panels/approvals/api'
import { getParty, getQuote } from '../../quotes/api'
import type { Order } from '../api'
import type { Change, Changes } from '../depth/api'
import { confirmationRecipient } from '../depth/model'
import { customerLocaleOf } from './lines-draft'

/**
 * F-OC-201 (order CHANGES tab; 13-backend §1, B-OC-001; 18-lead-settles L5) — the customer's new yes after a change, asked on the
 * REVISION. The old call asked it on the order (`recordType: 'SalesOrder'`), which the server refuses ("A revised order is asked on
 * SalesOrderAmendment."), sent no address with `send: true`, and a priced change asked nobody: every ask failed, the order waited
 * for a yes nobody was asked for. ONE helper for every door that asks — the Lines save (plain with the tick, priced always), its "Ask
 * again", and "Ask {customer}…" on the Customer's agreement for a revision never asked or whose ask expired:
 *
 *   POST /approvals-out { kind: REVISED_ORDER, recordType: SalesOrderAmendment, recordId: <the revision>, question (the customer's
 *   words, in the order's language), dueAt: in 7 days, language: the order's, send + email: the confirmation's own recipient (the
 *   quote's contact with an e-mail, else the first active orders contact with one) — no address: the portal task only }
 *
 * Who may ask: partners.approvals.ask and orders.manage over the order (the route checks both). A revision is never "decided for
 * the customer by us" (the database refuses it).
 */

/** The customer's answer is asked for within a week (the kind allows up to 60 days). */
export const ASK_DAYS = 7

/** Where the ask went: an e-mail to the recipient (and the portal task), or the portal task only (no e-mail address on file). */
export type AskReach = { readonly reach: 'email'; readonly email: string } | { readonly reach: 'portal' }

/**
 * The revision a save asks the customer about — a plain change saved with the tick (`reacceptance: NEEDED`), a priced change the
 * customer must accept (`NOT_ASKED`: nobody asked yet); null: nothing to ask (no amendment: the delivery address alone moved; no
 * yes needed).
 */
export function askTargetOf(done: { readonly amendment?: { readonly id: string; readonly reacceptance: string } | null; readonly change?: Pick<Change, 'id' | 'customer'> | null }): string | null {
  if (done.change) return done.change.customer.decision === 'NOT_ASKED' ? done.change.id : null
  return done.amendment && done.amendment.reacceptance === 'NEEDED' ? done.amendment.id : null
}

/** The ask's body, exactly as the route takes it (13-backend §1). */
export function revisedOrderAskBody(order: Pick<Order, 'language'>, amendmentId: string, question: string, recipient: { readonly email: string } | null, now: number = Date.now()): AskBody {
  return {
    kind: 'REVISED_ORDER',
    recordType: 'SalesOrderAmendment',
    recordId: amendmentId,
    question,
    dueAt: new Date(now + ASK_DAYS * 86_400_000).toISOString(),
    fileIds: [],
    send: recipient !== null,
    ...(recipient ? { email: recipient.email } : {}),
    language: customerLocaleOf(order),
  }
}

/** The address the ask goes to: the confirmation's own rule; a read refused or failed: none (the portal task only). */
export async function askRecipientOf(api: ApiClient, order: Pick<Order, 'partyId' | 'chain'>, read: { readonly quotes: boolean }): Promise<{ readonly name: string; readonly email: string } | null> {
  const quoteId = order.chain.quote?.id ?? null
  try {
    const [party, contactId] = await Promise.all([getParty(api, order.partyId), quoteId && read.quotes ? getQuote(api, quoteId).then((quote) => quote.contactId).catch(() => null) : Promise.resolve(null)])
    return confirmationRecipient(party.contacts, contactId)
  } catch {
    return null
  }
}

/**
 * Ask the customer to re-confirm the revision; a refusal throws (the caller says "the ask could not be sent", the save stands). The
 * recipient as a window already read it (`known`, null: none), else read now.
 */
export async function askRevisedOrder(api: ApiClient, order: Pick<Order, 'language' | 'partyId' | 'chain'>, amendmentId: string, question: string, read: { readonly quotes: boolean }, known?: { readonly name: string; readonly email: string } | null): Promise<AskReach> {
  const recipient = known !== undefined ? known : await askRecipientOf(api, order, read)
  await askApproval(api, revisedOrderAskBody(order, amendmentId, question, recipient))
  return recipient ? { reach: 'email', email: recipient.email } : { reach: 'portal' }
}

/**
 * L5: "Ask {customer}…" — offered on the order's LATEST revision while the order waits for the customer's yes and that revision's
 * ask is NOT_ASKED (never asked: the bug's old revisions, an accepted request that raised the total), EXPIRED or WITHDRAWN; null
 * otherwise (it waits on an open ask, they answered, or no yes is needed).
 */
export function revisionToAskOf(changes: Pick<Changes, 'reapprovalNeededAt' | 'changes'> | null | undefined): { readonly amendmentId: string; readonly revision: number; readonly expired: boolean } | null {
  if (!changes?.reapprovalNeededAt) return null
  const latest = [...changes.changes].sort((a, b) => b.revision - a.revision)[0]
  if (!latest) return null
  const decision = latest.customer.decision
  return decision === 'NOT_ASKED' || decision === 'EXPIRED' || decision === 'WITHDRAWN' ? { amendmentId: latest.id, revision: latest.revision, expired: decision === 'EXPIRED' } : null
}
