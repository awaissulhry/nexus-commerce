import type { AttentionCandidate } from '@nexus/factory-domain/insights/attention'
import { mailSeverity } from '@nexus/factory-domain/insights/states'
import { mailToSortWords, type MailAttentionState } from '@nexus/factory-domain/insights/words'
import { listInbound } from '../../../platform/email-in/triage'
import { SOURCE_LIMIT, type Source } from './common'

/**
 * Mail to sort (B-W0-22 email in, SCR-019): the received mail no record took (TRIAGE), held for a person (HELD) or that
 * could not be read (FAILED), as the email-in module's own list (`GET /email/inbound`, email.triage over the mail's
 * company) gives it, newest first. Each opens in Mail to sort's own review.
 */

/** MAIL_TO_SORT: one row per mail waiting to be sorted. */
export const mailToSort: Source = async ({ caller }) => {
  const page = await listInbound(caller, { limit: SOURCE_LIMIT })
  const candidates: AttentionCandidate[] = page.mails.flatMap((mail) => {
    if (mail.status !== 'TRIAGE' && mail.status !== 'HELD' && mail.status !== 'FAILED') return []
    const state: MailAttentionState = mail.status
    const sender = mail.from.name?.trim() || mail.from.address || 'an unknown sender'
    return [
      {
        kind: 'MAIL_TO_SORT' as const,
        state,
        severity: mailSeverity(state),
        record: { type: 'InboundEmail', id: mail.id, label: mail.subject?.trim() || sender },
        scope: { companyId: mail.companyId, siteId: null, partyId: null },
        ...mailToSortWords({ sender, subject: mail.subject?.trim() || null, state, heldReason: mail.heldReason }),
        due: null,
        since: new Date(mail.receivedAt),
      },
    ]
  })
  return { kind: 'MAIL_TO_SORT', candidates, complete: page.nextCursor === null }
}
