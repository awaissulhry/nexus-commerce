import type { FactoryDatabase, Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { absenceRunsOf, automaticProposals, HEALTH_ABSENCE_CATEGORIES, HEALTH_LIMITS, returnVisitOf, roleChangeVisit } from '@nexus/factory-domain/safety/health/rules'
import { addDays } from '@nexus/factory-domain/safety/calendar/rules'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSettings } from '../../../core/command'
import { SYSTEM_ACTOR_ID } from '../../../core/context'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { activeTenants, systemContext } from '../../../platform/outbox/system'
import { legalGateFor } from '../../people/privacy/gate'
import { dateOf, dayOf } from './access'
import { healthFactsOf, proposalsOf } from './facts'
import { planFactsOf, plansOfRoles, planVisitInCommand, readPerson, visitChanged, type VisitDraft } from './store'

/**
 * The due list builds itself (B-W2b-135; design plant.health live: "employee.role_changed → change-of-task visit due",
 * "attendance.absence (sickness, over 60 days) → return visit due (no diagnosis travels)", "employee.created → before-task visit
 * due"; people.employees "end-of-employment visit (if the doctor's plan says so)"). Only from a plan the doctor set (its doctor
 * recorded: "Plans the doctor sets"; live use waits for the company doctor), each a system command keyed by its cause, writing
 * through store.ts planVisitInCommand (audit without a value; the event: id and state). A person with an open visit of the type
 * gets nothing more.
 *
 *   handler safety.healthVisitOnRoleChange   employee.role_changed → a change-of-task visit due today (a move from another role),
 *                                            or a visit before the task for a starter's first role (a person is never given a
 *                                            role when the record is made: their first role IS the start, so employee.created
 *                                            needs no handler of its own)
 *   handler safety.healthVisitOnLeaving      leaver.started → the end-of-employment visit due on the last working day when the
 *                                            plan asks one; leaver.ended CANCELLED → that visit cancelled (NOT_NEEDED); DONE (the
 *                                            person left) → their other open visits cancelled (LEFT)
 *   cron    safety.healthDueList (daily)     the periodic visits falling due within 60 days (sooner at an expiry or the end of a
 *                                            temporary unfitness); a return visit after more than 60 continuous days of absence
 *                                            for health reasons, read from People › Attendance only where the site's ATTENDANCE
 *                                            gate is open (Statuto art. 4 c.2), the absence's LENGTH only (never a code, a reason
 *                                            or a document): a later absent day entered moves the return visit's due day
 *
 * background.ts lists both handlers and the cron (handler and cron lines only).
 */

type Caller = CommandCaller

/** One system command writing one visit (none when an open one of the type exists: then nothing runs at all). */
async function planNow(caller: Caller, settings: CommandSettings, draft: VisitDraft, key: string, causationId?: string): Promise<boolean> {
  const open = await caller.withClient((client) => client.healthVisit.findFirst({ where: { employeeId: draft.employeeId, type: draft.type, status: { in: ['DUE', 'BOOKED'] } }, select: { id: true } }))
  if (open) return false
  const { result } = await runCommand(caller, { name: 'safety.planHealthVisitsAuto', idempotencyKey: key, input: draft, ...(causationId ? { causationId } : {}) }, async (tools) => {
    const made = await planVisitInCommand(tools, draft, 'SYSTEM', { skipOpen: true })
    // Planned meanwhile by someone else: the audit row names the company only (never the person a visit was meant for).
    if (!made) tools.audit({ action: 'safety.planHealthVisitsAuto', recordType: 'Company', recordId: draft.companyId, companyId: draft.companyId, after: { unchanged: true } })
    return { visitId: made?.id ?? null }
  }, settings)
  return result.visitId !== null
}

/** employee.role_changed → the change-of-task (or before-task) visit. */
export async function visitOnRoleChange(caller: Caller, settings: CommandSettings, payload: { readonly employeeId: string; readonly fromRoleSheetId: string | null; readonly toRoleSheetId: string | null }, eventId: string): Promise<boolean> {
  if (!payload.toRoleSheetId) return false
  const today = businessDate(settings.clock.now())
  const found = await caller.withClient(async (client) => {
    const person = await readPerson(client, payload.employeeId)
    if (!person || person.status !== 'ACTIVE' || person.roleSheetId !== payload.toRoleSheetId) return null
    const plan = (await plansOfRoles(client, [payload.toRoleSheetId])).get(payload.toRoleSheetId!) ?? null
    return { person, plan }
  })
  if (!found) return false
  const visit = roleChangeVisit({ fromRoleSheetId: payload.fromRoleSheetId, plan: found.plan ? planFactsOf(found.plan) : null, startDate: dayOf(found.person.startDate), today })
  if (!visit || !found.plan) return false
  return planNow(caller, settings, { companyId: found.person.companyId, siteId: found.person.siteId, employeeId: found.person.id, type: visit.type, dueOn: visit.dueOn, planId: found.plan.id, roleSheetId: found.plan.roleSheetId, absenceDays: null }, `health-role:${eventId}`, eventId)
}

/** leaver.started / leaver.ended → the end-of-employment visit, or the visits a leaving ends. */
export async function visitsOnLeaving(caller: Caller, settings: CommandSettings, type: 'leaver.started' | 'leaver.ended', payload: { readonly caseId: string; readonly employeeId: string; readonly outcome?: 'DONE' | 'CANCELLED' }, eventId: string): Promise<number> {
  const found = await caller.withClient(async (client) => {
    const person = await readPerson(client, payload.employeeId)
    const leaving = await client.leaverCase.findUnique({ where: { id: payload.caseId }, select: { lastWorkingDay: true } })
    const plan = person?.roleSheetId ? ((await plansOfRoles(client, [person.roleSheetId])).get(person.roleSheetId) ?? null) : null
    return person && leaving ? { person, leaving, plan } : null
  })
  if (!found) return 0
  const { person, plan } = found
  if (type === 'leaver.started') {
    if (!plan || !plan.needed || !plan.endOfEmploymentVisit || plan.doctorAppointmentId === null) return 0
    const made = await planNow(caller, settings, { companyId: person.companyId, siteId: person.siteId, employeeId: person.id, type: 'END_OF_EMPLOYMENT', dueOn: dayOf(found.leaving.lastWorkingDay), planId: plan.id, roleSheetId: plan.roleSheetId, absenceDays: null }, `health-leaving:${payload.caseId}`, eventId)
    return made ? 1 : 0
  }
  // Ended: a cancelled leaving needs no end-of-employment visit; a person who left needs none of their other open visits.
  const cancelled = payload.outcome === 'CANCELLED'
  const where: Prisma.HealthVisitWhereInput = { employeeId: person.id, status: { in: ['DUE', 'BOOKED'] }, type: cancelled ? 'END_OF_EMPLOYMENT' : { not: 'END_OF_EMPLOYMENT' } }
  const open = await caller.withClient((client) => client.healthVisit.findMany({ where, select: { id: true } }))
  if (open.length === 0) return 0
  const { result } = await runCommand(caller, { name: 'safety.cancelHealthVisitsAuto', idempotencyKey: `health-leaving-ended:${payload.caseId}`, input: { caseId: payload.caseId, outcome: payload.outcome } }, async (tools) => {
    const rows = await tools.tx.healthVisit.findMany({ where, select: { id: true } })
    for (const row of rows) {
      await tools.tx.healthVisit.update({ where: { id: row.id }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelledById: SYSTEM_ACTOR_ID, cancelReason: cancelled ? 'NOT_NEEDED' : 'LEFT', version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
      visitChanged(tools, { id: row.id, companyId: person.companyId, siteId: person.siteId }, 'CANCELLED', 'CANCELLED', 'SYSTEM', 'safety.cancelHealthVisitsAuto')
    }
    if (rows.length === 0) tools.audit({ action: 'safety.cancelHealthVisitsAuto', recordType: 'Company', recordId: person.companyId, companyId: person.companyId, after: { unchanged: true } })
    return { cancelled: rows.length }
  }, settings)
  return result.cancelled
}

export function healthHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: 'safety.healthVisitOnRoleChange',
      events: ['employee.role_changed'],
      async handle(event, { caller }) {
        await visitOnRoleChange(caller, COMMAND_SETTINGS, event.payload as { employeeId: string; fromRoleSheetId: string | null; toRoleSheetId: string | null }, event.eventId)
      },
    }),
    defineHandler({
      name: 'safety.healthVisitOnLeaving',
      events: ['leaver.started', 'leaver.ended'],
      async handle(event, { caller }) {
        await visitsOnLeaving(caller, COMMAND_SETTINGS, event.type as 'leaver.started' | 'leaver.ended', event.payload as { caseId: string; employeeId: string; outcome?: 'DONE' | 'CANCELLED' }, event.eventId)
      },
    }),
  ]
}

export interface HealthDueListOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

/** One tenant's pass: the periodic visits, then the return visits. Answers how many visits it planned or moved. */
export async function dueListForTenant(caller: Caller, settings: CommandSettings, log: Log, tenantId: string): Promise<{ readonly planned: number; readonly moved: number; readonly failed: number }> {
  const now = settings.clock.now()
  const today = businessDate(now)
  let planned = 0
  let moved = 0
  let failed = 0
  // 1. The periodic visits of plans the doctor set.
  const facts = await caller.withClient((client) => healthFactsOf(client, {}))
  const people = new Map(facts.people.map((row) => [row.id, row]))
  for (const proposal of automaticProposals(proposalsOf(facts, today, HEALTH_LIMITS.horizonDays))) {
    const person = people.get(proposal.employeeId)!
    try {
      if (await planNow(caller, settings, { companyId: person.companyId, siteId: person.siteId, employeeId: person.id, type: proposal.type, dueOn: proposal.dueOn, planId: proposal.planId, roleSheetId: proposal.roleSheetId, absenceDays: null }, `health-due:${today}:${person.id}:${proposal.type}`)) planned++
    } catch (error) {
      failed++
      log.error({ err: error, tenantId, employeeId: person.id }, 'a periodic health visit could not be planned')
    }
  }
  // 2. Return visits: only where the site's ATTENDANCE gate is open (the absences exist only there), from plans the doctor set.
  const doctorSet = facts.people.filter((row) => facts.plans.get(row.roleSheetId!)?.doctorAppointmentId)
  for (const siteId of [...new Set(doctorSet.map((row) => row.siteId))]) {
    const open = await caller.withClient((client) => legalGateFor(client, siteId, 'ATTENDANCE', now))
    if (!open.open) continue
    const here = doctorSet.filter((row) => row.siteId === siteId)
    // The days only (the code's category picks them; nothing of the code, the minutes or the document is kept).
    const days = await caller.withClient((client) =>
      client.absenceEntry.findMany({
        where: { employeeId: { in: here.map((row) => row.id) }, date: { gte: dateOf(addDays(today, -400)), lte: dateOf(addDays(today, 120)) }, code: { category: { in: [...HEALTH_ABSENCE_CATEGORIES] } } },
        select: { employeeId: true, date: true },
      }),
    )
    for (const person of here) {
      const runs = absenceRunsOf(days.filter((row) => row.employeeId === person.id).map((row) => dayOf(row.date)))
      for (const run of runs) {
        const visit = returnVisitOf(run, today)
        if (!visit) continue
        try {
          const changed = await returnVisitNow(caller, settings, person, facts.plans.get(person.roleSheetId!)!.id, person.roleSheetId!, run.from, visit)
          if (changed === 'PLANNED') planned++
          if (changed === 'MOVED') moved++
        } catch (error) {
          failed++
          log.error({ err: error, tenantId, employeeId: person.id }, 'a return health visit could not be planned')
        }
      }
    }
  }
  return { planned, moved, failed }
}

/** The return visit of one absence: planned once (a return visit made since the absence began is its own), moved when it grew. */
async function returnVisitNow(caller: Caller, settings: CommandSettings, person: { readonly id: string; readonly companyId: string; readonly siteId: string }, planId: string, roleSheetId: string, from: BusinessDate, visit: { readonly absenceDays: number; readonly dueOn: BusinessDate }): Promise<'PLANNED' | 'MOVED' | null> {
  const since = new Date(`${from}T00:00:00.000Z`)
  const existing = await caller.withClient((client) => client.healthVisit.findFirst({ where: { employeeId: person.id, type: 'RETURN_AFTER_ABSENCE', createdAt: { gte: since } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, status: true, dueOn: true } }))
  if (!existing) {
    const made = await planNow(caller, settings, { companyId: person.companyId, siteId: person.siteId, employeeId: person.id, type: 'RETURN_AFTER_ABSENCE', dueOn: visit.dueOn, planId, roleSheetId, absenceDays: visit.absenceDays }, `health-return:${person.id}:${from}`)
    return made ? 'PLANNED' : null
  }
  if (existing.status !== 'DUE' || dayOf(existing.dueOn) >= visit.dueOn) return null
  await runCommand(caller, { name: 'safety.moveHealthVisitAuto', idempotencyKey: `health-return-move:${existing.id}:${visit.dueOn}`, input: { visitId: existing.id, dueOn: visit.dueOn } }, async (tools) => {
    await tools.tx.$queryRaw`SELECT "id" FROM "HealthVisit" WHERE "id" = ${existing.id}::uuid FOR UPDATE`
    const row = (await tools.tx.healthVisit.findUnique({ where: { id: existing.id }, select: { status: true } }))!
    if (row.status === 'DUE') {
      await tools.tx.healthVisit.update({ where: { id: existing.id }, data: { dueOn: dateOf(visit.dueOn), version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
      visitChanged(tools, { id: existing.id, companyId: person.companyId, siteId: person.siteId }, 'MOVED', 'DUE', 'SYSTEM', 'safety.moveHealthVisitAuto')
    } else tools.audit({ action: 'safety.moveHealthVisitAuto', recordType: 'HealthVisit', recordId: existing.id, companyId: person.companyId, siteId: person.siteId, after: { unchanged: true } })
    return { moved: row.status === 'DUE' }
  }, settings)
  return 'MOVED'
}

/** One pass over every tenant (the cron's body; tests call it with a moved clock). */
export async function runHealthDueList(options: HealthDueListOptions): Promise<{ readonly tenants: number; readonly planned: number; readonly moved: number; readonly failed: number }> {
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock: options.clock ?? serverClock }
  const requestId = `health-due-list-${newId()}`
  let planned = 0
  let moved = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    try {
      const outcome = await dueListForTenant(callerFor(options.database, systemContext(tenantId, requestId)), settings, options.log, tenantId)
      planned += outcome.planned
      moved += outcome.moved
      failed += outcome.failed
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, 'the health due list could not be built')
    }
  }
  if (planned + moved + failed > 0) options.log.info({ tenants: tenants.length, planned, moved, failed }, 'health due list built')
  return { tenants: tenants.length, planned, moved, failed }
}

/** The clustered cron (scheduler only; one replica per tick): daily at 05:40 (before the office opens). */
export function healthDueListCron(options: HealthDueListOptions): CronJob {
  return defineCron({
    name: 'safety.healthDueList',
    schedule: '40 5 * * *',
    async run() {
      await runHealthDueList(options)
    },
  })
}
