import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * Customer 360 (B-W2b-324; SAL-019) on the local stack with the app's real routes: a throwaway PostgreSQL 17 database from
 * the migrations (the runtime login: row-level security is real), tenant A from EVERY seed (SEED-C1 a tenant-wide brand and
 * team with its rider SEED-R2, sample rounds, a repair, a team profile, requirements, a credit limit with company A; P4 a
 * private rider with two revisions of a jacket profile). Test sessions hold the role templates' grants. Every name and
 * number is made up.
 *
 * What it walks: the customer at a glance for company A (holds, requirements in force, promises, free credit, samples in
 * progress, profiles, riders, repairs), a hold placed and released through B-W2b-290's routes showing in the glance, a
 * rider's team, a private rider's newest profile only, the parts withheld without their permission, the amounts left out
 * without the price grain, and the refusals (no company, a company the reader does not see, a customer of another
 * company, a customer not seen, the floor). Run with `node scripts/factory/run-pg-tests.mjs modules/sales/customer-360/`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST'

const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'customer-360-324'
const id = (key: string) => seedUuid(NS, key)
const A = { tenant: id('tenant'), companyA: id('company:A'), companyB: id('company:B'), p1: id('party:P1'), p3: id('party:P3'), p4: id('party:P4') }

function grantsOf(role: string, companies: 'all' | readonly string[] = 'all', drop: readonly string[] = []): Grant[] {
  const template = templateOf(role)!
  const permissions = [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)].filter((permission) => !drop.includes(permission))
  return [{ permissions, companies, sites: 'all', parties: 'all' }]
}
const SESSIONS: Record<string, SessionContext> = {}
const ACTORS: Record<string, string> = {}
function office(key: string, role: string, companies: 'all' | readonly string[] = 'all', drop: readonly string[] = []): void {
  ACTORS[key] = newId()
  SESSIONS[key] = { audience: 'office', tenantId: A.tenant, actorId: ACTORS[key]!, grants: grantsOf(role, companies, drop) }
}

let h: Harness
let app: FastifyInstance
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': `w2b324-${run}-${++keys}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function no(session: string, url: string, status: number): Promise<Json> {
  const response = await call(session, 'GET', url)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const glance = (session: string, partyId: string, companyId: string = A.companyA) => ok(session, 'GET', `/sales/customer-360/${partyId}?companyId=${companyId}`)
const count = async (sql: string, values: unknown[]) => Number((await one<{ n: string }>(sql, values)).n)

let r2: string
let foreign: string

beforeAll(async () => {
  h = await startHarness('customer360_w2b324')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  office('sales', 'sales')
  office('finance', 'finance')
  office('reader', 'read_only')
  office('salesB', 'sales', [A.companyB])
  office('noSamples', 'sales', 'all', ['sales.samples.view', 'sales.repairs.view', 'orders.view'])
  office('noPrice', 'sales', 'all', ['money.price'])
  for (const [key, actorId] of Object.entries(ACTORS)) await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [actorId, A.tenant, `w2b324-${key}-${run}@example.com`, `Made-up ${key}`])
  SESSIONS.floor = { audience: 'floor', tenantId: A.tenant, actorId: newId(), siteId: id('site:A1'), deviceId: newId(), grants: [{ permissions: ['parties.view' as Permission], companies: 'all', sites: 'all', parties: 'all' }] } as SessionContext
  r2 = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-R2'`, [A.tenant])).id
  // P2: a party of company A only (seed/parties.ts), seen from company B below.
  foreign = id('party:P2')
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the customer at a glance (SAL-019)', () => {
  it('reads a team for company A: holds, requirements, promises, credit, samples, profiles, riders, repairs', async () => {
    const body = await glance('sales', A.p1)
    expect(body.party).toMatchObject({ id: A.p1, code: 'SEED-C1', kind: 'ORGANISATION' })
    expect(body.company).toMatchObject({ id: A.companyA, code: 'A' })
    expect(body.team).toBeNull()
    expect(body.withheld).toEqual([])

    const holds = await count(`SELECT count(*) AS n FROM "PartyHold" WHERE "tenantId" = $1 AND "partyId" = $2 AND "releasedAt" IS NULL AND ("companyId" IS NULL OR "companyId" = $3)`, [A.tenant, A.p1, A.companyA])
    expect(body.hold.holds).toHaveLength(holds)
    expect(body.hold.onHold).toBe(holds > 0)

    const requirements = await count(`SELECT count(*) AS n FROM "CustomerRequirement" WHERE "tenantId" = $1 AND "partyId" = $2 AND active AND ("companyId" IS NULL OR "companyId" = $3)`, [A.tenant, A.p1, A.companyA])
    expect(requirements).toBeGreaterThan(0)
    expect(body.requirements.count).toBe(requirements)
    expect(body.requirements.rows.length).toBe(Math.min(3, requirements))
    expect(body.requirements.rows.some((row: Json) => row.everyCompany === true && row.kind === 'DOCUMENT')).toBe(true)

    const open = await count(`SELECT count(*) AS n FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2 AND "companyId" = $3 AND status IN ('CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED')`, [A.tenant, A.p1, A.companyA])
    expect(body.promises.open).toBe(open)
    expect(body.promises.late + body.promises.noPromise).toBeLessThanOrEqual(open)

    // The seed's limit with company A: 50 000.00 EUR (B-W2b-279); free credit = the limit less open orders and invoices.
    expect(body.credit).toMatchObject({ currency: 'EUR', limit: 5_000_000, state: expect.stringMatching(/^(WITHIN|OVER)$/) })
    expect(body.credit.available).toBe(body.credit.limit - body.credit.used)

    const rounds = await count(`SELECT count(*) AS n FROM "SampleRound" WHERE "tenantId" = $1 AND "partyId" = $2 AND "companyId" = $3 AND stage IN ('REQUESTED', 'IN_MAKING', 'SENT', 'UNDER_REVIEW')`, [A.tenant, A.p1, A.companyA])
    expect(rounds).toBeGreaterThan(0)
    expect(body.samples.count).toBe(rounds)
    for (const row of body.samples.rows) expect(['REQUESTED', 'IN_MAKING', 'SENT', 'UNDER_REVIEW']).toContain(row.stage)
    expect(body.samples.rows[0]).toMatchObject({ number: expect.stringMatching(/^SEED-SR-/), style: { code: expect.any(String) } })

    expect(body.profiles.rows.map((row: Json) => row.riderName)).toContain('Seed Team Rider')
    expect(body.profiles.rows[0]).not.toHaveProperty('measurements')

    expect(body.riders.rows.map((row: Json) => row.code)).toContain('SEED-R2')

    const repairs = await count(`SELECT count(*) AS n FROM "RepairOrder" WHERE "tenantId" = $1 AND "partyId" = $2 AND "companyId" = $3 AND stage NOT IN ('SHIPPED', 'CANCELLED')`, [A.tenant, A.p1, A.companyA])
    expect(body.repairs.count).toBe(repairs)
  })

  it('shows a hold placed and released through the hold routes', async () => {
    await ok('finance', 'POST', `/parties/${A.p1}/holds`, { companyId: A.companyA, reason: 'LEGAL', words: 'A made-up contract dispute.' }, 201)
    const held = await glance('sales', A.p1)
    expect(held.hold.onHold).toBe(true)
    const legal = held.hold.holds.find((row: Json) => row.reason === 'LEGAL')
    expect(legal).toMatchObject({ words: 'A made-up contract dispute.', everyCompany: false, placedBy: 'Made-up finance' })
    // Company B does not see a hold of company A.
    const inB = await glance('sales', A.p1, A.companyB)
    expect(inB.hold.holds.some((row: Json) => row.id === legal.id)).toBe(false)

    const { holds } = await ok('finance', 'GET', `/parties/${A.p1}/holds`)
    const row = holds.holds.find((entry: Json) => entry.id === legal.id)
    await ok('finance', 'POST', `/parties/${A.p1}/holds/${legal.id}/release`, { version: row.version, words: 'Settled (made-up).' })
    const after = await glance('sales', A.p1)
    expect(after.hold.holds.some((entry: Json) => entry.id === legal.id)).toBe(false)
  })

  it("names a rider's team, and keeps only a private rider's newest profile", async () => {
    const rider = await glance('sales', r2)
    expect(rider.party.kind).toBe('PERSON')
    expect(rider.team).toMatchObject({ id: A.p1, code: 'SEED-C1' })
    expect(rider.riders).toBeNull()

    const p4 = await glance('sales', A.p4)
    expect(p4.team).toBeNull()
    const jackets = p4.profiles.rows.filter((row: Json) => row.riderName === 'Seed Private Rider' && row.garmentType === 'JACKET')
    expect(jackets).toEqual([expect.objectContaining({ revision: 2 })])
  })

  it('withholds a part without its permission, and the amounts without the price grain', async () => {
    const partial = await glance('noSamples', A.p1)
    expect(partial.withheld).toEqual(['promises', 'samples', 'repairs'])
    expect(partial.samples).toBeNull()
    expect(partial.repairs).toBeNull()
    expect(partial.promises).toBeNull()
    expect(partial.credit).not.toBeNull()

    const noPrice = await glance('noPrice', A.p1)
    expect(noPrice.credit.state).toMatch(/^(WITHIN|OVER)$/)
    expect(noPrice.credit).not.toHaveProperty('limit')
    expect(noPrice.credit).not.toHaveProperty('available')
    expect(noPrice.credit).not.toHaveProperty('overdue')

    const reader = await glance('reader', A.p1)
    expect(reader.requirements.count).toBeGreaterThan(0)
  })

  it('refuses without a company, a company not seen, a customer of another company, a customer not seen, and the floor', async () => {
    expect((await no('sales', `/sales/customer-360/${A.p1}`, 400)).issues.map((issue: Json) => issue.path)).toContain('query/companyId')
    expect((await no('salesB', `/sales/customer-360/${A.p1}?companyId=${A.companyA}`, 400)).issues.map((issue: Json) => issue.path)).toContain('query/companyId')
    expect((await no('sales', `/sales/customer-360/${foreign}?companyId=${A.companyB}`, 400)).issues.map((issue: Json) => issue.path)).toContain('query/companyId')
    await no('salesB', `/sales/customer-360/${id('party:nobody')}?companyId=${A.companyB}`, 404)
    await no('floor', `/sales/customer-360/${A.p1}?companyId=${A.companyA}`, 403)
  })
})
