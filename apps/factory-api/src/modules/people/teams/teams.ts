import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDayRange, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PEOPLE_TEAM_VIEW, PEOPLE_VIEW } from '@nexus/factory-domain/people/employees/permissions'
import { PEOPLE_TEAMS_MANAGE } from '@nexus/factory-domain/people/teams/permissions'
import { cleanStructureCode, movePlan, teamProblems, type MoveConflict } from '@nexus/factory-domain/people/teams/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { actorIdOf, assertMay, assertMayWrite, assertVersion, bodyIssue, dateOf, dayOf, may, officeOf, problemsError, refuse, scopeOf, todayOf } from '../employees/access'
import { nameOf } from '../employees/store'

/**
 * Lines, teams and leads (B-W2b-26; MES-210, PLT-020; design people.employees "Teams view" and "Change team"), office
 * only, people.view to read (My team: people.team.view, the caller's own teams), people.teams.manage to write, each team
 * checked with can() against its company and site.
 *
 *   GET  /people/teams                   the teams of the caller's sites with lead, members and today's loans
 *   GET  /people/teams/mine              My team: the teams the caller leads or belongs to (their employee record)
 *   GET  /people/teams/:teamId           one team with its members, today's loans and its membership history
 *   POST /people/teams                   a team of a site (a code unique on the site, a name, an optional line)
 *   PATCH /people/teams/:teamId          its name and line
 *   POST /people/teams/:teamId/archive   archived (only with nobody in it)
 *   PUT  /people/teams/:teamId/lead      its lead: a current member (the old lead's flag goes first), or none
 *   POST /people/teams/moves/preview     who moves where: old → new team and lead per person, the conflicts
 *   POST /people/teams/moves             the moves, all or none, effective today (memberships keep their history)
 */

type Client = FactoryClient | CommandTx

export const TEAM_SELECT = { id: true, companyId: true, siteId: true, lineId: true, code: true, name: true, status: true, version: true } as const satisfies Prisma.TeamSelect
export type TeamRow = Prisma.TeamGetPayload<{ select: typeof TEAM_SELECT }>

const ref = (row: { readonly id: string; readonly code: string; readonly name: string }) => ({ id: row.id, code: row.code, name: row.name })

/** The loans that touch a calendar day (Europe/Rome), of these people or to these lines. */
export async function loansOfDay(client: Client, day: BusinessDate, where: Prisma.LineLoanWhereInput) {
  const { start, end } = businessDayRange(day)
  return client.lineLoan.findMany({
    where: { AND: [where, { startsAt: { lt: end }, endsAt: { gt: start } }] },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    select: { id: true, employeeId: true, startsAt: true, endsAt: true, fromLine: { select: { id: true, code: true, name: true } }, toLine: { select: { id: true, code: true, name: true } }, toTeamId: true, toLineId: true, employee: { select: { firstName: true, lastName: true } } },
  })
}

/** The views of many teams, with one read per related table. */
export async function teamViews(client: Client, teams: readonly TeamRow[], today: BusinessDate) {
  if (teams.length === 0) return []
  const ids = teams.map((team) => team.id)
  const sites = new Map((await client.site.findMany({ where: { id: { in: [...new Set(teams.map((team) => team.siteId))] } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const lineIds = [...new Set(teams.flatMap((team) => (team.lineId ? [team.lineId] : [])))]
  const lines = new Map(lineIds.length === 0 ? [] : (await client.line.findMany({ where: { id: { in: lineIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const members = await client.teamMember.findMany({
    where: { teamId: { in: ids }, until: null },
    orderBy: [{ isLead: 'desc' }, { employee: { lastName: 'asc' } }, { employee: { firstName: 'asc' } }, { id: 'asc' }],
    select: { teamId: true, employeeId: true, isLead: true, since: true, employee: { select: { firstName: true, lastName: true, displayName: true } } },
  })
  const memberIds = members.map((member) => member.employeeId)
  const loans = await loansOfDay(client, today, { OR: [{ employeeId: { in: memberIds } }, { toTeamId: { in: ids } }, ...(lineIds.length > 0 ? [{ toTeamId: null, toLineId: { in: lineIds } }] : [])] })
  return teams.map((team) => {
    const own = members.filter((member) => member.teamId === team.id)
    const ownIds = new Set(own.map((member) => member.employeeId))
    const lead = own.find((member) => member.isLead)
    const site = sites.get(team.siteId)
    return {
      id: team.id,
      companyId: team.companyId,
      site: { id: team.siteId, code: site?.code ?? '', name: site?.name ?? '' },
      line: team.lineId ? (lines.get(team.lineId) ? ref(lines.get(team.lineId)!) : null) : null,
      code: team.code,
      name: team.name,
      status: team.status as 'ACTIVE' | 'ARCHIVED',
      lead: lead ? { employeeId: lead.employeeId, name: nameOf(lead.employee) } : null,
      members: own.map((member) => {
        const away = loans.find((loan) => loan.employeeId === member.employeeId && loan.toTeamId !== team.id)
        return {
          employeeId: member.employeeId,
          name: nameOf(member.employee),
          displayName: member.employee.displayName,
          isLead: member.isLead,
          since: dayOf(member.since),
          onLoan: away ? { loanId: away.id, toLine: ref(away.toLine), until: toUtcIso(away.endsAt) } : null,
        }
      }),
      loansIn: loans
        .filter((loan) => !ownIds.has(loan.employeeId) && (loan.toTeamId === team.id || (loan.toTeamId === null && team.lineId !== null && loan.toLineId === team.lineId)))
        .map((loan) => ({ loanId: loan.id, employeeId: loan.employeeId, name: nameOf(loan.employee), fromLine: loan.fromLine ? ref(loan.fromLine) : null, startsAt: toUtcIso(loan.startsAt), until: toUtcIso(loan.endsAt) })),
      version: team.version,
    }
  })
}

export const teamView = async (client: Client, team: TeamRow, today: BusinessDate) => (await teamViews(client, [team], today))[0]!

const readTeam = (client: Client, id: string): Promise<TeamRow | null> => client.team.findUnique({ where: { id }, select: TEAM_SELECT })

async function lockTeam(tx: CommandTx, id: string): Promise<TeamRow> {
  await tx.$queryRaw`SELECT "id" FROM "Team" WHERE "id" = ${id}::uuid FOR UPDATE`
  return (await readTeam(tx, id))!
}

/** GET /people/teams. */
export async function listTeams(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly companyId?: string | undefined; readonly lineId?: string | undefined; readonly includeArchived?: boolean | undefined }, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  const where: Prisma.TeamWhereInput = {
    AND: [
      scopeOf(context, PEOPLE_VIEW) as Prisma.TeamWhereInput,
      query.siteId ? { siteId: query.siteId } : {},
      query.companyId ? { companyId: query.companyId } : {},
      query.lineId ? { lineId: query.lineId } : {},
      query.includeArchived ? {} : { status: 'ACTIVE' },
    ],
  }
  return caller.withClient(async (client) => {
    const teams = await client.team.findMany({ where, orderBy: [{ siteId: 'asc' }, { code: 'asc' }], take: 1000, select: TEAM_SELECT })
    return { teams: await teamViews(client, teams, today), today }
  })
}

/** The caller's employee record and their current memberships (My team). */
export async function myMemberships(client: Client, context: OfficeContext) {
  const employee = await client.employee.findFirst({ where: { userId: context.actorId, status: 'ACTIVE' }, select: { id: true } })
  if (!employee) return { employeeId: null, memberships: [] as { teamId: string; isLead: boolean }[] }
  const memberships = await client.teamMember.findMany({ where: { employeeId: employee.id, until: null }, select: { teamId: true, isLead: true } })
  return { employeeId: employee.id, memberships }
}

/** GET /people/teams/mine: the teams the caller leads or belongs to (their employee record's), where their role reaches. */
export async function myTeams(caller: CommandCaller, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  return caller.withClient(async (client) => {
    const { employeeId, memberships } = await myMemberships(client, context)
    const teams = memberships.length === 0 ? [] : await client.team.findMany({ where: { id: { in: memberships.map((row) => row.teamId) } }, orderBy: [{ code: 'asc' }], select: TEAM_SELECT })
    const visible = teams.filter((team) => may(context, PEOPLE_TEAM_VIEW, team))
    const views = await teamViews(client, visible, today)
    return { employeeId, teams: views.map((view) => ({ ...view, mine: memberships.find((row) => row.teamId === view.id)?.isLead ? ('LEAD' as const) : ('MEMBER' as const) })), today }
  })
}

/** GET /people/teams/:teamId. */
export async function teamRecord(caller: CommandCaller, teamId: string, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  return caller.withClient(async (client) => {
    const team = isUuid(teamId) ? await readTeam(client, teamId) : null
    if (!team) throw new NotFoundError('Team not found.')
    assertMay(context, PEOPLE_VIEW, team, 'Team')
    const history = await client.teamMember.findMany({
      where: { teamId, until: { not: null } },
      orderBy: [{ until: 'desc' }, { id: 'desc' }],
      take: 100,
      select: { employeeId: true, isLead: true, since: true, until: true, employee: { select: { firstName: true, lastName: true } } },
    })
    return {
      team: await teamView(client, team, today),
      history: history.map((row) => ({ employeeId: row.employeeId, name: nameOf(row.employee), isLead: row.isLead, since: dayOf(row.since), until: dayOf(row.until!) })),
      canManage: may(context, PEOPLE_TEAMS_MANAGE, team),
      today,
    }
  })
}

// ---- writes -------------------------------------------------------------------------------------------------------------

const MANAGE_WORDS = 'Teams of this site are kept by a role that keeps them (people.teams.manage).'

/** The line a team is on: a line of its site, active. */
async function checkLine(tx: CommandTx, siteId: string, lineId: string | null | undefined): Promise<void> {
  if (!lineId) return
  const line = await tx.line.findUnique({ where: { id: lineId }, select: { siteId: true, status: true } })
  if (!line || line.siteId !== siteId) refuse('LINE_NOT_OF_SITE', "A team's line is a line of its site.", 'lineId')
  if (line!.status !== 'ACTIVE') refuse('LINE_NOT_OF_SITE', 'This line is archived: pick an active one.', 'lineId')
}

/** POST /people/teams. */
export async function createTeam(caller: CommandCaller, body: { readonly siteId: string; readonly lineId?: string | null | undefined; readonly code: string; readonly name: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const problems = teamProblems(body)
  if (problems.length > 0) throw problemsError(problems, 'The team is not valid.')
  const site = await caller.withClient((client) => client.site.findUnique({ where: { id: body.siteId }, select: { id: true, companyId: true, status: true, code: true } }))
  if (!site) throw bodyIssue('siteId', 'Not a site of the group.')
  assertMayWrite(context, PEOPLE_TEAMS_MANAGE, { companyId: site.companyId, siteId: site.id }, MANAGE_WORDS)
  const code = cleanStructureCode(body.code)
  const id = newId()
  const { result, replayed } = await command(caller, { name: 'people.createTeam', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    if (site.status !== 'ACTIVE') refuse('SITE_ARCHIVED', `Site ${site.code} is archived: it takes no new team.`, 'siteId')
    await checkLine(tx, site.id, body.lineId)
    if (await tx.team.findFirst({ where: { siteId: site.id, code }, select: { id: true } })) refuse('CODE_TAKEN', `The site has a team ${code} already.`, 'code')
    await tx.team.create({ data: { id, companyId: site.companyId, siteId: site.id, lineId: body.lineId ?? null, code, name: body.name.trim(), createdAt: now, updatedAt: now, createdById: actorIdOf(tools.context) }, select: { id: true } })
    tools.audit({ action: 'people.createTeam', recordType: 'Team', recordId: id, companyId: site.companyId, siteId: site.id, after: { code, name: body.name.trim(), lineId: body.lineId ?? null } })
    tools.emit({ type: 'team.changed', subject: id, companyId: site.companyId, siteId: site.id, payload: { teamId: id, code, change: 'CREATED', employeeIds: [] } })
    return { team: await teamView(tx, (await readTeam(tx, id))!, todayOf(now)) }
  })
  return { ...result, replayed }
}

async function writableTeam(caller: CommandCaller, context: OfficeContext, teamId: string): Promise<TeamRow> {
  const team = isUuid(teamId) ? await caller.withClient((client) => readTeam(client, teamId)) : null
  if (!team) throw new NotFoundError('Team not found.')
  assertMay(context, PEOPLE_VIEW, team, 'Team')
  assertMayWrite(context, PEOPLE_TEAMS_MANAGE, team, MANAGE_WORDS)
  return team
}

/** PATCH /people/teams/:teamId. */
export async function updateTeam(caller: CommandCaller, teamId: string, body: { readonly version: number; readonly name?: string | undefined; readonly lineId?: string | null | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const problems = teamProblems({ ...(body.name !== undefined ? { name: body.name } : {}) })
  if (problems.length > 0) throw problemsError(problems, 'The change is not valid.')
  await writableTeam(caller, context, teamId)
  const { result } = await command(caller, { name: 'people.updateTeam', idempotencyKey, input: { teamId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const team = await lockTeam(tx, teamId)
    assertVersion('team', team.version, body.version)
    if (team.status !== 'ACTIVE') refuse('TEAM_ARCHIVED', `Team ${team.code} is archived: it no longer changes.`)
    const data: Prisma.TeamUncheckedUpdateInput = {}
    if (body.name !== undefined && body.name.trim() !== team.name) data.name = body.name.trim()
    if (body.lineId !== undefined && body.lineId !== team.lineId) {
      await checkLine(tx, team.siteId, body.lineId)
      data.lineId = body.lineId
    }
    const fields = Object.keys(data)
    if (fields.length > 0) {
      await tx.team.update({ where: { id: team.id }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      tools.emit({ type: 'team.changed', subject: team.id, companyId: team.companyId, siteId: team.siteId, payload: { teamId: team.id, code: team.code, change: 'EDITED', employeeIds: [] } })
    }
    tools.audit({ action: 'people.updateTeam', recordType: 'Team', recordId: team.id, companyId: team.companyId, siteId: team.siteId, before: { name: team.name, lineId: team.lineId }, after: fields.length > 0 ? data : { unchanged: true } })
    return { team: await teamView(tx, (await readTeam(tx, team.id))!, todayOf(now)) }
  })
  return result
}

/** POST /people/teams/:teamId/archive: only with nobody in it. */
export async function archiveTeam(caller: CommandCaller, teamId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const context = officeOf(caller)
  await writableTeam(caller, context, teamId)
  const { result } = await command(caller, { name: 'people.archiveTeam', idempotencyKey, input: { teamId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const team = await lockTeam(tx, teamId)
    assertVersion('team', team.version, body.version)
    if (team.status !== 'ACTIVE') refuse('TEAM_ARCHIVED', `Team ${team.code} is archived already.`)
    const members = await tx.teamMember.count({ where: { teamId, until: null } })
    if (members > 0) refuse('TEAM_NOT_EMPTY', `Team ${team.code} has ${members} ${members === 1 ? 'person' : 'people'} in it: move them first.`)
    await tx.team.update({ where: { id: team.id }, data: { status: 'ARCHIVED', version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'people.archiveTeam', recordType: 'Team', recordId: team.id, companyId: team.companyId, siteId: team.siteId, before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED' } })
    tools.emit({ type: 'team.changed', subject: team.id, companyId: team.companyId, siteId: team.siteId, payload: { teamId: team.id, code: team.code, change: 'ARCHIVED', employeeIds: [] } })
    return { team: await teamView(tx, (await readTeam(tx, team.id))!, todayOf(now)) }
  })
  return result
}

/** PUT /people/teams/:teamId/lead: a current member, or none; the old lead's flag goes first (one lead at a time). */
export async function setLead(caller: CommandCaller, teamId: string, body: { readonly version: number; readonly employeeId: string | null }, idempotencyKey?: string) {
  const context = officeOf(caller)
  await writableTeam(caller, context, teamId)
  const { result } = await command(caller, { name: 'people.setTeamLead', idempotencyKey, input: { teamId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const team = await lockTeam(tx, teamId)
    assertVersion('team', team.version, body.version)
    if (team.status !== 'ACTIVE') refuse('TEAM_ARCHIVED', `Team ${team.code} is archived: it has no lead.`)
    const current = await tx.teamMember.findFirst({ where: { teamId, isLead: true, until: null }, select: { id: true, employeeId: true } })
    const next = body.employeeId === null ? null : await tx.teamMember.findFirst({ where: { teamId, employeeId: body.employeeId, until: null }, select: { id: true, employeeId: true } })
    if (body.employeeId !== null && !next) refuse('NOT_MEMBER', 'The lead is a person in the team: move them into it first.', 'employeeId')
    if ((current?.employeeId ?? null) !== body.employeeId) {
      if (current) await tx.teamMember.update({ where: { id: current.id }, data: { isLead: false, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      if (next) await tx.teamMember.update({ where: { id: next.id }, data: { isLead: true, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      await tx.team.update({ where: { id: team.id }, data: { version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      tools.emit({ type: 'team.changed', subject: team.id, companyId: team.companyId, siteId: team.siteId, payload: { teamId: team.id, code: team.code, change: 'LEAD_SET', employeeIds: [current?.employeeId, body.employeeId].filter((value): value is string => typeof value === 'string') } })
    }
    tools.audit({ action: 'people.setTeamLead', recordType: 'Team', recordId: team.id, companyId: team.companyId, siteId: team.siteId, before: { leadEmployeeId: current?.employeeId ?? null }, after: { leadEmployeeId: body.employeeId } })
    return { team: await teamView(tx, (await readTeam(tx, team.id))!, todayOf(now)) }
  })
  return result
}

// ---- moves --------------------------------------------------------------------------------------------------------------

export interface Move {
  readonly employeeId: string
  readonly teamId: string | null
}

interface MoveRow {
  readonly employeeId: string
  readonly name: string | null
  readonly from: { readonly team: { id: string; code: string; name: string }; readonly lead: string | null } | null
  readonly to: { readonly team: { id: string; code: string; name: string }; readonly lead: string | null } | null
  readonly change: 'NONE' | 'MOVE'
  readonly conflict: MoveConflict | null
  readonly leavesLead: boolean
}

/** What each move would do, with the person's and the teams' facts read now; the caller's right checked per row. */
async function planMoves(client: Client, context: OfficeContext, moves: readonly Move[], today: BusinessDate) {
  const employeeIds = [...new Set(moves.map((move) => move.employeeId))]
  const teamIds = [...new Set(moves.flatMap((move) => (move.teamId ? [move.teamId] : [])))]
  const employees = new Map((await client.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, companyId: true, siteId: true, status: true, firstName: true, lastName: true } })).map((row) => [row.id, row]))
  const memberships = await client.teamMember.findMany({ where: { employeeId: { in: employeeIds }, until: null }, select: { id: true, employeeId: true, teamId: true, isLead: true, since: true } })
  const allTeamIds = [...new Set([...teamIds, ...memberships.map((row) => row.teamId)])]
  const teams = new Map((await client.team.findMany({ where: { id: { in: allTeamIds } }, select: TEAM_SELECT })).map((row) => [row.id, row]))
  const leads = await client.teamMember.findMany({ where: { teamId: { in: allTeamIds }, isLead: true, until: null }, select: { teamId: true, employee: { select: { firstName: true, lastName: true } } } })
  const leadOf = new Map(leads.map((row) => [row.teamId, nameOf(row.employee)]))
  const seen = new Set<string>()
  const rows: (MoveRow & { readonly plan: ReturnType<typeof movePlan>; readonly membershipId: string | null })[] = []
  for (const move of moves) {
    const employee = employees.get(move.employeeId)
    const visible = employee && may(context, PEOPLE_VIEW, employee)
    const membership = memberships.find((row) => row.employeeId === move.employeeId) ?? null
    const fromTeam = membership ? teams.get(membership.teamId) : undefined
    const toTeam = move.teamId ? teams.get(move.teamId) : undefined
    let conflict: MoveConflict | null = null
    if (!visible) conflict = 'NOT_ACTIVE'
    else if (seen.has(move.employeeId)) conflict = 'DUPLICATE'
    else if (employee.status !== 'ACTIVE') conflict = 'NOT_ACTIVE'
    else if (!may(context, PEOPLE_TEAMS_MANAGE, employee)) conflict = 'OTHER_SITE'
    else if (move.teamId && (!toTeam || !may(context, PEOPLE_VIEW, toTeam))) conflict = 'TEAM_OTHER_SITE'
    else if (toTeam && toTeam.siteId !== employee.siteId) conflict = 'TEAM_OTHER_SITE'
    else if (toTeam && toTeam.status !== 'ACTIVE') conflict = 'TEAM_ARCHIVED'
    seen.add(move.employeeId)
    const plan = movePlan(membership ? { id: membership.id, teamId: membership.teamId, isLead: membership.isLead, since: dayOf(membership.since) } : null, move.teamId, today)
    rows.push({
      employeeId: move.employeeId,
      name: visible ? nameOf(employee) : null,
      from: fromTeam && visible ? { team: ref(fromTeam), lead: leadOf.get(fromTeam.id) ?? null } : null,
      to: toTeam && visible && conflict !== 'TEAM_OTHER_SITE' ? { team: ref(toTeam), lead: leadOf.get(toTeam.id) ?? null } : null,
      change: plan.kind,
      conflict,
      leavesLead: plan.kind === 'MOVE' && plan.wasLead,
      plan,
      membershipId: membership?.id ?? null,
    })
  }
  return { rows, teams }
}

const shownRow = ({ plan: _plan, membershipId: _membership, ...row }: MoveRow & { plan: unknown; membershipId: unknown }): MoveRow => row

/** POST /people/teams/moves/preview: old → new team and lead per person, and the conflicts (nothing written). */
export async function previewMoves(caller: CommandCaller, body: { readonly moves: readonly Move[] }, now: Date = new Date()) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const { rows } = await planMoves(client, context, body.moves, todayOf(now))
    return { rows: rows.map(shownRow), moving: rows.filter((row) => row.change === 'MOVE' && row.conflict === null).length, conflicts: rows.filter((row) => row.conflict !== null).length }
  })
}

/** Writes one person's move inside the command (planned by movePlan, effective today). */
async function writeMove(tools: CommandTools, employeeId: string, plan: Extract<ReturnType<typeof movePlan>, { kind: 'MOVE' }>, siteId: string): Promise<void> {
  const { tx, now } = tools
  if (plan.remove) await tx.teamMember.delete({ where: { id: plan.remove }, select: { id: true } })
  if (plan.end) {
    if (plan.wasLead) await tx.teamMember.update({ where: { id: plan.end.id }, data: { isLead: false, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    await tx.teamMember.update({ where: { id: plan.end.id }, data: { until: dateOf(plan.end.until), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
  }
  if (plan.start) {
    await tx.teamMember.create({ data: { id: newId(), siteId, teamId: plan.start.teamId, employeeId, isLead: false, since: dateOf(plan.start.since), createdAt: now, updatedAt: now, createdById: actorIdOf(tools.context) }, select: { id: true } })
  }
}

/** POST /people/teams/moves: every move or none (a conflict refuses the whole set, each named at its row). */
export async function applyMoves(caller: CommandCaller, body: { readonly moves: readonly Move[]; readonly reason?: string | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const { result } = await command(caller, { name: 'people.moveTeamMembers', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const today = todayOf(now)
    // The people's rows in id order (a concurrent move of the same people waits).
    const ids = [...new Set(body.moves.map((move) => move.employeeId))].sort()
    for (const id of ids) await tx.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${id}::uuid FOR UPDATE`
    const { rows, teams } = await planMoves(tx, context, body.moves, today)
    const conflicts = rows.flatMap((row, index) => (row.conflict ? [{ path: `body/moves/${index}`, message: row.conflict }] : []))
    if (conflicts.length > 0) refuse('MOVES_REFUSED', `${conflicts.length} of the moves cannot be made: nothing was moved.`, undefined, conflicts)
    const touched = new Map<string, string[]>()
    let moved = 0
    for (const row of rows) {
      if (row.plan.kind !== 'MOVE') continue
      const siteId = (await tx.employee.findUnique({ where: { id: row.employeeId }, select: { siteId: true } }))!.siteId
      await writeMove(tools, row.employeeId, row.plan, siteId)
      moved += 1
      for (const teamId of [row.from?.team.id, row.to?.team.id]) if (teamId) touched.set(teamId, [...(touched.get(teamId) ?? []), row.employeeId])
    }
    for (const [teamId, employeeIds] of touched) {
      const team = teams.get(teamId)!
      tools.audit({ action: 'people.moveTeamMembers', recordType: 'Team', recordId: team.id, companyId: team.companyId, siteId: team.siteId, after: { moved: rows.filter((row) => employeeIds.includes(row.employeeId)).map((row) => ({ employeeId: row.employeeId, from: row.from?.team.code ?? null, to: row.to?.team.code ?? null })) }, ...(body.reason ? { reason: body.reason } : {}) })
      tools.emit({ type: 'team.changed', subject: team.id, companyId: team.companyId, siteId: team.siteId, payload: { teamId: team.id, code: team.code, change: 'MEMBERS_MOVED', employeeIds } })
    }
    if (moved === 0) {
      if (rows.length === 0) throw new ConflictError('Nothing to move.')
      const first = (await tx.employee.findUnique({ where: { id: rows[0]!.employeeId }, select: { companyId: true, siteId: true } }))!
      tools.audit({ action: 'people.moveTeamMembers', recordType: 'Employee', recordId: rows[0]!.employeeId, companyId: first.companyId, siteId: first.siteId, after: { unchanged: true } })
    }
    return { rows: rows.map(shownRow), moved, teams: [...touched.keys()] }
  })
  return result
}
