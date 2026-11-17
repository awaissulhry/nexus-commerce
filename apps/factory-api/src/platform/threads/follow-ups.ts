import type { FactoryDatabase, Prisma } from '@nexus/factory-db'
import { eventFor } from '@nexus/factory-domain/events/define'
import { events as reminderEvents } from '@nexus/factory-domain/reminders/events'
import { REMINDER_LIMITS } from '@nexus/factory-domain/reminders/rules'
import { callerFor, command } from '../../core/command'
import { asSystem, systemContext } from '../outbox/system'

/**
 * B-TH-096 (threads plan TH-9, N16; feature T8-F05 "Remind me if no answer"): a follow-up that stops on a reply. "Remind me in
 * 3 days if no answer" on Send is a reminder (platform/tasks/reminders, the person's own, POST /reminders) AT_TIME on the message
 * the person just sent to the record's customer: the reminder of a message they themselves shared with the customer (OUTBOUND,
 * audience PARTNER) is a follow-up. It waits for the customer's answer — the team-inbox follow-up's rule (B-W2b-394, COL-027)
 * on a record's conversation — and needs no column of its own:
 *
 *   - the customer answers on the thread after the message (an INBOUND message: their mail or portal post) → the follow-up is
 *     done by itself (ANSWERED); a colleague's note, another mail of ours, another customer's thread never stop it;
 *   - the record's conversation is closed → done by itself (CLOSED);
 *   - neither by its time → it comes back to Today as every reminder does ("no answer yet"), and still stops if the answer
 *     comes after; snoozed (put off 3 or 7 days) it waits again from then.
 *
 * The reminders' scheduler (`tasks.reminders`, every minute) runs this first for each tenant, so an answered follow-up is never
 * brought back. ONE command per tenant: each follow-up re-checked as read (done, put off or removed meanwhile: left alone), its
 * audit row on the Reminder (why it stopped) and `reminder.changed` DONE (the person's lists read again).
 */

const reminderChanged = reminderEvents.find((event) => event.type === 'reminder.changed')!

/** The messages a follow-up is set on: ours, shared with the record's customer. */
export const FOLLOW_UP_MESSAGE = { direction: 'OUTBOUND', audience: 'PARTNER' } as const satisfies Prisma.MessageWhereInput

/** Whether a reminder is a follow-up: AT_TIME on a message its own person shared with the customer. */
export function isFollowUp(reminder: { readonly kind: string; readonly userId: string; readonly message: { readonly direction: string; readonly audience: string; readonly authorId: string | null } | null }): boolean {
  const message = reminder.message
  return reminder.kind === 'AT_TIME' && message !== null && message.direction === FOLLOW_UP_MESSAGE.direction && message.audience === FOLLOW_UP_MESSAGE.audience && message.authorId === reminder.userId
}

export type FollowUpStop = 'ANSWERED' | 'CLOSED'

/** The open follow-ups of a tenant that should stop now, and why (reads only). */
async function stopsOf(database: FactoryDatabase, tenantId: string, requestId: string): Promise<{ readonly id: string; readonly version: number; readonly stop: FollowUpStop }[]> {
  return asSystem(database, tenantId, requestId, async (client) => {
    const open = await client.reminder.findMany({
      where: { kind: 'AT_TIME', doneAt: null, message: FOLLOW_UP_MESSAGE },
      orderBy: [{ since: 'asc' }, { id: 'asc' }],
      take: REMINDER_LIMITS.perRun,
      select: { id: true, version: true, kind: true, userId: true, message: { select: { direction: true, audience: true, authorId: true, at: true, threadId: true, thread: { select: { status: true } } } } },
    })
    const stops: { id: string; version: number; stop: FollowUpStop }[] = []
    for (const reminder of open) {
      if (!isFollowUp(reminder) || !reminder.message) continue
      if (reminder.message.thread.status === 'CLOSED') {
        stops.push({ id: reminder.id, version: reminder.version, stop: 'CLOSED' })
        continue
      }
      // The customer's answer: a message from their side on the same conversation, after ours.
      const answer = await client.message.findFirst({ where: { threadId: reminder.message.threadId, direction: 'INBOUND', at: { gt: reminder.message.at } }, select: { id: true } })
      if (answer) stops.push({ id: reminder.id, version: reminder.version, stop: 'ANSWERED' })
    }
    return stops
  })
}

/** Stops the follow-ups of a tenant that were answered or whose conversation closed (the reminders' scheduler, first). How many. */
export async function stopAnsweredFollowUps(database: FactoryDatabase, tenantId: string, requestId: string): Promise<number> {
  const stops = await stopsOf(database, tenantId, requestId)
  if (stops.length === 0) return 0
  const caller = callerFor(database, systemContext(tenantId, requestId))
  const { result } = await command(caller, { name: 'threads.followUpsStopped', input: { count: stops.length, requestId } }, async (tools) => {
    let stopped = 0
    for (const candidate of stops) {
      // Only a follow-up still open as read (done, put off or removed meanwhile: left alone).
      const updated = await tools.tx.reminder.updateMany({ where: { id: candidate.id, version: candidate.version, doneAt: null }, data: { doneAt: tools.now, version: { increment: 1 }, updatedAt: tools.now } })
      if (updated.count === 0) continue
      const row = await tools.tx.reminder.findUniqueOrThrow({ where: { id: candidate.id }, select: { id: true, userId: true, companyId: true, recordType: true, recordId: true } })
      tools.audit({ recordType: 'Reminder', recordId: row.id, companyId: row.companyId, after: { state: 'DONE', followUp: candidate.stop } })
      tools.emit(eventFor(reminderChanged, { subject: row.id, companyId: row.companyId, payload: { reminderId: row.id, recordType: row.recordType, recordId: row.recordId, userId: row.userId, change: 'DONE' } }))
      stopped += 1
    }
    // Every command records at least one audit row: a run where everything moved meanwhile notes the run itself.
    if (stopped === 0) tools.audit({ recordType: 'Reminder', recordId: stops[0]!.id, after: { followUpsStopped: 0 } })
    return stopped
  })
  return result
}
