import { EMAIL_TRIAGE } from '@nexus/factory-domain/auth/permissions/catalogue'
import { can, holds } from '@nexus/factory-domain/core/permissions'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { events as mailDepthEvents } from '@nexus/factory-domain/mail-depth/events'
import type { Draft, FanOutRule, RuleContext } from '../../notifications/fan-out'

/**
 * The notifications of team inboxes (B-W2b-394; COL-027; B-W2b-385: "a team-inbox mail given to a person → ASSIGNMENT with a
 * message key starting notifications.mail.", the preference matrix's MAIL_ASSIGNED row):
 *
 *   email.inbound_worked ASSIGNED       the member a mail was given to (not when they took it themselves), while it is still
 *                                       theirs and they sort the company's mail;
 *   email.inbound_worked FOLLOW_UP_DUE  its follow-up came with no answer: its assignee, else the inbox's members who sort the
 *                                       company's mail (the mail is open again in their queue).
 * The record is the mail (its subject as the label), {title} the inbox's name; never its sender's address or its text.
 */

const workedPayload = mailDepthEvents[2].payload

async function mailOf(context: RuleContext, inboundEmailId: string) {
  const mail = await context.tx.inboundEmail.findUnique({ where: { id: inboundEmailId }, select: { id: true, companyId: true, subject: true, status: true, teamInboxId: true, assigneeId: true } })
  if (!mail || mail.status === 'REJECTED' || !mail.teamInboxId) return null
  const inbox = await context.tx.teamInbox.findUnique({ where: { id: mail.teamInboxId }, select: { name: true, memberIds: true } })
  return inbox ? { mail, inbox } : null
}

const labelOf = (subject: string | null): string => (subject?.trim() ? subject.trim().slice(0, 120) : '—')

/** May this person be told of the mail now: home and the company's mail. */
async function mayHear(context: RuleContext, userId: string, companyId: string | null): Promise<boolean> {
  const reader = await context.reader(userId)
  return reader !== null && holds(reader.actor, HOME_VIEW) && can(reader.actor, EMAIL_TRIAGE, { companyId })
}

export const TEAM_INBOX_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'email.mailAssigned',
    events: ['email.inbound_worked'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = workedPayload.parse(raw)
      if (payload.change !== 'ASSIGNED' || payload.assigneeId === null || payload.assigneeId === payload.byId) return []
      const found = await mailOf(context, payload.inboundEmailId)
      if (!found || found.mail.assigneeId !== payload.assigneeId || !(await mayHear(context, payload.assigneeId, found.mail.companyId))) return []
      return [
        {
          userId: payload.assigneeId,
          category: 'ASSIGNMENT',
          record: { type: 'InboundEmail', id: found.mail.id, label: labelOf(found.mail.subject) },
          companyId: found.mail.companyId,
          anchor: null,
          messageKey: 'notifications.mail.assigned',
          params: { title: found.inbox.name, actorId: payload.byId },
          actorId: payload.byId,
        },
      ]
    },
  },
  {
    name: 'email.followUpDue',
    events: ['email.inbound_worked'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = workedPayload.parse(raw)
      if (payload.change !== 'FOLLOW_UP_DUE') return []
      const found = await mailOf(context, payload.inboundEmailId)
      if (!found) return []
      const people = found.mail.assigneeId ? [found.mail.assigneeId] : found.inbox.memberIds
      const drafts: Draft[] = []
      for (const userId of people) {
        if (!(await mayHear(context, userId, found.mail.companyId))) continue
        drafts.push({ userId, category: 'ASSIGNMENT', record: { type: 'InboundEmail', id: found.mail.id, label: labelOf(found.mail.subject) }, companyId: found.mail.companyId, anchor: null, messageKey: 'notifications.mail.followUpDue', params: { title: found.inbox.name }, actorId: null })
      }
      return drafts
    },
  },
])
