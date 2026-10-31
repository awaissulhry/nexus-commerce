import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPeople, type PeopleSeed } from '../../../../../../packages/factory-db/seed/people'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * Lines, teams and leads, loans to another line, and the site › area › line › station tree (B-W2b-26; MES-210, PLT-020,
 * PLT-005) on the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the
 * runtime login: row-level security and the …_people_w2b_guards triggers are real), the factory-db seeds of one tenant up
 * to the people (team L1-A on A1's line L1: E2 its lead, E1 and E3; E5 until 2026-06-30; L1-B on B1: EB1; A1's areas
 * Sewing hall (L1) and Cutting room), office sessions from the test authenticator. Every name and code is made up. Run
 * with `node scripts/factory/run-pg-tests.mjs modules/people/teams`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let people: PeopleSeed

const NS = 'w2b26-teams'
const idOf = (key: string): string => seedUuid(NS, key)
const T = {
  tenant: idOf('tenant'),
  companyA: idOf('company:A'),
  companyB: idOf('company:B'),
  siteA1: idOf('site:A1'),
  siteB1: idOf('site:B1'),
  lineA1: idOf('site:A1:line:L1'),
  lineB1: idOf('site:B1:line:L1'),
  member: idOf('user:member'),
}
const lineA2 = newId()

const MANAGE: Permission[] = ['people.view', 'people.teams.manage', 'people.loans.manage', 'sites.view', 'sites.manage']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  manager: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(MANAGE)] },
  viewer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['people.view', 'sites.view'])] },
  companyB: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(MANAGE, [T.companyB])] },
  // The seed member's account: E2's record, the lead of team L1-A (My team).
  lead: { audience: 'office', tenantId: T.tenant, actorId: T.member, grants: [grant(['people.team.view'])] },
  nobody: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['people.team.view'])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await db.admin.query(sql, values)).rows as R[]
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `t-${run}-${++keys}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const pathsOf = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const today = () => businessDate(new Date())
const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString()

beforeAll(async () => {
  db = await migratedDatabase('w2b26_teams')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  people = await seedPeople({ db: database, namespace: NS })
  // A second line of A1 (made up), in no area yet.
  await admin(`INSERT INTO "Line" (id, "tenantId", "companyId", "siteId", code, name) VALUES ($1, $2, $3, $4, 'L2', 'Line 2 (made up)')`, [lineA2, T.tenant, T.companyA, T.siteA1])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('teams and leads (MES-210, PLT-020)', () => {
  it('lists the teams with lead and members (the lead first), and My team for the lead', async () => {
    const list = await ok('manager', 'GET', '/people/teams')
    expect(list.teams.map((team: Json) => `${team.site.code}/${team.line?.code}/${team.code}`).sort()).toEqual(['A1/L1/L1-A', 'B1/L1/L1-B'])
    const a = list.teams.find((team: Json) => team.code === 'L1-A')
    expect(a).toMatchObject({ lead: { employeeId: people.employeeIds.e2, name: 'Seed Employee Two' }, loansIn: [] })
    expect(a.members.map((member: Json) => [member.name, member.isLead])).toEqual([['Seed Employee Two', true], ['Seed Agency Worker', false], ['Seed Employee One', false]])
    expect((await ok('companyB', 'GET', '/people/teams')).teams.map((team: Json) => team.code)).toEqual(['L1-B'])
    const mine = await ok('lead', 'GET', '/people/teams/mine')
    expect(mine).toMatchObject({ employeeId: people.employeeIds.e2, teams: [expect.objectContaining({ code: 'L1-A', mine: 'LEAD' })] })
    expect(await ok('nobody', 'GET', '/people/teams/mine')).toMatchObject({ employeeId: null, teams: [] })
    // My team alone opens no HR register.
    expect((await call('lead', 'GET', '/people/teams')).statusCode).toBe(403)
    const record = await ok('viewer', 'GET', `/people/teams/${people.teamIds.a}`)
    expect(record).toMatchObject({ canManage: false, history: [expect.objectContaining({ employeeId: people.employeeIds.e5, until: '2026-06-30' })] })
  })

  let teamB2: Json
  it('adds a team of a site (code in capitals, unique on the site), changes it, sets and clears its lead', async () => {
    teamB2 = (await ok('manager', 'POST', '/people/teams', { siteId: T.siteA1, lineId: T.lineA1, code: 'l1-b2', name: 'Line 1 second team' }, 201)).team
    expect(teamB2).toMatchObject({ code: 'L1-B2', line: { id: T.lineA1 }, members: [], lead: null, status: 'ACTIVE', version: 1 })
    expect(pathsOf(await no('manager', 'POST', '/people/teams', { siteId: T.siteA1, code: 'L1-B2', name: 'Again' }, 409))).toEqual(['refusal/CODE_TAKEN', 'body/code'])
    expect(pathsOf(await no('manager', 'POST', '/people/teams', { siteId: T.siteA1, lineId: T.lineB1, code: 'X1', name: 'Wrong line' }, 409))).toEqual(['refusal/LINE_NOT_OF_SITE', 'body/lineId'])
    expect((await call('viewer', 'POST', '/people/teams', { siteId: T.siteA1, code: 'X2', name: 'No right' })).statusCode).toBe(403)
    teamB2 = (await ok('manager', 'PATCH', `/people/teams/${teamB2.id}`, { version: 1, name: 'Line 2 team', lineId: lineA2 })).team
    expect(teamB2).toMatchObject({ name: 'Line 2 team', line: { code: 'L2' }, version: 2 })

    const a = (await ok('manager', 'GET', `/people/teams/${people.teamIds.a}`)).team
    const led = (await ok('manager', 'PUT', `/people/teams/${a.id}/lead`, { version: a.version, employeeId: people.employeeIds.e1 })).team
    expect(led.lead).toMatchObject({ employeeId: people.employeeIds.e1 })
    expect(led.members.filter((member: Json) => member.isLead).map((member: Json) => member.employeeId)).toEqual([people.employeeIds.e1])
    expect(pathsOf(await no('manager', 'PUT', `/people/teams/${a.id}/lead`, { version: led.version, employeeId: people.employeeIds.eb1 }, 409))).toEqual(['refusal/NOT_MEMBER', 'body/employeeId'])
    const back = (await ok('manager', 'PUT', `/people/teams/${a.id}/lead`, { version: led.version, employeeId: people.employeeIds.e2 })).team
    expect(back.lead.employeeId).toBe(people.employeeIds.e2)
    const changes = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'team.changed' ORDER BY "occurredAt", id`, [T.tenant])
    expect(changes.map((event) => event.payload.change)).toEqual(['CREATED', 'EDITED', 'LEAD_SET', 'LEAD_SET'])
  })

  it('previews moves (old → new team and lead, conflicts) and moves all or none, keeping the history', async () => {
    const moves = [
      { employeeId: people.employeeIds.e3, teamId: teamB2.id },
      { employeeId: people.employeeIds.eb1, teamId: teamB2.id },
      { employeeId: people.employeeIds.e5, teamId: teamB2.id },
      { employeeId: people.employeeIds.e1, teamId: people.teamIds.a },
    ]
    const preview = await ok('manager', 'POST', '/people/teams/moves/preview', { moves })
    expect(preview.rows.map((row: Json) => [row.change, row.conflict])).toEqual([['MOVE', null], ['MOVE', 'TEAM_OTHER_SITE'], ['MOVE', 'NOT_ACTIVE'], ['NONE', null]])
    expect(preview.rows[0]).toMatchObject({ name: 'Seed Agency Worker', from: { team: { code: 'L1-A' }, lead: 'Seed Employee Two' }, to: { team: { code: 'L1-B2' }, lead: null }, leavesLead: false })
    expect(preview).toMatchObject({ moving: 1, conflicts: 2 })
    const refused = await no('manager', 'POST', '/people/teams/moves', { moves }, 409)
    expect(pathsOf(refused)).toEqual(['refusal/MOVES_REFUSED', 'body/moves/1', 'body/moves/2'])
    expect(await admin('SELECT count(*)::int AS n FROM "TeamMember" WHERE "teamId" = $1', [teamB2.id])).toEqual([{ n: 0 }])

    // The lead moves too: the old team loses its lead (said, not refused).
    const applied = await ok('manager', 'POST', '/people/teams/moves', { moves: [{ employeeId: people.employeeIds.e3, teamId: teamB2.id }, { employeeId: people.employeeIds.e2, teamId: teamB2.id }], reason: 'Line 2 opens (made up)' })
    expect(applied).toMatchObject({ moved: 2 })
    expect(applied.rows.map((row: Json) => row.leavesLead)).toEqual([false, true])
    const ended = await admin<{ until: string; lead: boolean }>(`SELECT until::text, "isLead" AS lead FROM "TeamMember" WHERE "employeeId" = $1 AND "teamId" = $2`, [people.employeeIds.e2, people.teamIds.a])
    expect(ended).toEqual([{ until: new Date(Date.parse(`${today()}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10), lead: false }])
    const b2 = (await ok('manager', 'GET', `/people/teams/${teamB2.id}`)).team
    expect(b2.members.map((member: Json) => member.employeeId).sort()).toEqual([people.employeeIds.e2, people.employeeIds.e3].sort())
    expect((await ok('manager', 'GET', `/people/teams/${people.teamIds.a}`)).team.lead).toBeNull()
  })

  it('archives a team only with nobody in it', async () => {
    const b2 = (await ok('manager', 'GET', `/people/teams/${teamB2.id}`)).team
    expect(pathsOf(await no('manager', 'POST', `/people/teams/${b2.id}/archive`, { version: b2.version }, 409))).toEqual(['refusal/TEAM_NOT_EMPTY'])
    await ok('manager', 'POST', '/people/teams/moves', { moves: [{ employeeId: people.employeeIds.e3, teamId: people.teamIds.a }, { employeeId: people.employeeIds.e2, teamId: people.teamIds.a }] })
    // They began in B2 today: their B2 rows were removed, not ended.
    expect(await admin('SELECT count(*)::int AS n FROM "TeamMember" WHERE "teamId" = $1', [teamB2.id])).toEqual([{ n: 0 }])
    const archived = (await ok('manager', 'POST', `/people/teams/${b2.id}/archive`, { version: b2.version })).team
    expect(archived.status).toBe('ARCHIVED')
    expect(pathsOf(await no('manager', 'PATCH', `/people/teams/${b2.id}`, { version: archived.version, name: 'x' }, 409))).toEqual(['refusal/TEAM_ARCHIVED'])
  })
})

describe('loans to another line (MES-210)', () => {
  it('lends a person to another line of the site for some hours; never two at once; only the end moves', async () => {
    const planned = (await ok('manager', 'POST', '/people/loans', { employeeId: people.employeeIds.e1, toLineId: lineA2, startsAt: hours(1), endsAt: hours(5), reason: 'Line 2 is short today (made up)' }, 201)).loan
    expect(planned).toMatchObject({ fromLine: { id: T.lineA1 }, toLine: { id: lineA2 }, state: 'PLANNED', name: 'Seed Employee One' })
    expect(pathsOf(await no('manager', 'POST', '/people/loans', { employeeId: people.employeeIds.e1, toLineId: lineA2, startsAt: hours(4), endsAt: hours(6), reason: 'Again' }, 409))).toEqual(['refusal/LOAN_OVERLAP', 'body/startsAt'])
    expect(pathsOf(await no('manager', 'POST', '/people/loans', { employeeId: people.employeeIds.e1, toLineId: T.lineB1, startsAt: hours(7), endsAt: hours(8), reason: 'Other site' }, 409))).toEqual(['refusal/LINE_NOT_OF_SITE', 'body/toLineId'])
    expect(pathsOf(await no('manager', 'POST', '/people/loans', { employeeId: people.employeeIds.e1, toLineId: T.lineA1, startsAt: hours(7), endsAt: hours(8), reason: 'Home line' }, 400))).toEqual(['body/toLineId'])
    expect(pathsOf(await no('manager', 'POST', '/people/loans', { employeeId: people.employeeIds.e1, toLineId: lineA2, toTeamId: people.teamIds.a, startsAt: hours(7), endsAt: hours(8), reason: 'Team of L1' }, 409))).toEqual(['refusal/TEAM_OTHER_LINE', 'body/toTeamId'])
    expect(pathsOf(await no('manager', 'POST', '/people/loans', { employeeId: people.employeeIds.e5, toLineId: lineA2, startsAt: hours(7), endsAt: hours(8), reason: 'Left' }, 409))).toEqual(['refusal/LEFT', 'body/employeeId'])
    const day = await ok('viewer', 'GET', `/people/loans?siteId=${T.siteA1}&date=${businessDate(new Date(Date.now() + 3_600_000))}`)
    expect(day.loans.map((loan: Json) => loan.id)).toContain(planned.id)
    expect(pathsOf(await no('manager', 'POST', `/people/loans/${planned.id}/end`, { version: 1 }, 409))).toEqual(['refusal/LOAN_NOT_BEGUN', 'body/endsAt'])
    expect(await ok('manager', 'POST', `/people/loans/${planned.id}/remove`, { version: 1 })).toEqual({ removed: planned.id })

    const running = (await ok('manager', 'POST', '/people/loans', { employeeId: people.employeeIds.e1, toLineId: lineA2, startsAt: hours(-1), endsAt: hours(3), reason: 'Peak (made up)' }, 201)).loan
    expect(running.state).toBe('RUNNING')
    // The lead's view: E1 is on loan today.
    const a = (await ok('manager', 'GET', `/people/teams/${people.teamIds.a}`)).team
    expect(a.members.find((member: Json) => member.employeeId === people.employeeIds.e1).onLoan).toMatchObject({ loanId: running.id, toLine: { code: 'L2' } })
    expect(pathsOf(await no('manager', 'POST', `/people/loans/${running.id}/remove`, { version: 1 }, 409))).toEqual(['refusal/LOAN_BEGUN'])
    const ended = (await ok('manager', 'POST', `/people/loans/${running.id}/end`, { version: 1 })).loan
    expect(ended.state).toBe('ENDED')
    expect(Date.parse(ended.endsAt)).toBeLessThan(Date.parse(running.endsAt))
    const events = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'line_loan.changed' ORDER BY "occurredAt", id`, [T.tenant])
    expect(events.map((event) => event.payload.change)).toEqual(['MADE', 'REMOVED', 'MADE', 'ENDED'])
    expect((await call('viewer', 'POST', '/people/loans', { employeeId: people.employeeIds.e1, toLineId: lineA2, startsAt: hours(10), endsAt: hours(11), reason: 'x' })).statusCode).toBe(403)
  })
})

describe('the org tree: site › area › line › station (PLT-005)', () => {
  it('shows each site with its areas in order, their lines with stations and teams, and what is in no area', async () => {
    const tree = await ok('viewer', 'GET', `/org/tree?siteId=${T.siteA1}`)
    const [site] = tree.sites
    expect(site.areas.map((area: Json) => [area.code, area.lines.map((line: Json) => line.code)])).toEqual([['SEW-HALL', ['L1']], ['CUT-ROOM', []]])
    expect(site.areas[0].lines[0].teams.map((team: Json) => team.code)).toEqual(['L1-A'])
    expect(site.areas[0].lines[0].stations.length).toBeGreaterThan(0)
    expect(site.linesWithoutArea.map((line: Json) => line.code)).toEqual(['L2'])
    expect(site.canManage).toBe(false)
  })

  it('adds, changes and archives an area; moves a line in and out; refuses an archived or foreign area', async () => {
    const area = (await ok('manager', 'POST', `/org/sites/${T.siteA1}/areas`, { code: 'pack', name: 'Packing room', sortOrder: 3 }, 201)).area
    expect(area).toMatchObject({ code: 'PACK', sortOrder: 3, status: 'ACTIVE', version: 1 })
    expect(pathsOf(await no('manager', 'POST', `/org/sites/${T.siteA1}/areas`, { code: 'PACK', name: 'Again' }, 409))).toEqual(['refusal/CODE_TAKEN', 'body/code'])
    expect((await call('viewer', 'POST', `/org/sites/${T.siteA1}/areas`, { code: 'X', name: 'No right' })).statusCode).toBe(403)
    const renamed = (await ok('manager', 'PATCH', `/org/areas/${area.id}`, { version: 1, name: 'Packing and dispatch' })).area
    expect(renamed).toMatchObject({ name: 'Packing and dispatch', version: 2 })
    const lineVersion = (await admin<{ version: number }>('SELECT version FROM "Line" WHERE id = $1', [lineA2]))[0]!.version
    const moved = (await ok('manager', 'PUT', `/org/lines/${lineA2}/area`, { version: lineVersion, areaId: area.id })).line
    expect(moved).toMatchObject({ areaId: area.id, version: lineVersion + 1 })
    expect(pathsOf(await no('manager', 'POST', `/org/areas/${area.id}/archive`, { version: 2 }, 409))).toEqual(['refusal/AREA_NOT_EMPTY'])
    expect(pathsOf(await no('manager', 'PUT', `/org/lines/${lineA2}/area`, { version: moved.version, areaId: people.areaIds.mainB }, 400))).toEqual(['body/areaId'])
    const out = (await ok('manager', 'PUT', `/org/lines/${lineA2}/area`, { version: moved.version, areaId: null })).line
    expect(out.areaId).toBeNull()
    expect((await ok('manager', 'POST', `/org/areas/${area.id}/archive`, { version: 2 })).area.status).toBe('ARCHIVED')
    expect(pathsOf(await no('manager', 'PUT', `/org/lines/${lineA2}/area`, { version: out.version, areaId: area.id }, 409))).toEqual(['refusal/AREA_ARCHIVED', 'body/areaId'])
    const events = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'org_area.changed' ORDER BY "occurredAt", id`, [T.tenant])
    expect(events.map((event) => event.payload.change)).toEqual(['CREATED', 'EDITED', 'LINE_MOVED', 'LINE_MOVED', 'ARCHIVED'])
  })
})
