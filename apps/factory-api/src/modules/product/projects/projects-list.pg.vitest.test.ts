import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedSalesIntake } from '../../../../../../packages/factory-db/seed/sales-intake'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { completeContext, testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { exportSourceOf } from '../../../platform/exports/registry'
import { fanOut } from '../../../platform/notifications/fan-out'
import { systemContext } from '../../../platform/outbox/system'

/**
 * B-TH-070 — the projects list and page reads (threads plan TH-5, PROJ-G10, PROJ-G11; wall W30) through the app's real routes on a
 * throwaway PostgreSQL 17 database from the migrations, on the seeds up to the sales intake (company A with its PROJECT series; the
 * brand P1 = SEED-C1 as "brand A", the customer P3 = SEED-C2 as "brand B"). Every name and word is made up. Five projects: A1 and A2
 * of brand A (A2 past its target date), B1 of brand B, O1 office only (put on hold, led by the production manager), C1 of brand A
 * closed.
 *
 *   - GET /projects: the views MINE (the default: open projects I am in), ACTIVE, ON_HOLD, CLOSED, ALL; the filters outside company,
 *     office only, lead, overdue, the words typed; the sorts TARGET (status, then the nearest date), PARTY (office only last), RECENT;
 *     paged by a cursor with the exact count;
 *   - New for me: the reader's OWN unread notifications of the project (a colleague's note fanned out to its followers), 0 for its
 *     author, 0 and a muted mark once the reader mutes it;
 *   - W30: a person limited to brand A lists brand A's and office-only projects only, never brand B's; the company band's count of
 *     brand B is 0 for them; the export source products.projects holds exactly what the list shows (screen = file);
 *   - GET /projects/:id: the page with the project, its people (lead, why each is in, who added them), its linked record, tasks
 *     and files.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/product/projects`.
 */

vi.setConfig({ testTimeout: 120_000 })

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'

const NS = 'th5-projects-list'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const P1 = idOf('party:P1')
const P3 = idOf('party:P3')
const STYLE = idOf('product:style:JKT-01')
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
  app.inject({ method, url, headers: { 'x-test-session': who, ...(method === 'GET' ? {} : { 'idempotency-key': `th5-list-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(who: Person, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(who, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}

const DAY = 86_400_000
const dayFromNow = (days: number): string => new Date(Date.now() + days * DAY).toISOString().slice(0, 10)
const system = () => callerFor(h.database, systemContext(T, `th5-list-${newId()}`))
const envelopeOf = (row: Json) => ({ eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload })

const P: Record<'A1' | 'A2' | 'B1' | 'O1' | 'C1', Json> = {} as never
const listed = async (who: Person, query: string): Promise<string[]> => ((await ok(who, 'GET', `/projects?${query}`)).rows as Json[]).map((row) => row.id)
const rowOf = async (who: Person, query: string, id: string): Promise<Json | undefined> => ((await ok(who, 'GET', `/projects?${query}`)).rows as Json[]).find((row) => row.id === id)
const sorted = (ids: readonly string[]) => [...ids].sort()

beforeAll(async () => {
  h = await startHarness('th5_projects_list')
  await seedCore({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
  for (const [person, userId] of Object.entries(PEOPLE) as [Person, string][]) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, 'ACTIVE', 'en')`, [userId, T, `th5-list-${person}-${run}@example.test`, `Made-up ${person}`])
    const roleId = (await one(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = $2`, [T, ROLE_OF[person]])).id
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "partyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], $5::uuid[], now() - interval '1 day')`, [newId(), T, userId, roleId, PARTIES_OF[person]])
    sessions.set(person, { audience: 'office', tenantId: T, actorId: userId, grants: [grantOf(person)] })
  }
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: SRC, authenticate: testAuthenticator((request) => sessions.get(String(request.headers['x-test-session'])) ?? null) },
  )
  const make = async (body: Json) => (await ok('ada', 'POST', '/projects', { companyId: companyA, ...body }, 201)).project
  P.A1 = await make({ name: 'Made-up Alpha jackets', partyId: P1, targetDate: dayFromNow(30), colleagueIds: [PEOPLE.bob] })
  P.A2 = await make({ name: 'Made-up Alpha overdue gloves', partyId: P1, targetDate: dayFromNow(-5) })
  P.B1 = await make({ name: 'Made-up Beta racing suits', partyId: P3, targetDate: dayFromNow(20) })
  P.O1 = await make({ name: 'Made-up lining supplier search', partyId: null, leadId: PEOPLE.pia, targetDate: dayFromNow(40) })
  P.C1 = await make({ name: 'Made-up Alpha closed belts', partyId: P1, targetDate: dayFromNow(10) })
  P.O1 = (await ok('ada', 'POST', `/projects/${P.O1.id}/hold`, { version: P.O1.version })).project
  P.C1 = (await ok('ada', 'POST', `/projects/${P.C1.id}/close`, { version: P.C1.version, outcome: 'DONE', outcomeNote: 'Made-up: the belts were approved.' })).project
  await ok('ada', 'POST', `/projects/${P.A1.id}/links`, { recordType: 'Style', recordId: STYLE, note: 'Made-up: the base jacket.' })
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('B-TH-070 the projects list', () => {
  it('views: MINE by default (open projects I am in), ACTIVE, ON_HOLD, CLOSED and ALL', async () => {
    expect(sorted(await listed('ada', ''))).toEqual(sorted([P.A1.id, P.A2.id, P.B1.id, P.O1.id]))
    expect(await listed('bob', 'view=MINE')).toEqual([P.A1.id])
    expect(sorted(await listed('ada', 'view=ACTIVE'))).toEqual(sorted([P.A1.id, P.A2.id, P.B1.id]))
    expect(await listed('ada', 'view=ON_HOLD')).toEqual([P.O1.id])
    expect(await listed('ada', 'view=CLOSED')).toEqual([P.C1.id])
    const all = await ok('ada', 'GET', '/projects?view=ALL')
    expect(all).toMatchObject({ count: 5, next: null, complete: true })
    const a2 = (all.rows as Json[]).find((row) => row.id === P.A2.id)!
    expect(a2).toMatchObject({ number: P.A2.number, party: { id: P1 }, lead: { id: PEOPLE.ada }, status: 'ACTIVE', statusWords: { en: 'Active' }, target: { state: 'OVERDUE' }, mine: true, linked: 0 })
    expect(a2.target.words.en).toMatch(/^Overdue \d+ d$/)
    expect((all.rows as Json[]).find((row) => row.id === P.O1.id)).toMatchObject({ party: null, lead: { id: PEOPLE.pia }, status: 'ON_HOLD' })
    expect((all.rows as Json[]).find((row) => row.id === P.A1.id)).toMatchObject({ linked: 1 })
  })

  it('filters: outside company, office only, lead, overdue and the words typed', async () => {
    expect(sorted(await listed('ada', `view=ALL&partyId=${P1}`))).toEqual(sorted([P.A1.id, P.A2.id, P.C1.id]))
    expect(await listed('ada', 'view=ALL&outside=none')).toEqual([P.O1.id])
    expect(await listed('ada', `view=ALL&leadId=${PEOPLE.pia}`)).toEqual([P.O1.id])
    expect(await listed('ada', 'view=ALL&target=OVERDUE')).toEqual([P.A2.id])
    expect(await listed('ada', `view=ALL&q=${encodeURIComponent('jackets')}`)).toEqual([P.A1.id])
    expect(await listed('ada', `view=ALL&q=${encodeURIComponent(P.B1.number)}`)).toEqual([P.B1.id])
  })

  it('sorts by status and target date, by outside company (office only last), by the last message; pages by a cursor', async () => {
    expect(await listed('ada', 'view=ALL')).toEqual([P.A2.id, P.B1.id, P.A1.id, P.O1.id, P.C1.id])
    expect((await listed('ada', 'view=ALL&sort=PARTY')).at(-1)).toBe(P.O1.id)
    // A1 has the newest message (its link's system line).
    expect((await listed('ada', 'view=ALL&sort=RECENT'))[0]).toBe(P.A1.id)
    const first = await ok('ada', 'GET', '/projects?view=ALL&limit=2')
    expect(first.rows.map((row: Json) => row.id)).toEqual([P.A2.id, P.B1.id])
    expect(first).toMatchObject({ count: 5, next: '2' })
    const second = await ok('ada', 'GET', `/projects?view=ALL&limit=2&cursor=${first.next}`)
    expect(second.rows.map((row: Json) => row.id)).toEqual([P.A1.id, P.O1.id])
    const third = await ok('ada', 'GET', `/projects?view=ALL&limit=2&cursor=${second.next}`)
    expect(third).toMatchObject({ next: null })
    expect(third.rows.map((row: Json) => row.id)).toEqual([P.C1.id])
  })

  it('New for me: my own unread notifications of the project, none for the author, none (a muted mark) once I mute it', async () => {
    const { message } = await ok('ada', 'POST', `/threads/Project/${P.A1.id}/notes`, { body: 'Made-up: the leather samples arrive on Monday.' }, 201)
    const [row] = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'thread.message_posted' AND payload->>'messageId' = $2`, [T, message.id])
    expect(row).toBeDefined()
    await fanOut(system(), envelopeOf(row!))
    expect(await rowOf('bob', 'view=MINE', P.A1.id)).toMatchObject({ newForMe: 1, muted: false, mine: true })
    expect(await rowOf('ada', 'view=MINE', P.A1.id)).toMatchObject({ newForMe: 0 })
    // Somebody else's marks never show: pia is not in A1 and reads it with 0.
    expect(await rowOf('pia', 'view=ALL', P.A1.id)).toMatchObject({ newForMe: 0, mine: false })
    await ok('bob', 'PUT', `/threads/Project/${P.A1.id}/followers/me`, { following: true, muted: true })
    expect(await rowOf('bob', 'view=MINE', P.A1.id)).toMatchObject({ newForMe: 0, muted: true })
  })

  it('W30: a person limited to brand A lists brand A’s and office-only projects, never brand B’s; the band count of brand B is 0', async () => {
    expect(sorted(await listed('lina', 'view=ALL'))).toEqual(sorted([P.A1.id, P.A2.id, P.O1.id, P.C1.id]))
    expect(await listed('lina', `view=ALL&partyId=${P3}`)).toEqual([])
    expect(await listed('lina', `view=ALL&q=${encodeURIComponent('Beta')}`)).toEqual([])
    expect((await ok('lina', 'GET', '/projects?view=ALL')).count).toBe(4)
    expect(await ok('lina', 'GET', `/projects/counts?partyId=${P3}`)).toEqual({ open: 0, all: 0 })
    expect(await ok('ada', 'GET', `/projects/counts?partyId=${P3}`)).toEqual({ open: 1, all: 1 })
    expect(await ok('lina', 'GET', `/projects/counts?partyId=${P1}`)).toEqual({ open: 2, all: 3 })
    expect((await call('lina', 'GET', `/projects/${P.B1.id}`)).statusCode).toBe(404)
  })

  it('W30: the export source products.projects holds exactly the rows the list shows (screen = file)', async () => {
    const source = exportSourceOf('products.projects')!
    expect(source).toBeDefined()
    const reader = (person: Person) => callerFor(h.database, completeContext(sessions.get(person)!, `th5-export-${newId()}`))
    const exported = async (person: Person, address: string) => ((await source.read(reader(person), source.query(new URLSearchParams(address)), null, 200)).rows as Json[]).map((row) => row.id)
    expect(await exported('lina', 'view=ALL')).toEqual(await listed('lina', 'view=ALL'))
    expect(await exported('lina', `view=ALL&party=${P3}`)).toEqual([])
    expect(await exported('ada', 'view=ALL')).toEqual(await listed('ada', 'view=ALL'))
    expect(await exported('ada', `view=ALL&party=${P3}`)).toEqual([P.B1.id])
  })
})

describe('B-TH-070 the project page', () => {
  it('answers the project with its people, its linked record, its tasks and files', async () => {
    const page = await ok('ada', 'GET', `/projects/${P.A1.id}`)
    expect(page.project).toMatchObject({ id: P.A1.id, number: P.A1.number, party: { id: P1 }, lead: { id: PEOPLE.ada }, status: 'ACTIVE', officeOnly: false })
    expect(page.project.openToOfficeWords.en).toMatch(/Everyone in the company who reads threads/)
    expect(page.people.office.count).toBe(2)
    expect(page.people.office.people).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: PEOPLE.ada, lead: true, me: true, reason: 'CREATOR' }),
        expect.objectContaining({ userId: PEOPLE.bob, lead: false, reason: 'ADDED', addedBy: { id: PEOPLE.ada, name: 'Made-up ada' }, muted: true }),
      ]),
    )
    expect(page.people.outside).toEqual({ count: 0, people: [] })
    expect(page.people.invited).toEqual({ count: 0, people: [] })
    expect(page.links.count).toBe(1)
    expect(page.links.records).toEqual([expect.objectContaining({ recordType: 'Style', recordId: STYLE, group: 'STYLES', label: 'SEED-JKT-01', mayOpen: true, note: 'Made-up: the base jacket.', linkedBy: { id: PEOPLE.ada, name: 'Made-up ada' } })])
    expect(page.tasks).toEqual({ open: 0, overdue: 0 })
    expect(page.files).toEqual({ count: 0 })
    expect(page.me).toMatchObject({ following: true, muted: false, reason: 'CREATOR' })
    // No money and no count of anyone's messages anywhere in the answer.
    expect(JSON.stringify(page)).not.toMatch(/price|cost|amount|seenBy|messageCount/i)
  })

  it('an office-only project lists no outside people and says so; brand B’s page is not found for a person limited to brand A', async () => {
    const office = await ok('pia', 'GET', `/projects/${P.O1.id}`)
    expect(office.project).toMatchObject({ party: null, officeOnly: true, status: 'ON_HOLD', lead: { id: PEOPLE.pia, name: 'Made-up pia' } })
    expect(office.project.may.moves.sort()).toEqual(['CLOSE', 'RESUME'])
    expect((await call('lina', 'GET', `/projects/${P.B1.id}`)).statusCode).toBe(404)
    expect((await call('lina', 'GET', `/projects/${P.B1.id}/people`)).statusCode).toBe(404)
  })
})
