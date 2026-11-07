import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { REMIND_BEFORE_MS, reminderDue } from '@nexus/factory-domain/portal/tasks/rules'
import { callerFor, COMMAND_SETTINGS, runCommand } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { activeTenants, systemContext } from '../../outbox/system'
import { markRemindedInCommand, taskById, TASK_COLUMNS } from './store'

/**
 * The reminder e-mails of the one task list (B-W2b-167; design portal.frame "The same task list feeds Home, the rail badges
 * and the reminder e-mails"). The scheduler's cron `portalTasks.remind` (hourly, minute 25) reads every tenant's OPEN requests
 * with a due date that are due within 2 days or past it (index [tenantId, status, dueAt]) and, for each whose reminder is
 * due (factory-domain portal/tasks/rules reminderDue: once before, once when past, then weekly for 30 days, never two in a
 * day), ONE system command marks `remindedAt` and emits `partner_task.reminded`; the notification fan-out tells the people
 * the request is for, and e-mails them as their REMINDERS setting says (as it happens, in the summary, or not at all).
 *
 * The partner's portal must be ON for anyone to be told (the fan-out's readers): a party whose portal is off is never
 * reminded by mail (the Owner's switch per partner, OFF by default).
 */

export interface ReminderOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

const BATCH = 500

/** One tick over every active tenant (the cron's; tests call it). How many requests were reminded. */
export async function remindPartnerTasks(options: ReminderOptions): Promise<number> {
  const clock = options.clock ?? serverClock
  const settings = { ...COMMAND_SETTINGS, clock }
  const now = clock.now()
  const requestId = `portal-task-reminders-${newId()}`
  let reminded = 0
  for (const tenantId of await activeTenants(options.database)) {
    try {
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      const candidates = await caller.withClient((client) =>
        client.partnerTask.findMany({ where: { status: 'OPEN', dueAt: { not: null, lte: new Date(now.getTime() + REMIND_BEFORE_MS) } }, orderBy: [{ dueAt: 'asc' }, { id: 'asc' }], take: BATCH, select: TASK_COLUMNS }),
      )
      for (const candidate of candidates.filter((task) => reminderDue(task, now))) {
        try {
          const outcome = await runCommand(
            caller,
            { name: 'portalTasks.remind', idempotencyKey: `portal-task-remind:${candidate.id}:${businessDate(now)}`, input: { taskId: candidate.id, day: businessDate(now) } },
            async (tools) => {
              const task = await taskById(tools.tx, candidate.id)
              if (!task || !reminderDue(task, tools.now)) {
                // Answered or reminded meanwhile: nothing to do (the command still says so).
                tools.audit({ action: 'partnerTasks.remind', recordType: 'PartnerTask', recordId: candidate.id, after: { skipped: true } })
                return false
              }
              await markRemindedInCommand(tools, task)
              return true
            },
            settings,
          )
          if (!outcome.replayed && outcome.result) reminded += 1
        } catch (error) {
          options.log.error({ err: error, tenantId, taskId: candidate.id }, 'a partner request could not be reminded')
        }
      }
    } catch (error) {
      options.log.error({ err: error, tenantId }, 'the partner requests of a tenant could not be read for reminders')
    }
  }
  if (reminded > 0) options.log.info({ reminded }, 'partner requests reminded')
  return reminded
}

/** The scheduler's cron: hourly at minute 25 (Europe/Rome). */
export function partnerTaskRemindersCron(options: ReminderOptions): CronJob {
  return defineCron({
    name: 'portalTasks.remind',
    schedule: '25 * * * *',
    lockTtlMs: 600_000,
    async run() {
      await remindPartnerTasks(options)
    },
  })
}
