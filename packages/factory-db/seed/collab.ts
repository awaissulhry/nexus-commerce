import type { Prisma } from '../src/generated/prisma/client'
import { seed as seedAuth } from './auth'
import { seed as seedThreads } from './threads'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The working-together seed (B-W2a-20's tables), per tenant of seed/_core.ts, around the threads seed's quote thread
 * (`Quote` Q1 of company A for party P1):
 *   - an internal note on it by the owner that @mentions the member (a Message: its threads table, an ffffffff id so
 *     the generated isolation tests still copy that table's own first message), and its MessageMention;
 *   - notifications: the member's mention (unread; its e-mail skipped, quiet by default), the member's assigned task
 *     (read and done; e-mailed), the owner's export (snoozed until new activity);
 *   - followers of the quote: the owner (its creator), the member (mentioned, muted on the company's thread);
 *   - tasks: an open one for the member on the quote with a checklist, a done one, a cancelled one, and one of its own.
 * People are named by user id only. Made-up data, written in the tenant's office scope as the API writes them;
 * idempotent (rows found by id first; the mention and the deliveries are append-only). First rows (00000000) are ones
 * the generated isolation tests can copy.
 */

const AT = new Date('2026-10-30T09:00:00.000Z')
const minutes = (n: number): Date => new Date(AT.getTime() + n * 60_000)

export async function seed(context: SeedContext): Promise<void> {
  const { db, namespace } = context
  const { ownerId, memberId } = await seedAuth(context)
  await seedThreads(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const companyA = id('company:A')
  const quote = { type: 'Quote', id: id('quote:Q1'), label: 'SEED-QT-0001' }
  const quoteThread = id('threads:quote:Q1')
  const noteId = lastId('collab:message:mention')

  const notifications: Prisma.NotificationCreateManyInput[] = [
    {
      id: firstId('collab:notification:mention'),
      userId: memberId,
      companyId: companyA,
      category: 'MENTION',
      eventType: 'thread.user_mentioned',
      eventId: id('collab:event:mention'),
      recordType: quote.type,
      recordId: quote.id,
      recordLabel: quote.label,
      anchor: `message:${noteId}`,
      messageKey: 'notifications.mentioned',
      params: { actorId: ownerId },
      actorId: ownerId,
      groupKey: `${quote.type}:${quote.id}:MENTION`,
      createdAt: minutes(1),
      updatedAt: minutes(1),
    },
    {
      id: id('collab:notification:task'),
      userId: memberId,
      companyId: companyA,
      category: 'ASSIGNMENT',
      eventType: 'task.assigned',
      eventId: id('collab:event:task-assigned'),
      recordType: quote.type,
      recordId: quote.id,
      recordLabel: quote.label,
      messageKey: 'notifications.taskAssigned',
      params: { actorId: ownerId, taskId: firstId('collab:task:open') },
      actorId: ownerId,
      readAt: minutes(20),
      doneAt: minutes(21),
      createdAt: minutes(2),
      updatedAt: minutes(21),
    },
    {
      id: id('collab:notification:export'),
      userId: ownerId,
      companyId: companyA,
      category: 'SYSTEM',
      eventType: 'export.done',
      eventId: id('collab:event:export-done'),
      recordType: 'ExportJob',
      recordId: id('views:export:failed'),
      recordLabel: 'sales.orders',
      messageKey: 'notifications.exportFailed',
      params: {},
      snoozedAt: minutes(30),
      createdAt: minutes(25),
      updatedAt: minutes(30),
    },
  ]
  const deliveries: Prisma.NotificationDeliveryCreateManyInput[] = [
    {
      id: firstId('collab:delivery:mention:email'),
      notificationId: firstId('collab:notification:mention'),
      channel: 'EMAIL',
      outcome: 'SKIPPED',
      detail: 'Mentions are not e-mailed unless the person asks for it (quiet by default).',
      at: minutes(1),
      requestId: 'seed-collab',
      createdAt: minutes(1),
    },
    {
      id: id('collab:delivery:task:email'),
      notificationId: id('collab:notification:task'),
      channel: 'EMAIL',
      outcome: 'SENT',
      emailOutboundId: id('collab:email:task-assigned'),
      at: minutes(3),
      requestId: 'seed-collab',
      createdAt: minutes(3),
    },
  ]
  const followers: Prisma.RecordFollowerCreateManyInput[] = [
    { id: firstId('collab:follower:quote:owner'), recordType: quote.type, recordId: quote.id, userId: ownerId, reason: 'CREATOR', createdAt: AT, updatedAt: AT, createdById: ownerId },
    { id: id('collab:follower:quote:member'), recordType: quote.type, recordId: quote.id, userId: memberId, reason: 'MENTIONED', createdAt: minutes(1), updatedAt: minutes(1), createdById: ownerId },
    { id: id('collab:follower:company:member'), recordType: 'Company', recordId: companyA, userId: memberId, reason: 'CHOSE', muted: true, createdAt: AT, updatedAt: AT, createdById: memberId },
  ]
  const onQuote = { companyId: companyA, partyId: id('party:P1'), recordType: quote.type, recordId: quote.id, recordLabel: quote.label }
  const tasks: Prisma.TaskCreateManyInput[] = [
    {
      id: firstId('collab:task:open'),
      ...onQuote,
      title: 'Call the customer about the sample sizes',
      description: 'They asked for a 52 and a 54 in the sample run.',
      assigneeId: memberId,
      assignedById: ownerId,
      assignedAt: minutes(2),
      dueDate: new Date('2026-11-03T00:00:00.000Z'),
      dueTime: '10:00',
      checklist: [
        { id: 'c1', text: 'Check the size chart', done: true, doneAt: minutes(15).toISOString(), doneById: memberId },
        { id: 'c2', text: 'Call the buyer', done: false },
      ],
      createdAt: minutes(2),
      updatedAt: minutes(15),
      createdById: ownerId,
    },
    {
      id: id('collab:task:done'),
      ...onQuote,
      title: 'Check the leather availability',
      assigneeId: ownerId,
      assignedById: ownerId,
      assignedAt: AT,
      dueDate: new Date('2026-10-30T00:00:00.000Z'),
      status: 'DONE',
      closedAt: minutes(40),
      closedById: ownerId,
      createdAt: AT,
      updatedAt: minutes(40),
      createdById: ownerId,
    },
    {
      id: id('collab:task:cancelled'),
      ...onQuote,
      title: 'Send a second quote version',
      status: 'CANCELLED',
      closedAt: minutes(45),
      closedById: ownerId,
      createdAt: AT,
      updatedAt: minutes(45),
      createdById: ownerId,
    },
    {
      id: id('collab:task:own'),
      companyId: companyA,
      title: 'Prepare the season planning meeting',
      assigneeId: ownerId,
      assignedById: ownerId,
      assignedAt: AT,
      dueDate: new Date('2026-11-10T00:00:00.000Z'),
      snoozedUntil: new Date('2026-11-09T07:00:00.000Z'),
      createdAt: AT,
      updatedAt: AT,
      createdById: ownerId,
    },
  ]

  await db.withScope({ audience: 'office', tenantId, actorId: ownerId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.message.createMany({
        data: [
          {
            id: noteId,
            threadId: quoteThread,
            direction: 'INTERNAL_NOTE',
            audience: 'OFFICE',
            channel: 'APP',
            authorKind: 'USER',
            authorId: ownerId,
            authorName: 'Seed Office User',
            bodyText: 'Seed note: can you call them about the sample sizes?',
            mentionedUserIds: [memberId],
            at: minutes(1),
            createdAt: minutes(1),
          },
        ],
        skipDuplicates: true,
      })
      await tx.messageMention.createMany({
        data: [{ id: firstId('collab:mention:member'), messageId: noteId, threadId: quoteThread, recordType: quote.type, recordId: quote.id, userId: memberId, authorId: ownerId, at: minutes(1), createdAt: minutes(1) }],
        skipDuplicates: true,
      })
      await tx.notification.createMany({ data: notifications, skipDuplicates: true })
      await tx.notificationDelivery.createMany({ data: deliveries, skipDuplicates: true })
      await tx.recordFollower.createMany({ data: followers, skipDuplicates: true })
      await tx.task.createMany({ data: tasks, skipDuplicates: true })
    }),
  )
}
