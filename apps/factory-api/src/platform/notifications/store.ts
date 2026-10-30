import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { NotificationCategory } from '@nexus/factory-domain/notifications/rules'
import type { CommandTx } from '../../core/command'

/**
 * The storage of the notification centre (B-W2a-20; collab.prisma Notification and NotificationDelivery): every read and
 * write of those tables is here. The rules are factory-domain notifications/rules; the fan-out fan-out.ts, the person's
 * own list notifications.ts, the digest platform/email-out/digest.
 */

type Client = FactoryClient | CommandTx

export const NOTIFICATION_COLUMNS = {
  id: true,
  userId: true,
  companyId: true,
  category: true,
  eventType: true,
  eventId: true,
  recordType: true,
  recordId: true,
  recordLabel: true,
  anchor: true,
  messageKey: true,
  params: true,
  actorId: true,
  groupKey: true,
  readAt: true,
  doneAt: true,
  snoozedAt: true,
  snoozedUntil: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.NotificationSelect
export type NotificationRow = Prisma.NotificationGetPayload<{ select: typeof NOTIFICATION_COLUMNS }>

/** One notification as the fan-out makes it (its id, group and time are the fan-out's). */
export interface NotificationInsert {
  readonly id: string
  readonly userId: string
  readonly companyId: string | null
  readonly category: NotificationCategory
  readonly eventType: string
  readonly eventId: string
  readonly recordType: string
  readonly recordId: string
  readonly recordLabel: string
  readonly anchor: string | null
  readonly messageKey: string
  readonly params: Prisma.InputJsonValue
  readonly actorId: string | null
  readonly groupKey: string
  readonly createdAt: Date
}

/** Inserts the fan-out's rows; a row of the same person and event is skipped (a replayed event makes none). How many were new. */
export async function insertNotifications(tx: CommandTx, rows: readonly NotificationInsert[]): Promise<number> {
  if (rows.length === 0) return 0
  const { count } = await tx.notification.createMany({ data: rows.map((row) => ({ ...row, updatedAt: row.createdAt })), skipDuplicates: true })
  return count
}

/** The person's latest notification of this record and category since a time (the group a new one joins). */
export async function latestOfGroup(client: Client, userId: string, recordType: string, recordId: string, category: NotificationCategory, since: Date) {
  return client.notification.findFirst({
    where: { userId, recordType, recordId, category, createdAt: { gte: since } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, groupKey: true, createdAt: true },
  })
}

/** The person's newest notification time per record (a snooze "until new activity" wakes when a newer one came). */
export async function latestPerRecord(client: Client, userId: string, recordIds: readonly string[]): Promise<Map<string, Date>> {
  if (recordIds.length === 0) return new Map()
  const rows = await client.notification.groupBy({ by: ['recordType', 'recordId'], where: { userId, recordId: { in: [...new Set(recordIds)] } }, _max: { createdAt: true } })
  return new Map(rows.flatMap((row) => (row._max.createdAt ? [[`${row.recordType}:${row.recordId}`, row._max.createdAt] as const] : [])))
}

/** Notifications of one person by id (the person's own only: another person's id is as unknown as a wrong one). */
export async function ownNotifications(client: Client, userId: string, ids: readonly string[]): Promise<NotificationRow[]> {
  if (ids.length === 0) return []
  return client.notification.findMany({ where: { userId, id: { in: [...new Set(ids)] } }, select: NOTIFICATION_COLUMNS })
}

/** One delivery attempt (append-only): an e-mail SENT names its mail; SKIPPED and FAILED say why. */
export async function logDeliveries(
  tx: CommandTx,
  rows: readonly { readonly id: string; readonly notificationId: string; readonly outcome: 'SENT' | 'SKIPPED' | 'FAILED'; readonly emailOutboundId: string | null; readonly detail: string | null }[],
  at: Date,
  requestId: string,
): Promise<void> {
  if (rows.length === 0) return
  await tx.notificationDelivery.createMany({ data: rows.map((row) => ({ ...row, channel: 'EMAIL' as const, at, requestId, createdAt: at })) })
}
