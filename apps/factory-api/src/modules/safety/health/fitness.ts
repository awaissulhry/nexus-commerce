import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { PEOPLE_AUTHORISATIONS_MANAGE } from '@nexus/factory-domain/people/skills/permissions'
import { currentJudgement, fitYesNo, type JudgementFacts } from '@nexus/factory-domain/safety/health/rules'
import { command, type CommandCaller } from '../../../core/command'
import { assertMay, officeOf, todayOf } from './access'
import { judgementFactsOf } from './facts'
import { readPerson, type Client } from './store'

/**
 * Fit yes or no (B-W2b-135; design people.skills "Authorise a machine": "fitness valid (yes / no only, no detail)"; B-W2b-91's
 * note: "a function returning a boolean only"; the lead: "reads fit yes/no only, never the limits beyond what a station needs").
 * The person's current judgement says fit (with or without limits) and has not expired: yes; temporarily unfit, unfit, expired,
 * none on file: no. Never the outcome's words, the limits, the days or the visit.
 *
 *   fitnessYesNoOf(client, employeeIds, today)        THE read for other modules (B-W2b-139's authorisation dialog, a later
 *                                                     floor task gate): a boolean per person, nothing else. A caller that shows it
 *                                                     to someone records the check as below.
 *   POST /safety/health/people/:employeeId/fitness    (people.authorisations.manage over the person) the check recorded first (an
 *                                                     audit row `safety.checkFitness`: who asked, whose; never the answer), then
 *                                                     the yes or no. "Who looked" lists these checks beside the views.
 */

export const FITNESS_CHECK_ACTION = 'safety.checkFitness'

/** A boolean per person (a person with nothing on file: false). Read with the caller's client; no value leaves but the boolean. */
export async function fitnessYesNoOf(client: Client, employeeIds: readonly string[], today: BusinessDate): Promise<Map<string, boolean>> {
  const people = [...new Set(employeeIds)]
  if (people.length === 0) return new Map()
  const rows = await client.fitnessJudgement.findMany({ where: { employeeId: { in: people }, voidedAt: null }, select: { id: true, employeeId: true, outcome: true, judgedOn: true, expiresOn: true, unfitUntil: true, voidedAt: true, createdAt: true } })
  const facts = rows.map(judgementFactsOf)
  return new Map(people.map((employeeId) => [employeeId, fitYesNo(currentJudgement(facts.filter((row: JudgementFacts) => row.employeeId === employeeId)), today)]))
}

/** POST /safety/health/people/:employeeId/fitness. */
export async function checkFitness(caller: CommandCaller, employeeId: string, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  const person = isUuid(employeeId) ? await caller.withClient((client) => readPerson(client, employeeId)) : null
  if (!person) throw new NotFoundError('Employee not found.')
  assertMay(context, PEOPLE_AUTHORISATIONS_MANAGE, person, 'Employee')
  // The check first (who asked whose fitness), its answer never in it: the receipt keeps a command's answer.
  await command(caller, { name: FITNESS_CHECK_ACTION, input: { employeeId, today } }, async (tools) => {
    tools.audit({ action: FITNESS_CHECK_ACTION, recordType: 'Employee', recordId: person.id, companyId: person.companyId, siteId: person.siteId, after: { asked: 'FIT_YES_NO' } })
    return { checked: true }
  })
  const fit = await caller.withClient((client) => fitnessYesNoOf(client, [person.id], today))
  return { employeeId: person.id, fit: fit.get(person.id) ?? false, today }
}
