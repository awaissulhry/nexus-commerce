import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCalendar } from '../../../../../../packages/factory-db/seed/calendar'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPlanningDepth } from '../../../../../../packages/factory-db/seed/planning-depth'
import { seed as seedQuality } from '../../../../../../packages/factory-db/seed/quality'
import { seed as seedSales } from '../../../../../../packages/factory-db/seed/sales'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * Promise dates (B-W2b-301; PLN-168, PLN-169, PLN-171, PLN-179) on the local stack with the app's real routes: a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security, grants and the
 * …_planning_depth_w2b_guards triggers on PromiseRecord are real), the factory-db seeds up to the planning depth (A1's
 * lanes and calendars, SEED-JKT-02 released with its BOM and routing, SEED-SO-0002 and its work orders, SEED-JKT-02 BLK 52
 * made to stock), the quality seed's certificate of SEED-JKT-02 and the sales seed's quotes. Here: 4 finished BLK 52
 * garments on hand, the certificate narrowed to sizes 50 and 52, a JKT-02 line on the DRAFT quote SEED-Q-0002. Every name
 * and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/planning/promise`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = 'promise-a'
const tenant = seedUuid(ns, 'tenant')
const A: Record<string, string> = {}

const VIEW: Permission[] = ['planning.promise.view']
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(permissions)] })
const SESSIONS: Record<string, SessionContext> = {
  planner: office([...VIEW, 'planning.promise.manage', 'planning.view', 'orders.view', 'quotes.view']),
  sales: office([...VIEW, 'quotes.view', 'quotes.manage', 'orders.view']),
  // Reads the plan, but not promise dates.
  viewer: office(['planning.view', 'orders.view', 'quotes.view']),
  // Promises at the site, but may not see the order.
  noOrders: office([...VIEW, 'planning.promise.manage']),
  // Reads promises and the order, records nothing.
  reader: office([...VIEW, 'orders.view']),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `promise-test-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, idempotencyKey?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, idempotencyKey?: string): Promise<Json> {
  const response = await call(session, method, url, payload, idempotencyKey)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const one = async (sql: string, values: unknown[] = []): Promise<string> => (await admin<{ id: string }>(sql, values))[0]!.id
let today = ''

beforeAll(async () => {
  db = await migratedDatabase('planning_promise')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedCalendar({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  await seedPlanningDepth({ db: database, namespace: ns })
  await seedQuality({ db: database, namespace: ns })
  await seedSales({ db: database, namespace: ns })
  A.site = await one(`SELECT id FROM "Site" WHERE code = 'A1'`)
  A.jkt02 = await one(`SELECT id FROM "Style" WHERE code = 'SEED-JKT-02'`)
  A.jkt01 = await one(`SELECT id FROM "Style" WHERE code = 'SEED-JKT-01'`)
  A.blk = await one(`SELECT id FROM "Colourway" WHERE "styleId" = $1 AND code = 'BLK'`, [A.jkt02])
  A.jkt01Blk = await one(`SELECT id FROM "Colourway" WHERE "styleId" = $1 AND code = 'BLK'`, [A.jkt01])
  A.fg = await one(`SELECT id FROM "Location" WHERE kind = 'FINISHED_GOODS' AND "siteId" = $1`, [A.site])
  A.blk52 = await one(`SELECT id FROM "Item" WHERE code = 'SEED-JKT-02-BLK-52'`)
  A.so2 = await one(`SELECT id FROM "SalesOrder" WHERE number = 'SEED-SO-0002'`)
  A.so2Blk = await one(`SELECT l.id FROM "SalesOrderLine" l JOIN "Colourway" c ON c.id = l."colourwayId" WHERE l."orderId" = $1 AND c.code = 'BLK'`, [A.so2])
  A.q2 = await one(`SELECT id FROM "Quote" WHERE number = 'SEED-Q-0002'`)
  const company = await one(`SELECT "companyId" AS id FROM "Site" WHERE id = $1`, [A.site])
  const opening = (await admin<{ createdById: string }>(`SELECT "createdById" FROM "StockMove" WHERE reason = 'OPENING' LIMIT 1`))[0]!
  // 4 finished BLK 52 garments on hand at A1's finished goods (an opening count).
  await admin(
    `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "toLocationId", quantity, uom, "baseQuantity", reference, "idempotencyKey", "occurredAt", "createdById")
     VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, 4, 'PCS', 4, 'Opening count', $7, now() - interval '1 day', $8)`,
    [newId(), tenant, company, A.site, A.blk52, A.fg, `promise-opening-${run}`, opening.createdById],
  )
  // The certificate of SEED-JKT-02 covers sizes 50 and 52 only (PLN-179: 54 is not promised).
  await admin(`UPDATE "CertificateCoverage" SET sizes = ARRAY['50','52'] WHERE "styleId" = $1`, [A.jkt02])
  // A SEED-JKT-02 BLK line on the DRAFT quote SEED-Q-0002 (a copy of its first line), 50/52/54 as that line's.
  const version = await one(`SELECT id FROM "QuoteVersion" WHERE "quoteId" = $1 AND revision = 1`, [A.q2])
  const first = await one(`SELECT id FROM "QuoteLine" WHERE "versionId" = $1 AND seq = 10`, [version])
  A.q2Line = newId()
  await admin(
    `INSERT INTO "QuoteLine" SELECT (jsonb_populate_record(NULL::"QuoteLine", to_jsonb(l) || jsonb_build_object('id', $1::text, 'seq', 30, 'styleId', $2::text, 'colourwayId', $3::text, 'styleRevisionId', NULL))).* FROM "QuoteLine" l WHERE l.id = $4`,
    [A.q2Line, A.jkt02, A.blk, first],
  )
  await admin(`INSERT INTO "QuoteLineSize" (id, "tenantId", "lineId", "partyId", size, quantity, "unitPrice") SELECT gen_random_uuid(), "tenantId", $1, "partyId", size, quantity, "unitPrice" FROM "QuoteLineSize" WHERE "lineId" = $2`, [A.q2Line, first])
  today = businessDate(new Date(), 'Europe/Rome')
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 480_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

const sizeOf = (answer: Json, size: string): Json => (answer.sizes as Json[]).find((entry) => entry.size === size)!

describe('available to promise for stock styles (PLN-168)', { timeout: 120_000 }, () => {
  it('per colourway, size and week: on hand, what work orders and the plan bring, what orders wait for', async () => {
    const answer = await ok('planner', 'GET', `/planning/promise/atp?siteId=${A.site}&styleId=${A.jkt02}&weeks=8`)
    expect(answer).toMatchObject({ site: { id: A.site, code: 'A1' }, today, style: { code: 'SEED-JKT-02', sizes: ['50', '52', '54'] }, stockStyle: true, empty: false })
    expect(answer.weeks).toHaveLength(8)
    const blk = (answer.colourways as Json[]).find((entry) => entry.colourway.code === 'BLK')!
    const blk52 = (blk.sizes as Json[]).find((entry) => entry.size === '52')!
    expect(blk52).toMatchObject({ sku: 'SEED-JKT-02-BLK-52', strategy: 'MAKE_TO_STOCK', onHand: 4 })
    // SEED-SO-0002 waits for BLK 52 (2 garments) and the seeded work orders make them.
    expect(blk52.sources.some((source: Json) => source.kind === 'ORDER_LINE' && source.number.startsWith('SEED-SO-0002'))).toBe(true)
    expect(blk52.sources.some((source: Json) => source.kind === 'WORK_ORDER')).toBe(true)
    const committed = blk52.cells.reduce((sum: number, cell: Json) => sum + cell.committed, 0) + blk52.later.committed
    const receipts = blk52.cells.reduce((sum: number, cell: Json) => sum + cell.receipts, 0) + blk52.later.receipts
    const last = blk52.cells[blk52.cells.length - 1]
    expect(last.cumulative).toBe(4 + receipts - committed - blk52.later.receipts + blk52.later.committed)
    // The look-ahead: what can be promised now never exceeds any later week's cumulative.
    for (const cell of blk52.cells) expect(blk52.availableNow).toBeLessThanOrEqual(Math.max(0, cell.cumulative))
    // The colourway's total adds its sizes up.
    expect(blk.onHand).toBe(4)
    // The stock styles of the site: JKT-02 (made to stock, on hand).
    const styles = await ok('sales', 'GET', `/planning/promise/atp/styles?siteId=${A.site}`)
    expect(styles.styles).toEqual([expect.objectContaining({ code: 'SEED-JKT-02', makeToStock: true, onHand: true })])
  })

  it('refuses a caller without promise dates (the route) and an unknown style', async () => {
    await refused('viewer', 'GET', `/planning/promise/atp?siteId=${A.site}&styleId=${A.jkt02}`, undefined, 403)
    await refused('planner', 'GET', `/planning/promise/atp?siteId=${A.site}&styleId=${newId()}`, undefined, 404)
  })
})

describe('the promise calculator (PLN-169, PLN-171, PLN-179)', { timeout: 120_000 }, () => {
  it('a date per size: stock first for the stock size, made from material and capacity for the others, 54 not certified', async () => {
    const wanted = plusDays(today, 60)
    const { answer, ...where } = await ok('sales', 'POST', '/planning/promise/calculate', {
      siteId: A.site,
      styleId: A.jkt02,
      colourwayId: A.blk,
      sizes: [
        { size: '50', quantity: 2 },
        { size: '52', quantity: 1 },
        { size: '54', quantity: 1 },
      ],
      wantedDate: wanted,
      country: 'IT',
    })
    // The market is the profile of the destination when one names it (none is seeded here: the certificate rule is every market's).
    expect(where).toMatchObject({ site: { code: 'A1' }, today, destination: 'IT' })
    expect(answer).toMatchObject({ key: 'calculator', style: { code: 'SEED-JKT-02' }, colourway: { code: 'BLK' }, revision: { revision: 1, status: 'RELEASED' }, wantedDate: wanted, complete: false })
    // 54: no valid certificate covers it, so it is not promised and nothing is made for it.
    expect(sizeOf(answer, '54')).toMatchObject({ state: 'NOT_CERTIFIED', date: null, toMake: 0, certificate: { state: 'MISSING' } })
    expect(sizeOf(answer, '54').words).toMatch(/^Size 54 is not promised: /)
    // 50: made (material and the routing's lanes); the bridge adds up to its date.
    const s50 = sizeOf(answer, '50')
    expect(s50).toMatchObject({ state: 'MAKE', fromStock: 0, toMake: 2, certificate: { state: 'OK', certificate: 'SEED-CERT-0003' } })
    expect(s50.date >= today).toBe(true)
    expect(s50.bridge.materialDays + s50.bridge.baseDays + s50.bridge.queueDays).toBe(s50.bridge.spanDays)
    expect(s50.bridge.finish).toBe(s50.date)
    // 52 is made to stock: from available to promise when it has one free, else made.
    const s52 = sizeOf(answer, '52')
    expect(['FROM_STOCK', 'STOCK_AND_MAKE', 'MAKE']).toContain(s52.state)
    expect(s52.fromStock + s52.toMake).toBe(1)
    // The routing's steps on A1's lanes, and the words of the date.
    expect(answer.steps.length).toBeGreaterThan(0)
    expect(answer.bridgeWords).toMatch(/^base lead time \d+ days? \+ queue at today's load \d+ days? \+ .+ = \d+ days? → \d{1,2} [A-Z][a-z]{2}/)
    expect(answer.groupsWords).toContain('54 not promised')
    expect(answer.date).toBe([s50.date, s52.date].sort().reverse()[0])
  })

  it('a certificate that ends before the day does not promise the size', async () => {
    // SEED-CERT-0003 suspended; a made-up certificate covers 50 and 52 until today only.
    const seeded = await one(`SELECT "certificateId" AS id FROM "CertificateCoverage" WHERE "styleId" = $1 LIMIT 1`, [A.jkt02])
    const short = newId()
    await admin(`INSERT INTO "Certificate" SELECT (jsonb_populate_record(NULL::"Certificate", to_jsonb(c) || jsonb_build_object('id', $1::text, 'number', 'TEST-CERT-0301', 'validTo', $3::text))).* FROM "Certificate" c WHERE c.id = $2`, [short, seeded, today])
    await admin(`INSERT INTO "CertificateCoverage" SELECT (jsonb_populate_record(NULL::"CertificateCoverage", to_jsonb(v) || jsonb_build_object('id', $1::text, 'certificateId', $2::text))).* FROM "CertificateCoverage" v WHERE v."certificateId" = $3 AND v."styleId" = $4`, [newId(), short, seeded, A.jkt02])
    await admin(`UPDATE "Certificate" SET status = 'SUSPENDED', "statusChangedAt" = now() WHERE id = $1`, [seeded])
    try {
      const { answer } = await ok('planner', 'POST', '/planning/promise/calculate', { siteId: A.site, styleId: A.jkt02, colourwayId: A.blk, sizes: [{ size: '50', quantity: 2 }] })
      const s50 = sizeOf(answer, '50')
      // Covered today (nothing refused at first), but made after today: the certificate does not reach its day.
      expect(s50.readyDate > today).toBe(true)
      expect(s50).toMatchObject({ state: 'NOT_CERTIFIED', date: null, certificate: { state: 'MISSING' } })
    } finally {
      await admin(`UPDATE "Certificate" SET status = 'VALID', "statusChangedAt" = now() WHERE id = $1`, [seeded])
      await admin(`UPDATE "Certificate" SET status = 'WITHDRAWN', "statusChangedAt" = now() WHERE id = $1`, [short])
    }
  })

  it('refuses a size twice, a size not in the range, a colourway of another style; a style without a released revision says so', async () => {
    const base = { siteId: A.site, styleId: A.jkt02, colourwayId: A.blk }
    expect((await refused('sales', 'POST', '/planning/promise/calculate', { ...base, sizes: [{ size: '50', quantity: 1 }, { size: '50', quantity: 1 }] }, 400)).issues[0].path).toBe('body/sizes/1/size')
    expect((await refused('sales', 'POST', '/planning/promise/calculate', { ...base, sizes: [{ size: '58', quantity: 1 }] }, 400)).issues[0].path).toBe('body/sizes/0/size')
    expect((await refused('sales', 'POST', '/planning/promise/calculate', { ...base, colourwayId: A.jkt01Blk, sizes: [{ size: '50', quantity: 1 }] }, 400)).issues[0].path).toBe('body/colourwayId')
    const { answer } = await ok('sales', 'POST', '/planning/promise/calculate', { siteId: A.site, styleId: A.jkt01, colourwayId: A.jkt01Blk, sizes: [{ size: '50', quantity: 1 }] })
    expect(answer.revision).toBeNull()
    expect(answer.warnings.map((warning: Json) => warning.code)).toContain('NO_RELEASED_BOM')
    await refused('viewer', 'POST', '/planning/promise/calculate', { ...base, sizes: [{ size: '50', quantity: 1 }] }, 403)
  })
})

describe("a quote's suggested dates (PLN-169)", { timeout: 120_000 }, () => {
  it('every line asked at once: dates per size, the delivery schedule they make, the fee skipped, Use on quote for a DRAFT', async () => {
    const answer = await ok('sales', 'GET', `/planning/promise/quotes/${A.q2}`)
    expect(answer.quote).toMatchObject({ id: A.q2, number: 'SEED-Q-0002', revision: 1, status: 'DRAFT' })
    expect(answer.mayUse).toBe(true)
    const line = (answer.lines as Json[]).find((entry) => entry.lineId === A.q2Line)!
    expect(line.answer).toMatchObject({ style: { code: 'SEED-JKT-02' }, colourway: { code: 'BLK' } })
    // The deliveries: one per day, every promised size on it with its pieces.
    const delivered = (line.deliveries as Json[]).flatMap((delivery) => Object.keys(delivery.sizeQuantities ?? {}))
    expect(delivered.sort()).toEqual((line.answer.sizes as Json[]).filter((size) => size.date !== null).map((size) => size.size).sort())
    expect(line.deliveries.every((delivery: Json) => delivery.quantity === Object.values(delivery.sizeQuantities as Record<string, number>).reduce((a, b) => a + b, 0))).toBe(true)
    // The made-to-measure line is asked as one unit of its base size; JKT-01 has no released revision.
    const mtm = (answer.lines as Json[]).find((entry) => entry.answer.madeToMeasure)
    expect(mtm?.answer.sizes).toHaveLength(1)
    expect(answer.promiseDate === null || answer.promiseDate >= today).toBe(true)
    // A reader of plans who may not ask promise dates.
    await refused('viewer', 'GET', `/planning/promise/quotes/${A.q2}`, undefined, 403)
    await refused('planner', 'GET', `/planning/promise/quotes/${newId()}`, undefined, 404)
  })
})

describe("an order line's promise per size (PLN-171, PLN-179)", { timeout: 180_000 }, () => {
  it('reads each size: what is open, the work orders making it, the promise sales typed, the plan’s day', async () => {
    const view = await ok('reader', 'GET', `/planning/promise/order-lines/${A.so2Blk}`)
    expect(view).toMatchObject({ order: { id: A.so2, number: 'SEED-SO-0002' }, line: { id: A.so2Blk, colourway: { code: 'BLK' } }, history: [], may: { record: false } })
    expect(view.sizes.map((entry: Json) => entry.size)).toEqual(['50', '52', '54'])
    for (const entry of view.sizes) {
      expect(entry.current).toMatchObject({ source: 'TYPED', date: view.order.promiseDate })
      if (entry.open > 0) expect(entry.workOrders.length + entry.plannedOrders.length + entry.uncovered).toBeGreaterThan(0)
      else expect(entry.state).toBe('SHIPPED')
    }
    expect(view.sizes.find((entry: Json) => entry.size === '54')).toMatchObject({ state: 'NOT_CERTIFIED', proposed: null })
    await refused('noOrders', 'GET', `/planning/promise/order-lines/${A.so2Blk}`, undefined, 404)
    await refused('viewer', 'GET', `/planning/promise/order-lines/${A.so2Blk}`, undefined, 403)
  })

  it('records sizes apart: the typed date becomes the FIRST, a size on another day a RE_PROMISE; once only; only certified sizes', async () => {
    const before = await ok('planner', 'GET', `/planning/promise/order-lines/${A.so2Blk}`)
    const typed = before.order.promiseDate as string
    // The sizes still open and covered by a certificate (54 is not: PLN-179).
    const open = (before.sizes as Json[]).filter((entry) => entry.open > 0 && entry.state !== 'NOT_CERTIFIED').map((entry) => entry.size as string)
    expect(open).toContain('52')
    const later = plusDays(typed > today ? typed : today, 7)
    const idempotencyKey = key()
    const body = { sizes: [{ size: '52', date: later }] }
    const first = await ok('planner', 'POST', `/planning/promise/order-lines/${A.so2Blk}`, body, idempotencyKey)
    expect(first.written.map((row: Json) => [row.size, row.promisedDate, row.kind, row.reasonCode, row.backfill])).toEqual([
      [null, typed, 'FIRST', null, true],
      ['52', later, 'RE_PROMISE', 'SIZES_FINISH_APART', false],
    ])
    expect(first.unchanged).toEqual([])
    expect(first.view.sizes.find((entry: Json) => entry.size === '52').current).toMatchObject({ date: later, source: 'RECORD', kind: 'RE_PROMISE', ownSize: true })
    // The other sizes now read the line's FIRST row (the date sales typed).
    for (const entry of first.view.sizes as Json[]) if (entry.size !== '52') expect(entry.current).toMatchObject({ date: typed, source: 'RECORD', kind: 'FIRST', ownSize: false })
    expect(first.view.history).toHaveLength(2)
    // The same request again: the stored answer, nothing written twice.
    const again = await ok('planner', 'POST', `/planning/promise/order-lines/${A.so2Blk}`, body, idempotencyKey)
    expect(again.replayed).toBe(true)
    // The same date without a key: nothing to write.
    expect((await ok('planner', 'POST', `/planning/promise/order-lines/${A.so2Blk}`, body)).written).toEqual([])
    const rows = await admin<{ size: string | null; kind: string; reasonCode: string | null; siteId: string | null; planVersionId: string | null }>(`SELECT size, kind, "reasonCode", "siteId", "planVersionId" FROM "PromiseRecord" WHERE "salesOrderLineId" = $1 ORDER BY "promisedAt", id`, [A.so2Blk])
    expect(rows.map((row) => [row.size, row.kind, row.reasonCode])).toEqual([
      [null, 'FIRST', null],
      ['52', 'RE_PROMISE', 'SIZES_FINISH_APART'],
    ])
    expect(rows[0]!.planVersionId).toBeNull()
    expect(rows[1]!.siteId === null).toBe(rows[1]!.planVersionId === null)
    const events = await admin<{ n: string }>(`SELECT count(*)::text AS n FROM "OutboxEvent" WHERE type = 'order_promise.recorded' AND subject = $1`, [A.so2])
    expect(events[0]!.n).toBe('1')
    // PLN-179: 54 is not covered by a valid certificate: refused in the gate's words, nothing written.
    const error = await refused('planner', 'POST', `/planning/promise/order-lines/${A.so2Blk}`, { sizes: [{ size: '54', date: later }] }, 409)
    expect(error.message).toMatch(/^Only sizes a valid certificate covers through their date are promised: /)
    expect(error.issues[0].path).toBe('body/sizes/0/date')
    // A day before today, a size not on the line; a reader may not record.
    expect((await refused('planner', 'POST', `/planning/promise/order-lines/${A.so2Blk}`, { sizes: [{ size: '52', date: plusDays(today, -1) }] }, 400)).issues[0].path).toBe('body/sizes/0/date')
    expect((await refused('planner', 'POST', `/planning/promise/order-lines/${A.so2Blk}`, { sizes: [{ size: '58', date: later }] }, 400)).issues[0].path).toBe('body/sizes/0/size')
    await refused('reader', 'POST', `/planning/promise/order-lines/${A.so2Blk}`, { sizes: [{ size: '50', date: later }] }, 403)
    // The history is append-only: the database refuses a change of a row.
    await expect(admin(`UPDATE "PromiseRecord" SET "promisedDate" = $2::date WHERE "salesOrderLineId" = $1`, [A.so2Blk, later])).rejects.toThrow()
  })
})
