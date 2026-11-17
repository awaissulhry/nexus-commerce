import type { OutboundStatus } from './rules'

/**
 * Undo send (B-TH-048; threads plan TH-3, thread-G08, feature T7-F06; Owner decision 6 "undo send, 10 seconds"), pure:
 *
 *   - a mail sent from a record's thread (the composer's Send) waits UNDO_SEND_MS after it was queued before the worker
 *     sends it (EmailOutbound.sendAfter); its OUTBOUND message is held meanwhile (Message.held: no customer reads it);
 *   - in that time the person who sent it may take it back: QUEUED → WITHDRAWN, never claimed for sending (attempts 0) and
 *     only before sendAfter; it never leaves and its message stays held for good (the office still reads it, "Taken back");
 *   - the screen says "Sending…" with Undo until `undoUntilOf`, then the mail's delivery word.
 *
 * Other mail leaves at once (no window): a module's document mail (an invoice, a purchase order, a reminder), a mail the
 * system sends, a sign-in mail. The …_threads_composer_th_guards triggers hold the same rules for every login (a window of
 * at most a minute, the take-back only from QUEUED with no attempt, by an office person); the take-back's time and the
 * sender are the API's (its clock is injected, the database's is not).
 */

/** How long a thread mail waits before it leaves (Owner decision 6). */
export const UNDO_SEND_MS = 10_000
/** The database's cap on a window (…_threads_composer_th_guards: at most a minute after the mail was queued). */
export const UNDO_SEND_CAP_MS = 60_000

/** When a mail queued now may leave. */
export const sendAfterOf = (queuedAt: Date): Date => new Date(queuedAt.getTime() + UNDO_SEND_MS)

/** What the take-back reads of a mail. */
export interface UndoFacts {
  readonly status: OutboundStatus
  readonly attempts: number
  readonly sendAfter: Date | null
  readonly createdById: string | null
}

/**
 * Until when this mail may still be taken back, or null: a mail with a window, still QUEUED, never claimed, before its
 * sendAfter (the screen's "Sending… · Undo").
 */
export function undoUntilOf(facts: Pick<UndoFacts, 'status' | 'attempts' | 'sendAfter'>, now: Date): Date | null {
  if (facts.sendAfter === null || facts.status !== 'QUEUED' || facts.attempts > 0) return null
  return facts.sendAfter.getTime() > now.getTime() ? facts.sendAfter : null
}

/** Is the mail due to leave (no window, or its window has passed)? */
export const isDue = (facts: Pick<UndoFacts, 'sendAfter'>, now: Date): boolean => facts.sendAfter === null || facts.sendAfter.getTime() <= now.getTime()

/** How long the worker still waits before it sends this mail (0: now), at most the database's cap. */
export function waitMsOf(facts: Pick<UndoFacts, 'sendAfter'>, now: Date): number {
  if (facts.sendAfter === null) return 0
  return Math.min(Math.max(0, facts.sendAfter.getTime() - now.getTime()), UNDO_SEND_CAP_MS)
}

/** Why a take-back is refused. */
export const UNDO_REFUSALS = Object.freeze({
  /** The mail left at once: it had no undo window (a document mail, a mail of the system). */
  NO_WINDOW: Object.freeze({
    it: 'Questa mail è partita subito, senza i 10 secondi per annullare l’invio.',
    en: 'This mail went at once, without the 10 seconds to undo the send.',
  }),
  /** Its window passed, or the worker already took it to send (it may have reached the mail service). */
  LEFT: Object.freeze({
    it: 'Questa mail è già partita: non si può più annullare l’invio.',
    en: 'This mail has already left: the send can no longer be undone.',
  }),
  /** It did not go (refused or out of tries): there is nothing to take back. */
  NOT_SENT: Object.freeze({
    it: 'Questa mail non è partita: non c’è niente da annullare.',
    en: 'This mail did not go: there is nothing to undo.',
  }),
  /** Only the person who sent it takes it back (the Undo is theirs, in the 10 seconds after their Send). */
  NOT_YOURS: Object.freeze({
    it: 'Solo chi ha inviato questa mail può annullarne l’invio.',
    en: 'Only the person who sent this mail can undo the send.',
  }),
})
export type UndoRefusal = keyof typeof UNDO_REFUSALS

/**
 * Why this person may not take this mail back now, or null (they may). A mail already taken back is not refused: taking it
 * back again changes nothing (a second click, a repeated call).
 */
export function undoRefusal(facts: UndoFacts, actorId: string, now: Date): UndoRefusal | null {
  if (facts.status === 'WITHDRAWN') return facts.createdById === actorId ? null : 'NOT_YOURS'
  if (facts.sendAfter === null) return 'NO_WINDOW'
  if (facts.createdById !== actorId) return 'NOT_YOURS'
  if (facts.status === 'FAILED') return 'NOT_SENT'
  return undoUntilOf(facts, now) === null ? 'LEFT' : null
}

/** The words of a mail in its window and of a mail taken back (the message's delivery state, the delivery log). */
export const UNDO_WORDS = Object.freeze({
  SENDING: Object.freeze({ it: 'Invio in corso…', en: 'Sending…' }),
  WITHDRAWN: Object.freeze({ it: 'Invio annullato', en: 'Taken back' }),
})
