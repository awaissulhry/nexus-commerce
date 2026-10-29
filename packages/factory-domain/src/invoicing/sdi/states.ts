import { createHash } from 'node:crypto'
import { defineMachine } from '../../state/machine'
import type { SdiNotificationType } from '../../ports/sdi'
import { progressiveOf } from '../document'
import { invoiceMachine, type InvoiceStatus } from '../invoices'

/**
 * The SDI rules of an invoice (B-W1-50; PLAN §2.4 F3; FIN-084, FIN-086, FIN-087, FIN-088), pure. One SdiSubmission per
 * send attempt; SDI's notifications are rows of their send; the invoice's status is what its sends decided. The
 * database (factory-db money.prisma, the …_money_guards triggers) holds the moves; it does not tie the invoice to its
 * sends, so the API applies `invoiceStatusFromSends` in every command that moves a send.
 *
 * A send:     SENDING (written before the provider is called) → SENT (the provider took it) | FAILED (it did not, or
 *             did not answer); SENT → FAILED; SENT | FAILED → DELIVERED | NOT_DELIVERABLE | REJECTED (FAILED: the
 *             provider timed out but the file reached SDI). The outcomes are final: a resend is a new send.
 * An invoice: sent from ISSUED, REJECTED (corrected, same number and date) or ERROR (sent again).
 *
 * Notifications come in any order, for a send in any state, and more than once (webhooks, provider retries, polls):
 *   1. each is recorded once per send (its SDI MessageId);
 *   2. what a send's notifications decide, strongest first: DELIVERED (RC, NE, DT: SDI handed the file to the buyer)
 *      > NOT_DELIVERABLE (MC, AT: issued, in the buyer's tax drawer) > REJECTED (NS: never issued). SDI never sends both
 *      a delivery and a rejection for one file; when the notifications disagree, the stronger one decides;
 *   3. a send's outcome, once recorded, is final (the database): a later notification that would decide otherwise is
 *      kept and reported as a conflict for a person, never applied;
 *   4. the invoice follows its sends: a send that reached the buyer's side (DELIVERED, NOT_DELIVERABLE) decides it for
 *      good (the invoice exists); otherwise the LATEST attempt decides: SENT → SENT, FAILED → ERROR, REJECTED →
 *      REJECTED; a send still SENDING leaves the invoice as it was (ISSUED, REJECTED or ERROR) until the provider answers.
 */

export const SDI_SEND_STATUSES = ['SENDING', 'SENT', 'FAILED', 'DELIVERED', 'NOT_DELIVERABLE', 'REJECTED'] as const
export type SdiSendStatus = (typeof SDI_SEND_STATUSES)[number]

export const SDI_OUTCOMES = ['DELIVERED', 'NOT_DELIVERABLE', 'REJECTED'] as const
export type SdiOutcome = (typeof SDI_OUTCOMES)[number]

/** The moves of a send, as the database allows them. */
export const sdiSendMachine = defineMachine<SdiSendStatus>({
  name: 'SDI send',
  states: SDI_SEND_STATUSES,
  transitions: {
    SENDING: ['SENT', 'FAILED'],
    SENT: ['FAILED', 'DELIVERED', 'NOT_DELIVERABLE', 'REJECTED'],
    FAILED: ['DELIVERED', 'NOT_DELIVERABLE', 'REJECTED'],
  },
})

/** An invoice is sent to SDI from these states: issued, rejected (corrected) or in error (sent again). */
export const SEND_FROM: readonly InvoiceStatus[] = Object.freeze(['ISSUED', 'REJECTED', 'ERROR'])
export const maySend = (status: InvoiceStatus): boolean => SEND_FROM.includes(status)

/** The outcome one notification says (rule 2). */
export function outcomeOf(type: SdiNotificationType): SdiOutcome {
  switch (type) {
    case 'RC':
    case 'NE':
    case 'DT':
      return 'DELIVERED'
    case 'MC':
    case 'AT':
      return 'NOT_DELIVERABLE'
    case 'NS':
      return 'REJECTED'
  }
}

const RANK: Readonly<Record<SdiOutcome, number>> = Object.freeze({ DELIVERED: 3, NOT_DELIVERABLE: 2, REJECTED: 1 })

/** What a send's notifications decide, the strongest first (rule 2); null when there are none. */
export function decidedOutcome(types: readonly SdiNotificationType[]): SdiOutcome | null {
  let best: SdiOutcome | null = null
  for (const type of types) {
    const outcome = outcomeOf(type)
    if (best === null || RANK[outcome] > RANK[best]) best = outcome
  }
  return best
}

export const isOutcome = (status: SdiSendStatus): status is SdiOutcome => (SDI_OUTCOMES as readonly string[]).includes(status)

/**
 * How a send moves when its notifications decide `decided` (rules 2, 3): the steps through the send's machine (SENDING
 * passes SENT: a notification proves the provider took the file), none when it is there already, and `conflict` when
 * its recorded outcome differs (final: kept as it is).
 */
export function sendMoveFor(current: SdiSendStatus, decided: SdiOutcome | null): { readonly steps: readonly SdiSendStatus[]; readonly conflict: boolean } {
  if (decided === null || current === decided) return { steps: [], conflict: false }
  if (isOutcome(current)) return { steps: [], conflict: true }
  return { steps: current === 'SENDING' ? ['SENT', decided] : [decided], conflict: false }
}

/** One send as the invoice's rule reads it. */
export interface SendFact {
  readonly attempt: number
  readonly status: SdiSendStatus
}

/** The invoice's status its sends decide (rule 4). `current` is the invoice's status now. */
export function invoiceStatusFromSends(sends: readonly SendFact[], current: InvoiceStatus): InvoiceStatus {
  if (current === 'DRAFT' || current === 'DELIVERED' || current === 'NOT_DELIVERABLE') return current
  if (sends.some((send) => send.status === 'DELIVERED')) return 'DELIVERED'
  if (sends.some((send) => send.status === 'NOT_DELIVERABLE')) return 'NOT_DELIVERABLE'
  const latest = [...sends].sort((a, b) => b.attempt - a.attempt)[0]
  if (!latest) return current
  switch (latest.status) {
    case 'SENT':
      return 'SENT'
    case 'FAILED':
      return 'ERROR'
    case 'REJECTED':
      return 'REJECTED'
    default:
      return current
  }
}

/**
 * The invoice's moves from `from` to `to` along the database's machine, shortest first (ISSUED → DELIVERED passes
 * SENT: the notification arrived before the provider's answer was recorded); [] when equal, null when no path exists.
 */
export function invoicePath(from: InvoiceStatus, to: InvoiceStatus): InvoiceStatus[] | null {
  if (from === to) return []
  const previous = new Map<InvoiceStatus, InvoiceStatus>()
  const queue: InvoiceStatus[] = [from]
  while (queue.length > 0) {
    const state = queue.shift()!
    for (const next of invoiceMachine.transitions[state] ?? []) {
      if (next === from || previous.has(next)) continue
      previous.set(next, state)
      if (next === to) {
        const path: InvoiceStatus[] = [to]
        let step = state
        while (step !== from) {
          path.unshift(step)
          step = previous.get(step)!
        }
        return path
      }
      queue.push(next)
    }
  }
  return null
}

// ---- why a send failed -----------------------------------------------------------------------------------------------

/**
 * Why a send FAILED, as the code that starts SdiSubmission.failureReason (`<CODE>: <words>`):
 *   REFUSED    the provider answered and refused the file (a 4xx): it never reached SDI. Fix it, send again.
 *   NOT_SENT   nothing was sent: the connection is paused, failing or busy, the XML could not be read, or the sending
 *              process stopped before the provider got it. Send again.
 *   NO_ANSWER  the provider did not answer (a timeout, the network, a 5xx after the retries): the file MAY have reached
 *              SDI. The status poll asks the provider; a resend first asks it too (SDI refuses a second file of the
 *              same invoice as a duplicate, 00404).
 */
export const SEND_FAILURES = Object.freeze({
  REFUSED: { uncertain: false, words: 'The SDI intermediary refused the file before SDI; it never reached SDI.' },
  NOT_SENT: { uncertain: false, words: 'The file was not sent.' },
  NO_ANSWER: { uncertain: true, words: 'The SDI intermediary did not answer: the file may have reached SDI. We ask the intermediary until it says.' },
} as const)
export type SendFailureCode = keyof typeof SEND_FAILURES

const MAX_REASON = 500

/** The failureReason of a FAILED send: its code, the words, and the detail (never a secret: the gateway's message). */
export function failureReasonOf(code: SendFailureCode, detail: string | null): string {
  const text = `${code}: ${SEND_FAILURES[code].words}${detail ? ` (${detail.replace(/\s+/g, ' ').trim()})` : ''}`
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text
}

/** A stored failureReason read back: its code (UNKNOWN for text written otherwise), whether it may have reached SDI. */
export function failureOf(reason: string | null): { readonly code: SendFailureCode | 'UNKNOWN'; readonly uncertain: boolean; readonly words: string } | null {
  if (reason === null) return null
  const code = /^([A-Z_]+):/.exec(reason)?.[1]
  if (code && Object.hasOwn(SEND_FAILURES, code)) return { code: code as SendFailureCode, uncertain: SEND_FAILURES[code as SendFailureCode].uncertain, words: reason.slice(code.length + 1).trim() }
  return { code: 'UNKNOWN', uncertain: false, words: reason }
}

// ---- the file names of the sends ---------------------------------------------------------------------------------------

/** `<country><transmitter id>_<progressive>.xml` (Specifiche tecniche SDI: the progressive 1 to 5 letters or digits). */
const FILE_NAME = /^([A-Z]{2}[A-Za-z0-9]{1,28})_([A-Za-z0-9]{1,5})\.xml$/

/**
 * The progressive of a send: the first send uses the one the issue built into the XML (factory-domain document
 * `progressiveOf`); a later send, or a name already taken (`salt` > 0), takes another one from the invoice id, the
 * attempt and the salt. SDI refuses a file name it has seen (00002), so every send has its own name.
 */
export function sendProgressive(invoiceId: string, attempt: number, salt = 0): string {
  if (attempt === 1 && salt === 0) return progressiveOf(invoiceId)
  const hash = createHash('sha256').update(`${invoiceId}:${attempt}:${salt}`).digest()
  return (hash.readUInt32BE(0) % 36 ** 5).toString(36).toUpperCase().padStart(5, '0')
}

/** The send's file name: the XML's transmitter part with this progressive. Null when `xmlFileName` is not an SDI name. */
export function sendFileName(xmlFileName: string, progressive: string): string | null {
  const match = FILE_NAME.exec(xmlFileName)
  if (!match || !/^[A-Za-z0-9]{1,5}$/.test(progressive)) return null
  return `${match[1]}_${progressive}.xml`
}

export const isSdiFileName = (value: string): boolean => FILE_NAME.test(value)
