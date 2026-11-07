import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { holds, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { SAFETY_HEALTH_MANAGE, SAFETY_HEALTH_PLANS, SAFETY_HEALTH_VIEW, SAFETY_HEALTH_VIEWS } from '@nexus/factory-domain/safety/health/permissions'
import { AUTOMATIC_WORDS, currentJudgement, HEALTH_LAW, HEALTH_LIMITS, healthRefusalOf, healthTiles, LIVE_USE_WORDS, PRIVACY_WORDS, PROTECTED_HEALTH_LAW, TASK_LIMITS_HINT, type JudgementFacts, type VisitStatus, type VisitType } from '@nexus/factory-domain/safety/health/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { roleNeedsOf } from '../rolesheets/needs'
import { askedPeople, assertMay, assertMayWrite, assertVersion, bodyIssue, dateOf, dayOf, may, officeOf, peopleScope, PLANS_WORDS, refuse, todayOf } from './access'
import { healthFactsOf, judgementFactsOf, proposalsOf } from './facts'
import { doctorFor, doctorNames, PLAN_SELECT, type PlanRow } from './store'

/**
 * The health page's frame and its plans per role (B-W2b-135; design plant.health "Protected page", "Tiles", "Plans per role"):
 *
 *   GET   /safety/health                   (safety.health.view) the PrivacyNote's words, "live use waits for the doctor", what plans
 *                                          itself, the form's hint, the tiles (counts only: nothing recorded), what the caller may do
 *   GET   /safety/health/plans             (safety.view) one plan per role: needed (from the role sheet), how often, the doctor, the
 *                                          end-of-employment visit, the risks driving it (the role sheet's surveillance needs), how
 *                                          many people are in the role: no person in a plan
 *   PATCH /safety/health/plans/:planId     (safety.health.plans) how often, the doctor, the end-of-employment visit, the day the
 *                                          doctor set it; "needed" stays the role sheet's (its Apply writes it, B-W2b-128)
 */

/** GET /safety/health. */
export async function healthFrame(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined }, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  const where: Prisma.EmployeeWhereInput = { AND: [peopleScope(context, SAFETY_HEALTH_VIEW), askedPeople(query)] }
  const tiles = await caller.withClient(async (client) => {
    const facts = await healthFactsOf(client, where)
    const proposals = proposalsOf(facts, today, HEALTH_LIMITS.horizonDays)
    // Open visits of every person in reach (also people no longer in a role that needs visits), and their current judgements.
    const open = await client.healthVisit.findMany({ where: { status: { in: ['DUE', 'BOOKED'] }, employee: where }, select: { employeeId: true, type: true, status: true, dueOn: true, bookedOn: true } })
    const judgements = await client.fitnessJudgement.findMany({ where: { voidedAt: null, employee: { AND: [where, { status: { not: 'LEFT' } }] } }, select: { id: true, employeeId: true, outcome: true, judgedOn: true, expiresOn: true, unfitUntil: true, voidedAt: true, createdAt: true } })
    const byPerson = new Map<string, JudgementFacts[]>()
    for (const row of judgements.map(judgementFactsOf)) byPerson.set(row.employeeId, [...(byPerson.get(row.employeeId) ?? []), row])
    const current = [...byPerson.values()].map((rows) => currentJudgement(rows)).filter((row): row is JudgementFacts => row !== null)
    return healthTiles({
      today,
      visits: open.map((row) => ({ employeeId: row.employeeId, type: row.type as VisitType, status: row.status as VisitStatus, dueOn: dayOf(row.dueOn), bookedOn: row.bookedOn ? dayOf(row.bookedOn) : null })),
      proposals,
      current,
    })
  })
  // Whether a grant of the session holds it anywhere (the page's buttons; each record is still checked).
  const anywhere = (permission: Permission): boolean => holds(actorOf(context), permission)
  return {
    today,
    privacy: { words: PRIVACY_WORDS, law: PROTECTED_HEALTH_LAW, viewLog: anywhere(SAFETY_HEALTH_VIEWS) },
    liveUse: LIVE_USE_WORDS,
    automatic: AUTOMATIC_WORDS,
    hint: TASK_LIMITS_HINT,
    tiles,
    can: { manage: anywhere(SAFETY_HEALTH_MANAGE), plans: anywhere(SAFETY_HEALTH_PLANS), views: anywhere(SAFETY_HEALTH_VIEWS) },
    law: HEALTH_LAW,
  }
}

const PLAN_READ = { ...PLAN_SELECT, site: { select: { code: true, name: true } }, roleSheet: { select: { id: true, code: true, name: true } } } as const satisfies Prisma.HealthPlanSelect
type PlanRead = Prisma.HealthPlanGetPayload<{ select: typeof PLAN_READ }>

async function planViews(caller: CommandCaller, context: OfficeContext, rows: readonly PlanRead[]) {
  return caller.withClient(async (client) => {
    const needs = await roleNeedsOf(client, rows.map((row) => row.roleSheetId))
    const doctors = await doctorNames(client, rows.map((row) => row.doctorAppointmentId))
    const counts = rows.length === 0 ? [] : await client.employee.groupBy({ by: ['roleSheetId'], where: { roleSheetId: { in: rows.map((row) => row.roleSheetId) }, status: 'ACTIVE' }, _count: { _all: true } })
    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      site: row.site,
      role: row.roleSheet,
      needed: row.needed,
      frequencyMonths: row.frequencyMonths,
      endOfEmploymentVisit: row.endOfEmploymentVisit,
      setOn: dayOf(row.setOn),
      doctor: row.doctorAppointmentId ? { id: row.doctorAppointmentId, name: doctors.get(row.doctorAppointmentId) ?? '' } : null,
      doctorSet: row.doctorAppointmentId !== null,
      risks: [...(needs.get(row.roleSheetId)?.surveillanceNeeds ?? [])],
      people: counts.find((entry) => entry.roleSheetId === row.roleSheetId)?._count._all ?? 0,
      status: row.status as 'ACTIVE' | 'ARCHIVED',
      version: row.version,
      canEdit: row.status === 'ACTIVE' && may(context, SAFETY_HEALTH_PLANS, row),
    }))
  })
}

/** GET /safety/health/plans. */
export async function listPlans(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined; readonly status?: 'ACTIVE' | 'ARCHIVED' | 'all' | undefined }) {
  const context = officeOf(caller)
  const reach = scopeWhere(actorOf(context), SAFETY_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.HealthPlanWhereInput
  const status = query.status ?? 'ACTIVE'
  const rows = await caller.withClient((client) =>
    client.healthPlan.findMany({
      where: { AND: [reach, context.companyId ? { companyId: context.companyId } : {}, query.companyId ? { companyId: query.companyId } : {}, query.siteId ? { siteId: query.siteId } : {}, status === 'all' ? {} : { status }] },
      orderBy: [{ site: { code: 'asc' } }, { roleSheet: { code: 'asc' } }, { id: 'asc' }],
      take: 500,
      select: PLAN_READ,
    }),
  )
  return { plans: await planViews(caller, context, rows), law: HEALTH_LAW }
}

/** PATCH /safety/health/plans/:planId. */
export async function editPlan(caller: CommandCaller, planId: string, body: { readonly version: number; readonly frequencyMonths?: number | undefined; readonly endOfEmploymentVisit?: boolean | undefined; readonly doctorAppointmentId?: string | null | undefined; readonly setOn?: BusinessDate | undefined }, idempotencyKey?: string, now: Date = new Date()) {
  const context = officeOf(caller)
  const known = isUuid(planId) ? await caller.withClient((client) => client.healthPlan.findUnique({ where: { id: planId }, select: PLAN_SELECT })) : null
  if (!known) throw new NotFoundError('Plan not found.')
  assertMay(context, SAFETY_VIEW, known, 'Plan')
  assertMayWrite(context, SAFETY_HEALTH_PLANS, known, PLANS_WORDS)
  const today = todayOf(now)
  if (body.setOn && body.setOn > today) throw bodyIssue('setOn', 'The doctor set the plan today at the latest.')
  const { result } = await command(caller, { name: 'safety.setHealthPlan', idempotencyKey, input: { planId, ...body } }, async (tools) => {
    const { tx } = tools
    await tx.$queryRaw`SELECT "id" FROM "HealthPlan" WHERE "id" = ${planId}::uuid FOR UPDATE`
    const plan = (await tx.healthPlan.findUnique({ where: { id: planId }, select: PLAN_SELECT }))!
    assertVersion('plan', plan.version, body.version)
    if (plan.status !== 'ACTIVE') refuse(healthRefusalOf('PLAN_ARCHIVED'))
    if (!plan.needed && (body.frequencyMonths !== undefined || body.endOfEmploymentVisit === true)) refuse(healthRefusalOf('PLAN_NOT_NEEDED', body.frequencyMonths !== undefined ? 'frequencyMonths' : 'endOfEmploymentVisit'))
    const data: Prisma.HealthPlanUncheckedUpdateInput = {}
    const fields: string[] = []
    if (body.frequencyMonths !== undefined && body.frequencyMonths !== plan.frequencyMonths) {
      data.frequencyMonths = body.frequencyMonths
      fields.push('frequencyMonths')
    }
    if (body.endOfEmploymentVisit !== undefined && body.endOfEmploymentVisit !== plan.endOfEmploymentVisit) {
      data.endOfEmploymentVisit = body.endOfEmploymentVisit
      fields.push('endOfEmploymentVisit')
    }
    if (body.doctorAppointmentId !== undefined && body.doctorAppointmentId !== plan.doctorAppointmentId) {
      if (body.doctorAppointmentId !== null) {
        const doctor = await doctorFor(tx, plan.companyId, body.doctorAppointmentId, today)
        if (doctor.refused) refuse(healthRefusalOf('NOT_A_DOCTOR', 'doctorAppointmentId'))
      }
      data.doctorAppointmentId = body.doctorAppointmentId
      fields.push('doctorAppointmentId')
    }
    if (fields.length === 0 && (body.setOn === undefined || body.setOn === dayOf(plan.setOn))) {
      tools.audit({ action: 'safety.setHealthPlan', recordType: 'HealthPlan', recordId: plan.id, companyId: plan.companyId, siteId: plan.siteId, after: { unchanged: true } })
      return { changed: false }
    }
    const setOn = body.setOn ?? today
    if (setOn !== dayOf(plan.setOn)) fields.push('setOn')
    await tx.healthPlan.update({ where: { id: plan.id }, data: { ...data, setOn: dateOf(setOn), version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    // A plan names no person: its audit row may say what changed.
    tools.audit({
      action: 'safety.setHealthPlan',
      recordType: 'HealthPlan',
      recordId: plan.id,
      companyId: plan.companyId,
      siteId: plan.siteId,
      before: { frequencyMonths: plan.frequencyMonths, endOfEmploymentVisit: plan.endOfEmploymentVisit, doctorAppointmentId: plan.doctorAppointmentId, setOn: dayOf(plan.setOn) },
      after: { frequencyMonths: data.frequencyMonths ?? plan.frequencyMonths, endOfEmploymentVisit: data.endOfEmploymentVisit ?? plan.endOfEmploymentVisit, doctorAppointmentId: body.doctorAppointmentId !== undefined ? body.doctorAppointmentId : plan.doctorAppointmentId, setOn },
    })
    tools.emit({ type: 'health_plan.changed', subject: plan.id, companyId: plan.companyId, siteId: plan.siteId, payload: { planId: plan.id, roleSheetId: plan.roleSheetId, change: 'EDITED', fields } })
    return { changed: true }
  })
  const row = (await caller.withClient((client) => client.healthPlan.findUnique({ where: { id: planId }, select: PLAN_READ })))!
  return { plan: (await planViews(caller, context, [row]))[0]!, changed: result.changed }
}

export type { PlanRow }
