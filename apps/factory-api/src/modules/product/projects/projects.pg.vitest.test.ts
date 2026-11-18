import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { PROJECT_REFUSALS } from '@nexus/factory-domain/projects/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedSalesIntake } from '../../../../../../packages/factory-db/seed/sales-intake'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../platform/outbox/system'
import { rebuildIndex } from '../../../platform/search/indexing'
import { loadIndexers } from '../../../platform/search/registry'

/**
 * B-TH-066 — the project record (threads plan TH-5, PROJ-G02, PROJ-G08, PROJ-G13; wall W38, test T38) through the app's real routes
 * on a throwaway PostgreSQL 17 database from the migrations, on the seeds up to the sales intake (company A with its PROJECT series
 * PRJ-{YY}-{N:3}; the brand P1 = SEED-C1, the customer P3 = SEED-C2 standing in for "brand B", P4 = SEED-R1 made BLOCKED here; the
 * season FW27 of company A). Every name and word is made up.
 *
 *   - POST /projects numbers from the company's PROJECT series (PRJ-…), ACTIVE; its maker follows it (CREATOR), the lead and the
 *     colleagues named are ADDED by the maker; project.created is in the outbox; a BLOCKED outside company is refused in words;
 *   - PATCH at the version read (a stale version 409), a lead who cannot read it refused (LEAD), a season of the company or none;
 *   - hold → resume; close with its outcome: an office line posted and pinned (or, ticked, the line to the outside company pinned
 *     instead), the thread CLOSED, a live invitation by link ended; a CLOSED project refuses a change and a link (refusal/CLOSED);
 *     reopen: ACTIVE, the outcome gone, the thread OPEN again, a system line; project.status_changed for each move;
 *   - T38 / W38: a person limited to brand A (P1) never opens, changes, finds or makes brand B's (P3) project: 404, nothing in
 *     search, "no such customer" when they name P3; GET /projects/similar warns of a project with a name alike.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/product/projects`.
 */

vi.setConfig({ testTimeout: 120_000 })

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

const NS = 'th5-projects-record'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const P1 = idOf('party:P1')
const P3 = idOf('party:P3')
const P4 = idOf('party:P4')
const SRC = fileURLToPath(new URL('../../..', import.meta.url))

const PEOPLE = { ada: newId(), lina: newId(), pia: newId(), bob: newId(), nora: newId() } as const
type Person = keyof typeof PEOPLE
/** ada and bob: Sales over every customer; lina: Sales limited to P1 (brand A); pia: the production manager; nora: an office person with no role. */
const ROLE_OF: Partial<Record<Person, string>> = { ada: 'sales', lina: 'sales', pia: 'production_manager', bob: 'sales' }
const PARTIES_OF: Record<Person, string[]> = { ada: [], lina: [P1], pia: [], bob: [], nora: [] }

const permissionsOf = (key: string): Permission[] => {
  const template = templateOf(key)!
  return [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)]
}
const grantOf = (person: Person): Grant => ({ permissions: ROLE_OF[person] ? permissionsOf(ROLE_OF[person]!) : [], companies: 'all', sites: 'all', parties: PARTIES_OF[person].length === 0 ? 'all' : PARTIES_OF[person] })
const sessions = new Map<string, SessionContext>()

let h: Harness
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let serial = 0
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const one = async (sql: string, values: unknown[] = []): Promise<Json> => (await admin(sql, values))[0]!
const call = (who: Person, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': who, ...(method === 'GET' ? {} : { 'idempotency-key': `th5-record-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(who: Person, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(who, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(who: Person, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(who, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error as Json
}
const pathsOf = (error: Json): string[] => ((error.issues ?? []) as Json[]).map((issue) => issue.path)

const DAY = 86_400_000
const dayFromNow = (days: number): string => new Date(Date.now() + days * DAY).toISOString().slice(0, 10)
const system = () => callerFor(h.database, systemContext(T, `th5-record-${newId()}`))

async function newProject(who: Person, body: Json): Promise<Json> {
  return (await ok(who, 'POST', '/projects', { companyId: companyA, targetDate: dayFromNow(60), ...body }, 201)).project
}
const followersOf = (projectId: string) =>
  admin<{ userId: string; reason: string; createdById: string | null; partyId: string | null }>(`SELECT "userId", reason::text AS reason, "createdById", "partyId" FROM "RecordFollower" WHERE "tenantId" = $1 AND "recordType" = 'Project' AND "recordId" = $2 ORDER BY "createdAt", id`, [T, projectId])
const threadOf = (projectId: string) => one(`SELECT id, status::text AS status, "partyId" FROM "Thread" WHERE "tenantId" = $1 AND "recordType" = 'Project' AND "recordId" = $2`, [T, projectId])
const outboxOf = (type: string, subject: string) => admin(`SELECT type, payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 AND subject = $3 ORDER BY id`, [T, type, subject])

beforeAll(async () => {
  h = await startHarness('th5_projects_record')
  await seedCore({ db: h.database, namespace: NS })
  // fix-pg-2: the roles seed assigns roles to the auth seed's people (it runs after seed/auth.ts).
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
  for (const [person, userId] of Object.entries(PEOPLE) as [Person, string][]) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, 'ACTIVE', 'en')`, [userId, T, `th5-${person}-${run}@example.test`, `Made-up ${person}`])
    const role = ROLE_OF[person]
    if (role) {
      const roleId = (await one(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = $2`, [T, role])).id
      await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "partyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], $5::uuid[], now() - interval '1 day')`, [newId(), T, userId, roleId, PARTIES_OF[person]])
    }
    sessions.set(person, { audience: 'office', tenantId: T, actorId: userId, grants: [grantOf(person)] })
  }
  // A company that is blocked takes no new project (PROJ.new-F02).
  await admin(`UPDATE "Party" SET status = 'BLOCKED' WHERE "tenantId" = $1 AND id = $2`, [T, P4])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: SRC, authenticate: testAuthenticator((request) => sessions.get(String(request.headers['x-test-session'])) ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('B-TH-066 the project record', () => {
  let alpha: Json

  it('makes a project numbered from the PROJECT series: its maker follows it, the lead and colleagues are added by the maker', async () => {
    alpha = await newProject('ada', { name: 'Made-up Alpha touring line', partyId: P1, leadId: PEOPLE.bob, goal: 'Made-up: six styles for the spring.', colleagueIds: [PEOPLE.pia] })
    expect(alpha).toMatchObject({ name: 'Made-up Alpha touring line', status: 'ACTIVE', party: { id: P1 }, lead: { id: PEOPLE.bob }, officeOnly: false, outcome: null, version: 1 })
    expect(alpha.number).toMatch(/^PRJ-\d{2}-\d{3}$/)
    expect(alpha.may).toMatchObject({ manage: true, post: true })
    expect(alpha.may.moves.sort()).toEqual(['CLOSE', 'HOLD'])
    const people = await followersOf(alpha.id)
    expect(people).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: PEOPLE.ada, reason: 'CREATOR', partyId: null }),
        expect.objectContaining({ userId: PEOPLE.bob, reason: 'ADDED', createdById: PEOPLE.ada, partyId: null }),
        expect.objectContaining({ userId: PEOPLE.pia, reason: 'ADDED', createdById: PEOPLE.ada, partyId: null }),
      ]),
    )
    expect(people).toHaveLength(3)
    const [made] = await outboxOf('project.created', alpha.id)
    expect(made?.payload).toMatchObject({ projectId: alpha.id, number: alpha.number, partyId: P1, fromRecordType: null })
    // The lead and the colleague added are told (thread.follower_added), never the maker.
    expect((await admin(`SELECT payload->>'userId' AS "userId" FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'thread.follower_added' AND subject = $2`, [T, alpha.id])).map((row) => row.userId).sort()).toEqual([PEOPLE.bob, PEOPLE.pia].sort())
    // The next one takes the next number of the same series.
    const next = await newProject('ada', { name: 'Made-up office tooling', partyId: null })
    expect(next.officeOnly).toBe(true)
    expect(Number(next.number.slice(-3))).toBe(Number(alpha.number.slice(-3)) + 1)
  })

  it('refuses a blocked outside company, a name of two lines and a lead who may not read it, in words', async () => {
    const blocked = await refused('ada', 'POST', '/projects', { companyId: companyA, name: 'Made-up blocked', partyId: P4, targetDate: dayFromNow(30) }, 409)
    expect(blocked.message).toBe(PROJECT_REFUSALS.PARTY_BLOCKED.en)
    expect(pathsOf(blocked)).toContain('body/partyId')
    expect(pathsOf(await refused('ada', 'POST', '/projects', { companyId: companyA, name: 'Made-up\nsecond line', targetDate: dayFromNow(30) }, 400))).toContain('body/name')
    const lead = await refused('ada', 'POST', '/projects', { companyId: companyA, name: 'Made-up leaderless', leadId: PEOPLE.nora, targetDate: dayFromNow(30) }, 409)
    expect(lead.message).toBe(PROJECT_REFUSALS.LEAD.en)
    expect(pathsOf(lead)).toContain('body/leadId')
  })

  it('changes its details at the version read: a stale version, a lead who cannot read it and another season are refused', async () => {
    const changed = (await ok('ada', 'PATCH', `/projects/${alpha.id}`, { version: alpha.version, name: 'Made-up Alpha touring line 2027', targetDate: dayFromNow(90), seasonCode: 'FW27' })).project
    expect(changed).toMatchObject({ name: 'Made-up Alpha touring line 2027', targetDate: dayFromNow(90), seasonCode: 'FW27', version: alpha.version + 1 })
    expect((await call('ada', 'PATCH', `/projects/${alpha.id}`, { version: alpha.version, name: 'Made-up late edit' })).statusCode).toBe(409)
    expect(pathsOf(await refused('ada', 'PATCH', `/projects/${alpha.id}`, { version: changed.version, leadId: PEOPLE.nora }, 409))).toContain('body/leadId')
    expect((await refused('ada', 'PATCH', `/projects/${alpha.id}`, { version: changed.version, seasonCode: 'NOT-A-SEASON' }, 409)).message).toBe(PROJECT_REFUSALS.SEASON.en)
    // A new lead follows the project (added by who changed it).
    const led = (await ok('ada', 'PATCH', `/projects/${alpha.id}`, { version: changed.version, leadId: PEOPLE.ada })).project
    expect(led.lead.id).toBe(PEOPLE.ada)
    const changes = await outboxOf('project.changed', alpha.id)
    expect(changes.map((row) => row.payload.leadChanged)).toEqual([false, true])
    alpha = led
  })

  it('puts it on hold and resumes it; closes it with its outcome: the line pinned, the thread closed, the invitation ended', async () => {
    const held = (await ok('ada', 'POST', `/projects/${alpha.id}/hold`, { version: alpha.version })).project
    expect(held.status).toBe('ON_HOLD')
    expect((await refused('ada', 'POST', `/projects/${alpha.id}/hold`, { version: held.version }, 409)).issues).toEqual([expect.objectContaining({ path: 'refusal/MOVE' })])
    const resumed = (await ok('ada', 'POST', `/projects/${alpha.id}/resume`, { version: held.version })).project
    expect(resumed.status).toBe('ACTIVE')
    // A live invitation by link of the project (as the shares route makes it): it ends with the close.
    const shareId = newId()
    await admin(`INSERT INTO "RecordShare" (id, "tenantId", "companyId", "recordType", "recordId", "partyId", email, "expiresAt") VALUES ($1, $2, $3, 'Project', $4, $5, $6, now() + interval '30 days')`, [shareId, T, companyA, alpha.id, P1, `designer-${run}@example.test`])
    expect(pathsOf(await refused('ada', 'POST', `/projects/${alpha.id}/close`, { version: resumed.version, outcome: 'DONE', outcomeNote: '   ' }, 400))).toContain('body/outcomeNote')
    const closed = (await ok('ada', 'POST', `/projects/${alpha.id}/close`, { version: resumed.version, outcome: 'DONE', outcomeNote: 'Made-up: six styles approved for production in March.' })).project
    expect(closed).toMatchObject({ status: 'CLOSED', outcome: 'DONE', outcomeNote: 'Made-up: six styles approved for production in March.', closedBy: { id: PEOPLE.ada }, threadStatus: 'CLOSED' })
    expect(closed.may.moves).toEqual(['REOPEN'])
    const thread = await threadOf(alpha.id)
    expect(thread).toMatchObject({ status: 'CLOSED', partyId: P1 })
    const pins = await admin(`SELECT p."messageId", m.direction::text AS direction, m."bodyText" FROM "ThreadPin" p JOIN "Message" m ON m.id = p."messageId" WHERE p."threadId" = $1`, [thread.id])
    expect(pins).toEqual([expect.objectContaining({ direction: 'INTERNAL_NOTE' })])
    expect(pins[0]!.bodyText).toContain('Made-up: six styles approved for production in March.')
    expect(await one(`SELECT "revokedAt" IS NOT NULL AS revoked, "revokedById" FROM "RecordShare" WHERE id = $1`, [shareId])).toEqual({ revoked: true, revokedById: PEOPLE.ada })
    // A CLOSED project changes nothing and links nothing until it is reopened.
    expect((await refused('ada', 'PATCH', `/projects/${alpha.id}`, { version: closed.version, name: 'Made-up after close' }, 409)).issues).toEqual([expect.objectContaining({ path: 'refusal/CLOSED' })])
    const style = idOf('product:style:JKT-01')
    expect(pathsOf(await refused('ada', 'POST', `/projects/${alpha.id}/links`, { recordType: 'Style', recordId: style }, 409))).toContain('refusal/CLOSED')
    alpha = closed
  })

  it('reopens it on its own: ACTIVE, the outcome gone, the thread open again with a system line; every move is an event', async () => {
    const reopened = (await ok('ada', 'POST', `/projects/${alpha.id}/reopen`, { version: alpha.version })).project
    expect(reopened).toMatchObject({ status: 'ACTIVE', outcome: null, outcomeNote: null, closedAt: null, closedBy: null, threadStatus: 'OPEN' })
    const thread = await threadOf(alpha.id)
    const last = await one(`SELECT direction::text AS direction, "authorKind"::text AS "authorKind", "bodyText" FROM "Message" WHERE "threadId" = $1 ORDER BY at DESC, id DESC LIMIT 1`, [thread.id])
    expect(last).toMatchObject({ direction: 'INTERNAL_NOTE', authorKind: 'SYSTEM' })
    expect(last.bodyText).toMatch(/Reopened by Made-up ada/)
    // The ended invitation stays ended (a new one is needed).
    expect((await admin(`SELECT id FROM "RecordShare" WHERE "tenantId" = $1 AND "recordType" = 'Project' AND "recordId" = $2 AND "revokedAt" IS NULL`, [T, alpha.id])).length).toBe(0)
    expect((await outboxOf('project.status_changed', alpha.id)).map((row) => [row.payload.from, row.payload.to])).toEqual([
      ['ACTIVE', 'ON_HOLD'],
      ['ON_HOLD', 'ACTIVE'],
      ['ACTIVE', 'CLOSED'],
      ['CLOSED', 'ACTIVE'],
    ])
    alpha = reopened
  })

  it('closes with the line told to the outside company when ticked: the shared message is the one pinned', async () => {
    const told = await newProject('ada', { name: 'Made-up Alpha glove colours', partyId: P1 })
    await ok('ada', 'POST', `/projects/${told.id}/close`, { version: told.version, outcome: 'STOPPED', outcomeNote: 'Made-up: the colours move to next year.', tellCustomer: true })
    const thread = await threadOf(told.id)
    const pins = await admin(`SELECT m.direction::text AS direction, m.channel::text AS channel, m."partyId", m."bodyText" FROM "ThreadPin" p JOIN "Message" m ON m.id = p."messageId" WHERE p."threadId" = $1`, [thread.id])
    expect(pins).toEqual([{ direction: 'OUTBOUND', channel: 'PORTAL', partyId: P1, bodyText: 'Made-up: the colours move to next year.' }])
    // The office line is there too, never shared.
    expect((await admin(`SELECT count(*)::int AS n FROM "Message" WHERE "threadId" = $1 AND direction = 'INTERNAL_NOTE' AND "partyId" IS NULL`, [thread.id]))[0]!.n).toBe(1)
  })

  it('T38 / W38: a person limited to brand A never opens, changes, finds or makes brand B’s project', async () => {
    const beta = await newProject('ada', { name: 'Made-up Beta racing suit programme', partyId: P3 })
    const alphaRow = await newProject('ada', { name: 'Made-up Alpha boots', partyId: P1 })
    // Brand A's project opens for lina; brand B's is not found (never "you may not").
    expect((await ok('lina', 'GET', `/projects/${alphaRow.id}`)).project.id).toBe(alphaRow.id)
    const notFound = await refused('lina', 'GET', `/projects/${beta.id}`, undefined, 404)
    expect(JSON.stringify(notFound)).not.toMatch(/SEED-C2|Beta|customer/i)
    expect((await call('lina', 'PATCH', `/projects/${beta.id}`, { version: beta.version, name: 'Made-up takeover' })).statusCode).toBe(404)
    expect((await call('lina', 'POST', `/projects/${beta.id}/hold`, { version: beta.version })).statusCode).toBe(404)
    expect((await call('lina', 'GET', `/projects/${beta.id}/people`)).statusCode).toBe(404)
    // Making one for brand B: "no such customer" (the words of an unknown one), never that it exists.
    expect(pathsOf(await refused('lina', 'POST', '/projects', { companyId: companyA, name: 'Made-up for B', partyId: P3, targetDate: dayFromNow(30) }, 400))).toEqual(['body/partyId'])
    // The duplicate warning and the list never show it either.
    expect((await ok('lina', 'GET', `/projects/similar?companyId=${companyA}&partyId=${P3}&name=${encodeURIComponent('racing suit programme')}`)).projects).toEqual([])
    expect((await ok('ada', 'GET', `/projects/similar?companyId=${companyA}&partyId=${P3}&name=${encodeURIComponent('racing suit programme')}`)).projects.map((row: Json) => row.id)).toEqual([beta.id])
    expect(((await ok('lina', 'GET', '/projects?view=ALL')).rows as Json[]).map((row) => row.id)).not.toContain(beta.id)
    // Search: the office index holds it with its outside company; lina finds nothing of it, ada does.
    await rebuildIndex(system(), await loadIndexers(SRC), { recordTypes: ['Project'], key: `th5-search-${run}` })
    const searched = async (who: Person, q: string) => ((await ok(who, 'GET', `/search?q=${encodeURIComponent(q)}&type=Project&limit=100`)).results as Json[]).map((row) => row.recordId)
    expect(await searched('ada', 'racing suit programme')).toContain(beta.id)
    expect(await searched('lina', 'racing suit programme')).not.toContain(beta.id)
    expect(await searched('lina', beta.number)).not.toContain(beta.id)
    expect(await searched('lina', 'Alpha boots')).toContain(alphaRow.id)
  })

  it('GET /projects/similar warns of an open project with a name alike, of the same company and outside company only', async () => {
    const similar = (q: string, party = P1) => ok('ada', 'GET', `/projects/similar?companyId=${companyA}&partyId=${party}&name=${encodeURIComponent(q)}`)
    expect((await similar('alpha touring line')).projects.map((row: Json) => row.id)).toContain(alpha.id)
    expect((await similar('ab')).projects).toEqual([])
    expect((await similar('alpha touring line', P3)).projects).toEqual([])
  })
})
