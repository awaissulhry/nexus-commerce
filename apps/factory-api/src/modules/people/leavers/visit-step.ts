import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { PEOPLE_LEAVERS_MANAGE } from '@nexus/factory-domain/people/leavers/permissions'
import { SAFETY_HEALTH_VIEW } from '@nexus/factory-domain/safety/health/permissions'
import { healthRefusalOf, visitStateOf, type VisitStatus } from '@nexus/factory-domain/safety/health/rules'
import type { CommandCaller } from '../../../core/command'
import { assertMayWrite as assertHealth, dayOf, officeOf, refuse, todayOf, VIEW_WORDS } from '../../safety/health/access'
import { recordViews } from '../../safety/health/protected'
import { plansOfRoles, readPerson } from '../../safety/health/store'
import { assertMayWrite } from '../employees/access'
import { leaverRecord, moveStep } from './leavers'

/**
 * The leaver step "End-of-employment visit" linked to the visit (B-W2b-135 for B-W2b-26's leaver steps; design people.employees
 * "Leavers in progress … end-of-employment visit (if the doctor's plan says so)"; D.Lgs. 81/2008 art. 41 c.2 e). The leaver
 * routes and their rules stay B-W2b-26's (./leavers.ts); these two are registered by modules/safety/health/routes.ts. The visit
 * itself is planned by the health module (its handler on leaver.started, when the role's plan asks one and the doctor set it; or
 * by hand on the health page); whether a person needs one is protected, so both routes ask the health reader's permission too.
 *
 *   POST /people/leavers/:caseId/exit-visit/open                     (people.view + safety.health.view) the person's end-of-
 *                                                                    employment visits (each a view recorded: HEALTH_VISIT,
 *                                                                    OPEN), whether the role's plan asks one, the step
 *   POST /people/leavers/:caseId/steps/:stepId/exit-visit            (people.leavers.manage + safety.health.view) {version,
 *                                                                    visitId}: the step done, naming the visit (recordType
 *                                                                    HealthVisit) once it took place (DONE), through B-W2b-26's
 *                                                                    own step command (moveStep: the case's lock, the step's
 *                                                                    version, its audit row and event, the case settled)
 * No visit needed (the plan asks none, the doctor says so): skip the step with the reason (B-W2b-26's skip).
 */

/** POST /people/leavers/:caseId/exit-visit/open. */
export async function exitVisit(caller: CommandCaller, caseId: string, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  const { leaver } = await leaverRecord(caller, caseId)
  const place = { companyId: leaver.employee.companyId, siteId: leaver.employee.site.id }
  assertHealth(context, SAFETY_HEALTH_VIEW, place, VIEW_WORDS)
  const ids = await caller.withClient((client) => client.healthVisit.findMany({ where: { employeeId: leaver.employeeId, type: 'END_OF_EMPLOYMENT' }, select: { id: true, companyId: true } }))
  await recordViews(caller, context, 'safety.openExitVisit', ids.map((row) => ({ recordType: 'HEALTH_VISIT', recordId: row.id, employeeId: leaver.employeeId, companyId: row.companyId, what: 'OPEN' })))
  return caller.withClient(async (client) => {
    const person = await readPerson(client, leaver.employeeId)
    const plan = person?.roleSheetId ? ((await plansOfRoles(client, [person.roleSheetId])).get(person.roleSheetId) ?? null) : null
    const rows = ids.length === 0 ? [] : await client.healthVisit.findMany({ where: { id: { in: ids.map((row) => row.id) } }, orderBy: [{ dueOn: 'asc' }, { id: 'asc' }], select: { id: true, dueOn: true, status: true, bookedOn: true, doneOn: true, version: true } })
    const step = leaver.steps.find((entry) => entry.kind === 'EXIT_VISIT') ?? null
    return {
      employee: { id: leaver.employee.id, name: leaver.employee.name },
      step: step ? { id: step.id, status: step.status, version: step.version, recordType: step.recordType, recordId: step.recordId } : null,
      planAsks: plan !== null && plan.needed && plan.endOfEmploymentVisit,
      visits: rows.map((row) => ({
        id: row.id,
        dueOn: dayOf(row.dueOn),
        status: row.status as VisitStatus,
        state: visitStateOf({ status: row.status as VisitStatus, dueOn: dayOf(row.dueOn), bookedOn: row.bookedOn ? dayOf(row.bookedOn) : null }, today),
        bookedOn: row.bookedOn ? dayOf(row.bookedOn) : null,
        doneOn: row.doneOn ? dayOf(row.doneOn) : null,
        version: row.version,
      })),
      recorded: ids.length > 0,
    }
  })
}

/** POST /people/leavers/:caseId/steps/:stepId/exit-visit. */
export async function markExitVisit(caller: CommandCaller, caseId: string, stepId: string, body: { readonly version: number; readonly visitId: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const { leaver } = await leaverRecord(caller, caseId)
  const place = { companyId: leaver.employee.companyId, siteId: leaver.employee.site.id }
  assertMayWrite(context, PEOPLE_LEAVERS_MANAGE, place, 'Leaver steps are kept by a role that keeps them (people.leavers.manage).')
  assertHealth(context, SAFETY_HEALTH_VIEW, place, VIEW_WORDS)
  const step = leaver.steps.find((entry) => entry.id === stepId)
  if (!step) throw new NotFoundError('Leaver step not found.')
  if (step.kind !== 'EXIT_VISIT') refuse(healthRefusalOf('NOT_EXIT_STEP'))
  const visit = isUuid(body.visitId) ? await caller.withClient((client) => client.healthVisit.findFirst({ where: { id: body.visitId, employeeId: leaver.employeeId, type: 'END_OF_EMPLOYMENT' }, select: { id: true, status: true } })) : null
  if (!visit || visit.status !== 'DONE') refuse(healthRefusalOf('EXIT_VISIT_NOT_DONE', 'visitId'))
  return moveStep(caller, caseId, stepId, 'DONE', { version: body.version, recordType: 'HealthVisit', recordId: body.visitId }, idempotencyKey)
}
