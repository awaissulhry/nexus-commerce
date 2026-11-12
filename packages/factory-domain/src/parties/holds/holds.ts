import type { Issue } from '../../core/errors'

/**
 * A customer's account on hold (B-W2b-290; SAL-023; design sales.customers record › Tax & terms › "Hold": "Stop new orders
 * and shipments with a reason", "Putting on hold asks for the reason; lifting it too", "Who and when"; customers.block
 * "What it stops: new quotes, orders and shipments; open quotes show a warning"), pure. The rows are factory-db's PartyHold
 * (B-W2b-279): placed with a reason and words, released once with words; never edited or removed: the history is the rows.
 * At most one in force per party, company (or every company) and reason.
 *
 * What a hold in force does, for the company it names (null: every company):
 *
 *   QUOTE     a new or open quote shows a warning (quotes go on: the customer may still ask)
 *   ORDER     a new order waits: the office's typed order and a portal request's are refused in words; the order of an
 *             accepted quote is not made until the hold is released (the acceptance stays), then the office makes it
 *   SHIPMENT  a new shipment waits, and a shipment does not leave (DDT issued, ship): refused in words
 *
 * B-W2b-281's PENDING_APPROVAL order status (not on main yet) turns "waits" into an order that waits for a yes; until then a
 * hold refuses in words, and the office makes the order after the release.
 */

export const HOLD_REASONS = ['CREDIT', 'LEGAL', 'QUALITY_DISPUTE', 'DATA_MISSING', 'OTHER'] as const
export type HoldReason = (typeof HOLD_REASONS)[number]

export const HOLD_LIMITS = Object.freeze({ words: 2000 })

export const HOLD_STAGES = ['QUOTE', 'ORDER', 'SHIPMENT'] as const
export type HoldStage = (typeof HOLD_STAGES)[number]

/** What a hold does at each stage. */
export const HOLD_EFFECT: Readonly<Record<HoldStage, 'WARN' | 'WAIT'>> = Object.freeze({ QUOTE: 'WARN', ORDER: 'WAIT', SHIPMENT: 'WAIT' })

export const REASON_WORDS: Readonly<Record<HoldReason, { readonly en: string; readonly it: string }>> = Object.freeze({
  CREDIT: { en: 'credit', it: 'credito' },
  LEGAL: { en: 'legal', it: 'legale' },
  QUALITY_DISPUTE: { en: 'quality dispute', it: 'contestazione qualità' },
  DATA_MISSING: { en: 'data missing', it: 'dati mancanti' },
  OTHER: { en: 'other', it: 'altro' },
})

/** The words of a placement or a release: 1 to 2000 characters. */
export function holdWordsProblem(words: string | null | undefined, what: 'place' | 'release'): Issue | null {
  const text = (words ?? '').trim()
  if (text === '') return { path: 'words', message: what === 'place' ? 'Say why the account goes on hold.' : 'Say why the hold is lifted.' }
  if (text.length > HOLD_LIMITS.words) return { path: 'words', message: `At most ${HOLD_LIMITS.words} characters.` }
  return null
}

export interface HoldFacts {
  readonly companyId: string | null
  readonly reason: HoldReason
  readonly words: string
  readonly releasedAt: Date | null
}

/** The holds in force for a record of `companyId` (a hold of every company, or of that company). */
export function holdsInForceFor<Hold extends HoldFacts>(holds: readonly Hold[], companyId: string): Hold[] {
  return holds.filter((hold) => hold.releasedAt === null && (hold.companyId === null || hold.companyId === companyId))
}

const STOPS: Readonly<Record<Exclude<HoldStage, 'QUOTE'>, string>> = Object.freeze({
  ORDER: 'new orders wait until it is released (an accepted quote keeps its acceptance; the order is made after the release)',
  SHIPMENT: 'shipments wait until it is released',
})

/** The words of a hold where it stops (or warns): "SEED-C1 is on hold (credit): two invoices overdue. New orders wait …". */
export function holdStopWords(code: string, holds: readonly Pick<HoldFacts, 'reason' | 'words'>[], stage: HoldStage): string {
  const why = holds.map((hold) => `${REASON_WORDS[hold.reason].en}: ${hold.words.trim()}`).join('; ')
  const head = `${code} is on hold (${why}).`
  if (stage === 'QUOTE') return `${head} The quote may go on; new orders and shipments wait until the hold is released.`
  return `${head} ${STOPS[stage].charAt(0).toUpperCase()}${STOPS[stage].slice(1)}.`
}
