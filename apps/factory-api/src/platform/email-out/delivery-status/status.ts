import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { deliveryStateOf } from '@nexus/factory-domain/mail-depth/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayOnThread } from '../../threads/records'
import { contextOf, officeRecord, type RecordRef } from '../../threads/threads'
import type { MessageDeliveryView } from './contract'
import { bounceTaskIdOf } from './tasks'

/**
 * Where each mail of a record's thread is (B-W2b-394; COL-031 "each external message shows sent, delivered or bounced"):
 * GET /email/delivery-status?recordType&recordId (threads.read over the record, as its thread). One row per mail we sent from
 * the thread, newest first (at most 200), keyed by its thread message so the screen puts the pill on it: WAITING, SENT,
 * DELIVERED, SOFT_BOUNCE, BOUNCED, COMPLAINED or FAILED (factory-domain mail-depth `deliveryStateOf`), the times, how many it
 * went to (never who: the thread's mail list names them), and the task its bounce made. A mail that came in has no row.
 */

const iso = (date: Date | null): string | null => (date === null ? null : toUtcIso(date))
const MAX_ROWS = 200

export async function threadDeliveryStatus(caller: CommandCaller, record: RecordRef): Promise<{ messages: MessageDeliveryView[] }> {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  return caller.withClient(async (client) => {
    const { thread, scope } = await officeRecord(client, record)
    if (!mayOnThread(actorOf(context), THREADS_READ, record.type, scope)) throw new NotFoundError('Record not found.')
    if (!thread) return { messages: [] }
    const rows = await client.emailOutbound.findMany({
      where: { threadId: thread.id },
      orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
      take: MAX_ROWS,
      select: { id: true, messageId: true, status: true, bounceKind: true, to: true, cc: true, bcc: true, queuedAt: true, sentAt: true, deliveredAt: true, bouncedAt: true, complainedAt: true, failedAt: true },
    })
    const taskIds = rows.flatMap((row) => (row.bounceKind ? [bounceTaskIdOf(row.id, true), bounceTaskIdOf(row.id, false)] : []))
    const tasks = taskIds.length === 0 ? [] : await client.task.findMany({ where: { id: { in: taskIds } }, select: { id: true, status: true, createdAt: true } })
    return {
      messages: rows.map((row) => {
        const task = [bounceTaskIdOf(row.id, true), bounceTaskIdOf(row.id, false)].map((taskId) => tasks.find((entry) => entry.id === taskId)).find((entry) => entry !== undefined) ?? null
        return {
          outboundId: row.id,
          messageId: row.messageId,
          state: deliveryStateOf(row.status, row.bounceKind),
          bounceKind: row.bounceKind,
          recipients: row.to.length + row.cc.length + row.bcc.length,
          queuedAt: toUtcIso(row.queuedAt),
          sentAt: iso(row.sentAt),
          deliveredAt: iso(row.deliveredAt),
          bouncedAt: iso(row.bouncedAt),
          complainedAt: iso(row.complainedAt),
          failedAt: iso(row.failedAt),
          task: task ? { id: task.id, status: task.status } : null,
        }
      }),
    }
  })
}
