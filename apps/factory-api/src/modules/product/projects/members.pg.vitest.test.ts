import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { PROJECT_REFUSALS } from '@nexus/factory-domain/projects/rules'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard } from '../../../platform/auth/portal/testing/portal'
import { startHarness, type Browser, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { fanOut } from '../../../platform/notifications/fan-out'
import { systemContext } from '../../../platform/outbox/system'
import { partnerFanOut } from '../../../platform/portal/notifications/fan-out'
import { unsubscribeKeyOf } from '../../../platform/portal/notifications/mail'
import { inTenant, partnerWorld, signIn, type PartnerWorld, type Person } from '../../../platform/search/partner/testing/world'

/**
 * B-TH-068 — project people (threads plan TH-5, PROJ-G04, PROJ-G05, PROJ-G06; wall tests T38 / W38 "a brand person is added only
 * inside the project's party" and T06 / W06 "project news only to members of that party"), through the app's real routes on a
 * throwaway PostgreSQL 17 database from the migrations, with every factory-db seed in one namespace: brand A is P1 (its portal buyer
 * and a viewer who is never added), brand B the two-brands seed's SEED-C2B (its portal buyer), SEED-PRJ-002 the seeds' office-only
 * project. Office people are Sales with live roles (the people checks read the roles the database holds).
 *
 *   - a colleague who may read the project is ADDED by hand (the adder named), told once ("Ada added you to …", ASSIGNMENT); added
 *     twice: no second row, no second notice; one who may not read it (limited to brand B) is refused in words;
 *   - the generic "Add a colleague" of any record now says ADDED (CHOSE when one adds oneself) and never takes a portal person;
 *   - T38: brand A's portal buyer is added by someone who keeps projects (the row names brand A); not by a colleague who only writes;
 *     brand B's person and any portal person on an office-only project are refused in words;
 *   - T06: a message to brand A on the project reaches, in the portal, the MEMBER only — never brand A's viewer who was not added,
 *     never brand B — and the office fan-out never drafts a notice for a portal member;
 *   - the lead removes a colleague (told once) and a member (their access ends at once); the lead stays; a colleague who neither
 *     leads nor keeps projects removes nobody; the people and the choices read as the page shows them.
 * Every name is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/product/projects`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'DELETE'

const NS = 'th5-members'
let h: Harness
let world: PartnerWorld
let app: FastifyInstance
let serial = 0

const permissionsOf = (key: string): Permission[] => {
  const template = templateOf(key)!
  return [...template.permissions, ...template.grains.map((grain) => `money.${grain}`)] as Permission[]
}
const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const PEOPLE = { ada: newId(), bob: newId(), cleo: newId(), lina: newId(), sam: newId() } as const
type Who = keyof typeof PEOPLE
const SESSIONS = new Map<string, SessionContext>()

const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => {
  const rows = await admin<R>(sql, values)
  expect(rows.length, sql).toBeGreaterThan(0)
  return rows[0]!
}
const call = (who: Who, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': who, ...(method === 'GET' ? {} : { 'idempotency-key': `th5-members-${++serial}-${Date.now()}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(who: Who, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(who, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function refused(who: Who, method: Method, url: string, payload: unknown, status: number, words: string | null, path: string): Promise<Json> {
  const response = await call(who, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  const body = response.json() as Json
  if (words !== null) expect(body.error.message).toBe(words)
  expect((body.error.issues ?? []).map((issue: Json) => issue.path)).toContain(path)
  return body
}

const system = () => callerFor(h.database, systemContext(world.tenantId, `th5-members-${newId()}`))
const envelopeOf = (row: Json) => ({ eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload })
const outbox = (type: string, subject: string) => admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 AND subject = $3 ORDER BY "occurredAt", id`, [world.tenantId, type, subject])
/** The office notifications of these events, as the worker's fan-out makes them. */
async function officeNews(type: string, subject: string): Promise<void> {
  for (const row of await outbox(type, subject)) await fanOut(system(), envelopeOf(row))
}
/** The portal news of these events, as the worker's partner fan-out makes them. */
async function portalNews(type: string, subject: string): Promise<void> {
  for (const row of await outbox(type, subject)) await partnerFanOut(system(), envelopeOf(row) as never, { clock: h.clock, unsubscribeKey: unsubscribeKeyOf(h.auth.secrets) })
}
const followers = (projectId: string) =>
  admin<{ userId: string; reason: string; partyId: string | null; createdById: string | null }>(`SELECT "userId", reason, "partyId", "createdById" FROM "RecordFollower" WHERE "tenantId" = $1 AND "recordType" = 'Project' AND "recordId" = $2 ORDER BY "createdAt", id`, [world.tenantId, projectId])

let brandB = ''
let buyerB: Person
let orderA = ''
let project: Json = {}
let officeOnly = ''
const browsers = {} as { buyer: Browser; viewer: Browser; buyerB: Browser }

beforeAll(async () => {
  h = await startHarness('th5_members')
  h.clock.set(new Date())
  freshGuard(h)
  world = await partnerWorld(h, NS)
  const T = world.tenantId
  brandB = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-C2B'`, [T])).id
  const b = await one<{ id: string; email: string; displayName: string }>(`SELECT id, email, "displayName" FROM "User" WHERE "tenantId" = $1 AND "partyId" = $2 AND email LIKE 'buyer.second-brand.%' LIMIT 1`, [T, brandB])
  buyerB = { id: b.id, email: b.email, name: b.displayName }
  await inTenant(h, world, (client) => client.portalSettings.updateMany({ where: { partyId: brandB }, data: { portalOn: true } }))
  orderA = (await one<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2 AND "companyId" = $3 ORDER BY number LIMIT 1`, [T, world.p1, world.companyA])).id
  officeOnly = (await one<{ id: string }>(`SELECT id FROM "Project" WHERE "tenantId" = $1 AND number = 'SEED-PRJ-002' AND "partyId" IS NULL`, [T])).id

  const sales = (await one<{ id: string }>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'sales'`, [T])).id
  for (const [who, userId] of Object.entries(PEOPLE) as [Who, string][]) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, 'ACTIVE', 'en')`, [userId, T, `th5-members-${who}@example.test`, `Made-up ${who}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "partyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], $5::uuid[], now() - interval '1 day')`, [newId(), T, userId, sales, who === 'lina' ? [brandB] : []])
  }
  for (const who of Object.keys(PEOPLE) as Who[]) {
    // Sam writes in threads but keeps no projects (a session without projects.manage); Lina is limited to brand B.
    const permissions = who === 'sam' ? (permissionsOf('sales').filter((permission) => permission !== 'projects.manage') as Permission[]) : permissionsOf('sales')
    SESSIONS.set(who, { audience: 'office', tenantId: T, actorId: PEOPLE[who], grants: [grant(permissions, who === 'lina' ? [brandB] : 'all')] })
  }
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS.get(String(request.headers['x-test-session'])) ?? null) },
  )
  // Signed in once (the terms acknowledged): only a person who may use the portal now can be a member.
  browsers.buyer = await signIn(h, world, world.people.buyer)
  browsers.viewer = await signIn(h, world, world.people.viewer)
  browsers.buyerB = await signIn(h, world, buyerB)
  const due = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10)
  project = (await ok('ada', 'POST', '/projects', { companyId: world.companyA, name: 'Made-up mesh summer line', partyId: world.p1, targetDate: due }, 201)).project
}, 900_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await app?.close()
  await h?.close()
}, 60_000)

describe('B-TH-068: project people', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('a colleague who may read it is ADDED by hand (the adder named) and told once; twice changes nothing', async () => {
    expect(await followers(project.id)).toEqual([{ userId: PEOPLE.ada, reason: 'CREATOR', partyId: null, createdById: PEOPLE.ada }])
    const answer = await ok('ada', 'POST', `/projects/${project.id}/people`, { userId: PEOPLE.bob })
    expect(answer.people.office.people.find((person: Json) => person.userId === PEOPLE.bob)).toMatchObject({ name: 'Made-up bob', reason: 'ADDED', addedBy: { id: PEOPLE.ada, name: 'Made-up ada' }, lead: false, muted: false })
    expect((await followers(project.id)).find((row) => row.userId === PEOPLE.bob)).toEqual({ userId: PEOPLE.bob, reason: 'ADDED', partyId: null, createdById: PEOPLE.ada })
    expect((await outbox('project.person_added', project.id)).map((row) => row.payload)).toEqual([expect.objectContaining({ userId: PEOPLE.bob, outside: false, byId: PEOPLE.ada, partyId: world.p1 })])
    expect(await outbox('thread.follower_added', project.id)).toHaveLength(1)
    await officeNews('thread.follower_added', project.id)
    const told = await admin(`SELECT category, "messageKey", "actorId", "recordLabel" FROM "Notification" WHERE "tenantId" = $1 AND "userId" = $2 AND "recordType" = 'Project' AND "recordId" = $3`, [world.tenantId, PEOPLE.bob, project.id])
    expect(told).toEqual([{ category: 'ASSIGNMENT', messageKey: 'notifications.projects.addedYou', actorId: PEOPLE.ada, recordLabel: `${project.number} Made-up mesh summer line` }])
    // Added twice: no second row, no second event, no second notice.
    await ok('ada', 'POST', `/projects/${project.id}/people`, { userId: PEOPLE.bob })
    expect((await followers(project.id)).filter((row) => row.userId === PEOPLE.bob)).toHaveLength(1)
    expect(await outbox('thread.follower_added', project.id)).toHaveLength(1)
  })

  it('T38: a colleague who may not read the project (limited to brand B) is refused in words', async () => {
    await refused('ada', 'POST', `/projects/${project.id}/people`, { userId: PEOPLE.lina }, 409, PROJECT_REFUSALS.MEMBER_NOT_READER.en, 'body/userId')
    expect((await followers(project.id)).map((row) => row.userId)).not.toContain(PEOPLE.lina)
  })

  it('the generic “Add a colleague” of any record says ADDED (CHOSE when one adds oneself) and never takes a portal person', async () => {
    const added = await ok('ada', 'POST', `/threads/SalesOrder/${orderA}/followers`, { userId: PEOPLE.cleo })
    expect(added.followers.find((row: Json) => row.userId === PEOPLE.cleo)).toMatchObject({ reason: 'ADDED', addedBy: { id: PEOPLE.ada }, outside: false })
    const mine = await ok('ada', 'POST', `/threads/SalesOrder/${orderA}/followers`, { userId: PEOPLE.ada })
    expect(mine.followers.find((row: Json) => row.userId === PEOPLE.ada)).toMatchObject({ addedBy: null })
    expect(['CHOSE', 'CREATOR', 'ASSIGNEE', 'MENTIONED']).toContain(mine.followers.find((row: Json) => row.userId === PEOPLE.ada).reason)
    expect((await outbox('thread.follower_added', orderA)).map((row) => row.payload.userId)).toEqual([PEOPLE.cleo])
    await refused('ada', 'POST', `/threads/SalesOrder/${orderA}/followers`, { userId: world.people.buyer.id }, 400, null, 'body/userId')
  })

  it('T38: brand A’s portal buyer is added by someone who keeps projects; never by one who only writes; never brand B’s; never on an office-only project', async () => {
    await refused('sam', 'POST', `/projects/${project.id}/people`, { userId: world.people.buyer.id }, 400, null, 'body/userId')
    const answer = await ok('ada', 'POST', `/projects/${project.id}/people`, { userId: world.people.buyer.id })
    expect(answer.people.outside.people.map((person: Json) => person.userId)).toEqual([world.people.buyer.id])
    expect((await followers(project.id)).find((row) => row.userId === world.people.buyer.id)).toEqual({ userId: world.people.buyer.id, reason: 'ADDED', partyId: world.p1, createdById: PEOPLE.ada })
    expect((await outbox('project.person_added', project.id)).map((row) => row.payload)).toContainEqual(expect.objectContaining({ userId: world.people.buyer.id, outside: true }))
    // Brand B's person is "not one of this company's portal people" (never who they are); an office-only project takes nobody outside.
    const other = await refused('ada', 'POST', `/projects/${project.id}/people`, { userId: buyerB.id }, 409, PROJECT_REFUSALS.MEMBER_OTHER_PARTY.en, 'body/userId')
    expect(JSON.stringify(other)).not.toMatch(/SEED-C2B|Seed Brand Two/)
    await refused('ada', 'POST', `/projects/${officeOnly}/people`, { userId: world.people.buyer.id }, 409, PROJECT_REFUSALS.MEMBER_OFFICE_ONLY.en, 'body/userId')
    // The portal: the member opens the project, brand A's viewer who was not added and brand B do not (neutral 404).
    expect((await browsers.buyer.get(`/portal/threads/Project/${project.id}`)).status).toBe(200)
    expect((await browsers.viewer.get(`/portal/threads/Project/${project.id}`)).status).toBe(404)
    const beta = await browsers.buyerB.get(`/portal/threads/Project/${project.id}`)
    expect(beta.status).toBe(404)
    expect(JSON.stringify(beta.body)).not.toContain('Made-up mesh summer line')
  })

  it('T06: a message to brand A on the project reaches the MEMBER only in the portal; the office fan-out never tells a portal member', async () => {
    const posted = await ok('ada', 'POST', `/threads/Project/${project.id}/replies`, { body: 'Made-up: the mesh swatches leave on Monday.' }, 201)
    expect(posted.message).toMatchObject({ direction: 'OUTBOUND', audience: 'PARTNER', channel: 'PORTAL' })
    const messageId = posted.message.id
    const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'thread.message_posted' AND payload->>'messageId' = $2`, [world.tenantId, messageId])
    expect(rows).toHaveLength(1)
    await partnerFanOut(system(), envelopeOf(rows[0]!) as never, { clock: h.clock, unsubscribeKey: unsubscribeKeyOf(h.auth.secrets) })
    await fanOut(system(), envelopeOf(rows[0]!))
    const portal = await admin<{ userId: string; partyId: string | null }>(`SELECT "userId", "partyId" FROM "Notification" WHERE "tenantId" = $1 AND "recordType" = 'Project' AND "recordId" = $2 AND anchor = $3 AND "partyId" IS NOT NULL`, [world.tenantId, project.id, `message:${messageId}`])
    expect(portal).toEqual([{ userId: world.people.buyer.id, partyId: world.p1 }])
    // The office's news of it: office followers only (Bob), never a portal member as if they were office.
    const office = await admin<{ userId: string }>(`SELECT "userId" FROM "Notification" WHERE "tenantId" = $1 AND "recordType" = 'Project' AND "recordId" = $2 AND anchor = $3 AND "partyId" IS NULL`, [world.tenantId, project.id, `message:${messageId}`])
    expect(office.map((row) => row.userId)).toEqual([PEOPLE.bob])
    // The member reads it; brand B's bell holds nothing of the project.
    const read = await browsers.buyer.get(`/portal/threads/Project/${project.id}`)
    expect(read.body.messages.map((message: Json) => message.body)).toContain('Made-up: the mesh swatches leave on Monday.')
    const bell = await browsers.buyerB.get('/portal/notifications')
    expect(bell.status).toBe(200)
    expect(JSON.stringify(bell.body)).not.toMatch(new RegExp(`${project.id}|Made-up mesh summer line`))
    // The member who was just added is told so in their portal (that person only).
    await portalNews('project.person_added', project.id)
    const added = await admin<{ userId: string; messageKey: string }>(`SELECT "userId", "messageKey" FROM "Notification" WHERE "tenantId" = $1 AND "recordType" = 'Project' AND "recordId" = $2 AND "messageKey" = 'portal.project.added'`, [world.tenantId, project.id])
    expect(added).toEqual([{ userId: world.people.buyer.id, messageKey: 'portal.project.added' }])
  })

  it('the people and the choices read as the page shows them', async () => {
    const { people } = await ok('ada', 'GET', `/projects/${project.id}/people`)
    expect(people.office.count).toBe(2)
    expect(people.office.people.find((person: Json) => person.userId === PEOPLE.ada)).toMatchObject({ lead: true, me: true, reason: 'CREATOR' })
    expect(people.outside).toMatchObject({ count: 1, people: [expect.objectContaining({ userId: world.people.buyer.id, reason: 'ADDED' })] })
    expect(people.invited).toEqual({ count: 0, people: [] })
    const choices = await ok('ada', 'GET', `/projects/${project.id}/people/choices`)
    expect(choices.mayAddOutside).toBe(true)
    expect(choices.office.map((person: Json) => person.userId)).toEqual(expect.arrayContaining([PEOPLE.cleo, PEOPLE.sam]))
    expect(choices.office.map((person: Json) => person.userId)).not.toContain(PEOPLE.bob)
    expect(choices.office.map((person: Json) => person.userId)).not.toContain(PEOPLE.lina)
    expect(choices.outside.map((person: Json) => person.userId)).toContain(world.people.viewer.id)
    expect(choices.outside.map((person: Json) => person.userId)).not.toContain(world.people.buyer.id)
    expect(choices.outside.map((person: Json) => person.userId)).not.toContain(buyerB.id)
    // Sam writes but keeps no projects: no outside people offered to him.
    const sams = await ok('sam', 'GET', `/projects/${project.id}/people/choices`)
    expect(sams).toMatchObject({ outside: [], mayAddOutside: false })
  })

  it('the lead removes a colleague (told once) and a member (access ends at once); the lead stays; a colleague who neither leads nor keeps projects removes nobody', async () => {
    await refused('sam', 'DELETE', `/projects/${project.id}/people/${PEOPLE.bob}`, undefined, 409, PROJECT_REFUSALS.MEMBER_REMOVE.en, 'refusal/MEMBER_REMOVE')
    await refused('ada', 'DELETE', `/projects/${project.id}/people/${PEOPLE.ada}`, undefined, 409, PROJECT_REFUSALS.MEMBER_LEAD.en, 'refusal/MEMBER_LEAD')
    await ok('ada', 'DELETE', `/projects/${project.id}/people/${PEOPLE.bob}`)
    expect((await followers(project.id)).map((row) => row.userId)).not.toContain(PEOPLE.bob)
    await officeNews('project.person_removed', project.id)
    const told = await admin(`SELECT category, "messageKey", "actorId" FROM "Notification" WHERE "tenantId" = $1 AND "userId" = $2 AND "recordType" = 'Project' AND "recordId" = $3 AND "messageKey" = 'notifications.projects.removedYou'`, [world.tenantId, PEOPLE.bob, project.id])
    expect(told).toEqual([{ category: 'SYSTEM', messageKey: 'notifications.projects.removedYou', actorId: PEOPLE.ada }])
    // The member taken out: their messages stay, their access ends at once.
    await ok('ada', 'DELETE', `/projects/${project.id}/people/${world.people.buyer.id}`)
    expect((await browsers.buyer.get(`/portal/threads/Project/${project.id}`)).status).toBe(404)
    expect((await admin(`SELECT count(*)::int AS n FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordType" = 'Project' AND t."recordId" = $1 AND m.direction = 'OUTBOUND'`, [project.id]))[0]!.n).toBe(1)
    expect((await outbox('project.person_removed', project.id)).map((row) => row.payload)).toEqual([
      expect.objectContaining({ userId: PEOPLE.bob, outside: false, byId: PEOPLE.ada }),
      expect.objectContaining({ userId: world.people.buyer.id, outside: true, byId: PEOPLE.ada }),
    ])
  })
})
