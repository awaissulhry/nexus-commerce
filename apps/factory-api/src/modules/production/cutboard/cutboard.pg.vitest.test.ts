import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * The cutting room board and the cutting and yield report (B-W2b-130; MES-163, MES-302) through the app's real routes on a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security is real), tenant A from EVERY seed:
 * the cutting seed's three cut orders at plant A1 (SEED-CO-0001 fabric cutting, lay 1 cut on 2026-11-20 with its fabric
 * confirmed and lay 2 spread; SEED-CO-0002 leather cut that day, one line reconciled; SEED-CO-0003 planned), the production
 * seed's cut log (a hide of SEED-LOT-LEA-01 cut for SEED-WO-0001 on 2026-10-30). Two due dates are set here (made up). In order:
 * the board of that day (tiles, cut against plan, fabric, the open list, nothing per person or money), the leather of the cut
 * log's day, the report over the period (cut vs ordered with the leather order waiting, fabric per material, yield per lot and
 * supplier), the work order's shade lots, and the refusals (no permission, another company's site, a period the wrong way round).
 * Run with `node scripts/factory/run-pg-tests.mjs modules/production/cutboard`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'cutboard-a'
let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const id = (key: string) => seedUuid(NS, key)
const A = { tenant: id('tenant'), companyA: id('company:A'), companyB: id('company:B'), siteA1: id('site:A1') }

const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  manager: office([grant(['production.cutting.view', 'production.reports.view', 'workorders.view'])]),
  reports: office([grant(['production.reports.view'])]),
  orders: office([grant(['workorders.view'])]),
  companyB: office([grant(['production.cutting.view', 'production.reports.view', 'workorders.view'], { companies: [A.companyB] })]),
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
async function ok(session: string, url: string): Promise<Json> {
  const response = await call(session, url)
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as Json
}
const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : [])
const MONEY = /cost|price|margin|amount|wage|valuation/i
const PERSON = /worker|operator|cutBy|createdBy|actor|user/i

const DAY = '2026-11-20'

beforeAll(async () => {
  db = await migratedDatabase('production_cutboard')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: NS })
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  // Made-up due dates: the fabric order due on the day, the planned leather order the day before (late).
  await admin(`UPDATE "CutOrder" SET "dueDate" = $2 WHERE "tenantId" = $1 AND number = 'SEED-CO-0001'`, [A.tenant, DAY])
  await admin(`UPDATE "CutOrder" SET "dueDate" = $2 WHERE "tenantId" = $1 AND number = 'SEED-CO-0003'`, [A.tenant, '2026-11-19'])
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('the cutting room board (MES-163)', () => {
  it('says the day at the site: waiting, cutting, cut against plan, the fabric used and the open cut orders', async () => {
    const board = await ok('manager', `/production/cutboard?siteId=${A.siteA1}&date=${DAY}`)
    expect(board.site.id).toBe(A.siteA1)
    expect(board.day).toBe(DAY)
    expect(board.tiles).toEqual({ planned: 1, released: 0, inProgress: 1, late: 1 })
    // Lay 2 is spread at the table; lay 1's fabric is confirmed.
    expect(board.lays).toEqual({ atTable: 1, waitingFabric: 0 })
    // Lay 1: 6 plies × six lines of ratio 1 = 36 garments; the leather order's 3 garments ended with its ticket, ahead of no due date.
    // The plan: the fabric order (7 garments, due today) and the late planned leather order (1).
    expect(board.plan).toEqual({ planned: 8, cut: 36, cutThatDay: 39, pct: 450 })
    expect(board.cut).toEqual({ cutOrders: 1, lays: 1, leatherPieces: 0 })
    expect(board.fabric).toEqual({ lays: 1, confirmed: 1, estimated: '14.4000', used: '15.0000', differencePct: '4.2' })
    expect(board.hides).toBe(0)
    expect(board.leather).toEqual([])
    expect(board.orders.map((row: Json) => [row.number, row.status, row.late, row.lays])).toEqual([
      ['SEED-CO-0001', 'IN_PROGRESS', false, { cut: 1, of: 3 }],
      ['SEED-CO-0003', 'PLANNED', true, null],
    ])
    expect(board.orders[0].garments).toBe(7)
    expect(board.orders[0].workOrders).toHaveLength(1)
    expect(board.more).toBe(0)
    expect(keysOf(board).filter((key) => MONEY.test(key) || PERSON.test(key))).toEqual([])
  })

  it('reads the hides cut on a day from the cut log: per area unit, with the yield, never who cut them', async () => {
    const board = await ok('manager', `/production/cutboard?siteId=${A.siteA1}&date=2026-10-30`)
    expect(board.hides).toBe(1)
    expect(board.cut.leatherPieces).toBe(6)
    expect(board.leather).toHaveLength(1)
    expect(board.leather[0]).toMatchObject({ uom: 'FT2', hides: 1, used: '20.0000' })
    expect(keysOf(board).filter((key) => PERSON.test(key))).toEqual([])
  })

  it('opens on the first site by default and today', async () => {
    const board = await ok('manager', '/production/cutboard')
    expect(board.sites.length).toBeGreaterThan(0)
    expect(board.day).toBe(board.today)
  })

  it('is refused without production.cutting.view, and at another company’s site', async () => {
    expect((await call('orders', '/production/cutboard')).statusCode).toBe(403)
    expect((await call('reports', '/production/cutboard')).statusCode).toBe(403)
    expect((await call('companyB', `/production/cutboard?siteId=${A.siteA1}`)).statusCode).toBe(404)
  })
})

describe('the cutting and yield report (MES-302)', () => {
  it('says cut vs ordered, the fabric used per material and the leather yield per lot and supplier', async () => {
    const report = await ok('reports', `/production/cutboard/yield?siteId=${A.siteA1}&from=2026-10-01&to=2026-11-30`)
    expect([report.from, report.to]).toEqual(['2026-10-01', '2026-11-30'])
    // The leather order is cut, one of its two lines reconciled: it waits, never guessed.
    expect(report.cut).toMatchObject({ orders: 0, ordered: 0, cut: 0, waiting: 1 })
    expect(report.orders.map((row: Json) => [row.number, row.kind, row.ordered, row.cut, row.reconciled])).toEqual([['SEED-CO-0002', 'LEATHER', 3, null, false]])
    expect(report.fabric).toMatchObject({ lays: 1, waiting: 0, estimated: '14.4000', used: '15.0000', differencePct: '4.2' })
    expect(report.fabric.materials).toHaveLength(1)
    expect(report.leather.lots).toHaveLength(1)
    expect(report.leather.lots[0]).toMatchObject({ uom: 'FT2', hides: 1, used: '20.0000' })
    expect(report.leather.suppliers).toHaveLength(1)
    expect(report.leather.suppliers[0]).toMatchObject({ lots: 1, hides: 1 })
    expect(report.leather.materials).toHaveLength(1)
    expect(keysOf(report).filter((key) => MONEY.test(key) || PERSON.test(key))).toEqual([])
  })

  it('a reconciled fabric order counts its frozen figures', async () => {
    const [order] = await admin<{ id: string }>(`SELECT id FROM "CutOrder" WHERE "tenantId" = $1 AND number = 'SEED-CO-0002'`, [A.tenant])
    const lines = await admin<{ id: string; quantity: number }>(`SELECT id, quantity FROM "CutOrderLine" WHERE "cutOrderId" = $1 ORDER BY seq`, [order!.id])
    const done = await admin<{ cutOrderLineId: string }>(`SELECT "cutOrderLineId" FROM "CutReconciliation" WHERE "cutOrderId" = $1`, [order!.id])
    // Reconcile the second line as the office would (made up: one garment short, with its reason), by SQL on this throwaway database.
    const open = lines.find((line) => !done.some((row) => row.cutOrderLineId === line.id))!
    await admin(
      `INSERT INTO "CutReconciliation" (id, "tenantId", "siteId", "cutOrderId", "cutOrderLineId", key, "orderedQuantity", "cutQuantity", "varianceReasonCode", "reconciledAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'MISCUT', now())`,
      [newId(), A.tenant, A.siteA1, order!.id, open.id, `reconciliation:${open.id}`, open.quantity, open.quantity - 1],
    )
    const report = await ok('manager', `/production/cutboard/yield?siteId=${A.siteA1}&from=2026-10-01&to=2026-11-30`)
    expect(report.cut).toMatchObject({ orders: 1, ordered: 3, cut: 2, difference: -1, pct: 67, waiting: 0, variances: 1 })
  })

  it('reads 30 days back from today by default; refuses a period the wrong way round, too long, or without the right', async () => {
    const report = await ok('reports', '/production/cutboard/yield')
    expect(report.to).toBe(report.today)
    expect((await call('reports', `/production/cutboard/yield?from=2026-11-30&to=2026-11-01`)).statusCode).toBe(400)
    expect((await call('reports', `/production/cutboard/yield?from=2024-01-01&to=2026-11-01`)).statusCode).toBe(400)
    expect((await call('orders', '/production/cutboard/yield')).statusCode).toBe(403)
    expect((await call('companyB', `/production/cutboard/yield?siteId=${A.siteA1}`)).statusCode).toBe(404)
  })
})

describe('one shade lot per order on the work order (SCM-206)', () => {
  it('names the shade lots the work order’s leather holds, has reserved and has cut, under the site’s rule', async () => {
    const [workOrder] = await admin<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = 'SEED-WO-0001'`, [A.tenant])
    const answer = await ok('orders', `/production/cutboard/work-orders/${workOrder!.id}/leather`)
    expect(answer.rule).toBe('ORDER')
    const leather = answer.materials.find((material: Json) => material.hides.cut > 0)
    expect(leather).toBeTruthy()
    expect(leather.verdict).toBe('ONE')
    expect(leather.breaksRule).toBe(false)
    expect(leather.lots).toHaveLength(1)
    expect(leather.lots[0].cut).toBe(1)
    expect(keysOf(answer).filter((key) => MONEY.test(key) || PERSON.test(key))).toEqual([])
  })

  it('is refused without workorders.view, and for another company’s work order', async () => {
    const [workOrder] = await admin<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = 'SEED-WO-0001'`, [A.tenant])
    expect((await call('reports', `/production/cutboard/work-orders/${workOrder!.id}/leather`)).statusCode).toBe(403)
    expect((await call('companyB', `/production/cutboard/work-orders/${workOrder!.id}/leather`)).statusCode).toBe(404)
    expect((await call('orders', `/production/cutboard/work-orders/${newId()}/leather`)).statusCode).toBe(404)
  })
})
