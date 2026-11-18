import type { Issue } from '../core/errors'
import type { Words } from '../portal/tasks/kinds'
import { URGENCY_BATCH_MAX, type AskReason } from './urgency'

/**
 * B-PR-46a — a customer's bulk asks on My production (production plan §3 "Bulk asks: one request per order, one batch; one kind
 * per batch; Approvals shows the batch as one group"; lead picks L25, L26; review fixes R-50, R-51, R-65; the Owner rule
 * 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit, should be
 * able to see it all. And manage it all as well."), pure: the kinds, the limits, the body's own problems and the words.
 *
 *   Ask N         one request per order, all of ONE batch and ONE kind: a pause, a resume or a cancel (the kinds its limits
 *                 open; a cancel follows the company's cut-offs). "Urgent" is never asked here: Mark urgent asks it when it must
 *                 (R-50) — a mark over the quota or from Cutting becomes an "Urgent – asked" (RUSH) of its own batch
 *   Undo          the batch's requests that still wait for our answer are withdrawn; the ones we answered, or countered, stay
 *   the office    the batch is one group in Home › Approvals: accept all (each request re-checked through its own accept, its own
 *                 command) or row by row; refuse all the same
 * At most 50 orders per action (as the urgency marks). Every customer word addresses it with "voi" (fix-portal-1, 2026-11-18).
 */

/** The kinds a customer asks of many orders at once (Ask ▾ on the bulk bar). RUSH only through Mark urgent (R-50). */
export const BULK_ASK_KINDS = ['HOLD', 'RESUME', 'CANCEL'] as const
export type BulkAskKind = (typeof BULK_ASK_KINDS)[number]

/** Every kind a batch of the portal holds: Ask N's and Mark urgent's "Urgent – asked". One kind per batch (the database checks it). */
export const BATCH_ASK_KINDS = ['RUSH', ...BULK_ASK_KINDS] as const
export type BatchAskKind = (typeof BATCH_ASK_KINDS)[number]

/** Orders per bulk action (the same cap as the urgency marks). */
export const BULK_ASK_MAX = URGENCY_BATCH_MAX

/** Requests the office answers in one batch call (a batch holds at most BULK_ASK_MAX). */
export const BATCH_ANSWER_MAX = BULK_ASK_MAX

/** A bulk ask as the customer sends it (one kind for every order named). */
export interface BulkAskBody {
  readonly kind: BulkAskKind
  /** CANCEL: a code of the cancel reasons (required); HOLD: none offered yet (refused); RESUME: none. */
  readonly reasonCode?: string | null | undefined
  /** Their words (HOLD: why, required while no reason list is offered). */
  readonly reason?: string | null | undefined
}

/** A cancel reason as the tenant offers it (sales/change-requests readCancelReasons). */
export interface OfferedReason {
  readonly needsNote: boolean
}

/** The longest words a bulk ask keeps (the request's own limit, sales/change-requests MAX_NOTE). */
export const BULK_REASON_MAX = 2000

const filled = (text: string | null | undefined): boolean => typeof text === 'string' && text.trim() !== ''

/**
 * What the bulk ask's own fields break, for every order alike (so a 400 before any order is asked, never 50 refusals of one
 * mistake). The state of each order — open to the customer, waiting already, paused, cut-offs — is each order's own result.
 */
export function bulkAskProblems(body: BulkAskBody, cancelReasons: ReadonlyMap<string, OfferedReason>): Issue[] {
  const issues: Issue[] = []
  const code = filled(body.reasonCode) ? body.reasonCode!.trim() : null
  if (typeof body.reason === 'string' && body.reason.trim().length > BULK_REASON_MAX) issues.push({ path: 'body/reason', message: `At most ${BULK_REASON_MAX} characters.` })
  switch (body.kind) {
    case 'HOLD':
      // No pause reason list is offered yet (B-PR-25): their words say why.
      if (code !== null) issues.push({ path: 'body/reasonCode', message: 'Pick one of the reasons offered.' })
      if (!filled(body.reason)) issues.push({ path: 'body/reason', message: 'Say why you want to pause, in a few words.' })
      break
    case 'RESUME':
      if (code !== null) issues.push({ path: 'body/reasonCode', message: 'This ask takes no reason code: say it in your words.' })
      break
    case 'CANCEL': {
      if (code === null) {
        issues.push({ path: 'body/reasonCode', message: 'Pick a reason.' })
        break
      }
      const reason = cancelReasons.get(code)
      if (!reason) issues.push({ path: 'body/reasonCode', message: 'Pick one of the reasons offered.' })
      else if (reason.needsNote && !filled(body.reason)) issues.push({ path: 'body/reason', message: 'Say why in a few words.' })
      break
    }
  }
  return issues
}

/** The code of a refusal at its path's end (`body/WAITING`, `body/cells/0/LEATHER_CUT`), or null when the path names a field. */
export function refusalCodeOf(issues: readonly Issue[] | undefined): string | null {
  for (const issue of issues ?? []) {
    const last = issue.path.split('/').pop() ?? ''
    if (/^[A-Z][A-Z_]+$/.test(last)) return last
  }
  return null
}

// ---- the customer's words ("voi") ---------------------------------------------------------------------------------------

/** "Urgent – asked" on a row of Mark urgent that became a request: why it was asked of us, and that we answer. */
export function askedUrgentWords(reason: AskReason, max: number): Words {
  const sent = { it: 'inviato a noi come «Urgente – richiesto»: vi rispondiamo noi.', en: 'sent to us as "Urgent – asked": we answer you.' }
  if (reason === 'CUT') return { it: `Il taglio di questo ordine è iniziato: ${sent.it}`, en: `Cutting has started on this order: ${sent.en}` }
  if (max <= 0) return { it: `Per i vostri ordini le urgenze si chiedono a noi: ${sent.it}`, en: `Urgent marks on your orders are asked of us: ${sent.en}` }
  return max === 1
    ? { it: `Avete già usato la vostra urgenza: ${sent.it}`, en: `You have used your 1 urgent mark: ${sent.en}` }
    : { it: `Avete già usato le vostre ${max} urgenze: ${sent.it}`, en: `You have used your ${max} urgent marks: ${sent.en}` }
}

/** A row of Ask N (or of Mark urgent) that became a request: it waits for our answer. */
export const ASKED_WORDS: Words = Object.freeze({ it: 'Richiesto: vi rispondiamo noi.', en: 'Asked: we answer you.' })

/** Nothing of the batch was asked (409; each order's words at its place). */
export const NONE_ASKED_WORDS: Words = Object.freeze({ it: 'Non è stato chiesto nulla: vedete ogni ordine.', en: 'Nothing was asked: see each order.' })

/** A refusal of one order that carries no words of its own (never names another customer). */
export const NOT_ASKED_WORDS: Words = Object.freeze({ it: 'Non è stato possibile chiederlo per questo ordine.', en: 'This could not be asked for this order.' })

/** The words of a refusal that came back in one language only (a rule's message): the same text in both. */
export const wordsOfMessage = (message: string): Words => {
  const text = message.trim()
  return text === '' ? NOT_ASKED_WORDS : { it: text, en: text }
}

/** Undo of a batch: what happens to each of its requests (withdrawn now, or left as it is and why). */
export const WITHDRAW_OUTCOMES = ['WITHDRAWN', 'ANSWERED', 'ALREADY', 'COUNTERED'] as const
export type WithdrawOutcome = (typeof WITHDRAW_OUTCOMES)[number]

export const WITHDRAW_WORDS: Readonly<Record<WithdrawOutcome, Words>> = Object.freeze({
  WITHDRAWN: { it: 'Ritirata.', en: 'Withdrawn.' },
  ANSWERED: { it: 'Vi abbiamo già risposto: non si può più ritirare.', en: 'We already answered this request: it can no longer be withdrawn.' },
  ALREADY: { it: 'Già ritirata.', en: 'Already withdrawn.' },
  COUNTERED: {
    it: 'Vi abbiamo inviato una controproposta su questa richiesta: rispondete in «Cosa vi aspetta» (un no ritira la richiesta).',
    en: 'We sent you a counter-offer on this request: answer it in Waiting for you (no withdraws the request).',
  },
})

/** What Undo does to a request of the batch in this status: withdrawn now, or left as it is (and why). */
export function withdrawOutcomeOf(status: string): WithdrawOutcome {
  if (status === 'OPEN') return 'WITHDRAWN'
  if (status === 'COUNTERED') return 'COUNTERED'
  if (status === 'WITHDRAWN') return 'ALREADY'
  return 'ANSWERED'
}

/** Undo found nothing still waiting (409). */
export const NOTHING_WITHDRAWN_WORDS: Words = Object.freeze({
  it: 'Non è stato ritirato nulla: queste richieste hanno già una risposta, o sono già ritirate.',
  en: 'Nothing was withdrawn: these requests are answered already, or withdrawn.',
})

/** A batch the customer does not have (another customer's id, or none): neutral, the same words. */
export const BATCH_NOT_FOUND_WORDS: Words = Object.freeze({ it: 'Richieste non trovate.', en: 'These requests are not found.' })

// ---- the office's words (a batch answered as one group) ------------------------------------------------------------------

/** A batch the reader does not reach (another customer's, or none): "not found", never that it exists. */
export const OFFICE_BATCH_NOT_FOUND = 'Customer requests not found.'

/** What a batch answer did to one request (the office's words). */
export const BATCH_ANSWER_WORDS: Readonly<Record<'ACCEPTED' | 'REFUSED', Words>> = Object.freeze({
  ACCEPTED: { it: 'Accettata.', en: 'Accepted.' },
  REFUSED: { it: 'Rifiutata.', en: 'Refused.' },
})

/** "Accept and rush the floor" names only a batch of "Urgent – asked". */
export const BATCH_RUSH_FLOOR_ONLY = 'Rush the floor is only for a batch of "Urgent – asked".'
