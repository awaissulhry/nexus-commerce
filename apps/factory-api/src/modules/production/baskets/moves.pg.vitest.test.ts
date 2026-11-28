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
 * owb-fl2 (S5 server A) — moves by hand, the second Done, undo and route edits, on the local stack with the app's real routes
 * (a throwaway PostgreSQL 17 database from the migrations: the runtime logins, row-level security and the G5 trigger are real)
 * and the factory-db seeds (plant A1 names workers; WO-0001 with its steps 10 cut / 20 sew / 30 QC / 40 pack and bundles 1-2;
 * bundle 2 has a standing report at 20 sew). Written, not run (Owner rule: checks at the end). Every name is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/production/baskets/moves`.
 *
 * Floor safety (PL-review § 4 "Scan", "Move back"): a move writes no scan, no earnings and no cost row; BACK needs its reason and
 * the team leader; the second Done writes a FORWARD move and no scan; a hold still refuses the REPORT after a move; another
 * site's basket is not found; an undo of an undo changes nothing; the last step is never skipped; NO_QUALITY_LEFT warns.
 */

let h: Harness
let app: FastifyInstance

const ns = 'basket-moves'
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
  cut: idOf('production:WO-0001:operation:10'),
  sew: idOf('production:WO-0001:operation:20'),
  qc: idOf('production:WO-0001:operation:30'),
  pack: idOf('production:WO-0001:operation:40'),
  phone: newId(),
  phoneSession: newId(),
  leadPhone: newId(),
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
const SESSIONS: Record<string, SessionContext> = {
  worker: floorAt(A.phone, A.operator, ['floor.work', 'production.scan', 'production.baskets.move']),
  lead: floorAt(A.leadPhone, A.lead, ['floor.work', 'floor.lead', 'production.scan', 'production.baskets.move', 'production.baskets.route']),
  otherSite: floorAt(A.otherSiteTablet, A.operator, ['floor.work', 'production.scan', 'production.baskets.move'], A.siteB1, A.companyB),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
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
const freshKey = () => `mv-${run}-${++keys}`
let cid = 0
const clientId = () => `evt-${run}-${String(++cid).padStart(4, '0')}`
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': freshKey() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const counts = async () =>
  (
    await admin<{ scans: number; earnings: number; costs: number }>(
      `SELECT (SELECT count(*)::int FROM "OperationScan" WHERE "workOrderId" = $1) AS scans,
              (SELECT count(*)::int FROM "EarningsEntry") AS earnings,
              (SELECT count(*)::int FROM "WorkOrderCostEntry" WHERE "workOrderId" = $1) AS costs`,
      [A.wo1],
    )
  )[0]!
const placeOf = async (bundleId: string) => (await ok('lead', 'GET', `/production/baskets/${bundleId}`)).place

beforeAll(async () => {
  h = await startHarness('basket-moves')
  await seedCore({ db: h.database, namespace: ns })
  await seedReasons({ db: h.database, namespace: ns })
  await seedProduct({ db: h.database, namespace: ns })
  await seedAndon({ db: h.database, namespace: ns })
  await seedNumbering({ db: h.database, namespace: ns })
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) =>
    applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }),
  )
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", mode, "personalWorkerId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, 'PHONE', $5, 'Operator phone', 'HANDHELD', 'ACTIVE', now())`, [A.phone, A.tenant, A.companyA, A.siteA1, A.operator])
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", mode, "personalWorkerId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, 'PHONE', $5, 'Leader phone', 'HANDHELD', 'ACTIVE', now())`, [A.leadPhone, A.tenant, A.companyA, A.siteA1, A.lead])
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", mode, name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, 'STATION', 'B1 tablet', 'TABLET', 'ACTIVE', now())`, [A.otherSiteTablet, A.tenant, A.companyB, A.siteB1])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('POST /production/baskets/move', () => {
  it('a move writes a BasketMove and NO scan, NO earnings, NO cost entry', async () => {
    const before = await counts()
    const answer = await ok('worker', 'POST', '/production/baskets/move', { bundleIds: [A.bundle1], toOperationId: A.sew, kind: 'TAKEN_HERE', clientEventId: clientId() }, 201)
    expect(answer).toMatchObject({ moved: 1, stay: 0, baskets: [{ bundleId: A.bundle1, to: A.sew }] })
    expect(await counts()).toEqual(before)
    expect(await admin('SELECT kind::text AS kind, "toOperationId"::text AS "to", "groupId"::text AS "group" FROM "BasketMove" WHERE "bundleId" = $1 ORDER BY "serverTime" DESC LIMIT 1', [A.bundle1])).toEqual([{ kind: 'TAKEN_HERE', to: A.sew, group: answer.groupId }])
    expect(await placeOf(A.bundle1)).toMatchObject({ operationId: A.sew, how: 'MOVE' })
    // Undo: the mover's own newest move; the basket is back where it was.
    const undone = await ok('worker', 'POST', `/production/baskets/moves/${answer.groupId}/undo`, { clientEventId: clientId() }, 201)
    expect(undone).toMatchObject({ undone: 1, stay: 0 })
    expect(await placeOf(A.bundle1)).toMatchObject({ how: 'SCANS' })
    // An undo of an undo changes nothing (the undo group holds only UNDO rows: nothing there to undo).
    expect((await call('worker', 'POST', `/production/baskets/moves/${undone.groupId}/undo`, { clientEventId: clientId() })).statusCode).toBe(404)
    // The same undo again: the move is undone already, it stays.
    expect(await ok('worker', 'POST', `/production/baskets/moves/${answer.groupId}/undo`, { clientEventId: clientId() }, 201)).toMatchObject({ undone: 0, stay: 1 })
  })

  it('BACK needs its reason (400) and the team leader (403); the leader moves back with a reason', async () => {
    expect((await call('lead', 'POST', '/production/baskets/move', { bundleIds: [A.bundle2], toOperationId: A.cut, kind: 'BACK', clientEventId: clientId() })).statusCode).toBe(400)
    expect((await call('worker', 'POST', '/production/baskets/move', { bundleIds: [A.bundle2], toOperationId: A.cut, kind: 'BACK', reason: 'REDO', clientEventId: clientId() })).statusCode).toBe(403)
  })

  it('a basket whose route lacks the step stays, with its words; 51 baskets are refused (400); another site\'s basket is not found (404)', async () => {
    const answer = await ok('worker', 'POST', '/production/baskets/move', { bundleIds: [A.bundle1], toOperationId: newId(), kind: 'FORWARD', clientEventId: clientId() }, 201)
    expect(answer).toMatchObject({ moved: 0, stay: 1 })
    expect(answer.stayWords[0]).toMatch(/not on its route/)
    expect((await call('worker', 'POST', '/production/baskets/move', { bundleIds: Array.from({ length: 51 }, () => newId()), toOperationId: A.sew, kind: 'FORWARD', clientEventId: clientId() })).statusCode).toBe(400)
    expect((await call('otherSite', 'POST', '/production/baskets/move', { bundleIds: [A.bundle1], toOperationId: A.sew, kind: 'FORWARD', clientEventId: clientId() })).statusCode).toBe(404)
    // Ready to ship before the last step is reported: it stays ("pack it first").
    const early = await ok('worker', 'POST', '/production/baskets/move', { bundleIds: [A.bundle1], toOperationId: null, kind: 'FORWARD', clientEventId: clientId() }, 201)
    expect(early.stayWords[0]).toMatch(/pack it first/)
  })
})

describe('the second Done (POST /production/scans after a move back)', () => {
  it('Done at a step reported before the move: a FORWARD move, no second scan, no pay (200 moved, the next step)', async () => {
    // Bundle 2 stands reported at 20 sew (seed/production.ts); "Take it here" puts it back there by hand.
    await ok('worker', 'POST', '/production/baskets/move', { bundleIds: [A.bundle2], toOperationId: A.sew, kind: 'TAKEN_HERE', clientEventId: clientId() }, 201)
    const before = await counts()
    const code = (await admin<{ code: string }>('SELECT code FROM "Bundle" WHERE id = $1', [A.bundle2]))[0]!.code
    const done = await ok('worker', 'POST', '/production/scans', { code, good: 1, clientScanId: clientId() }, 201)
    expect(done).toMatchObject({ scan: null, moved: true, to: A.qc })
    expect(await counts()).toEqual(before)
    expect(await placeOf(A.bundle2)).toMatchObject({ operationId: A.qc, how: 'MOVE' })
  })

  it('a hold still refuses the REPORT after a move (pick B: the scan rule untouched)', async () => {
    await ok('worker', 'POST', '/production/baskets/move', { bundleIds: [A.bundle1], toOperationId: A.sew, kind: 'TAKEN_HERE', clientEventId: clientId() }, 201)
    await replica(`UPDATE "WorkOrder" SET "heldFromStatus" = status, status = 'ON_HOLD', "holdReason" = 'Made-up: leather check', "heldAt" = now() WHERE id = $1`, [A.wo1])
    try {
      const code = (await admin<{ code: string }>('SELECT code FROM "Bundle" WHERE id = $1', [A.bundle1]))[0]!.code
      expect((await call('worker', 'POST', '/production/scans', { code, good: 1, clientScanId: clientId() })).statusCode).toBe(409)
      // And a held basket stays where it is when moved.
      const stay = await ok('worker', 'POST', '/production/baskets/move', { bundleIds: [A.bundle1], toOperationId: A.qc, kind: 'FORWARD', clientEventId: clientId() }, 201)
      expect(stay).toMatchObject({ moved: 0, stay: 1 })
    } finally {
      await replica(`UPDATE "WorkOrder" SET status = "heldFromStatus", "heldFromStatus" = NULL, "holdReason" = NULL, "heldAt" = NULL WHERE id = $1`, [A.wo1])
    }
  })
})

describe('POST /production/baskets/route and /route/normal', () => {
  it('the last step stays; skipping Quality warns NO_QUALITY_LEFT; back to normal drops the edits; a worker may not (403)', async () => {
    expect((await call('worker', 'POST', '/production/baskets/route', { bundleIds: [A.bundle1], edits: [{ kind: 'SKIP', operationId: A.qc }], reason: 'NOT_NEEDED' })).statusCode).toBe(403)
    const last = await ok('lead', 'POST', '/production/baskets/route', { bundleIds: [A.bundle1], edits: [{ kind: 'SKIP', operationId: A.pack }], reason: 'NOT_NEEDED' })
    expect(last).toMatchObject({ changed: 0, stay: 1 })
    expect(last.stayWords[0]).toMatch(/the last step stays/)
    const skipped = await ok('lead', 'POST', '/production/baskets/route', { bundleIds: [A.bundle1], edits: [{ kind: 'SKIP', operationId: A.qc }], reason: 'CUSTOMER' })
    expect(skipped).toMatchObject({ changed: 1, warnings: ['NO_QUALITY_LEFT'] })
    const read = await ok('lead', 'GET', `/production/baskets/${A.bundle1}`)
    expect(read.route.own).toBe(true)
    expect(read.route.steps.find((step: Json) => step.operationId === A.qc).state).toBe('SKIPPED')
    expect(await ok('lead', 'POST', '/production/baskets/route/normal', { bundleIds: [A.bundle1] })).toMatchObject({ changed: 1 })
    expect((await ok('lead', 'GET', `/production/baskets/${A.bundle1}`)).route.own).toBe(false)
    // A route edit writes no scan either, and the database keeps every edit (append-only).
    expect((await admin('SELECT count(*)::int AS n FROM "BasketRouteEdit" WHERE "bundleId" = $1', [A.bundle1]))[0]!.n).toBe(2)
  })
})
