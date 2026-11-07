import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { dayOf, daysUntil, EXPIRY_WINDOWS } from '@nexus/factory-domain/files/expiry/rules'
import type { CommandTools, CommandTx } from '../../../core/command'
import { closeOne, TASK_COLUMNS } from '../../portal/tasks/store'
import { EXPIRY_SOURCE, expiryKeyParts } from './source'

/**
 * Closing a partner's expiry request once it is answered (B-W2b-177, COL-049; ./source.ts): the series of the document has a
 * current version (AVAILABLE, not superseded) valid beyond the reminders — no expiry date, or one more than 30 days away. Run
 * in the command that moves a document's date (../required/record.ts setDocument) and by the reminder pass (./remind.ts).
 */

/** Whether the series of `root` has a current version that needs no reminder. */
export async function seriesAnswered(tx: Pick<CommandTx, 'storedFile'>, root: string, today: BusinessDate): Promise<boolean> {
  const current = await tx.storedFile.findFirst({ where: { OR: [{ id: root }, { seriesId: root }], status: 'AVAILABLE', supersededAt: null }, select: { expiresOn: true } })
  if (!current) return false
  return current.expiresOn === null || daysUntil(dayOf(current.expiresOn), today) > EXPIRY_WINDOWS[0]
}

/** Closes the open expiry requests of a series on a record when it is answered; how many closed. */
export async function closeAnsweredExpiryTasks(tools: CommandTools, input: { readonly root: string; readonly recordType: string; readonly recordId: string; readonly today: BusinessDate }): Promise<number> {
  const open = await tools.tx.partnerTask.findMany({
    where: { recordType: input.recordType, recordId: input.recordId, kind: 'UPLOAD_DOCUMENT', status: 'OPEN', sourceKey: { startsWith: `${EXPIRY_SOURCE.prefix}:${input.root}:` } },
    select: TASK_COLUMNS,
    take: 50,
  })
  if (open.length === 0 || !(await seriesAnswered(tools.tx, input.root, input.today))) return 0
  for (const task of open) await closeOne(tools, task, 'DONE', null, false)
  return open.length
}

/** The open expiry requests of the tenant (the reminder pass checks each), oldest first. */
export async function openExpiryTasks(tx: Pick<CommandTx, 'partnerTask'>, take = 200) {
  const rows = await tx.partnerTask.findMany({
    where: { kind: 'UPLOAD_DOCUMENT', status: 'OPEN', sourceKey: { startsWith: `${EXPIRY_SOURCE.prefix}:` } },
    select: TASK_COLUMNS,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take,
  })
  return rows.flatMap((task) => {
    const parts = expiryKeyParts(task.sourceKey)
    return parts ? [{ task, ...parts }] : []
  })
}
