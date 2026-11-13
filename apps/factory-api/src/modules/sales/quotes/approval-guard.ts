import { DomainError, type Issue } from '@nexus/factory-domain/core/errors'

/**
 * Nobody approves their own quote request (B-W2b-377; follow-up XF5:01; Owner answer Q3 of W2b-5 = A, the Owner included):
 * the quote approval's yes and no are never by the office person who asked (`QuoteApproval.createdById`). The route checks it
 * first and answers 403 in words (`assertNotOwnQuoteApproval`, the words W1 said); the database is the last word (B-W2b-363's
 * trigger `QuoteApproval_not_own`: check_violation 'sales: quote approval … is decided by another person than the one who
 * asked for it …'), and a write that reaches it past the check (a race, a later path) answers 409 in the same words
 * (`decidingQuote`), never a 500. A reopen (WITHDRAWN by the asker) passes both.
 */

export const OWN_QUOTE_APPROVAL_WORDS = 'You asked for this approval: another approver decides.'
const ISSUE: Issue = { path: 'refusal/OWN_REQUEST', message: OWN_QUOTE_APPROVAL_WORDS }

/** 403 in words when the person deciding asked for it (a request asked by nobody — written by the system — passes). */
export function assertNotOwnQuoteApproval(pending: { readonly createdById: string | null }, actorId: string): void {
  if (pending.createdById !== null && pending.createdById === actorId) throw new DomainError('forbidden', OWN_QUOTE_APPROVAL_WORDS, [ISSUE])
}

/** The database's refusal of a quote decided by its asker, as a 409 in words; null for anything else. */
export function ownQuoteDecisionRefusal(error: unknown): DomainError | null {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  if (cause?.originalCode !== '23514' || typeof cause.originalMessage !== 'string' || !/^sales: quote approval \S+ is decided by another person than the one who asked/.test(cause.originalMessage)) return null
  return new DomainError('conflict', OWN_QUOTE_APPROVAL_WORDS, [ISSUE])
}

/** Runs the write of a quote's decision; the database's own-request refusal comes back as a 409 in words. */
export async function decidingQuote<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    throw ownQuoteDecisionRefusal(error) ?? error
  }
}
