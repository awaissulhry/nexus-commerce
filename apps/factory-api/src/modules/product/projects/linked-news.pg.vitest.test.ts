import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard } from '../../../platform/auth/portal/testing/portal'
import { startHarness, type Browser, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { inTenant, partnerWorld, signIn, type PartnerWorld, type Person } from '../../../platform/search/partner/testing/world'

/**
 * B-TH-072 — linked news (threads plan TH-5, PROJ-G17, PROJ.linked-F08; wall test T38 / W38 "the brand sees news only of the linked
 * records it may open itself"), through the app's real routes on a throwaway PostgreSQL 17 database from the migrations, with every
 * factory-db seed in one namespace. Brand A's project (P1) links one of P1's orders, P1's private-label style SEED-JKT-01 and an
 * open-range style (no party); their status moves are audit rows written for the test in 2025 (no seed row is that old), so the
 * lines read here are only these.
 *
 *   - office: GET /threads/Project/<id>/timeline?kinds=linked merges the linked records' status moves newest first, one line per
 *     record per Rome day (the newest; `folded` says how many), with the office person by name; a change that moves no status and
 *     decides nothing is no news; the default feed holds no linked line; a reader who may not open a linked record (no
 *     orders.view) never sees its lines;
 *   - portal: GET /portal/projects/<id>/news for a MEMBER of brand A: status moves of the records they open in their own portal
 *     only (their order, their style; never the open-range style the office linked), no person, no action; brand A's viewer who
 *     was not added and brand B's buyer get 404.
 * Every name is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/product/projects`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST'

const NS = 'th5-linked-news'
let h: Harness
let world: PartnerWorld
let app: FastifyInstance
let serial = 0

const permissionsOf = (key: string): Permission[] => {
  const template = templateOf(key)!
  return [...template.permissions, ...template.grains.map((grain) => `money.${grain}`)] as Permission[]
}
const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const PEOPLE = { ada: newId(), paolo: newId() } as const
type Who = keyof typeof PEOPLE
const SESSIONS = new Map<string, SessionContext>()

const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => {
  const rows = await admin<R>(sql, values)
  expect(rows.length, sql).toBeGreaterThan(0)
  return rows[0]!
}
const call = (who: Who, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': who, ...(method === 'GET' ? {} : { 'idempotency-key': `th5-news-${++serial}-${Date.now()}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(who: Who, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(who, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}

const ids = { order: '', orderNumber: '', styleA: '', openRange: '', brandB: '' }
const rows = { orderDayBefore: newId(), orderMorning: newId(), orderNoon: newId(), orderNote: newId(), style: newId(), openRange: newId() }
const ours = new Set<string>(Object.values(rows))
let project: Json = {}
let buyerB: Person
const browsers = {} as { buyer: Browser; viewer: Browser; buyerB: Browser }

/** One audit row of a linked record, as its own module's command would have written it. */
async function audit(id: string, at: string, recordType: string, recordId: string, scope: { companyId: string | null; partyId: string | null }, action: string, before: Json, after: Json): Promise<void> {
  await admin(
    `INSERT INTO "AuditLog" (id, "tenantId", "companyId", "siteId", "partyId", at, audience, "actorId", action, "recordType", "recordId", before, after, "requestId")
     VALUES ($1, $2, $3, NULL, $4, $5, 'OFFICE'::"AuditAudience", $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)`,
    [id, world.tenantId, scope.companyId, scope.partyId, at, PEOPLE.ada, action, recordType, recordId, JSON.stringify(before), JSON.stringify(after), newId()],
  )
}
const linkedOf = async (who: Who, query = 'kinds=linked'): Promise<Json[]> => ((await ok(who, 'GET', `/threads/Project/${project.id}/timeline?${query}&limit=100`)).entries as Json[])

beforeAll(async () => {
  h = await startHarness('th5_linked_news')
  h.clock.set(new Date())
  freshGuard(h)
  world = await partnerWorld(h, NS)
  const T = world.tenantId
  ids.brandB = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-C2B'`, [T])).id
  const b = await one<{ id: string; email: string; displayName: string }>(`SELECT id, email, "displayName" FROM "User" WHERE "tenantId" = $1 AND "partyId" = $2 AND email LIKE 'buyer.second-brand.%' LIMIT 1`, [T, ids.brandB])
  buyerB = { id: b.id, email: b.email, name: b.displayName }
  await inTenant(h, world, (client) => client.portalSettings.updateMany({ where: { partyId: ids.brandB }, data: { portalOn: true } }))
  const order = await one<{ id: string; number: string }>(`SELECT id, number FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2 AND "companyId" = $3 ORDER BY number LIMIT 1`, [T, world.p1, world.companyA])
  ids.order = order.id
  ids.orderNumber = order.number
  ids.styleA = (await one<{ id: string }>(`SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-01' AND "brandPartyId" = $2`, [T, world.p1])).id
  ids.openRange = (await one<{ id: string }>(`SELECT id FROM "Style" WHERE "tenantId" = $1 AND "brandPartyId" IS NULL AND ("companyId" IS NULL OR "companyId" = $2) ORDER BY code LIMIT 1`, [T, world.companyA])).id

  const sales = (await one<{ id: string }>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'sales'`, [T])).id
  for (const [who, userId] of Object.entries(PEOPLE) as [Who, string][]) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, 'ACTIVE', 'en')`, [userId, T, `th5-news-${who}@example.test`, `Made-up ${who}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "partyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], '{}'::uuid[], now() - interval '1 day')`, [newId(), T, userId, sales])
  }
  // Ada keeps projects and opens orders and styles; Paolo reads the project and styles, never orders.
  SESSIONS.set('ada', { audience: 'office', tenantId: T, actorId: PEOPLE.ada, grants: [grant([...permissionsOf('sales'), 'product.styles.view'] as Permission[])] })
  SESSIONS.set('paolo', { audience: 'office', tenantId: T, actorId: PEOPLE.paolo, grants: [grant(['threads.read', 'product.styles.view'] as Permission[])] })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS.get(String(request.headers['x-test-session'])) ?? null) },
  )
  browsers.buyer = await signIn(h, world, world.people.buyer)
  browsers.viewer = await signIn(h, world, world.people.viewer)
  browsers.buyerB = await signIn(h, world, buyerB)

  const due = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10)
  project = (await ok('ada', 'POST', '/projects', { companyId: world.companyA, name: 'Made-up winter touring line', partyId: world.p1, targetDate: due, links: [{ recordType: 'SalesOrder', recordId: ids.order }, { recordType: 'Style', recordId: ids.styleA }] }, 201)).project
  await ok('ada', 'POST', `/projects/${project.id}/links`, { recordType: 'Style', recordId: ids.openRange })
  await ok('ada', 'POST', `/projects/${project.id}/people`, { userId: world.people.buyer.id })

  // The linked records' history (Rome days: 9, 10 and 10 March, 11 and 12 March 2025).
  const orderScope = { companyId: world.companyA, partyId: world.p1 }
  await audit(rows.orderDayBefore, '2025-03-09T09:00:00.000Z', 'SalesOrder', ids.order, orderScope, 'orders.confirm', { status: 'DRAFT' }, { status: 'CONFIRMED' })
  await audit(rows.orderMorning, '2025-03-10T08:00:00.000Z', 'SalesOrder', ids.order, orderScope, 'orders.start', { status: 'CONFIRMED' }, { status: 'IN_PRODUCTION' })
  await audit(rows.orderNoon, '2025-03-10T11:00:00.000Z', 'SalesOrder', ids.order, orderScope, 'orders.ship', { status: 'IN_PRODUCTION' }, { status: 'SHIPPED' })
  await audit(rows.orderNote, '2025-03-10T12:00:00.000Z', 'SalesOrder', ids.order, orderScope, 'orders.updateNote', { officeNote: 'Made-up a' }, { officeNote: 'Made-up b' })
  await audit(rows.style, '2025-03-11T09:00:00.000Z', 'Style', ids.styleA, { companyId: null, partyId: world.p1 }, 'product.styles.setStatus', { status: 'DEVELOPMENT' }, { status: 'RELEASED' })
  await audit(rows.openRange, '2025-03-12T09:00:00.000Z', 'Style', ids.openRange, { companyId: null, partyId: null }, 'product.styles.setStatus', { status: 'DEVELOPMENT' }, { status: 'RELEASED' })
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

describe('B-TH-072: linked news in the project’s feed, merged when read', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('merges the linked records’ status moves newest first, one line per record per day, with the office person by name', async () => {
    const lines = (await linkedOf('ada')).filter((entry) => ours.has(entry.id))
    expect(lines.every((entry) => entry.kind === 'linked')).toBe(true)
    expect(lines.map((entry) => entry.id)).toEqual([rows.openRange, rows.style, rows.orderNoon, rows.orderDayBefore])
    const noon = lines.find((entry) => entry.id === rows.orderNoon)!
    expect(noon).toMatchObject({ recordType: 'SalesOrder', recordId: ids.order, label: ids.orderNumber, action: 'orders.ship', status: { from: 'IN_PRODUCTION', to: 'SHIPPED' }, actorName: 'Made-up ada', folded: 2 })
    expect(lines.find((entry) => entry.id === rows.style)).toMatchObject({ recordType: 'Style', label: 'SEED-JKT-01', status: { from: 'DEVELOPMENT', to: 'RELEASED' }, folded: 1 })
    // A change that moves no status and decides nothing is no news; nothing of it is ever a value.
    expect(lines.map((entry) => entry.id)).not.toContain(rows.orderNote)
    expect(JSON.stringify(lines)).not.toMatch(/officeNote|Made-up a|Made-up b/)
  })

  it('the default feed holds no linked line; nothing is copied into the project’s thread', async () => {
    const entries = await linkedOf('ada', 'kinds=message,change,file')
    expect(entries.filter((entry) => entry.kind === 'linked')).toEqual([])
    const plain = (await ok('ada', 'GET', `/threads/Project/${project.id}/timeline?limit=100`)).entries as Json[]
    expect(plain.filter((entry) => entry.kind === 'linked')).toEqual([])
    const copied = await admin(`SELECT m.id FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordType" = 'Project' AND t."recordId" = $1 AND m."bodyText" LIKE '%SHIPPED%'`, [project.id])
    expect(copied).toEqual([])
  })

  it('T38: a reader who may not open a linked record never sees its lines', async () => {
    const lines = (await linkedOf('paolo')).filter((entry) => ours.has(entry.id))
    expect(lines.map((entry) => entry.recordType)).not.toContain('SalesOrder')
    expect(lines.map((entry) => entry.id)).toEqual([rows.openRange, rows.style])
  })

  it('T38: the portal member reads the status moves of the records they open themselves only — no person, no action', async () => {
    const answer = await browsers.buyer.get(`/portal/projects/${project.id}/news?limit=100`)
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    const lines = (answer.body.entries as Json[]).filter((entry) => ours.has(entry.id))
    expect(lines.map((entry) => entry.id)).toEqual([rows.style, rows.orderNoon, rows.orderDayBefore])
    expect(lines.find((entry) => entry.id === rows.orderNoon)).toMatchObject({ recordType: 'SalesOrder', recordId: ids.order, status: { from: 'IN_PRODUCTION', to: 'SHIPPED' }, folded: 2 })
    // The open-range style the office linked is no record of brand A's portal: never a line of it.
    expect((answer.body.entries as Json[]).map((entry) => entry.recordId)).not.toContain(ids.openRange)
    const text = JSON.stringify(answer.body)
    expect(text).not.toMatch(/Made-up ada|orders\.ship|actorName|action/)
  })

  it('T38: brand A’s viewer who was not added and brand B’s buyer get 404 in neutral words', async () => {
    for (const browser of [browsers.viewer, browsers.buyerB]) {
      const answer = await browser.get(`/portal/projects/${project.id}/news`)
      expect(answer.status, JSON.stringify(answer.body)).toBe(404)
      expect(JSON.stringify(answer.body)).not.toMatch(/Made-up winter touring line|SEED-JKT-01|another (customer|brand)/i)
    }
  })
})
