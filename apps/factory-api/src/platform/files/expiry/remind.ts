import type { FactoryDatabase, Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, businessDayStart } from '@nexus/factory-domain/core/time'
import { addDays, dayOf, daysUntil, EXPIRY_WINDOWS, reminderWindowOf } from '@nexus/factory-domain/files/expiry/rules'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSettings } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { activeTenants, systemContext } from '../../outbox/system'
import { closeOne, openTaskInCommand } from '../../portal/tasks/store'
import { openExpiryTasks, seriesAnswered } from './answered'
import { expirySourceKey } from './source'

/**
 * Expiry reminders (COL-049; B-W2b-177; plan: "a scheduler job reminds the record's owner and, for a partner's file, the
 * partner (a PartnerTask UPLOAD_DOCUMENT) 30 and 7 days before"). The scheduler's clustered cron `files.remindExpiry`, every
 * day at 06:40 Europe/Rome (in each tenant's system context):
 *
 *   1. requests answered: each open expiry request whose document now has a current version valid beyond the reminders is
 *      closed (DONE), one command each (./answered.ts)
 *   2. reminders: each CURRENT version (AVAILABLE, not superseded) whose expiry date is 0..30 days away and whose window (30,
 *      then 7: factory-domain files/expiry reminderWindowOf) was not reminded yet, in ONE system command keyed
 *      `files-expiry:<file>:<date>:<window>` (a second tick answers from its receipt): the row locked and read again,
 *      `expiryRemindedAt` written (only later; a new date clears it), the audit row, for a file shared with its partner
 *      (PARTNER + its party, of a company) the partner's request opened (one per document and date: the 7-day reminder finds
 *      it), and `file.expiry_due`, which tells the record's owner (./notices.ts) and refreshes the record's Files panel.
 *
 * A superseded version is never reminded (its columns are frozen; its successor carries the date). Nothing leaves the
 * factory here: the partner's mail follows the portal's own rules (B-W2b-167: only to people who can use the portal now).
 */

export interface ExpiryReminderOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

/** Nothing is due any more (seen inside the command): nothing written. */
class NothingDue extends Error {}

const CANDIDATE = {
  id: true,
  companyId: true,
  recordType: true,
  recordId: true,
  originalName: true,
  status: true,
  supersededAt: true,
  expiresOn: true,
  expiryRemindedAt: true,
  seriesId: true,
  visibility: true,
  partyId: true,
} as const satisfies Prisma.StoredFileSelect

const BATCH = 1000
const dateColumn = (day: string): Date => new Date(`${day}T00:00:00Z`)

async function remindOne(caller: CommandCaller, fileId: string, expiresOn: string, window: number, settings: CommandSettings): Promise<boolean> {
  try {
    await runCommand(
      caller,
      { name: 'files.remindExpiry', idempotencyKey: `files-expiry:${fileId}:${expiresOn}:${window}`, input: { fileId, expiresOn, window } },
      async (tools) => {
        const { tx, now } = tools
        await tx.$queryRaw`SELECT "id" FROM "StoredFile" WHERE "id" = ${fileId}::uuid FOR UPDATE`
        const row = await tx.storedFile.findUnique({ where: { id: fileId }, select: CANDIDATE })
        const today = businessDate(now)
        if (!row || row.status !== 'AVAILABLE' || row.supersededAt !== null || row.expiresOn === null || dayOf(row.expiresOn) !== expiresOn) throw new NothingDue()
        if (reminderWindowOf({ expiresOn, remindedAt: row.expiryRemindedAt }, today) !== window) throw new NothingDue()
        await tx.storedFile.update({ where: { id: fileId }, data: { expiryRemindedAt: now, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
        const root = row.seriesId ?? row.id
        const partner = row.partyId !== null && row.companyId !== null && row.visibility.includes('PARTNER')
        const asked = partner
          ? await openTaskInCommand(tools, {
              companyId: row.companyId!,
              partyId: row.partyId!,
              kind: 'UPLOAD_DOCUMENT',
              record: { type: row.recordType, id: row.recordId, label: `${row.originalName} (${expiresOn})` },
              sourceKey: expirySourceKey(root, expiresOn),
              dueAt: businessDayStart(expiresOn),
              askedBy: null,
            })
          : null
        const daysLeft = daysUntil(expiresOn, today)
        tools.audit({
          action: 'files.remindExpiry',
          recordType: 'StoredFile',
          recordId: fileId,
          companyId: row.companyId,
          after: { expiresOn, window, daysLeft, remindedAt: now.toISOString(), partnerAsked: asked ? { taskId: asked.task.id, made: asked.made } : null },
        })
        tools.emit({
          type: 'file.expiry_due',
          subject: fileId,
          companyId: row.companyId,
          payload: { fileId, recordType: row.recordType, recordId: row.recordId, expiresOn, daysLeft, window, partnerTaskId: asked?.task.id ?? null },
        })
        return { fileId, window }
      },
      settings,
    )
    return true
  } catch (error) {
    if (error instanceof NothingDue) return false
    throw error
  }
}

/** Closes one answered expiry request in its own system command; false when it was not answered (or not open) any more. */
async function closeAnswered(caller: CommandCaller, taskId: string, root: string, settings: CommandSettings): Promise<boolean> {
  try {
    await runCommand(caller, { name: 'files.closeExpiryRequest', idempotencyKey: `files-expiry-answered:${taskId}`, input: { taskId } }, async (tools) => {
      const task = await tools.tx.partnerTask.findUnique({ where: { id: taskId }, select: { id: true, status: true } })
      if (!task || task.status !== 'OPEN' || !(await seriesAnswered(tools.tx, root, businessDate(tools.now)))) throw new NothingDue()
      const full = (await openExpiryTasks(tools.tx, 500)).find((entry) => entry.task.id === taskId)
      if (!full) throw new NothingDue()
      await closeOne(tools, full.task, 'DONE', null, false)
      return { taskId }
    }, settings)
    return true
  } catch (error) {
    if (error instanceof NothingDue) return false
    throw error
  }
}

/** One pass over every tenant (the cron's body; tests call it with a moved clock). */
export async function runExpiryReminders(options: ExpiryReminderOptions): Promise<{ readonly tenants: number; readonly reminded: number; readonly closed: number; readonly failed: number }> {
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock: options.clock ?? serverClock }
  const requestId = `files-expiry-${newId()}`
  let reminded = 0
  let closed = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    const today = businessDate(settings.clock.now())
    try {
      for (const entry of await caller.withClient((client) => openExpiryTasks(client))) {
        if (!(await caller.withClient((client) => seriesAnswered(client, entry.root, today)))) continue
        try {
          if (await closeAnswered(caller, entry.task.id, entry.root, settings)) closed++
        } catch (error) {
          failed++
          options.log.error({ err: error, tenantId, taskId: entry.task.id }, 'an answered expiry request could not be closed')
        }
      }
      const rows = await caller.withClient((client) =>
        client.storedFile.findMany({
          where: { status: 'AVAILABLE', supersededAt: null, expiresOn: { gte: dateColumn(today), lte: dateColumn(addDays(today, EXPIRY_WINDOWS[0])) } },
          select: CANDIDATE,
          orderBy: [{ expiresOn: 'asc' }, { id: 'asc' }],
          take: BATCH,
        }),
      )
      for (const row of rows) {
        const expiresOn = dayOf(row.expiresOn!)
        const window = reminderWindowOf({ expiresOn, remindedAt: row.expiryRemindedAt }, today)
        if (window === null) continue
        try {
          if (await remindOne(caller, row.id, expiresOn, window, settings)) reminded++
        } catch (error) {
          failed++
          options.log.error({ err: error, tenantId, fileId: row.id }, 'a document expiry reminder could not be written')
        }
      }
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, 'the document expiry reminders of a tenant could not be read')
    }
  }
  if (reminded + closed + failed > 0) options.log.info({ tenants: tenants.length, reminded, closed, failed }, 'document expiry reminders')
  return { tenants: tenants.length, reminded, closed, failed }
}

/** The clustered cron (scheduler only; one replica per tick): every day at 06:40 Europe/Rome. */
export function expiryRemindersCron(options: ExpiryReminderOptions): CronJob {
  return defineCron({
    name: 'files.remindExpiry',
    schedule: '40 6 * * *',
    lockTtlMs: 900_000,
    async run() {
      await runExpiryReminders(options)
    },
  })
}
