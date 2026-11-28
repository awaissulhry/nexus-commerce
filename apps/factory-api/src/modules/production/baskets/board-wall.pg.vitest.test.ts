import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAndon } from '../../../../../../packages/factory-db/seed/andon'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * owb-fl4 (S5 server B) — the walls of the Baskets board, the chains and From the floor, on the local stack with the app's real
 * routes (a throwaway PostgreSQL 17 database from the migrations: the runtime logins, row-level security and every guard are
 * real) and the factory-db seeds up to the line's signals (plant A1, WO-0001 of customer P1 with its bundles, line L1). Written,
 * not run (Owner rule: checks at the end). Every name is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/production/baskets/board-wall`.
 *
 * Walls: a person limited to another customer never sees P1's baskets (nor their order's From the floor, nor its late answer);
 * the floor board carries no customer name and no price key; a STATION site's floor board names no worker; "+12" writes exactly
 * one REPORT and the same earnings rows a scan writes.
 */

let h: Harness
let app: FastifyInstance

const ns = 'board-wall'
const idOf = (key: string) => seedUuid(ns, key)
const A = {
  tenant: idOf('tenant'),
  companyA: idOf('company:A'),
  siteA1: idOf('site:A1'),
  lineL1: idOf('site:A1:line:L1'),
  p1: idOf('party:P1'),
  p2: idOf('party:P2'),
  operator: idOf('worker:A1:operator'),
  lead: idOf('worker:A1:lead'),
  wo1: idOf('production:work-order:WO-0001'),
  bundle1: idOf('production:bundle:WO-0001:1'),
  bundle2: idOf('production:bundle:WO-0001:2'),
  phone: newId(),
}

const office = (permissions: Permission[], parties: Grant['parties'] = 'all'): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [{ permissions, companies: 'all', sites: 'all', parties }] })
const floorAt = (deviceId: string, actorId: string, permissions: Permission[]): SessionContext => ({
  audience: 'floor',
  tenantId: A.tenant,
  actorId,
  siteId: A.siteA1,
  deviceId,
  grants: [{ permissions, companies: [A.companyA], sites: [A.siteA1], parties: 'all' }],
})
const SESSIONS: Record<string, SessionContext> = {
  everyCustomer: office(['workorders.view', 'orders.manage']),
  onlyP1: office(['workorders.view', 'orders.manage'], [A.p1]),
  onlyP2: office(['workorders.view', 'orders.manage'], [A.p2]),
  lead: floorAt(A.phone, A.lead, ['floor.work', 'floor.lead', 'production.scan']),
  worker: floorAt(A.phone, A.operator, ['floor.work', 'production.scan']),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `wall-${run}-${++keys}`
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': freshKey() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []
const cardsOf = (board: Json): Json[] => [...board.columns.flatMap((column: Json) => column.baskets), ...board.readyToShip, ...board.elsewhere]
const PRICE_KEYS = /price|amount|cost|money|currency|total$/i

beforeAll(async () => {
  h = await startHarness('board-wall')
  await seedCore({ db: h.database, namespace: ns })
  await seedReasons({ db: h.database, namespace: ns })
  await seedAndon({ db: h.database, namespace: ns })
  await seedNumbering({ db: h.database, namespace: ns })
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) =>
    applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }),
  )
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", mode, name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, 'STATION', 'Leader tablet', 'TABLET', 'ACTIVE', now())`, [A.phone, A.tenant, A.companyA, A.siteA1])
  // WO-0001 runs on line L1 (its chain).
  await admin('UPDATE "WorkOrder" SET "lineId" = $2 WHERE id = $1', [A.wo1, A.lineL1])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the brand wall on the office board (workorders.view)', () => {
  it('a person limited to P1 sees P1’s baskets with the customer’s name; one limited to P2 sees none of them', async () => {
    const p1 = await ok('onlyP1', 'GET', '/production/baskets/board')
    const ours = cardsOf(p1).filter((card) => card.bundleId === A.bundle1)
    expect(ours).toHaveLength(1)
    expect(ours[0]!.customer.name).toEqual(expect.any(String))
    const p2 = await ok('onlyP2', 'GET', '/production/baskets/board')
    expect(cardsOf(p2).map((card) => card.bundleId)).not.toContain(A.bundle1)
    expect(cardsOf(p2).map((card) => card.bundleId)).not.toContain(A.bundle2)
  })

  it('From the floor and the late answer of P1’s order are not found for a person limited to P2', async () => {
    const order = (await admin<{ orderId: string }>('SELECT l."orderId" FROM "WorkOrderSize" s JOIN "SalesOrderLine" l ON l.id = s."salesOrderLineId" WHERE s."workOrderId" = $1 LIMIT 1', [A.wo1]))[0]
    if (order) {
      expect((await call('onlyP2', 'GET', `/production/baskets/from-the-floor?salesOrderId=${order.orderId}`)).statusCode).toBe(404)
      expect((await call('onlyP1', 'GET', `/production/baskets/from-the-floor?salesOrderId=${order.orderId}`)).statusCode).toBe(200)
    }
    const late = await ok('lead', 'POST', '/production/baskets/late', { bundleIds: [A.bundle1], days: 2, reason: 'MATERIAL', clientEventId: `late-${run}-0001` }, 201)
    const lateId = late.warnings[0].id
    expect((await call('onlyP2', 'POST', `/production/baskets/late/${lateId}/answer`, { state: 'KEPT' })).statusCode).toBe(404)
    expect((await ok('onlyP1', 'POST', `/production/baskets/late/${lateId}/answer`, { state: 'KEPT' })).late.state).toBe('KEPT')
    expect((await call('onlyP1', 'POST', `/production/baskets/late/${lateId}/answer`, { state: 'CHANGED' })).statusCode).toBe(409)
  })
})

describe('the floor board (floor.lead)', () => {
  it('a worker has no Board (403); the leader’s whole-floor board carries the customer’s CODE, no name, no price key', async () => {
    expect((await call('worker', 'GET', '/production/baskets/board?scope=floor')).statusCode).toBe(403)
    const board = await ok('lead', 'GET', '/production/baskets/board?scope=floor')
    const cards = cardsOf(board)
    expect(cards.length).toBeGreaterThan(0)
    for (const card of cards) {
      expect(card.customer.name).toBeNull()
      expect(card.customerCode === null || typeof card.customerCode === 'string').toBe(true)
    }
    expect(keysOf(board).filter((key) => PRICE_KEYS.test(key))).toEqual([])
    expect(board.people).toBeNull()
  })

  it('a STATION site’s floor board names no worker', async () => {
    await admin('UPDATE "ProductionSettings" SET "scanSubject" = \'STATION\' WHERE id = $1', [A.siteA1])
    const board = await ok('lead', 'GET', '/production/baskets/board?scope=floor')
    expect(cardsOf(board).every((card) => card.worker === null)).toBe(true)
    await admin('UPDATE "ProductionSettings" SET "scanSubject" = \'WORKER\' WHERE id = $1', [A.siteA1])
  })
})

describe('"+12" on a chain (settle 10)', () => {
  it('writes exactly ONE REPORT of the cell’s next bundle and the same earnings rows a scan writes', async () => {
    const chain = await ok('lead', 'GET', `/production/chains/${A.lineL1}`)
    const step = chain.steps.find((entry: Json) => entry.workOrderId === A.wo1)
    const lot = chain.lots.find((entry: Json) => entry.workOrderId === A.wo1)
    expect(step && lot).toBeTruthy()
    const before = (await admin<{ n: number }>('SELECT count(*)::int AS n FROM "OperationScan" WHERE "workOrderOperationId" = $1 AND kind = \'REPORT\'', [step.operationId]))[0]!.n
    const clientEventId = `chain-${run}-0001`
    const reported = await call('lead', 'POST', '/production/chains/report', { lineId: A.lineL1, operationId: step.operationId, workOrderSizeId: lot.workOrderSizeId, clientEventId })
    if (reported.statusCode === 409) {
      // Nothing left at that step for that size: the words say so.
      expect(reported.json().error.issues?.[0]?.path).toBe('refusal/NOTHING_LEFT')
      return
    }
    expect(reported.statusCode, reported.body).toBe(201)
    const answer = reported.json()
    const after = (await admin<{ n: number }>('SELECT count(*)::int AS n FROM "OperationScan" WHERE "workOrderOperationId" = $1 AND kind = \'REPORT\'', [step.operationId]))[0]!.n
    expect(after).toBe(before + 1)
    const scan = (await admin('SELECT "bundleId", "goodQuantity", kind::text AS kind FROM "OperationScan" WHERE id = $1', [answer.scan.id]))[0]!
    expect(scan).toMatchObject({ bundleId: answer.bundle.id, goodQuantity: answer.bundle.quantity, kind: 'REPORT' })
    // A resent tap reports nothing again.
    const again = await ok('lead', 'POST', '/production/chains/report', { lineId: A.lineL1, operationId: step.operationId, workOrderSizeId: lot.workOrderSizeId, clientEventId })
    expect(again).toMatchObject({ replayed: true, scan: { id: answer.scan.id } })
    // The earnings of the chain's report are those of an ordinary scan (the same command wrote them).
    const viaChain = (await admin<{ n: number }>('SELECT count(*)::int AS n FROM "EarningsEntry" WHERE "operationScanId" = $1', [answer.scan.id]))[0]!.n
    const ordinary = await admin<{ id: string }>('SELECT s.id FROM "OperationScan" s WHERE s."workOrderId" = $1 AND s.kind = \'REPORT\' AND s.id <> $2 LIMIT 1', [A.wo1, answer.scan.id])
    if (ordinary[0]) {
      const viaScan = (await admin<{ n: number }>('SELECT count(*)::int AS n FROM "EarningsEntry" WHERE "operationScanId" = $1', [ordinary[0].id]))[0]!.n
      expect(viaChain).toBe(viaScan)
    }
  })
})
