import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { automaticPlan, closesNow, type LeaverStepKind, type LeaverStepStatus } from '@nexus/factory-domain/people/leavers/rules'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandSettings, type CommandTools } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { endSessions } from '../../../platform/auth/floor/store'
import { activeTenants, systemContext } from '../../../platform/outbox/system'
import { actorIdOf, dateOf, dayOf, todayOf } from '../employees/access'
import { auditedEmployee, readEmployee } from '../employees/store'
import { endMembership } from '../employees/writes'

/**
 * What the system does on its own for an open leaving (B-W2b-26; MES-214; design "automatic steps tick themselves"),
 * inside the caller's command: every write on a case settles it, the office may ask it (POST …/check), and the clustered
 * cron `people.leaverSteps` settles every open case once an hour.
 *
 *   1. After the last working day the person's floor sign-in is switched off: each active worker deactivated, its
 *      active badges revoked, its floor sessions ended (audited on the Worker); badge off and sessions ended tick.
 *   2. Access ended ticks once the office account is deactivated (never done here: a step-up act in Admin › Users).
 *   3. Shifts cleared ticks once the day after has come and no shift after the last day is planned.
 *   4. When no step is open and the last day has come, the case closes (DONE): the record becomes LEFT with its end
 *      date, its team membership ends on the last day, its loans not begun are removed and a running one ends, any
 *      floor sign-in still active is switched off.
 * An automatic step ticked here names no person (doneById null: the system), in the office scope as in the system's.
 */

export interface Settled {
  readonly ticked: readonly LeaverStepKind[]
  readonly floorSwitchedOff: number
  readonly closed: boolean
}

/** Switches the person's active floor sign-ins off (deactivated, badges revoked, sessions ended); how many. */
async function switchOffFloor(tools: CommandTools, employeeId: string, caseId: string): Promise<number> {
  const { tx, now } = tools
  const workers = await tx.worker.findMany({ where: { employeeId, status: 'ACTIVE' }, select: { id: true, companyId: true, siteId: true } })
  for (const worker of workers) {
    const ended = await endSessions(tx, { workerId: worker.id }, 'WORKER_DEACTIVATED', now)
    const badges = await tx.badge.findMany({ where: { workerId: worker.id, status: 'ACTIVE' }, select: { id: true } })
    if (badges.length > 0) {
      await tx.badge.updateMany({ where: { id: { in: badges.map((badge) => badge.id) }, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: now, revokedById: actorIdOf(tools.context), version: { increment: 1 } } })
    }
    await tx.worker.update({ where: { id: worker.id }, data: { status: 'INACTIVE', version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'people.leaverFloorOff', recordType: 'Worker', recordId: worker.id, companyId: worker.companyId, siteId: worker.siteId, before: { status: 'ACTIVE' }, after: { status: 'INACTIVE', revokedBadges: badges.map((badge) => badge.id), sessionsEnded: ended.length, leaverCaseId: caseId } })
  }
  return workers.length
}

const by = (tools: CommandTools): 'OFFICE' | 'SYSTEM' => (tools.context.audience === 'office' ? 'OFFICE' : 'SYSTEM')

/** What is due for an open case now (read only): the automatic plan, and whether the case then closes. Null: not open. */
async function dueFor(client: CommandTools['tx'], caseId: string, now: Date) {
  const leaver = await client.leaverCase.findUnique({ where: { id: caseId }, select: { id: true, employeeId: true, lastWorkingDay: true, status: true, steps: { orderBy: { seq: 'asc' }, select: { id: true, kind: true, status: true } } } })
  if (!leaver || leaver.status !== 'OPEN') return null
  const employee = (await readEmployee(client, leaver.employeeId))!
  const today = todayOf(now)
  const lastWorkingDay = dayOf(leaver.lastWorkingDay)
  const activeWorkers = await client.worker.count({ where: { employeeId: employee.id, status: 'ACTIVE' } })
  const account = employee.userId ? await client.user.findUnique({ where: { id: employee.userId }, select: { status: true } }) : null
  const shiftsAfter = await client.rosterEntry.count({ where: { employeeId: employee.id, date: { gt: leaver.lastWorkingDay }, kind: 'WORK' } })
  const open = leaver.steps.filter((step) => step.status === 'OPEN').map((step) => step.kind as LeaverStepKind)
  const plan = automaticPlan({ today, lastWorkingDay, activeWorkers, accountEnded: !account || account.status === 'DEACTIVATED', shiftsAfter }, open)
  const after = leaver.steps.map((step) => ({ status: (step.status === 'OPEN' && plan.tick.includes(step.kind as LeaverStepKind) ? 'DONE' : step.status) as LeaverStepStatus }))
  return { leaver, employee, lastWorkingDay, plan, closes: closesNow(after, lastWorkingDay, today) }
}

/** Something is due for the case (the cron runs a command only then). */
export async function isDue(client: CommandTools['tx'], caseId: string, now: Date): Promise<boolean> {
  const due = await dueFor(client, caseId, now)
  return due !== null && (due.plan.switchOffFloor || due.plan.tick.length > 0 || due.closes)
}

/** Settles one case: the automatic steps that are due, then the close when nothing is open. The case's row is locked. */
export async function settleCase(tools: CommandTools, caseId: string): Promise<Settled> {
  const { tx, now } = tools
  await tx.$queryRaw`SELECT "id" FROM "LeaverCase" WHERE "id" = ${caseId}::uuid FOR UPDATE`
  const due = await dueFor(tx, caseId, now)
  if (!due) return { ticked: [], floorSwitchedOff: 0, closed: false }
  const { leaver, employee, lastWorkingDay, plan } = due
  const floorSwitchedOff = plan.switchOffFloor ? await switchOffFloor(tools, employee.id, leaver.id) : 0
  for (const step of leaver.steps) {
    if (step.status !== 'OPEN' || !plan.tick.includes(step.kind as LeaverStepKind)) continue
    await tx.leaverStep.update({ where: { id: step.id }, data: { status: 'DONE', doneAt: now, doneById: null, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'people.leaverStepTicked', recordType: 'Employee', recordId: employee.id, companyId: employee.companyId, siteId: employee.siteId, before: { caseId: leaver.id, step: step.kind, status: 'OPEN' }, after: { caseId: leaver.id, step: step.kind, status: 'DONE', automatic: true } })
    tools.emit({ type: 'leaver.step_done', subject: leaver.id, companyId: employee.companyId, siteId: employee.siteId, payload: { caseId: leaver.id, employeeId: employee.id, stepId: step.id, kind: step.kind as LeaverStepKind, status: 'DONE', by: 'SYSTEM' } })
  }
  if (due.closes) await closeCase(tools, leaver.id, employee.id, lastWorkingDay)
  return { ticked: plan.tick, floorSwitchedOff, closed: due.closes }
}

/** Closes a case whose steps are all done: DONE, the person LEFT on the last day, membership, loans and floor sign-in ended. */
async function closeCase(tools: CommandTools, caseId: string, employeeId: string, lastWorkingDay: string): Promise<void> {
  const { tx, now } = tools
  const actorId = actorIdOf(tools.context)
  await tx.leaverCase.update({ where: { id: caseId }, data: { status: 'DONE', closedAt: now, closedById: actorId, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
  // Anything still on the floor goes (a skipped badge-off step leaves no live sign-in behind a person who left).
  await switchOffFloor(tools, employeeId, caseId)
  const before = (await readEmployee(tx, employeeId))!
  await endMembership(tools, employeeId, todayOf(now), lastWorkingDay)
  const planned = await tx.lineLoan.findMany({ where: { employeeId, startsAt: { gt: now } }, select: { id: true } })
  if (planned.length > 0) await tx.lineLoan.deleteMany({ where: { id: { in: planned.map((loan) => loan.id) } } })
  await tx.lineLoan.updateMany({ where: { employeeId, startsAt: { lte: now }, endsAt: { gt: now } }, data: { endsAt: now, version: { increment: 1 } } })
  await tx.employee.update({ where: { id: employeeId }, data: { status: 'LEFT', endDate: dateOf(lastWorkingDay), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
  const after = (await readEmployee(tx, employeeId))!
  tools.audit({ action: 'people.leaverClosed', recordType: 'Employee', recordId: employeeId, companyId: after.companyId, siteId: after.siteId, before: { ...auditedEmployee(before), caseId }, after: { ...auditedEmployee(after), caseId, loansRemoved: planned.length, closedAt: toUtcIso(now) } })
  tools.emit({ type: 'leaver.ended', subject: caseId, companyId: after.companyId, siteId: after.siteId, payload: { caseId, employeeId, outcome: 'DONE', by: by(tools) } })
  tools.emit({ type: 'employee.updated', subject: employeeId, companyId: after.companyId, siteId: after.siteId, payload: { employeeId, change: 'LEFT', fields: ['status', 'endDate'], workerId: null, by: by(tools) } })
}

// ---- the clustered cron -----------------------------------------------------------------------------------------------

export interface LeaverCronOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

/**
 * Settles every open case of every tenant (one system command per case, keyed by the case and the hour: a second tick
 * of the hour answers from its receipt). The system's own command: it names no person.
 */
export async function runLeaverSteps(options: LeaverCronOptions): Promise<{ readonly tenants: number; readonly settled: number; readonly failed: number }> {
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock: options.clock ?? serverClock }
  const requestId = `leaver-steps-${newId()}`
  const hour = settings.clock.now().toISOString().slice(0, 13)
  let settled = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    const cases = await caller.withClient((client) => client.leaverCase.findMany({ where: { status: 'OPEN' }, select: { id: true }, orderBy: { id: 'asc' }, take: 500 }))
    for (const { id } of cases) {
      try {
        // Only a case with something due takes a command (an audited write): an hour with nothing to do writes nothing.
        if (!(await caller.withClient((client) => isDue(client as CommandTools['tx'], id, settings.clock.now())))) continue
        await runCommand(caller, { name: 'people.settleLeaver', idempotencyKey: `leaver-settle:${id}:${hour}`, input: { caseId: id } }, (tools) => settleCase(tools, id), settings)
        settled++
      } catch (error) {
        failed++
        options.log.error({ err: error, tenantId, caseId: id }, 'an open leaver case could not be settled')
      }
    }
  }
  if (settled + failed > 0) options.log.info({ tenants: tenants.length, settled, failed }, 'leaver steps settled')
  return { tenants: tenants.length, settled, failed }
}

/** The clustered cron (scheduler only; one replica per tick): hourly, at minute 17. */
export function leaverStepsCron(options: LeaverCronOptions): CronJob {
  return defineCron({
    name: 'people.leaverSteps',
    schedule: '17 * * * *',
    async run() {
      await runLeaverSteps(options)
    },
  })
}
