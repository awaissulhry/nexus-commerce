import type { BusinessDate } from '../../core/time'
import type { QuoteStatus, QuoteVersionStatus } from './quotes'

/**
 * The customer's answer to a sent quote through its one-off link (B-W1-24; A1 §2.5 Quote: "accept only on the latest
 * version, through a valid link, with a typed name (ported)"; SAL-093, SAL-157, SAL-304; PLAN §4.7 stage 06a-accept),
 * pure. The link (QUOTE_ACCEPT) opens one quote; the version it shows is the one it was sent with (send.ts
 * versionOfLink). The typed name and the email check are the link's evidence rules (links/evidence: an accept needs the
 * typed name, and the address the link went to when it has one); the rules here are the quote's:
 *
 *   state        when                                                     accept / decline
 *   OPEN         the link's version is the quote's latest SENT version,  yes
 *                the quote is SENT and the offer's last day has not passed
 *   EXPIRED      as OPEN, but past validUntil (no expiry job: computed)   no: "ask for a new one"
 *   REVISING     the office is making a new version (the quote is a       no: the new version comes by mail
 *                draft again); this one is still SENT
 *   SUPERSEDED   a newer version was sent (this one is SUPERSEDED)        no: "replaced by version N"
 *   ACCEPTED,    the version was answered                                 no
 *   DECLINED
 *   CANCELLED    the office withdrew the quote                            no
 *
 * An answer names the version the page showed (`versionId`): it must be the link's version, so a page left open while
 * the office sent a newer version can never accept what the customer did not read. A version that states no right of
 * withdrawal (a made-to-measure unit for a consumer) is accepted only with that statement accepted (Codice del Consumo
 * art. 59(c)).
 */

export const LINK_QUOTE_STATES = ['OPEN', 'EXPIRED', 'REVISING', 'SUPERSEDED', 'ACCEPTED', 'DECLINED', 'CANCELLED'] as const
export type LinkQuoteState = (typeof LINK_QUOTE_STATES)[number]

export interface LinkVersionFacts {
  readonly id: string
  readonly revision: number
  readonly status: QuoteVersionStatus
  readonly validUntil: BusinessDate | null
  readonly noWithdrawal: boolean
}

export interface LinkQuoteFacts {
  readonly quoteStatus: QuoteStatus
  /** The link's version (send.ts versionOfLink). */
  readonly version: LinkVersionFacts
  /** The revisions of the quote's SENT versions (normally at most one). */
  readonly sentRevisions: readonly number[]
  /** The quote's newest revision (a newer one: SUPERSEDED or REVISING says which). */
  readonly currentRevision: number
  readonly today: BusinessDate
}

export interface LinkQuoteStatus {
  readonly state: LinkQuoteState
  /** In words, for the link page. */
  readonly message: string
  /** The answers the page may offer now. */
  readonly canAnswer: boolean
}

/** Where the link's version stands for its customer (see the module comment). */
export function linkQuoteState(facts: LinkQuoteFacts): LinkQuoteStatus {
  const { version, quoteStatus } = facts
  const newer = facts.currentRevision > version.revision ? facts.currentRevision : null
  if (version.status === 'ACCEPTED') return { state: 'ACCEPTED', message: `You accepted version ${version.revision} of this quote.`, canAnswer: false }
  if (version.status === 'DECLINED') return { state: 'DECLINED', message: `You declined version ${version.revision} of this quote.`, canAnswer: false }
  if (version.status === 'CANCELLED' || quoteStatus === 'CANCELLED') return { state: 'CANCELLED', message: 'The sender withdrew this quote.', canAnswer: false }
  // Only the quote's latest SENT version is answered (A1 §2.5).
  const latestSent = facts.sentRevisions.length === 0 ? null : Math.max(...facts.sentRevisions)
  const isLatestSent = version.status === 'SENT' && latestSent === version.revision
  if (!isLatestSent) {
    if (version.status === 'SUPERSEDED' || (latestSent !== null && latestSent > version.revision)) {
      return { state: 'SUPERSEDED', message: `This is version ${version.revision}: version ${newer ?? latestSent} replaced it and was sent to you. Open the newest link you received, or ask for a new one.`, canAnswer: false }
    }
    return { state: 'CANCELLED', message: 'This quote cannot be answered through this link.', canAnswer: false }
  }
  if (quoteStatus !== 'SENT') {
    return { state: 'REVISING', message: `The sender is preparing a new version of this quote${newer ? ` (version ${newer})` : ''}: it will reach you by e-mail.`, canAnswer: false }
  }
  if (version.validUntil !== null && version.validUntil < facts.today) {
    return { state: 'EXPIRED', message: `The offer ended on ${version.validUntil}. Ask for a new one.`, canAnswer: false }
  }
  return { state: 'OPEN', message: version.validUntil ? `The offer stands until ${version.validUntil}.` : 'The offer is open.', canAnswer: true }
}

export interface AnswerInput extends LinkQuoteFacts {
  readonly action: 'accept' | 'decline'
  /** The version the page showed and the customer answers. */
  readonly askedVersionId: string
  /** The customer accepted the no-withdrawal statement (accept only). */
  readonly noWithdrawalAccepted: boolean
}

export interface AnswerProblem {
  readonly state: LinkQuoteState | 'WRONG_VERSION' | 'NO_WITHDRAWAL_STATEMENT'
  readonly path: string
  readonly message: string
}

/**
 * Why this answer is refused, or null: the link's version must be the one asked, still OPEN (the quote's latest SENT
 * version, the quote SENT, the offer not past its day), and an accept of a version without a withdrawal right states
 * that the customer accepted that.
 */
export function answerProblem(input: AnswerInput): AnswerProblem | null {
  if (input.askedVersionId !== input.version.id) {
    return { state: 'WRONG_VERSION', path: 'body/versionId', message: `This link is for version ${input.version.revision} of the quote: reload the page and answer the version it shows.` }
  }
  const status = linkQuoteState(input)
  if (!status.canAnswer) return { state: status.state, path: 'body/versionId', message: status.message }
  if (input.action === 'accept' && input.version.noWithdrawal && !input.noWithdrawalAccepted) {
    return {
      state: 'NO_WITHDRAWAL_STATEMENT',
      path: 'body/noWithdrawalAccepted',
      message: 'This order is made to measure: confirm that you accept there is no right of withdrawal (Codice del Consumo art. 59(c)).',
    }
  }
  return null
}
