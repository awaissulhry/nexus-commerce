import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAndon } from '../../../../../../packages/factory-db/seed/andon'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduct } from '../../../../../../packages/factory-db/seed/product'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * owb-fl1 (S5 server A) — the basket read, the home, the department pick and the quality photo's refusals, on the local stack
 * with the app's real routes (a throwaway PostgreSQL 17 database from the migrations: the runtime logins, row-level security
 * and the guards are real) and the factory-db seeds up to the line's calls (plant A1 names workers; WO-0001 with its bundles,
 * its steps 10 cut / 20 sew / 30 QC / 40 pack; the nine departments). Written, not run (Owner rule: checks at the end). Every
 * name is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/production/baskets/baskets`.
 *
 * Walls: a floor read carries no customer name, no price key and — at a STATION site — no worker name; another site's basket is
 * not found (404); the office without production.bundles.view is refused (403); a held work order answers `hold` with
 * `can.start` false; a restricted order answers `restricted` with no picture and no notes. Contract: every field of § 3.
 */

let h: Harness
let app: FastifyInstance

const ns = 'basket-read'
const idOf = (key: string) => seedUuid(ns, key)
const A = {
  tenant: idOf('tenant'),
  companyA: idOf('company:A'),
  companyB: idOf('company:B'),
  siteA1: idOf('site:A1'),
  siteB1: idOf('site:B1'),
  operator: idOf('worker:A1:operator'),
  lead: idOf('worker:A1:lead'),
  wo1: idOf('production:work-order:WO-0001'),
  bundle1: idOf('production:bundle:WO-0001:1'),
  bundle2: idOf('production:bundle:WO-0001:2'),
  sew: idOf('production:WO-0001:operation:20'),
  phone: newId(),
  phoneSession: newId(),
  leadTablet: newId(),
  otherSiteTablet: newId(),
}

const floorAt = (deviceId: string, actorId: string, permissions: Permission[], siteId = A.siteA1, companyId = A.companyA): SessionContext => ({
  audience: 'floor',
  tenantId: A.tenant,
  actorId,
  siteId,
  deviceId,
  grants: [{ permissions, companies: [companyId], sites: [siteId], parties: 'all' }],
})
const office = (permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: idOf('actor'), grants: [{ permissions, companies: 'all', sites: 'all', parties: 'all' }] }) as unknown as SessionContext
const SESSIONS: Record<string, SessionContext> = {
  worker: floorAt(A.phone, A.operator, ['floor.work', 'production.scan', 'production.baskets.move']),
  lead: floorAt(A.leadTablet, A.lead, ['floor.work', 'floor.lead', 'production.scan', 'production.baskets.move', 'production.baskets.route']),
  otherSite: floorAt(A.otherSiteTablet, A.operator, ['floor.work', 'production.scan'], A.siteB1, A.companyB),
  manager: office(['production.bundles.view', 'production.baskets.move', 'production.baskets.route']),
  clerk: office(['workorders.view']),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
/** The owner, with every trigger off for one statement (a fact only time or another module reaches). */
async function replica(sql: string, values: unknown[] = []): Promise<void> {
  await h.db.admin.query('BEGIN')
  try {
    await h.db.admin.query("SET LOCAL session_replication_role = 'replica'")
    await h.db.admin.query(sql, values)
    await h.db.admin.query('COMMIT')
  } catch (error) {
    await h.db.admin.query('ROLLBACK')
    throw error
  }
}
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `bsk-${run}-${++keys}`
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': freshKey() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const codeOf = async (bundleId: string): Promise<string> => (await admin<{ code: string }>('SELECT code FROM "Bundle" WHERE id = $1', [bundleId]))[0]!.code

/** Every field of the § 3 sketch (and the fields the web builders added), top level and inside `basket`. */
const TOP_FIELDS = ['scanned', 'refusal', 'basket', 'picture', 'route', 'place', 'work', 'here', 'hold', 'changedDesign', 'flags', 'restricted', 'quality', 'next', 'notes', 'history', 'designPageHref', 'can'].sort()
const BASKET_FIELDS = ['id', 'code', 'quantity', 'smallParts', 'workOrderId', 'workOrderNumber', 'salesOrderId', 'customerCode', 'due', 'words', 'team', 'rush'].sort()
const PRICE_KEY = /"(price|unitPrice|amount|amountMinor|cost|margin|total)[A-Za-z]*"\s*:/i

beforeAll(async () => {
  h = await startHarness('basket-read')
  await seedCore({ db: h.database, namespace: ns })
  await seedReasons({ db: h.database, namespace: ns })
  await seedProduct({ db: h.database, namespace: ns })
  await seedAndon({ db: h.database, namespace: ns })
  await seedNumbering({ db: h.database, namespace: ns })
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) =>
    applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }),
  )
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", mode, "personalWorkerId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, 'PHONE', $5, 'Operator phone', 'HANDHELD', 'ACTIVE', now())`, [A.phone, A.tenant, A.companyA, A.siteA1, A.operator])
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", mode, name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, 'STATION', 'Leader tablet', 'TABLET', 'ACTIVE', now())`, [A.leadTablet, A.tenant, A.companyA, A.siteA1])
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", mode, name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, 'STATION', 'B1 tablet', 'TABLET', 'ACTIVE', now())`, [A.otherSiteTablet, A.tenant, A.companyB, A.siteB1])
  await admin(
    `INSERT INTO "FloorSession" (id, "tenantId", "siteId", "deviceId", "workerId", "tokenHash", "startedAt", "lastSeenAt", "idleExpiresAt", "endsAt") VALUES ($1, $2, $3, $4, $5, $6, now(), now(), now() + interval '1 hour', now() + interval '8 hours')`,
    [A.phoneSession, A.tenant, A.siteA1, A.phone, A.operator, randomBytes(32).toString('hex')],
  )
  await admin('UPDATE "Device" SET "currentSessionId" = $2, "inUseSince" = now() WHERE id = $1', [A.phone, A.phoneSession])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('GET /production/baskets/:bundleId — the contract', () => {
  it('a worker reads a basket by its ticket code; every field of § 3 is there; with no move and no edit the place is today\'s', async () => {
    const code = await codeOf(A.bundle1)
    const read = await ok('worker', 'GET', `/production/baskets/${encodeURIComponent(code)}?via=scan`)
    expect(Object.keys(read).sort()).toEqual(TOP_FIELDS)
    expect(Object.keys(read.basket).sort()).toEqual(BASKET_FIELDS)
    expect(read.scanned).toBe(true)
    expect(read.basket).toMatchObject({ id: A.bundle1, code, workOrderId: A.wo1 })
    expect(read.route).toMatchObject({ own: false })
    expect(read.route.steps.map((step: Json) => step.state)).toContain('HERE')
    expect(read.place).toMatchObject({ how: 'SCANS' })
    // Each step carries its department as the chips draw it.
    for (const step of read.route.steps) if (step.department) expect(Object.keys(step.department).sort()).toEqual(['icon', 'id', 'name', 'nameI18n', 'number', 'shortName', 'tone'])
    expect(read.can).toEqual(expect.objectContaining({ give: false, flag: false, late: false }))
    expect(read.designPageHref).toBe('/floor/instructions')
  })

  it('by its id too (a board or a list links it); `scanned` false without ?via=scan', async () => {
    const read = await ok('worker', 'GET', `/production/baskets/${A.bundle1}`)
    expect(read.basket.id).toBe(A.bundle1)
    expect(read.scanned).toBe(false)
  })

  it('the team leader may give, flag and say late; the office reads with production.bundles.view, no notes and no design page', async () => {
    const lead = await ok('lead', 'GET', `/production/baskets/${A.bundle1}`)
    expect(lead.can).toEqual(expect.objectContaining({ give: true, flag: true, late: true, route: true }))
    const manager = await ok('manager', 'GET', `/production/baskets/${A.bundle1}`)
    expect(manager).toMatchObject({ notes: [], designPageHref: null, here: { departmentId: null } })
    expect(manager.can).toEqual(expect.objectContaining({ start: false, done: false, give: false }))
  })
})

describe('GET /production/baskets/:bundleId — the walls', () => {
  it('a floor read carries no customer name and no price key', async () => {
    const body = (await call('worker', 'GET', `/production/baskets/${A.bundle1}`)).body
    for (const name of ['Seed Customer One', 'Seed Racing', 'S.r.l.']) expect(body).not.toContain(name)
    expect(body).not.toMatch(PRICE_KEY)
  })

  it('no worker name anywhere; at a STATION site the history names a department, never "You"', async () => {
    const before = await ok('worker', 'GET', `/production/baskets/${A.bundle1}`)
    expect(JSON.stringify(before)).not.toContain('Seed Worker')
    await replica('UPDATE "ProductionSettings" SET "scanSubject" = \'STATION\' WHERE id = $1', [A.siteA1])
    try {
      const read = await ok('worker', 'GET', `/production/baskets/${A.bundle1}`)
      expect(JSON.stringify(read)).not.toContain('Seed Worker')
      for (const line of read.history) expect(line.who.face).not.toBe('YOU')
    } finally {
      await replica('UPDATE "ProductionSettings" SET "scanSubject" = \'WORKER\' WHERE id = $1', [A.siteA1])
    }
  })

  it('another site\'s basket is not found (404); an unknown code too', async () => {
    expect((await call('otherSite', 'GET', `/production/baskets/${A.bundle1}`)).statusCode).toBe(404)
    expect((await call('otherSite', 'GET', `/production/baskets/${encodeURIComponent(await codeOf(A.bundle1))}`)).statusCode).toBe(404)
    expect((await call('worker', 'GET', '/production/baskets/B-NOT-THERE')).statusCode).toBe(404)
  })

  it('the office without production.bundles.view is refused (403)', async () => {
    expect((await call('clerk', 'GET', `/production/baskets/${A.bundle1}`)).statusCode).toBe(403)
  })

  it('a held work order: `hold` in today\'s words and `can.start` false (pick B; the scan rule untouched)', async () => {
    await replica(`UPDATE "WorkOrder" SET "heldFromStatus" = status, status = 'ON_HOLD', "holdReason" = 'Made-up: leather check', "heldAt" = now() WHERE id = $1`, [A.wo1])
    try {
      const read = await ok('worker', 'GET', `/production/baskets/${A.bundle1}`)
      expect(read.hold).toMatchObject({ kind: 'HOLD' })
      expect(read.hold.words).toMatch(/not scanned/)
      expect(read.can.start).toBe(false)
      expect(read.can.done).toBe(false)
    } finally {
      await replica(`UPDATE "WorkOrder" SET status = "heldFromStatus", "heldFromStatus" = NULL, "holdReason" = NULL, "heldAt" = NULL WHERE id = $1`, [A.wo1])
    }
  })

  it('a restricted order: `restricted` for a worker not given the basket, no picture, no notes; the team leader reads it', async () => {
    const [order] = await admin<{ id: string }>(
      `SELECT l."orderId"::text AS id FROM "Bundle" b JOIN "WorkOrderSize" c ON c.id = b."workOrderSizeId" JOIN "SalesOrderLine" l ON l.id = c."salesOrderLineId" WHERE b.id = $1`,
      [A.bundle1],
    )
    expect(order, 'WO-0001\'s cell names its order line (seed/production.ts)').toBeDefined()
    await replica('UPDATE "SalesOrder" SET "floorRestricted" = true, "floorRestrictedAt" = now() WHERE id = $1', [order!.id])
    try {
      const read = await ok('worker', 'GET', `/production/baskets/${A.bundle1}`)
      expect(read).toMatchObject({ restricted: 'RESTRICTED', picture: null, notes: [], designPageHref: null })
      expect(read.can).toEqual(expect.objectContaining({ start: false, done: false, moveForward: false }))
      expect((await ok('lead', 'GET', `/production/baskets/${A.bundle1}`)).restricted).toBeNull()
    } finally {
      await replica('UPDATE "SalesOrder" SET "floorRestricted" = false, "floorRestrictedAt" = NULL WHERE id = $1', [order!.id])
    }
  })
})

describe('POST /floor/session/department and the home', () => {
  it('Stitching: two sewing stations at A1 → choose; the pick with stationId takes it; the session keeps both', async () => {
    const [stitching] = await admin<{ id: string }>('SELECT id::text AS id FROM "Department" WHERE "tenantId" = $1 AND number = 4', [A.tenant])
    expect(stitching).toBeDefined()
    const first = await ok('worker', 'POST', '/floor/session/department', { departmentId: stitching!.id })
    expect(first.department).toMatchObject({ id: stitching!.id, number: 4 })
    expect(first.station).toBeNull()
    expect(first.choose.length).toBeGreaterThanOrEqual(2)
    const picked = await ok('worker', 'POST', '/floor/session/department', { departmentId: stitching!.id, stationId: first.choose[0].id })
    expect(picked.station).toEqual(first.choose[0])
    expect(picked.choose).toEqual([])
    expect(await admin('SELECT "departmentId"::text AS d, "stationId"::text AS s FROM "FloorSession" WHERE id = $1', [A.phoneSession])).toEqual([{ d: stitching!.id, s: first.choose[0].id }])
    // A station of another department is refused (400); an unknown department is not found (404).
    const [cutting] = await admin<{ id: string }>('SELECT id::text AS id FROM "Department" WHERE "tenantId" = $1 AND number = 2', [A.tenant])
    expect((await call('worker', 'POST', '/floor/session/department', { departmentId: cutting!.id, stationId: first.choose[0].id })).statusCode).toBe(400)
    expect((await call('worker', 'POST', '/floor/session/department', { departmentId: newId() })).statusCode).toBe(404)
  })

  it('with the department picked, the basket read says how it stands to it, and the home lists In this department / Coming next', async () => {
    const read = await ok('worker', 'GET', `/production/baskets/${A.bundle1}`)
    expect(read.here.departmentId).not.toBeNull()
    const home = await ok('worker', 'GET', '/production/baskets/home')
    expect(home.department).toMatchObject({ number: 4 })
    for (const row of [...home.here, ...home.comingNext]) {
      expect(Object.keys(row).sort()).toEqual(['bundleId', 'code', 'customerCode', 'flags', 'picture', 'state', 'step'])
      expect(JSON.stringify(row)).not.toMatch(/Seed Customer One|Seed Racing/)
    }
    // The office has no home.
    expect((await call('manager', 'GET', '/production/baskets/home')).statusCode).toBe(403)
  })
})

describe('the quality step photo — refusals', () => {
  it('an operation that is not the work order\'s is refused (409); another site\'s basket is not found (404)', async () => {
    const announce = { workOrderOperationId: newId(), originalName: 'front.jpg', contentType: 'image/jpeg', sizeBytes: 1000, sha256: 'a'.repeat(64) }
    expect((await call('worker', 'POST', `/production/baskets/${A.bundle1}/checklist/FRONT/photo`, announce)).statusCode).toBe(409)
    expect((await call('otherSite', 'POST', `/production/baskets/${A.bundle1}/checklist/FRONT/photo`, { ...announce, workOrderOperationId: A.sew })).statusCode).toBe(404)
    // Not a picture: refused by the contract (400).
    expect((await call('worker', 'POST', `/production/baskets/${A.bundle1}/checklist/FRONT/photo`, { ...announce, workOrderOperationId: A.sew, contentType: 'audio/webm' })).statusCode).toBe(400)
  })
})
