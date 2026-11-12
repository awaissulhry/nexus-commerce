import type { FactoryClient } from '@nexus/factory-db'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { holdStopWords, type HoldReason, type HoldStage } from '@nexus/factory-domain/parties/holds/holds'
import type { QuoteIssue } from '@nexus/factory-domain/sales/quotes/quotes'
import type { CommandTx } from '../../../core/command'
import { poNumberProblemFor } from '../company-terms/in-force'
import { holdsInForce } from './holds'

/**
 * What a customer's hold and its terms per company stop (B-W2b-290; SAL-023, SAL-013), for the modules that make the
 * records: one call each, inside their own command (office or system scope: the partner and the floor read no hold).
 *
 *   holdQuoteIssues(db, …)         a quote of a company where the customer is on hold: a WARNING issue (the quote goes on)
 *                                  — sales/quotes views.ts readFacts
 *   orderWaitFor(db, …)            the order of an accepted quote is not made while the customer is on hold for the
 *                                  quote's company, nor without its PO number where the company's terms require one:
 *                                  the wait, or null — sales/orders make.ts (the acceptance stays; POST /sales/orders
 *                                  makes it later, with the PO number when it was missing)
 *   assertOrderMayBeTaken(db, …)   a typed order (the office's, a portal request's, a replacement): 409 on hold, 400 on a
 *                                  missing PO number, in words — sales/orders manual.ts planManualOrder
 *   assertNotOnHold(db, …)         a new shipment, and a shipment leaving: 409 in words while a hold is in force —
 *                                  shipping/shipments shipments.ts and leave.ts
 */

type Reader = FactoryClient | CommandTx

export interface PartyAt {
  readonly partyId: string
  readonly companyId: string
}

const codeOf = async (db: Reader, partyId: string): Promise<string> => (await db.party.findUnique({ where: { id: partyId }, select: { code: true } }))?.code ?? 'The customer'

/** The words of the holds in force for the party with the company at `stage`, or null when none is in force. */
export async function holdWordsAt(db: Reader, at: PartyAt, stage: HoldStage): Promise<string | null> {
  const holds = await holdsInForce(db, at.partyId, at.companyId)
  if (holds.length === 0) return null
  return holdStopWords(await codeOf(db, at.partyId), holds.map((hold) => ({ reason: hold.reason as HoldReason, words: hold.words })), stage)
}

/** The quote's warning while the customer is on hold for its company (none otherwise). */
export async function holdQuoteIssues(db: Reader, at: PartyAt): Promise<QuoteIssue[]> {
  const words = await holdWordsAt(db, at, 'QUOTE')
  return words ? [{ code: 'ACCOUNT_ON_HOLD', severity: 'WARNING', path: 'party/hold', message: words, lineId: null, size: null }] : []
}

export type OrderWait = 'ACCOUNT_ON_HOLD' | 'PO_NUMBER_REQUIRED'

/** Why the order of an accepted quote is not made now, or null: a hold in force first, then a missing PO number. */
export async function orderWaitFor(db: Reader, at: PartyAt, customerRef: string | null | undefined): Promise<OrderWait | null> {
  if ((await holdsInForce(db, at.partyId, at.companyId)).length > 0) return 'ACCOUNT_ON_HOLD'
  const code = await codeOf(db, at.partyId)
  if ((await poNumberProblemFor(db, { id: at.partyId, code }, at.companyId, customerRef)) !== null) return 'PO_NUMBER_REQUIRED'
  return null
}

/** The words of a wait (the office's POST /sales/orders answer). */
export async function orderWaitWords(db: Reader, at: PartyAt, wait: OrderWait, customerRef: string | null | undefined): Promise<string> {
  if (wait === 'ACCOUNT_ON_HOLD') return (await holdWordsAt(db, at, 'ORDER')) ?? 'The customer is on hold: the order waits until the hold is released.'
  return (await poNumberProblemFor(db, { id: at.partyId, code: await codeOf(db, at.partyId) }, at.companyId, customerRef)) ?? 'The customer\'s PO number is needed.'
}

/** A typed order is taken only from a customer not on hold (409) and with its PO number where its terms require one (400). */
export async function assertOrderMayBeTaken(db: Reader, at: PartyAt, customerRef: string | null | undefined): Promise<{ path: string; message: string } | null> {
  const words = await holdWordsAt(db, at, 'ORDER')
  if (words) throw new DomainError('conflict', words, [{ path: 'party/hold', message: 'The customer is on hold for this company.' }])
  const missing = await poNumberProblemFor(db, { id: at.partyId, code: await codeOf(db, at.partyId) }, at.companyId, customerRef)
  return missing ? { path: 'body/customerRef', message: missing } : null
}

/** A shipment is made, and leaves, only while the customer is not on hold for its company: 409 in words. */
export async function assertNotOnHold(db: Reader, at: PartyAt, stage: Extract<HoldStage, 'SHIPMENT'>): Promise<void> {
  const words = await holdWordsAt(db, at, stage)
  if (words) throw new DomainError('conflict', words, [{ path: 'party/hold', message: 'The customer is on hold for this company.' }])
}
