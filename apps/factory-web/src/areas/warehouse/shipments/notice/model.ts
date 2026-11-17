import { NOTICE_HELD } from '@nexus/factory-domain/shipping/notices/rules'
import { words, type Read, type Words } from '../queue/shared/depth'
import type { Notice, NoticeSent } from './api'

/**
 * The customer notice, pure (SCR-598; design Tracking & delivery › Customer notice "sent at, to whom, delivery state · Send
 * again"; LOG-061): its view model, what holds Send again, the outcome of a send in words.
 */

export { NOTICE_HELD }

export interface NoticeModel {
  readonly notice: Read<Notice>
  /** Send again: the contacts ticked (all of them by default), or null while closed. */
  readonly dialog: null | { readonly contactIds: readonly string[] }
  readonly busy: boolean
  readonly problem: Words | null
  readonly sent: NoticeSent | null
}

export interface NoticeActions {
  onRetry?: () => void
  onDialog?: (dialog: NoticeModel['dialog']) => void
  onSend?: () => void
}

/** Why "Send again" is held (the API's code, the right, a send under way). */
export function sendHeld(notice: Notice, busy: boolean): Words | null {
  if (!notice.mayManage) return words('notice.held.noManage')
  if (notice.sendHeld) return words(`notice.why.${notice.sendHeld}`)
  if (busy) return words('notice.held.busy')
  return null
}

/** The line under the title: on by itself when the goods leave, or why it does not go by itself. */
export function automaticWords(notice: Notice): Words {
  if (notice.automaticHeld === 'SENT') return words('notice.auto.sent')
  if (!notice.switchOn) return words('notice.auto.off')
  if (notice.automaticHeld) return words(`notice.why.${notice.automaticHeld}`)
  return words('notice.auto.on')
}

/** The mail's state, the latest that happened. */
export function mailState(mail: Notice['mails'][number]): { state: Notice['mails'][number]['status']; at: string } {
  return { state: mail.status, at: mail.failedAt ?? mail.bouncedAt ?? mail.deliveredAt ?? mail.sentAt ?? mail.queuedAt }
}

// B-TH-038: WITHDRAWN, a thread mail taken back in its undo window (a notice mail never waits in one; listed for the full status).
export const MAIL_TONE = { QUEUED: 'neutral', SENDING: 'info', SENT: 'info', DELIVERED: 'success', BOUNCED: 'danger', COMPLAINED: 'danger', FAILED: 'danger', WITHDRAWN: 'neutral' } as const

/** The send's outcome, said: sent n, failed n, skipped addresses (suppressed). */
export function sentWords(sent: NoticeSent): Words {
  if (sent.failed > 0) return words('notice.outcome.failed', { sent: sent.sent, failed: sent.failed })
  if (sent.sent === 0) return words('notice.outcome.none')
  return words('notice.outcome.sent', { count: sent.sent })
}
