import type { AttentionCandidate } from '@nexus/factory-domain/insights/attention'
import { mentionWords, personalPhrase, taskDueWords } from '@nexus/factory-domain/insights/personal'
import { stateOf } from '@nexus/factory-domain/notifications/rules'
import { daysUntil } from '@nexus/factory-domain/tasks/rules'
import { latestPerRecord } from '../../../platform/notifications/store'
import { capped, dayOf, SOURCE_LIMIT, type Source } from './common'

/**
 * Today's own rows (B-W2a-20; design home.today needs-me "tasks due or overdue (W2a) · @mentions (W2a)"), read only when
 * Today is asked for them (`include`). Both are the person's own, never another's:
 *
 *   TASK_DUE   my OPEN tasks due today or before, not snoozed now (platform/tasks): HIGH when overdue, else MEDIUM; the
 *              condition holds the due day, so a moved date is a new row
 *   MENTION    my MENTION notifications not done and not snoozed now (platform/notifications): MEDIUM; done (E) through
 *              the notification, the record opens at the message
 */

/** TASK_DUE: one row per task of mine due today or overdue. */
export const taskDue: Source = async ({ caller, viewer }) => {
  const rows = await caller.withClient((db) =>
    db.task.findMany({
      where: { assigneeId: viewer.personId, status: 'OPEN', dueDate: { lte: new Date(`${viewer.today}T00:00:00.000Z`) }, OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: viewer.now } }] },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take: SOURCE_LIMIT + 1,
      select: { id: true, title: true, companyId: true, siteId: true, partyId: true, recordType: true, recordLabel: true, dueDate: true, dueTime: true, assignedAt: true, createdAt: true },
    }),
  )
  const { rows: shown, complete } = capped(rows, SOURCE_LIMIT)
  const candidates: AttentionCandidate[] = shown.map((task) => {
    const due = dayOf(task.dueDate!)
    const overdueDays = Math.max(0, -daysUntil(viewer.today, due))
    return {
      kind: 'TASK_DUE',
      state: overdueDays > 0 ? 'OVERDUE' : 'TODAY',
      severity: overdueDays > 0 ? 'HIGH' : 'MEDIUM',
      record: { type: 'Task', id: task.id, label: task.title },
      scope: { companyId: task.companyId, siteId: task.siteId, partyId: task.partyId },
      ...taskDueWords({ title: task.title, dueDate: due, dueTime: task.dueTime, overdueDays, recordLabel: task.recordLabel }),
      due,
      since: task.assignedAt ?? task.createdAt,
      why: () => personalPhrase('why.TASK_DUE.assigned'),
      condition: [due, task.dueTime ?? ''],
    }
  })
  return { kind: 'TASK_DUE', candidates, complete }
}

/** MENTION: one row per note that mentioned me, while its notification is still to look at. */
export const mentioned: Source = async ({ caller, viewer }) => {
  const { rows, names, latest } = await caller.withClient(async (db) => {
    const found = await db.notification.findMany({
      where: { userId: viewer.personId, category: 'MENTION', doneAt: null, OR: [{ snoozedAt: null }, { snoozedUntil: { lte: viewer.now } }, { snoozedUntil: null }] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: SOURCE_LIMIT + 1,
      select: { id: true, companyId: true, recordType: true, recordId: true, recordLabel: true, actorId: true, createdAt: true, snoozedAt: true, snoozedUntil: true, doneAt: true },
    })
    const actors = [...new Set(found.flatMap((row) => (row.actorId ? [row.actorId] : [])))]
    const people = actors.length ? new Map((await db.user.findMany({ where: { id: { in: actors } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName])) : new Map<string, string>()
    const newest = await latestPerRecord(db, viewer.personId, found.filter((row) => row.snoozedAt !== null).map((row) => row.recordId))
    return { rows: found, names: people, latest: newest }
  })
  const open = rows.filter((row) => stateOf(row, viewer.now, latest.get(`${row.recordType}:${row.recordId}`) ?? null) === 'OPEN')
  const { rows: shown, complete } = capped(open, SOURCE_LIMIT)
  const candidates: AttentionCandidate[] = shown.map((row) => ({
    kind: 'MENTION',
    state: 'MENTIONED',
    severity: 'MEDIUM',
    // The record the note is on (its chip opens it at the message); the sub key is the notification (Done finishes it).
    record: { type: row.recordType, id: row.recordId, label: row.recordLabel },
    subKey: row.id,
    scope: { companyId: row.companyId, siteId: null, partyId: null },
    sentence: mentionWords({ actor: row.actorId ? (names.get(row.actorId) ?? 'Someone') : 'The system', recordLabel: row.recordLabel }),
    blocks: null,
    due: null,
    since: row.createdAt,
    why: () => personalPhrase('why.MENTION.mentioned'),
  }))
  return { kind: 'MENTION', candidates, complete }
}
