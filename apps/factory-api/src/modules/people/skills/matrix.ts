import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/people/employees/rules'
import { PEOPLE_AUTHORISATIONS_MANAGE, PEOPLE_SKILLS_MANAGE, PEOPLE_SKILLS_VIEW } from '@nexus/factory-domain/people/skills/permissions'
import { authorisationStateOf, endsWithin, traineeStateOf, type SkillLevel } from '@nexus/factory-domain/people/skills/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { assertMay, dateOf, dayOf, dayOrNull, may, officeOf, scopeOf } from '../employees/access'
import { userNames } from '../employees/employees'
import { AUTHORISATION_SELECT, authorisationViews, LEVEL_SELECT, levelViews, SKILL_SELECT, skillView } from './store'

/**
 * The skills matrix and a person's skills (B-W2b-39; MES-241, MES-244, MES-246; design people.skills "Tiles", "Matrix",
 * "Cell detail"; people.employees › Skills & training). Office only, people.skills.view over each person's company and
 * site. Reads only.
 *
 *   GET /people/skills/matrix                   rows = the active people of the sites in view, grouped line › team;
 *                                               columns = the skills (operations, machines, general) and the classes of
 *                                               machine (authorisations); a cell = the level in force (trainee mark) or
 *                                               the authorisation in force; tiles = trainees not signed off, authorisations
 *                                               ending in 60 days (saved filters: `tile`)
 *   GET /people/employees/:employeeId/skills    the employee record's tab: levels and authorisations in force with who
 *                                               decided and when, and the removed / revoked ones
 *   GET /people/skills/cell                     one cell's popover: every row of one person and one skill (or class)
 *                                               with its history from the audit log
 *
 * No column sums people into a score and rows sort by name or team only (AI Act Annex III 4(b); Statuto dei Lavoratori
 * art. 4): a level is a qualification, never a figure about one person's work. The tiles count cells (person × skill),
 * never a person's own number.
 */

const ROW_LIMIT = 500
const ENDING_DAYS = 60

export interface MatrixQuery {
  readonly siteId?: string | undefined
  readonly companyId?: string | undefined
  readonly lineId?: string | undefined
  readonly teamId?: string | undefined
  readonly show?: 'ALL' | 'SKILLS' | 'MACHINES' | undefined
  readonly tile?: 'TRAINEES' | 'AUTHORISATIONS_ENDING' | undefined
  readonly sort?: 'TEAM' | 'NAME' | undefined
  readonly q?: string | undefined
}

/** GET /people/skills/matrix. */
export async function skillsMatrix(caller: CommandCaller, query: MatrixQuery) {
  const context = officeOf(caller)
  const today = businessDate(serverClock.now())
  const until = addDays(today, ENDING_DAYS)
  const show = query.show ?? 'ALL'
  return caller.withClient(async (client) => {
    const words = query.q?.trim()
    const where: Prisma.EmployeeWhereInput = {
      AND: [
        scopeOf(context, PEOPLE_SKILLS_VIEW) as Prisma.EmployeeWhereInput,
        { status: 'ACTIVE', startDate: { lte: dateOf(today) } },
        query.siteId ? { siteId: query.siteId } : {},
        query.companyId ? { companyId: query.companyId } : {},
        query.lineId ? { homeLineId: query.lineId } : {},
        query.teamId ? { teamMemberships: { some: { teamId: query.teamId, until: null } } } : {},
        words ? { OR: [{ firstName: { contains: words, mode: 'insensitive' } }, { lastName: { contains: words, mode: 'insensitive' } }, { displayName: { contains: words, mode: 'insensitive' } }, { employeeCode: { contains: words, mode: 'insensitive' } }] } : {},
      ],
    }
    const people = await client.employee.findMany({
      where,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
      take: 5000,
      select: {
        id: true,
        companyId: true,
        siteId: true,
        firstName: true,
        lastName: true,
        displayName: true,
        homeLine: { select: { id: true, code: true, name: true } },
        teamMemberships: { where: { until: null }, select: { team: { select: { id: true, code: true, name: true, line: { select: { id: true, code: true, name: true } } } } } },
      },
    })
    const ids = people.map((person) => person.id)
    const companies = [...new Set(people.map((person) => person.companyId))]
    const siteIds = [...new Set(people.map((person) => person.siteId))]
    const skills =
      show === 'MACHINES'
        ? []
        : await client.skill.findMany({ where: { status: 'ACTIVE', OR: [{ companyId: null }, ...(companies.length > 0 ? [{ companyId: { in: companies } }] : [])] }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], select: SKILL_SELECT })
    const visibleSkills = skills.filter((skill) => skill.companyId === null || can(actorOf(context), PEOPLE_SKILLS_VIEW, { companyId: skill.companyId }))
    const levels = ids.length === 0 || show === 'MACHINES' ? [] : await client.employeeSkill.findMany({ where: { employeeId: { in: ids }, removedAt: null, skillId: { in: visibleSkills.map((skill) => skill.id) } }, select: { id: true, employeeId: true, skillId: true, level: true, since: true, traineeUntil: true, signedOffOn: true, version: true } })
    const authorisations = ids.length === 0 || show === 'SKILLS' ? [] : await client.machineAuthorisation.findMany({ where: { employeeId: { in: ids }, revokedAt: null }, select: { id: true, employeeId: true, machineClassId: true, authorisedOn: true, validUntil: true, version: true } })
    // The classes of the sites in view: of a machine there (not retired), or authorised there (kept under authorisation).
    const machines = siteIds.length === 0 || show === 'SKILLS' ? [] : await client.machine.findMany({ where: { siteId: { in: siteIds }, status: { not: 'RETIRED' } }, select: { classId: true, siteId: true } })
    const keptRows = siteIds.length === 0 || show === 'SKILLS' ? [] : await client.machineAuthorisation.findMany({ where: { siteId: { in: siteIds } }, distinct: ['siteId', 'machineClassId'], select: { siteId: true, machineClassId: true } })
    const classIds = [...new Set([...machines.map((machine) => machine.classId), ...keptRows.map((row) => row.machineClassId), ...authorisations.map((row) => row.machineClassId)])]
    const classes = classIds.length === 0 ? [] : await client.machineClass.findMany({ where: { id: { in: classIds } }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], select: { id: true, code: true, labelEn: true, labelIt: true, active: true } })

    const levelCells = levels.map((row) => {
      const facts = { traineeUntil: dayOrNull(row.traineeUntil), signedOffOn: dayOrNull(row.signedOffOn) }
      return { employeeId: row.employeeId, skillId: row.skillId, levelId: row.id, level: row.level as SkillLevel, since: dayOf(row.since), traineeUntil: facts.traineeUntil, trainee: traineeStateOf(facts, today), signedOffOn: facts.signedOffOn, version: row.version }
    })
    const authorisationCells = authorisations.map((row) => {
      const facts = { authorisedOn: dayOf(row.authorisedOn), validUntil: dayOrNull(row.validUntil), revoked: false }
      return { employeeId: row.employeeId, machineClassId: row.machineClassId, authorisationId: row.id, state: authorisationStateOf(facts, today), authorisedOn: facts.authorisedOn, validUntil: facts.validUntil, ending: endsWithin(facts, today, until), version: row.version }
    })
    const isTraineeCell = (cell: (typeof levelCells)[number]) => cell.trainee === 'TRAINEE' || cell.trainee === 'OVERDUE'
    const tiles = {
      trainees: levelCells.filter(isTraineeCell).length,
      traineesOverdue: levelCells.filter((cell) => cell.trainee === 'OVERDUE').length,
      authorisationsEnding: authorisationCells.filter((cell) => cell.ending).length,
    }
    const tileHit = new Set(query.tile === 'TRAINEES' ? levelCells.filter(isTraineeCell).map((cell) => cell.employeeId) : query.tile === 'AUTHORISATIONS_ENDING' ? authorisationCells.filter((cell) => cell.ending).map((cell) => cell.employeeId) : ids)
    const rows = people
      .filter((person) => tileHit.has(person.id))
      .map((person) => {
        const team = person.teamMemberships[0]?.team ?? null
        return {
          employeeId: person.id,
          name: `${person.firstName} ${person.lastName}`,
          displayName: person.displayName,
          companyId: person.companyId,
          siteId: person.siteId,
          line: team?.line ?? person.homeLine ?? null,
          team: team ? { id: team.id, code: team.code, name: team.name } : null,
          levels: levelCells.filter((cell) => cell.employeeId === person.id).map(({ employeeId: _employeeId, ...cell }) => cell),
          authorisations: authorisationCells.filter((cell) => cell.employeeId === person.id).map(({ employeeId: _employeeId, ...cell }) => cell),
          canManage: may(context, PEOPLE_SKILLS_MANAGE, person),
          canAuthorise: may(context, PEOPLE_AUTHORISATIONS_MANAGE, person),
          sortKey: [team?.line?.code ?? person.homeLine?.code ?? '~', team?.code ?? '~', person.lastName, person.firstName, person.id],
        }
      })
    if ((query.sort ?? 'TEAM') === 'TEAM') rows.sort((a, b) => a.sortKey.join('\u0000').localeCompare(b.sortKey.join('\u0000')))
    const sites = siteIds.length === 0 ? [] : await client.site.findMany({ where: { id: { in: siteIds } }, orderBy: [{ code: 'asc' }], select: { id: true, code: true, name: true } })
    return {
      rows: rows.slice(0, ROW_LIMIT).map(({ sortKey: _sortKey, ...row }) => row),
      complete: rows.length <= ROW_LIMIT,
      skills: visibleSkills.map(skillView),
      machineClasses: classes.map((machineClass) => ({ id: machineClass.id, code: machineClass.code, labelEn: machineClass.labelEn, labelIt: machineClass.labelIt, active: machineClass.active, keptAtSites: keptRows.filter((row) => row.machineClassId === machineClass.id).map((row) => row.siteId) })),
      sites,
      tiles,
      today,
    }
  })
}

/** GET /people/employees/:employeeId/skills (the employee record's Skills & training tab). */
export async function employeeSkills(caller: CommandCaller, employeeId: string) {
  const context = officeOf(caller)
  const today = businessDate(serverClock.now())
  return caller.withClient(async (client) => {
    const employee = isUuid(employeeId) ? await client.employee.findUnique({ where: { id: employeeId }, select: { id: true, companyId: true, siteId: true, firstName: true, lastName: true, status: true } }) : null
    if (!employee) throw new NotFoundError('Employee not found.')
    assertMay(context, PEOPLE_SKILLS_VIEW, employee, 'Employee')
    const levels = await client.employeeSkill.findMany({ where: { employeeId }, orderBy: [{ removedAt: { sort: 'desc', nulls: 'first' } }, { skill: { sortOrder: 'asc' } }, { since: 'desc' }], select: LEVEL_SELECT })
    const authorisations = await client.machineAuthorisation.findMany({ where: { employeeId }, orderBy: [{ revokedAt: { sort: 'desc', nulls: 'first' } }, { authorisedOn: 'desc' }], select: AUTHORISATION_SELECT })
    const levelRows = await levelViews(client, levels, today)
    const authorisationRows = await authorisationViews(client, authorisations, today)
    return {
      employee: { id: employee.id, name: `${employee.firstName} ${employee.lastName}`, companyId: employee.companyId, siteId: employee.siteId, status: employee.status as 'ACTIVE' | 'LEFT' },
      levels: levelRows.filter((row) => row.removedAt === null),
      authorisations: authorisationRows.filter((row) => row.revokedAt === null),
      history: { levels: levelRows.filter((row) => row.removedAt !== null), authorisations: authorisationRows.filter((row) => row.revokedAt !== null) },
      canManage: may(context, PEOPLE_SKILLS_MANAGE, employee),
      canAuthorise: may(context, PEOPLE_AUTHORISATIONS_MANAGE, employee),
      today,
    }
  })
}

const LEVEL_ACTIONS = ['people.setSkillLevel', 'people.signOffTrainee', 'people.removeSkillLevel']
const AUTHORISATION_ACTIONS = ['people.authoriseMachine', 'people.changeMachineAuthorisation', 'people.revokeMachineAuthorisation', 'people.endMachineAuthorisation']

/** GET /people/skills/cell?employeeId&skillId|machineClassId: one cell's rows and their history (the audit log). */
export async function cellDetail(caller: CommandCaller, query: { readonly employeeId: string; readonly skillId?: string | undefined; readonly machineClassId?: string | undefined }) {
  const context = officeOf(caller)
  if ((query.skillId ? 1 : 0) + (query.machineClassId ? 1 : 0) !== 1) throw new ValidationError('Name one skill or one class of machine.', [{ path: 'querystring/skillId', message: 'Give exactly one of skillId and machineClassId.' }])
  const today: BusinessDate = businessDate(serverClock.now())
  return caller.withClient(async (client) => {
    const employee = isUuid(query.employeeId) ? await client.employee.findUnique({ where: { id: query.employeeId }, select: { id: true, companyId: true, siteId: true, firstName: true, lastName: true } }) : null
    if (!employee) throw new NotFoundError('Employee not found.')
    assertMay(context, PEOPLE_SKILLS_VIEW, employee, 'Employee')
    const levels = query.skillId ? await client.employeeSkill.findMany({ where: { employeeId: employee.id, skillId: query.skillId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: LEVEL_SELECT }) : []
    const authorisations = query.machineClassId ? await client.machineAuthorisation.findMany({ where: { employeeId: employee.id, machineClassId: query.machineClassId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: AUTHORISATION_SELECT }) : []
    const recordIds = [...levels.map((row) => row.id), ...authorisations.map((row) => row.id)]
    const audit = recordIds.length === 0
      ? []
      : await client.auditLog.findMany({ where: { recordId: { in: recordIds }, recordType: query.skillId ? 'EmployeeSkill' : 'MachineAuthorisation', action: { in: query.skillId ? LEVEL_ACTIONS : AUTHORISATION_ACTIONS } }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: 100, select: { id: true, at: true, action: true, actorId: true, recordId: true, before: true, after: true, reason: true } })
    const names = await userNames(client, audit.map((row) => row.actorId))
    return {
      employee: { id: employee.id, name: `${employee.firstName} ${employee.lastName}` },
      levels: await levelViews(client, levels, today),
      authorisations: await authorisationViews(client, authorisations, today),
      history: audit.map((row) => ({ id: row.id, at: row.at.toISOString(), action: row.action, recordId: row.recordId, by: names.get(row.actorId) ?? null, before: jsonOf(row.before), after: jsonOf(row.after), reason: row.reason })),
      canManage: may(context, PEOPLE_SKILLS_MANAGE, employee),
      canAuthorise: may(context, PEOPLE_AUTHORISATIONS_MANAGE, employee),
      today,
    }
  })
}

const jsonOf = (value: Prisma.JsonValue | null): Record<string, unknown> | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)

