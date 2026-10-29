import type { InvoiceStatus } from '../invoices'
import type { DeadlineState } from './deadline'
import { failureOf, type SdiSendStatus } from './states'

/**
 * Each SDI state in plain words with the next step (A2 SCR-081 tab "SDI status", SCR-080 "Where invoices stand"; design
 * 02-sections-plan-buy-pay: "SDI states explained with the next step"; FIN-086, FIN-087, FIN-088). The screen shows
 * `title`, `explanation` and the button of `next.action`. Pure; English (the screens' language; ui i18n later).
 */

export const SDI_STATE_CODES = ['DRAFT', 'NOT_SENT', 'SENDING', 'AT_SDI', 'DELIVERED', 'NOT_DELIVERED', 'REJECTED', 'ERROR'] as const
export type SdiStateCode = (typeof SDI_STATE_CODES)[number]

export const SDI_NEXT_ACTIONS = ['ISSUE', 'SEND', 'WAIT', 'FIX_AND_RESEND', 'SEND_AGAIN', 'CHECK_COPY', 'NONE'] as const
export type SdiNextAction = (typeof SDI_NEXT_ACTIONS)[number]

export interface SdiStateWords {
  readonly code: SdiStateCode
  readonly title: string
  readonly explanation: string
  readonly next: { readonly action: SdiNextAction; readonly words: string }
}

export interface SdiStateFacts {
  readonly invoiceStatus: InvoiceStatus
  readonly latest: { readonly status: SdiSendStatus; readonly fileName: string; readonly failureReason: string | null; readonly rejection: string | null } | null
  /** REJECTED: the deadline to send the corrected file again. */
  readonly deadline: DeadlineState | null
  /** NOT_DELIVERABLE: whether the courtesy copy went out by e-mail. */
  readonly copy: 'QUEUED' | 'MISSING' | null
}

const ABOUT_SDI = 'SDI is the tax agency’s post office for invoices: in Italy the invoice is the XML file SDI accepts; the PDF is only a courtesy copy.'

/** The words of where the invoice stands with SDI. */
export function sdiStateWords(facts: SdiStateFacts): SdiStateWords {
  const { invoiceStatus, latest } = facts
  if (invoiceStatus === 'DRAFT') {
    return { code: 'DRAFT', title: 'Not sent yet', explanation: `A draft has no number and is not sent. ${ABOUT_SDI}`, next: { action: 'ISSUE', words: 'Check and issue it, then send it to SDI.' } }
  }
  if (latest?.status === 'SENDING' && invoiceStatus !== 'DELIVERED' && invoiceStatus !== 'NOT_DELIVERABLE') {
    return { code: 'SENDING', title: 'Being sent to SDI', explanation: `The file ${latest.fileName} is going to SDI through the intermediary.`, next: { action: 'WAIT', words: 'Nothing to do: the answer comes by itself.' } }
  }
  switch (invoiceStatus) {
    case 'ISSUED':
      return { code: 'NOT_SENT', title: 'Issued, not sent to SDI', explanation: `The invoice has its number but SDI does not have it yet. ${ABOUT_SDI}`, next: { action: 'SEND', words: 'Send it to SDI.' } }
    case 'SENT':
      return {
        code: 'AT_SDI',
        title: 'At SDI',
        explanation: `SDI received the file${latest ? ` ${latest.fileName}` : ''} and is checking and delivering it; it answers within minutes, at most five days.`,
        next: { action: 'WAIT', words: 'Nothing to do: SDI’s answer arrives by itself.' },
      }
    case 'DELIVERED':
      return { code: 'DELIVERED', title: 'Delivered', explanation: 'SDI delivered the invoice to the customer. It is issued and final.', next: { action: 'NONE', words: 'Nothing more to do.' } }
    case 'NOT_DELIVERABLE':
      return {
        code: 'NOT_DELIVERED',
        title: 'Not delivered — in the customer’s tax drawer',
        explanation:
          'SDI could not reach the customer’s address. The invoice is still legally issued and waits in their tax drawer: their reserved area of the tax agency’s site (Provv. AdE 89757/2018).' +
          (facts.copy === 'QUEUED' ? ' We e-mailed them a copy and told them so.' : facts.copy === 'MISSING' ? ' We could not e-mail them a copy: send it from the invoice.' : ''),
        next: facts.copy === 'QUEUED' ? { action: 'NONE', words: 'Nothing more to do in SDI.' } : { action: 'CHECK_COPY', words: 'Send the customer a copy and tell them the invoice is in their tax drawer.' },
      }
    case 'REJECTED': {
      const deadline = facts.deadline
      const when = deadline ? (deadline.overdue ? `The deadline was ${deadline.deadline}: send it now and tell your accountant.` : `Send it again by ${deadline.deadline} (${deadline.workingDaysLeft} working days left).`) : ''
      return {
        code: 'REJECTED',
        title: 'Rejected by SDI',
        explanation: `SDI rejected the file${latest?.rejection ? ` (${latest.rejection})` : ''}: the invoice counts as never issued. Fix it and send it again with the same number and date. ${when}`.trim(),
        next: { action: 'FIX_AND_RESEND', words: 'Fix and resend (same number and date).' },
      }
    }
    case 'ERROR': {
      const failure = failureOf(latest?.failureReason ?? null)
      if (failure?.uncertain) {
        return {
          code: 'ERROR',
          title: 'No answer from the intermediary',
          explanation: `${failure.words} Sending it again before it says could make SDI reject the second file as a duplicate.`,
          next: { action: 'WAIT', words: 'Wait for the check, or send again: we ask the intermediary first.' },
        }
      }
      return { code: 'ERROR', title: 'Not sent', explanation: failure?.words ?? 'The last send did not reach SDI.', next: { action: 'SEND_AGAIN', words: 'Fix what the message says, then send it again.' } }
    }
    default:
      return { code: 'NOT_SENT', title: 'Not sent yet', explanation: ABOUT_SDI, next: { action: 'SEND', words: 'Send it to SDI.' } }
  }
}

/** The notification types in words (the SDI tab's timeline). */
export const NOTIFICATION_WORDS = Object.freeze({
  RC: 'Delivered to the customer (ricevuta di consegna).',
  MC: 'Not delivered: the invoice is in the customer’s tax drawer (mancata consegna).',
  NS: 'Rejected by SDI: the invoice counts as never issued (notifica di scarto).',
  NE: 'The public body answered (notifica di esito).',
  DT: 'The public body did not answer within 15 days (decorrenza termini).',
  AT: 'Transmitted, but it could not be delivered to the public body (attestazione).',
} as const)
