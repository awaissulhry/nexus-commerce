import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { type BusinessDate } from '@nexus/factory-domain/core/time'
import { PERSON_DENOMINATOR, PERSON_WORDS, personDaysOf, type PersonReport } from '@nexus/factory-domain/people/efficiency/rules'
import { openReasonProblems, type OpenReason } from '@nexus/factory-domain/people/privacy/figures'
import { PEOPLE_FIGURES_VIEW } from '@nexus/factory-domain/people/privacy/permissions'
import { STATION_SITE } from '@nexus/factory-domain/production/labour/rules'
import { minutesOf } from '@nexus/factory-domain/production/offstandard/rules'
import { command, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { dayColumn, isoDay } from '../../production/labour/store'
import { scanSubjectFor } from '../../production/settings/subject'
import { rangeOf, siteFor } from '../attendance/access'
import { officeOf, refuse } from '../employees/access'
import { openPersonFiguresInCommand, personFiguresAccess, requirePersonFigures, type PersonFiguresAccess } from '../privacy/access'
import { gateClosedError, legalGateFor, requireLegalGate } from '../privacy/gate'
import { onTraineeDay, readWork, siteLines, traineesOf, type DayRange, type Place, type Reader, type SiteLines } from './store'

/**
 * One person's figures (B-W2b-44; MES-247; design people.efficiency "One person's figures"; Statuto dei Lavoratori art. 4 c.1;
 * Owner answer H3: the worker and HR). The only per-person answer of this module.
 *
 *   gate first     the site's PERFORMANCE legal gate, before anything about the person is looked at: off (the default), every
 *                  person id, real or not, gets the same 409 `gate/PERFORMANCE`, so the answer never tells that a person
 *                  exists. That is why the site comes in the body and not from the person's record.
 *   who            personFiguresAccess: the worker, or a role People settings name (HR). A team lead is refused here even
 *                  where the site lets leads see figures: H3 names the worker and HR. A person who is not there, not at this
 *                  site or not the viewer's to open gets one and the same 403.
 *   recorded       ONE command writes the opening down (audit people.openPersonFigures: who, whose, purpose, why). The
 *                  command answers no figure on purpose: its answer is kept in the idempotency receipt, and one person's
 *                  figures would sit in that table past the opening and past the gate. They are read after it, gate asked again.
 *   what it says   days, own solo reports, no comparison, no rank, no target. Trainee days and shared work are left out and
 *                  counted. Not built on attended minutes (rules.ts PERSON_DENOMINATOR).
 */

export const PERSON_NOT_ALLOWED = "One person's efficiency is seen only by the worker and by HR (Statuto dei Lavoratori art. 4)."

const notAllowed = (): DomainError => new DomainError('forbidden', PERSON_NOT_ALLOWED, [{ path: 'figures/NOT_ALLOWED', message: PERSON_NOT_ALLOWED }])

interface PersonBody {
  readonly siteId: string
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly reason?: OpenReason | undefined
  readonly note?: string | null | undefined
}

/** Who the viewer is to the person, every refusal after the gate being the same answer. */
async function accessAt(caller: CommandCaller, employeeId: string, siteId: string): Promise<PersonFiguresAccess> {
  const access = await personFiguresAccess(caller, employeeId, 'PERFORMANCE').catch((error: unknown) => {
    if (error instanceof NotFoundError) throw notAllowed()
    throw error
  })
  const refused = !access.decision.allowed && access.decision.code === 'NOT_ALLOWED'
  if (access.employee.siteId !== siteId || refused) throw notAllowed()
  return access
}

/** One person's days at a site: their solo reports, their off-standard blocks. Nothing about anyone else. */
export async function personDaysAt(db: Reader, place: Place, setup: SiteLines, employeeId: string, range: DayRange, now: Date) {
  const workers = (await db.worker.findMany({ where: { employeeId, siteId: place.id }, select: { id: true } })).map((row) => row.id)
  const work = workers.length === 0 ? null : await readWork(db, place, setup.sources, range, { workerIds: workers })
  const trainees = await traineesOf(db, [employeeId])
  const blocks = await db.offStandardEntry.findMany({ where: { employeeId, siteId: place.id, workDate: { gte: dayColumn(range.from), lte: dayColumn(range.to) }, status: { not: 'REJECTED' } }, select: { workDate: true, startedAt: true, endedAt: true } })
  const leftDays = new Set<BusinessDate>()
  let sharedReports = 0
  const reports: PersonReport[] = []
  for (const entry of work?.records ?? []) {
    const { workDate, earnedMinutes, counts } = entry.record
    if (onTraineeDay(trainees, employeeId, workDate)) {
      leftDays.add(workDate)
      continue
    }
    if (entry.team) {
      sharedReports += 1
      continue
    }
    reports.push({ day: workDate, pieces: counts.good, earnedMinutes, timedPersonSeconds: entry.timed?.personSeconds ?? null })
  }
  const offStandard = new Map<BusinessDate, number>()
  for (const block of blocks) {
    const day = isoDay(block.workDate)
    if (onTraineeDay(trainees, employeeId, day)) {
      leftDays.add(day)
      continue
    }
    offStandard.set(day, (offStandard.get(day) ?? 0) + minutesOf(block.startedAt, block.endedAt, now))
  }
  return { days: personDaysOf(reports, offStandard), leftOut: { traineeDays: leftDays.size, sharedReports } }
}

/** POST /people/efficiency/people/:employeeId/figures (see the module's comment). */
export async function personFigures(caller: CommandCaller, employeeId: string, body: PersonBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const now = serverClock.now()
  const site = await caller.withClient(async (db) => {
    const found = await siteFor(db, context, body.siteId, [PEOPLE_FIGURES_VIEW])
    await requireLegalGate(db, found.id, 'PERFORMANCE')
    return found
  })
  const access = await accessAt(caller, employeeId, site.id)
  const as = requirePersonFigures(access)
  if (as === 'LEAD') throw notAllowed()
  const problems = openReasonProblems(access.decision, body.reason, body.note)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const range = rangeOf(body, site.timezone, now)
  await caller.withClient(async (db) => {
    if ((await scanSubjectFor(db, site.id)) === 'STATION') refuse(STATION_SITE.code, STATION_SITE.message)
  })
  await command(caller, { name: 'people.openPersonEfficiency', idempotencyKey, input: { employeeId, ...body } }, async (tools) => {
    const { gate } = await legalGateFor(tools.tx, site.id, 'PERFORMANCE')
    if (!gate) throw gateClosedError('PERFORMANCE')
    openPersonFiguresInCommand(tools, { ...access, gate }, { reason: body.reason, note: body.note })
    return { recorded: true }
  })
  return caller.withClient(async (db) => {
    await requireLegalGate(db, site.id, 'PERFORMANCE')
    const person = await db.employee.findUnique({ where: { id: access.employee.id }, select: { displayName: true } })
    const setup = await siteLines(db, site)
    const read = await personDaysAt(db, site, setup, access.employee.id, range, now)
    return {
      person: { employeeId: access.employee.id, name: person?.displayName ?? '—' },
      siteId: site.id,
      from: range.from,
      to: range.to,
      as,
      denominator: PERSON_DENOMINATOR,
      days: read.days,
      leftOut: read.leftOut,
      recorded: true as const,
      words: [PERSON_WORDS.logged, PERSON_WORDS.denominator, PERSON_WORDS.excluded],
    }
  })
}
