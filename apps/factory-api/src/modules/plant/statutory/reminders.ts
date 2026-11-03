import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { addDays, dateOf, dayOf, reminderDue, type CheckPlanStatus } from '@nexus/factory-domain/plant/statutory/rules'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSettings, type CommandTools, type CommandTx } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { activeTenants, systemContext } from '../../../platform/outbox/system'
import { todayOf } from './store'

/**
 * The reminders of statutory checks (B-W2b-124; QHS-205; design plant.preventive "Live": "check.due → tones", the plan's
 * "reminder lead time"). Hourly (at :07), per tenant, as its system: each ACTIVE plan whose reminder window opened (the next
 * due date minus its lead time is today or before) and whose due date was not reminded yet (lastRemindedAt null: a command
 * that moves the due date clears it) is reminded in ONE system command keyed `plant-check-remind:<plan>:<due date>` (a
 * second tick answers from its receipt): the plan row locked and read again, lastRemindedAt written, the audit row and
 * `machine_check.due` (overdue or not), which the plant screens show at once. Nothing reaches anyone outside the factory:
 * the outside body is booked by the office (Purchasing, Later).
 */

export interface ReminderOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

/** Nothing is due any more (seen inside the command): nothing written. */
class NothingDue extends Error {}

const CANDIDATE = { id: true, companyId: true, siteId: true, machineId: true, checkTypeId: true, nextDueOn: true, reminderDays: true, lastRemindedAt: true, status: true, machine: { select: { assetNumber: true } } } as const

/** Plans that may be due: ACTIVE, not reminded, due within a year of today (the longest lead time is 365 days). */
async function candidates(db: CommandTx, today: string) {
  return db.machineCheckPlan.findMany({
    where: { status: 'ACTIVE', lastRemindedAt: null, nextDueOn: { lte: dateOf(addDays(today, 365)) } },
    orderBy: [{ nextDueOn: 'asc' }, { id: 'asc' }],
    take: 1000,
    select: CANDIDATE,
  })
}

const dueOf = (row: { status: string; nextDueOn: Date; reminderDays: number; lastRemindedAt: Date | null }, today: string) =>
  reminderDue({ status: row.status as CheckPlanStatus, nextDueOn: dayOf(row.nextDueOn), reminderDays: row.reminderDays, lastRemindedAt: row.lastRemindedAt }, today)

/** Reminds one plan's due date in its own system command; false when nothing was due. */
async function remindOne(caller: CommandCaller, planId: string, dueOn: string, settings: CommandSettings): Promise<boolean> {
  try {
    await runCommand(
      caller,
      { name: 'plant.remindCheck', idempotencyKey: `plant-check-remind:${planId}:${dueOn}`, input: { planId, dueOn } },
      async (tools: CommandTools) => {
        const { tx, now } = tools
        await tx.$queryRaw`SELECT "id" FROM "MachineCheckPlan" WHERE "id" = ${planId}::uuid FOR UPDATE`
        const row = await tx.machineCheckPlan.findUnique({ where: { id: planId }, select: CANDIDATE })
        const today = todayOf(now)
        if (!row || dayOf(row.nextDueOn) !== dueOn || !dueOf(row, today)) throw new NothingDue()
        await tx.machineCheckPlan.update({ where: { id: row.id }, data: { lastRemindedAt: now, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
        const scope = { companyId: row.companyId, siteId: row.siteId }
        const overdue = dueOn < today
        tools.audit({ action: 'plant.remindCheck', recordType: 'MachineCheckPlan', recordId: row.id, ...scope, after: { nextDueOn: dueOn, reminderDays: row.reminderDays, overdue, remindedAt: now.toISOString() } })
        tools.emit({ type: 'machine_check.due', subject: row.id, ...scope, payload: { planId: row.id, machineId: row.machineId, assetNumber: row.machine.assetNumber, checkTypeId: row.checkTypeId, nextDueOn: dueOn, reminderDays: row.reminderDays, overdue } })
        return { planId: row.id, nextDueOn: dueOn, overdue }
      },
      settings,
    )
    return true
  } catch (error) {
    if (error instanceof NothingDue) return false
    throw error
  }
}

/** One pass over every tenant (the cron's body; tests call it with a moved clock). */
export async function runCheckReminders(options: ReminderOptions): Promise<{ readonly tenants: number; readonly reminded: number; readonly failed: number }> {
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock: options.clock ?? serverClock }
  const requestId = `plant-check-remind-${newId()}`
  let reminded = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    const today = todayOf(settings.clock.now())
    const rows = await caller.withClient((client) => candidates(client as CommandTx, today))
    for (const row of rows) {
      if (!dueOf(row, today)) continue
      try {
        if (await remindOne(caller, row.id, dayOf(row.nextDueOn), settings)) reminded++
      } catch (error) {
        failed++
        options.log.error({ err: error, tenantId, planId: row.id }, 'a check reminder could not be written')
      }
    }
  }
  if (reminded + failed > 0) options.log.info({ tenants: tenants.length, reminded, failed }, 'statutory check reminders')
  return { tenants: tenants.length, reminded, failed }
}

/** The clustered cron (scheduler only; one replica per tick): hourly at :07. */
export function checkRemindersCron(options: ReminderOptions): CronJob {
  return defineCron({
    name: 'plant.checkReminders',
    schedule: '7 * * * *',
    async run() {
      await runCheckReminders(options)
    },
  })
}
