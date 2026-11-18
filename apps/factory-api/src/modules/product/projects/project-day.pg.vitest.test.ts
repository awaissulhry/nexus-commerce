import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { THREAD_RECORD_TYPES } from '@nexus/factory-domain/approvals-out/kinds'
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
import { callerFor, command, COMMAND_SETTINGS } from '../../../core/command'
import { completeContext, testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { ensureBuiltInRules } from '../../../platform/alerts/built-in'
import { evaluateKind } from '../../../platform/alerts/engine'
import { adapterOf } from '../../../platform/approvals-out/records'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { fanOut } from '../../../platform/notifications/fan-out'
import { systemContext } from '../../../platform/outbox/system'
import { ensureThread, writeMessage } from '../../../platform/threads/threads'
import { projectsStaleFindings } from './today'

/**
 * B-TH-071 — projects around the day (threads plan TH-5, PROJ-G14, PROJ-G15, PROJ-G20; wall W38) through the app's real routes and the
 * alert engine on a throwaway PostgreSQL 17 database from the migrations, on the seeds up to the sales intake (company A with its
 * PROJECT series; the brand P1 = SEED-C1 as "brand A", the customer P3 = SEED-C2 as "brand B"; the requests SEED-INQ-0004 of P1,
 * SEED-INQ-0002 of P3 and SEED-INQ-0001 of a prospect). Every name and word is made up.
 *
 *   - GET /projects/mine (Today's "My projects"): the open projects I lead or am in, nearest first, never a closed one, never one I
 *     may not read (W38);
 *   - the alert PROJECT_STALE: an open project past its target date whose thread has been quiet for 14 days is found (a recent
 *     message or a closed project is not); the engine raises one alert, its notification goes to the project's LEAD alone
 *     (notifications.projects.stale), and a new message clears it;
 *   - "Start a project" from a request: brand A's request makes brand A's project (the outside company is the request's, never one
 *     the body names), the request linked to it; a prospect's request is refused in words (refusal/NO_PARTY_REQUEST); a person
 *     limited to brand A never starts one from brand B's request (404);
 *   - Project is one of the records an approval is asked on (artwork, colour, leather, sample), held for an office-only or a
 *     closed project.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/product/projects`.
 */

vi.setConfig({ testTimeout: 120_000 })

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'

const NS = 'th5-projects-day'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const P1 = idOf('party:P1')
const P3 = idOf('party:P3')
const SRC = fileURLToPath(new URL('../../..', import.meta.url))

const PEOPLE = { ada: newId(), bob: newId(), lina: newId(), pia: newId() } as const
type Person = keyof typeof PEOPLE
/** ada and bob: Sales over every customer; lina: Sales limited to P1 (brand A); pia: the production manager. */
const ROLE_OF: Record<Person, string> = { ada: 'sales', bob: 'sales', lina: 'sales', pia: 'production_manager' }
const PARTIES_OF: Record<Person, string[]> = { ada: [], bob: [], lina: [P1], pia: [] }

const permissionsOf = (key: string): Permission[] => {
  const template = templateOf(key)!
  return [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)]
}
const grantOf = (person: Person): Grant => ({ permissions: permissionsOf(ROLE_OF[person]), companies: 'all', sites: 'all', parties: PARTIES_OF[person].length === 0 ? 'all' : PARTIES_OF[person] })
const sessions = new Map<string, SessionContext>()

let h: Harness
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let serial = 0
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const one = async (sql: string, values: unknown[] = []): Promise<Json> => (await admin(sql, values))[0]!
const call = (who: Person, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': who, ...(method === 'GET' ? {} : { 'idempotency-key': `th5-day-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const system = () => callerFor(h.database, systemContext(T, `th5-day-${newId()}`))
const settings = { ...COMMAND_SETTINGS, clock: { now: () => new Date() } }
const envelopeOf = (row: Json) => ({ eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload })

async function newProject(who: Person, body: Json): Promise<Json> {
  return (await ok(who, 'POST', '/projects', { companyId: companyA, targetDate: dayFromNow(30), ...body }, 201)).project
}
/** One office note on the project's thread through the threads' seam, `daysAgo` back in time, as ada. */
async function noteOn(projectId: string, daysAgo: number): Promise<void> {
  const record = { type: 'Project', id: projectId }
  await command(callerFor(h.database, completeContext(sessions.get('ada')!, `th5-day-note-${newId()}`)), { name: 'threads.postNote', input: { record, daysAgo } }, async (tools) => {
    const { thread } = await ensureThread(tools, record, PEOPLE.ada)
    await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'USER', id: PEOPLE.ada, name: 'Made-up ada' }, bodyText: `Made-up note of ${daysAgo} days ago.`, at: new Date(Date.now() - daysAgo * DAY) })
    return { done: true }
  })
}
const inquiryId = async (number: string): Promise<string> => (await one(`SELECT id FROM "Inquiry" WHERE "tenantId" = $1 AND number = $2`, [T, number])).id

beforeAll(async () => {
  h = await startHarness('th5_projects_day')
  await seedCore({ db: h.database, namespace: NS })
  // fix-pg-2: the roles seed assigns roles to the auth seed's people (it runs after seed/auth.ts).
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
  for (const [person, userId] of Object.entries(PEOPLE) as [Person, string][]) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, 'ACTIVE', 'en')`, [userId, T, `th5-day-${person}-${run}@example.test`, `Made-up ${person}`])
    const roleId = (await one(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = $2`, [T, ROLE_OF[person]])).id
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "partyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], $5::uuid[], now() - interval '1 day')`, [newId(), T, userId, roleId, PARTIES_OF[person]])
    sessions.set(person, { audience: 'office', tenantId: T, actorId: userId, grants: [grantOf(person)] })
  }
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: SRC, authenticate: testAuthenticator((request) => sessions.get(String(request.headers['x-test-session'])) ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('B-TH-071 My projects', () => {
  it('lists the open projects I lead or am in, nearest first; never a closed one; W38: never one I may not read', async () => {
    const soon = await newProject('ada', { name: 'Made-up Alpha jackets soon', partyId: P1, targetDate: dayFromNow(5) })
    const later = await newProject('ada', { name: 'Made-up Beta suits later', partyId: P3, targetDate: dayFromNow(50) })
    const closed = await newProject('ada', { name: 'Made-up Alpha closed', partyId: P1 })
    await ok('ada', 'POST', `/projects/${closed.id}/close`, { version: closed.version, outcome: 'STOPPED', outcomeNote: 'Made-up: not this season.' })
    const linas = await newProject('lina', { name: 'Made-up Alpha boots by lina', partyId: P1, targetDate: dayFromNow(20) })
    const mine = (await ok('ada', 'GET', '/projects/mine')).projects as Json[]
    const ids = mine.map((row) => row.id)
    expect(ids).toEqual(expect.arrayContaining([soon.id, later.id]))
    expect(ids).not.toContain(closed.id)
    expect(ids.indexOf(soon.id)).toBeLessThan(ids.indexOf(later.id))
    expect(mine.every((row) => row.status !== 'CLOSED')).toBe(true)
    expect(mine.find((row) => row.id === soon.id)).toMatchObject({ lead: { id: PEOPLE.ada, me: true }, target: { state: 'SOON' }, mine: true })
    // lina is in her own project only; brand B's project is never listed to her, and she cannot be added to it.
    expect(((await ok('lina', 'GET', '/projects/mine')).projects as Json[]).map((row) => row.id)).toEqual([linas.id])
    const notReader = await refused('ada', 'POST', '/projects', { companyId: companyA, name: 'Made-up Beta with lina', partyId: P3, targetDate: dayFromNow(30), colleagueIds: [PEOPLE.lina] }, 409)
    expect(notReader.message).toBe(PROJECT_REFUSALS.MEMBER_NOT_READER.en)
    expect(pathsOf(notReader)).toContain('body/userId')
    expect((await ok('pia', 'GET', '/projects/mine')).projects).toEqual([])
  })
})

describe('B-TH-071 the alert PROJECT_STALE', () => {
  let stale: Json
  let recent: Json
  let closedStale: Json

  beforeAll(async () => {
    stale = await newProject('ada', { name: 'Made-up Alpha quiet line', partyId: P1, leadId: PEOPLE.bob, targetDate: dayFromNow(-10) })
    recent = await newProject('ada', { name: 'Made-up Alpha busy line', partyId: P1, leadId: PEOPLE.bob, targetDate: dayFromNow(-10) })
    closedStale = await newProject('ada', { name: 'Made-up Alpha closed quiet line', partyId: P1, leadId: PEOPLE.bob, targetDate: dayFromNow(-10) })
    await noteOn(stale.id, 20)
    await noteOn(recent.id, 1)
    await noteOn(closedStale.id, 20)
    await ok('ada', 'POST', `/projects/${closedStale.id}/close`, { version: closedStale.version, outcome: 'DONE', outcomeNote: 'Made-up: done after all.' })
  })

  it('finds an open project past its target date and quiet for 14 days; not a busy one, not a closed one', async () => {
    const findings = await system().withClient((client) => projectsStaleFindings(client, { companyId: null, siteId: null }, new Date()))
    expect(findings.map((finding) => finding.recordId)).toEqual([stale.id])
    expect(findings[0]).toMatchObject({ recordType: 'Project', label: `${stale.number} ${stale.name}`, scope: { companyId: companyA, siteId: null, partyId: P1 }, facts: { targetDate: dayFromNow(-10) } })
    expect(findings[0]!.facts.quietDays).toBeGreaterThanOrEqual(19)
    // A rule of another company finds nothing of company A's.
    expect(await system().withClient((client) => projectsStaleFindings(client, { companyId: idOf('company:B'), siteId: null }, new Date()))).toEqual([])
  })

  it('the engine raises one alert; it is told to the project’s lead alone; a new message clears it', async () => {
    await ensureBuiltInRules(system(), settings)
    expect(await one(`SELECT enabled, "builtIn" FROM "AlertRule" WHERE "tenantId" = $1 AND "ruleKind" = 'PROJECT_STALE'`, [T])).toEqual({ enabled: true, builtIn: true })
    expect(await evaluateKind(system(), 'PROJECT_STALE', settings)).toMatchObject({ kind: 'PROJECT_STALE', raised: 1, cleared: 0 })
    const alert = await one(`SELECT id, state::text AS state, "recordType", "recordId", "recordLabel", "partyId", facts FROM "Alert" WHERE "tenantId" = $1 AND "ruleKind" = 'PROJECT_STALE'`, [T])
    expect(alert).toMatchObject({ state: 'OPEN', recordType: 'Project', recordId: stale.id, recordLabel: `${stale.number} ${stale.name}`, partyId: P1 })
    const [raised] = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'alert.raised' AND payload->>'alertId' = $2`, [T, alert.id])
    expect(raised).toBeDefined()
    await fanOut(system(), envelopeOf(raised!))
    const told = await admin<{ userId: string; category: string; messageKey: string }>(`SELECT "userId", category::text AS category, "messageKey" FROM "Notification" WHERE "tenantId" = $1 AND "recordType" = 'Project' AND "recordId" = $2 AND "eventType" = 'alert.raised'`, [T, stale.id])
    expect(told).toEqual([{ userId: PEOPLE.bob, category: 'ALERT', messageKey: 'notifications.projects.stale' }])
    // A second pass raises nothing twice; a message now clears it.
    expect(await evaluateKind(system(), 'PROJECT_STALE', settings)).toMatchObject({ raised: 0 })
    await noteOn(stale.id, 0)
    expect(await evaluateKind(system(), 'PROJECT_STALE', settings)).toMatchObject({ raised: 0, cleared: 1 })
    expect((await one(`SELECT state::text AS state FROM "Alert" WHERE id = $1`, [alert.id])).state).toBe('RESOLVED')
  })
})

describe('B-TH-071 Start a project from a request', () => {
  it('W38: brand A’s request makes brand A’s project, the request linked to it; the body never names another company', async () => {
    const request = await inquiryId('SEED-INQ-0004')
    const started = await ok('ada', 'POST', `/sales/inquiries/${request}/project`, { name: 'Made-up Alpha RFQ follow-up', targetDate: dayFromNow(45) }, 201)
    expect(started.project).toMatchObject({ name: 'Made-up Alpha RFQ follow-up', party: { id: P1 }, companyId: companyA, status: 'ACTIVE' })
    expect(started.files).toEqual({ carried: [], notCarried: [] })
    expect(await admin(`SELECT "recordType", "recordId", "partyId" FROM "ProjectLink" WHERE "tenantId" = $1 AND "projectId" = $2`, [T, started.project.id])).toEqual([{ recordType: 'Inquiry', recordId: request, partyId: P1 }])
    const [made] = await admin(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'project.created' AND subject = $2`, [T, started.project.id])
    expect(made?.payload).toMatchObject({ partyId: P1, fromRecordType: 'Inquiry', fromRecordId: request })
    // The request shows its project ("In project").
    expect((await ok('ada', 'GET', `/projects/of/Inquiry/${request}`)).projects.map((row: Json) => row.id)).toEqual([started.project.id])
    // The body has no outside company to name (a strict body): asking for another one is refused, nothing made.
    expect((await call('ada', 'POST', `/sales/inquiries/${request}/project`, { name: 'Made-up for B', targetDate: dayFromNow(45), partyId: P3 })).statusCode).toBe(400)
  })

  it('refuses a prospect’s request in words; a person limited to brand A never starts one from brand B’s request', async () => {
    const prospect = await refused('ada', 'POST', `/sales/inquiries/${await inquiryId('SEED-INQ-0001')}/project`, { targetDate: dayFromNow(45) }, 409)
    expect(prospect.message).toBe(PROJECT_REFUSALS.NO_PARTY_REQUEST.en)
    expect(pathsOf(prospect)).toContain('refusal/NO_PARTY_REQUEST')
    const before = (await one(`SELECT count(*)::int AS n FROM "Project" WHERE "tenantId" = $1`, [T])).n
    expect((await call('lina', 'POST', `/sales/inquiries/${await inquiryId('SEED-INQ-0002')}/project`, { targetDate: dayFromNow(45) })).statusCode).toBe(404)
    expect((await one(`SELECT count(*)::int AS n FROM "Project" WHERE "tenantId" = $1`, [T])).n).toBe(before)
  })
})

describe('B-TH-071 Project in the approval record types', () => {
  it('an artwork, colour, leather or sample is asked on a project of an outside company; held for an office-only or a closed one', async () => {
    expect(THREAD_RECORD_TYPES).toContain('Project')
    const adapter = adapterOf('ARTWORK', 'Project')
    expect(adapter).toBeDefined()
    expect(adapter!.kinds).toEqual(expect.arrayContaining(['SAMPLE', 'COLOUR', 'LEATHER', 'ARTWORK']))
    const shared = await newProject('ada', { name: 'Made-up Alpha artwork round', partyId: P1 })
    const office = await newProject('ada', { name: 'Made-up office research', partyId: null })
    const closed = await newProject('ada', { name: 'Made-up Alpha artwork closed', partyId: P1 })
    await ok('ada', 'POST', `/projects/${closed.id}/close`, { version: closed.version, outcome: 'DONE', outcomeNote: 'Made-up: approved.' })
    const read = (id: string) => system().withClient((client) => adapter!.read(client, id, 'ARTWORK', { partyId: null, now: new Date() }))
    expect(await read(shared.id)).toMatchObject({ companyId: companyA, partyId: P1, held: null, thread: { type: 'Project', id: shared.id } })
    expect((await read(office.id))?.held).toMatch(/made for no customer or supplier/)
    expect((await read(closed.id))?.held).toMatch(/is closed/)
  })
})
