import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { can } from '@nexus/factory-domain/core/permissions'
import type { MessageKey } from '@nexus/factory-domain/notifications/rules'
import { events as threadEvents } from '@nexus/factory-domain/threads/events'
import { followersOf } from '../../threads/followers'
import { recordLabelOf } from '../../threads/labels'
import { scopeOfThread } from '../../threads/threads'
import type { Draft, FanOutRule, RuleContext } from '../fan-out'

/**
 * Notes and mail on a record (COL-006 mentions, COL-011 followers):
 *   thread.user_mentioned   MENTION to the person mentioned, while they may still read the thread
 *   thread.message_posted   FOLLOWING to the record's followers who did not mute it, may read it, and are neither its
 *                           author nor mentioned in it (they have their mention): a note, a mail sent, a reply in
 */

const payloadOf = (type: string) => threadEvents.find((event) => event.type === type)!.payload

async function threadOf(context: RuleContext, threadId: string) {
  return context.tx.thread.findUnique({ where: { id: threadId }, select: { id: true, companyId: true, siteId: true, partyId: true, recordType: true, recordId: true } })
}

const FOLLOWING_KEYS: Readonly<Record<string, MessageKey>> = Object.freeze({ INTERNAL_NOTE: 'notifications.following.note', INBOUND: 'notifications.following.mail_in', OUTBOUND: 'notifications.following.mail_out' })

export const THREAD_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'threads.mentioned',
    events: ['thread.user_mentioned'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf('thread.user_mentioned').parse(raw) as unknown as { threadId: string; messageId: string; userId: string; authorId: string | null }
      const thread = await threadOf(context, payload.threadId)
      const reader = thread ? await context.reader(payload.userId) : null
      if (!thread || !reader || !can(reader.actor, THREADS_READ, scopeOfThread(thread))) return []
      const label = await recordLabelOf(context.tx, thread.recordType, thread.recordId)
      if (label === null) return []
      return [
        {
          userId: payload.userId,
          category: 'MENTION',
          record: { type: thread.recordType, id: thread.recordId, label },
          companyId: thread.companyId,
          anchor: `message:${payload.messageId}`,
          messageKey: 'notifications.mentioned',
          params: { actorId: payload.authorId, messageId: payload.messageId },
          actorId: payload.authorId,
        },
      ]
    },
  },
  {
    name: 'threads.following',
    events: ['thread.message_posted'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf('thread.message_posted').parse(raw) as unknown as { threadId: string; messageId: string; recordType: string; recordId: string; direction: string }
      const thread = await threadOf(context, payload.threadId)
      if (!thread) return []
      const followers = await followersOf(context.tx, { type: thread.recordType, id: thread.recordId })
      if (followers.length === 0) return []
      const message = await context.tx.message.findUnique({ where: { id: payload.messageId }, select: { authorKind: true, authorId: true, mentionedUserIds: true } })
      if (!message) return []
      const authorId = message.authorKind === 'USER' ? message.authorId : null
      const label = await recordLabelOf(context.tx, thread.recordType, thread.recordId)
      if (label === null) return []
      const drafts: Draft[] = []
      for (const userId of followers) {
        if (userId === authorId || message.mentionedUserIds.includes(userId)) continue
        const reader = await context.reader(userId)
        if (!reader || !can(reader.actor, THREADS_READ, scopeOfThread(thread))) continue
        drafts.push({
          userId,
          category: 'FOLLOWING',
          record: { type: thread.recordType, id: thread.recordId, label },
          companyId: thread.companyId,
          anchor: `message:${payload.messageId}`,
          messageKey: FOLLOWING_KEYS[payload.direction] ?? 'notifications.following.note',
          params: { actorId: authorId, messageId: payload.messageId, direction: payload.direction },
          actorId: authorId,
        })
      }
      return drafts
    },
  },
])
