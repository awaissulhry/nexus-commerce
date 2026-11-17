import type { FactoryClient, FactoryDatabase, Prisma } from '@nexus/factory-db'
import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { events as reminderEvents, REMINDER_CHANGES } from '@nexus/factory-domain/reminders/events'
import {
  bulkRefusal,
  changesRecord,
  cleanLabel,
  cleanNote,
  noteProblems,
  REMINDER_LIMITS,
  REMINDER_REFUSALS,
  stateOf,
  whenProblems,
  type ReminderBulkAction,
  type ReminderKind,
  type ReminderRefusal,
  type ReminderView,
} from '@nexus/factory-domain/reminders/rules'
import { callerFor, command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { activeTenants, asSystem, systemContext } from '../../outbox/system'
import { recordLabelOf } from '../../threads/labels'
import { mayOnThread, resolveRecord } from '../../threads/records'
import { officeOf } from '../tasks'
// B-TH-096 (threads plan TH-9, N16): a reminder on a message I shared with the customer is a follow-up that stops on their answer.
import { isFollowUp, stopAnsweredFollowUps } from '../../threads/follow-ups'

/**
 * Remind me about this (B-W2b-388; COL-041; design shell.panels popup remind-me, side panel "Reminders I set", home.tasks
 * section reminders, home.today needs-me "reminders that came back", coming-up "Remind me the day before"; rules
 * factory-domain reminders). Storage: Reminder (B-W2b-366, notify-depth.prisma), every read and write of it here.
 *
 *   GET    /reminders               mine: open (waiting or back), waiting, back or done; one record's with recordType + recordId
 *   POST   /reminders               set one on a record I read (or one of its messages): AT_TIME (a moment) or ON_CHANGE
 *   POST   /reminders/:id/put-off   a new time or kind; it waits again (since = now, came back cleared)
 *   POST   /reminders/:id/done      done (off Today, kept); POST /reminders/:id/undo puts it back
 *   DELETE /reminders/:id           removed (the person's own)
 *   POST   /reminders/bulk          Done N · Remove N over my reminders, in ONE command (all or none)
 *
 * Only the person's own reminders exist for them (another's id is "not found"). Setting one needs the record's thread readable
 * (as a task on a record). Every change is one command with the reminder's version (409 on a stale one), its audit row (on the
 * Reminder, never on the record: another person's ON_CHANGE reminder must not come back because someone set a reminder) and its
 * event. The scheduler (`tasks.reminders`, every minute) brings reminders back: AT_TIME whose moment passed, ON_CHANGE whose
 * record someone else changed after `since` (an audit row of the record that is not a read, or a message on its conversation: a
 * colleague's note, the party's mail).
 */

const [reminderSet, reminderCameBack, reminderChanged] = reminderEvents

export const REMINDER_COLUMNS = {
  id: true,
  userId: true,
  companyId: true,
  recordType: true,
  recordId: true,
  recordLabel: true,
  messageId: true,
  kind: true,
  remindAt: true,
  since: true,
  note: true,
  cameBackAt: true,
  doneAt: true,
  version: true,
  createdAt: true,
  // B-TH-096: what tells a follow-up (the message's side and author).
  message: { select: { direction: true, audience: true, authorId: true } },
} as const satisfies Prisma.ReminderSelect
export type ReminderRow = Prisma.ReminderGetPayload<{ select: typeof REMINDER_COLUMNS }>

type Client = FactoryClient | CommandTx

/** The live events a reminder screen reads its list again on. */
export const REMINDER_LIVE = ['reminder.set', 'reminder.came_back', 'reminder.changed'] as const

const NOT_FOUND = 'Reminder not found.'
const refused = (code: ReminderRefusal): DomainError => new DomainError('conflict', REMINDER_REFUSALS[code], [{ path: `reminder/${code}`, message: REMINDER_REFUSALS[code] }])

export function reminderView(row: ReminderRow) {
  return {
    id: row.id,
    record: { type: row.recordType, id: row.recordId, label: row.recordLabel },
    companyId: row.companyId,
    messageId: row.messageId,
    kind: row.kind as ReminderKind,
    remindAt: row.remindAt ? toUtcIso(row.remindAt) : null,
    since: toUtcIso(row.since),
    note: row.note,
    cameBackAt: row.cameBackAt ? toUtcIso(row.cameBackAt) : null,
    doneAt: row.doneAt ? toUtcIso(row.doneAt) : null,
    state: stateOf(row),
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    // B-TH-096: "Reminds you 18 Nov if no answer" — it stops by itself when the customer answers.
    followUp: isFollowUp(row),
  }
}

const viewWhere = (view: ReminderView): Prisma.ReminderWhereInput =>
  view === 'DONE' ? { doneAt: { not: null } } : view === 'CAME_BACK' ? { doneAt: null, cameBackAt: { not: null } } : view === 'WAITING' ? { doneAt: null, cameBackAt: null } : { doneAt: null }

/** GET /reminders: my reminders of one list (open first: what came back, then by when it comes back), with the lists' counts. */
export async function listReminders(caller: CommandCaller, query: { readonly view: ReminderView; readonly recordType?: string | undefined; readonly recordId?: string | undefined }) {
  const context = officeOf(caller)
  if ((query.recordType === undefined) !== (query.recordId === undefined)) {
    throw new ValidationError('Name the record by its type and id together.', [{ path: 'querystring/recordId', message: 'Give recordType and recordId together.' }])
  }
  const now = serverClock.now()
  const record: Prisma.ReminderWhereInput = query.recordType && query.recordId ? { recordType: query.recordType, recordId: query.recordId } : {}
  return caller.withClient(async (db) => {
    const mine: Prisma.ReminderWhereInput = { userId: context.actorId, ...record }
    const rows = await db.reminder.findMany({
      where: { AND: [mine, viewWhere(query.view)] },
      orderBy: query.view === 'DONE' ? [{ doneAt: 'desc' }, { id: 'asc' }] : [{ cameBackAt: { sort: 'desc', nulls: 'last' } }, { remindAt: { sort: 'asc', nulls: 'last' } }, { since: 'asc' }, { id: 'asc' }],
      take: REMINDER_LIMITS.list + 1,
      select: REMINDER_COLUMNS,
    })
    const [waiting, cameBack, done] = [
      await db.reminder.count({ where: { AND: [mine, viewWhere('WAITING')] } }),
      await db.reminder.count({ where: { AND: [mine, viewWhere('CAME_BACK')] } }),
      await db.reminder.count({ where: { AND: [mine, viewWhere('DONE')] } }),
    ]
    return {
      asOf: toUtcIso(now),
      view: query.view,
      counts: { waiting, cameBack, done },
      items: rows.slice(0, REMINDER_LIMITS.list).map(reminderView),
      complete: rows.length <= REMINDER_LIMITS.list,
      live: { events: [...REMINDER_LIVE] },
    }
  })
}

/** My reminder, read for a change (another person's: not found). */
async function mineOf(tx: Client, id: string, personId: string): Promise<ReminderRow> {
  const row = await tx.reminder.findFirst({ where: { id, userId: personId }, select: REMINDER_COLUMNS })
  if (!row) throw new NotFoundError(NOT_FOUND)
  return row
}

const checkVersion = (row: Pick<ReminderRow, 'id' | 'version'>, version: number) => {
  if (row.version !== version) throw new StaleVersionError('Reminder', row.id, row.version, version)
}

const about = (row: Pick<ReminderRow, 'id' | 'recordType' | 'recordId' | 'userId'>) => ({ reminderId: row.id, recordType: row.recordType, recordId: row.recordId, userId: row.userId })

function emitChanged(tools: CommandTools, row: ReminderRow, change: (typeof REMINDER_CHANGES)[number]) {
  tools.emit(eventFor(reminderChanged, { subject: row.id, companyId: row.companyId, payload: { ...about(row), change } }))
}

interface SetBody {
  readonly record: { readonly type: string; readonly id: string }
  readonly messageId?: string | null | undefined
  readonly kind: ReminderKind
  readonly remindAt?: string | null | undefined
  readonly note?: string | null | undefined
}

/** POST /reminders: a reminder on a record I read (or one message of its thread). */
export async function setReminder(caller: CommandCaller, body: SetBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const { result } = await command(caller, { name: 'tasks.reminderSet', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const problems = [...whenProblems(body, now), ...noteProblems(body.note)]
    if (problems.length > 0) throw new ValidationError('The reminder is not valid.', problems)
    const found = await resolveRecord(tx, body.record.type, body.record.id)
    if (!found || !mayOnThread(actor, THREADS_READ, body.record.type, found)) throw new NotFoundError('Record not found.')
    const label = await recordLabelOf(tx, body.record.type, body.record.id)
    if (label === null) throw new NotFoundError('Record not found.')
    if (body.messageId) {
      const message = await tx.message.findFirst({ where: { id: body.messageId, thread: { recordType: body.record.type, recordId: body.record.id } }, select: { id: true } })
      if (!message) throw new ValidationError('This message is not on the record’s conversation.', [{ path: 'body/messageId', message: 'Not a message of this record.' }])
    }
    if ((await tx.reminder.count({ where: { userId: context.actorId, doneAt: null } })) >= REMINDER_LIMITS.open) throw refused('TOO_MANY')
    const id = newId()
    const row = await tx.reminder.create({
      data: {
        id,
        userId: context.actorId,
        companyId: found.companyId ?? null,
        recordType: body.record.type,
        recordId: body.record.id,
        recordLabel: cleanLabel(label),
        messageId: body.messageId ?? null,
        kind: body.kind,
        remindAt: body.kind === 'AT_TIME' ? new Date(body.remindAt!) : null,
        since: now,
        note: cleanNote(body.note),
        createdAt: now,
        updatedAt: now,
      },
      select: REMINDER_COLUMNS,
    })
    tools.audit({ recordType: 'Reminder', recordId: id, companyId: row.companyId, after: { recordType: row.recordType, recordId: row.recordId, messageId: row.messageId, kind: row.kind, remindAt: row.remindAt ? toUtcIso(row.remindAt) : null, note: row.note !== null } })
    tools.emit(eventFor(reminderSet, { subject: id, companyId: row.companyId, payload: { ...about(row), kind: row.kind as ReminderKind } }))
    return { reminder: reminderView(row) }
  })
  return result
}

/** POST /reminders/:id/put-off: a new time or kind (Snooze); it waits again from now. */
export async function putOffReminder(caller: CommandCaller, id: string, body: { readonly version: number; readonly kind: ReminderKind; readonly remindAt?: string | null | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const { result } = await command(caller, { name: 'tasks.reminderPutOff', idempotencyKey, input: { id, ...body } }, async (tools) => {
    const { tx, now } = tools
    const problems = whenProblems(body, now)
    if (problems.length > 0) throw new ValidationError('The reminder is not valid.', problems)
    const before = await mineOf(tx, id, context.actorId)
    checkVersion(before, body.version)
    if (before.doneAt !== null) throw refused('DONE')
    // The moment it watches from moves on (never back, even when two writes share a millisecond).
    const since = now > before.since ? now : new Date(before.since.getTime() + 1)
    const row = await tx.reminder.update({
      where: { id },
      data: { kind: body.kind, remindAt: body.kind === 'AT_TIME' ? new Date(body.remindAt!) : null, since, cameBackAt: null, version: before.version + 1, updatedAt: now },
      select: REMINDER_COLUMNS,
    })
    tools.audit({ recordType: 'Reminder', recordId: id, companyId: row.companyId, before: { kind: before.kind, remindAt: before.remindAt ? toUtcIso(before.remindAt) : null, cameBack: before.cameBackAt !== null }, after: { kind: row.kind, remindAt: row.remindAt ? toUtcIso(row.remindAt) : null } })
    emitChanged(tools, row, 'PUT_OFF')
    return { reminder: reminderView(row) }
  })
  return result
}

/** POST /reminders/:id/done (done: true) and /undo (done: false). */
export async function setReminderDone(caller: CommandCaller, id: string, body: { readonly version: number }, done: boolean, idempotencyKey?: string) {
  const context = officeOf(caller)
  const { result } = await command(caller, { name: done ? 'tasks.reminderDone' : 'tasks.reminderUndo', idempotencyKey, input: { id, ...body } }, async (tools) => {
    const { tx, now } = tools
    const before = await mineOf(tx, id, context.actorId)
    checkVersion(before, body.version)
    if (done && before.doneAt !== null) throw refused('DONE')
    if (!done && before.doneAt === null) throw refused('NOT_DONE')
    const row = await tx.reminder.update({ where: { id }, data: { doneAt: done ? now : null, version: before.version + 1, updatedAt: now }, select: REMINDER_COLUMNS })
    tools.audit({ recordType: 'Reminder', recordId: id, companyId: row.companyId, before: { state: stateOf(before) }, after: { state: stateOf(row) } })
    emitChanged(tools, row, done ? 'DONE' : 'UNDONE')
    return { reminder: reminderView(row) }
  })
  return result
}

/** DELETE /reminders/:id?version: removed by its person. */
export async function removeReminder(caller: CommandCaller, id: string, version: number, idempotencyKey?: string) {
  const context = officeOf(caller)
  const { result } = await command(caller, { name: 'tasks.reminderRemove', idempotencyKey, input: { id, version } }, async (tools) => {
    const before = await mineOf(tools.tx, id, context.actorId)
    checkVersion(before, version)
    await tools.tx.reminder.delete({ where: { id } })
    tools.audit({ recordType: 'Reminder', recordId: id, companyId: before.companyId, before: { recordType: before.recordType, recordId: before.recordId, state: stateOf(before) } })
    emitChanged(tools, before, 'REMOVED')
    return { removed: id }
  })
  return result
}

/** POST /reminders/bulk: Done N · Remove N over my reminders, all or none (a reminder done already refuses Done N). */
export async function bulkReminders(caller: CommandCaller, body: { readonly action: ReminderBulkAction; readonly ids: readonly string[] }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const ids = [...new Set(body.ids)]
  const { result } = await command(caller, { name: 'tasks.reminderBulk', idempotencyKey, input: { action: body.action, ids } }, async (tools) => {
    const { tx, now } = tools
    const rows = await tx.reminder.findMany({ where: { id: { in: ids }, userId: context.actorId }, select: REMINDER_COLUMNS })
    if (rows.length !== ids.length) throw new NotFoundError('One of the reminders is not yours, or was removed meanwhile.')
    for (const row of rows) {
      const refusal = bulkRefusal(row, body.action)
      if (refusal) throw new DomainError('conflict', `${row.recordLabel}: ${REMINDER_REFUSALS[refusal]}`, [{ path: `reminder/${refusal}`, message: REMINDER_REFUSALS[refusal] }])
    }
    const items: ReturnType<typeof reminderView>[] = []
    for (const row of rows) {
      if (body.action === 'REMOVE') {
        await tx.reminder.delete({ where: { id: row.id } })
        tools.audit({ recordType: 'Reminder', recordId: row.id, companyId: row.companyId, before: { recordType: row.recordType, recordId: row.recordId, state: stateOf(row) }, after: { bulk: ids.length } })
        emitChanged(tools, row, 'REMOVED')
      } else {
        const after = await tx.reminder.update({ where: { id: row.id }, data: { doneAt: now, version: row.version + 1, updatedAt: now }, select: REMINDER_COLUMNS })
        tools.audit({ recordType: 'Reminder', recordId: row.id, companyId: row.companyId, before: { state: stateOf(row) }, after: { state: 'DONE', bulk: ids.length } })
        emitChanged(tools, after, 'DONE')
        items.push(reminderView(after))
      }
    }
    return { action: body.action, changed: rows.length, items }
  })
  return result
}

// ---- the scheduler: reminders come back --------------------------------------------------------------------------------------

export interface ReminderRunOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

export interface ReminderRun {
  readonly atTime: number
  readonly onChange: number
  readonly failed: number
}

/** Whether a waiting ON_CHANGE reminder's record changed after `since`, by someone else (a read never counts; a message does). */
async function recordChanged(client: Client, reminder: Pick<ReminderRow, 'userId' | 'recordType' | 'recordId' | 'since'>, now: Date): Promise<boolean> {
  const rows = await client.auditLog.findMany({
    where: { recordType: reminder.recordType, recordId: reminder.recordId, at: { gt: reminder.since, lte: now } },
    orderBy: [{ at: 'asc' }, { id: 'asc' }],
    take: 50,
    select: { actorId: true, action: true },
  })
  if (rows.some((row) => changesRecord(row, reminder.userId))) return true
  // New activity on its conversation by anyone else: a colleague's note, a mail or portal message from the party (a message is
  // audited on the Message, not on the record).
  const message = await client.message.findFirst({
    where: { at: { gt: reminder.since, lte: now }, OR: [{ authorId: null }, { authorId: { not: reminder.userId } }], thread: { recordType: reminder.recordType, recordId: reminder.recordId } },
    select: { id: true },
  })
  return message !== null
}

/**
 * One run over every active tenant (the cron's tick; tests call it with their clock): per tenant ONE command brings back the
 * AT_TIME reminders whose moment passed and the ON_CHANGE reminders whose record changed, each with `reminder.came_back`.
 */
export async function runReminders(options: ReminderRunOptions): Promise<ReminderRun> {
  const result = { atTime: 0, onChange: 0, failed: 0 }
  const requestId = `tasks-reminders-${newId()}`
  for (const tenantId of await activeTenants(options.database)) {
    try {
      // B-TH-096: answered follow-ups (or of a closed conversation) stop first, so they never come back.
      await stopAnsweredFollowUps(options.database, tenantId, requestId)
      const now = (options.clock ?? serverClock).now()
      const { due, changed } = await asSystem(options.database, tenantId, requestId, async (client) => {
        const atTime = await client.reminder.findMany({
          where: { kind: 'AT_TIME', doneAt: null, cameBackAt: null, remindAt: { lte: now } },
          orderBy: [{ remindAt: 'asc' }, { id: 'asc' }],
          take: REMINDER_LIMITS.perRun,
          select: { id: true, version: true },
        })
        const watching = await client.reminder.findMany({
          where: { kind: 'ON_CHANGE', doneAt: null, cameBackAt: null, since: { lt: now } },
          orderBy: [{ since: 'asc' }, { id: 'asc' }],
          take: REMINDER_LIMITS.perRun,
          select: { id: true, version: true, userId: true, recordType: true, recordId: true, since: true },
        })
        const moved: { id: string; version: number }[] = []
        for (const reminder of watching) if (await recordChanged(client, reminder, now)) moved.push({ id: reminder.id, version: reminder.version })
        return { due: atTime, changed: moved }
      })
      if (due.length + changed.length === 0) continue
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      const run = await command(caller, { name: 'tasks.remindersCameBack', input: { atTime: due.length, onChange: changed.length, requestId } }, async (tools) => {
        const { tx } = tools
        let atTime = 0
        let onChange = 0
        for (const candidate of [...due, ...changed]) {
          // Only a reminder still waiting, as read (done or put off meanwhile: left alone).
          const updated = await tx.reminder.updateMany({ where: { id: candidate.id, version: candidate.version, doneAt: null, cameBackAt: null }, data: { cameBackAt: tools.now, version: { increment: 1 }, updatedAt: tools.now } })
          if (updated.count === 0) continue
          const row = await tx.reminder.findUniqueOrThrow({ where: { id: candidate.id }, select: REMINDER_COLUMNS })
          tools.audit({ recordType: 'Reminder', recordId: row.id, companyId: row.companyId, after: { cameBack: row.kind } })
          tools.emit(eventFor(reminderCameBack, { subject: row.id, companyId: row.companyId, payload: { ...about(row), kind: row.kind as ReminderKind } }))
          if (row.kind === 'AT_TIME') atTime += 1
          else onChange += 1
        }
        // Every command records at least one audit row: a run where everything moved meanwhile notes the run itself.
        if (atTime + onChange === 0) tools.audit({ recordType: 'Reminder', recordId: [...due, ...changed][0]!.id, after: { cameBack: 0 } })
        return { atTime, onChange }
      })
      result.atTime += run.result.atTime
      result.onChange += run.result.onChange
    } catch (error) {
      result.failed += 1
      options.log.error({ err: error, tenantId }, 'the reminders of a tenant could not be brought back')
    }
  }
  return result
}

/** The clustered cron `tasks.reminders`: every minute (a reminder for 16:00 comes back by 16:01). */
export function remindersCron(options: Omit<ReminderRunOptions, 'clock'>): CronJob {
  return defineCron({
    name: 'tasks.reminders',
    schedule: '* * * * *',
    async run() {
      const result = await runReminders(options)
      if (result.atTime + result.onChange + result.failed > 0) options.log.info({ ...result }, 'reminders came back')
    },
  })
}
