import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/planning/buy'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPlanning } from '../../../../../../packages/factory-db/seed/planning'
import { seed as seedSourcing } from '../../../../../../packages/factory-db/seed/sourcing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * Requests to buy (B-W2a-10; SCM-034, SCM-036) on the local stack, with the app's real routes: a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security, the grants and the triggers are real), the
 * factory-db seeds up to planning and sourcing: the supply seed's run 1 of plant A1 (black leather and the protectors
 * ORDERED on PO1, the lining set aside, the red leather OPEN and made a firm planned order of 4 hides from P2 by 16 Nov),
 * A1's reorder point for the protectors (24, a lot of 48, 7 days) and min/max for the grey lining (50 to 300 m), PO2's
 * draft of 10 protectors, P2's approved source for the black leather. Sessions from the test authenticator. Every name,
 * number and price is made up. Run with `node scripts/factory/run-pg-tests.mjs purchasing/requests`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = { a: 'requests-a', b: 'requests-b' } as const
const idOf = (key: string) => seedUuid(ns.a, key)
const A = {
  tenant: idOf('tenant'),
  companyA: idOf('company:A'),
  companyB: idOf('company:B'),
  siteA1: idOf('site:A1'),
  brand: idOf('party:P1'),
  supplier: idOf('party:P2'),
  protector: idOf('product:item:protector'),
  leather: idOf('product:item:leather'),
  leatherRED: idOf('product:item-colour:leather:RED'),
  redLine: idOf('supply:run:1:2'),
  protectorRule: idOf('planning:item:A1:protector'),
  po2: `00000000${idOf('supply:PO2').slice(8)}`,
}

const BUY: Permission[] = ['purchasing.view', 'purchasing.manage', 'money.cost']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties })
/** One actor per office session name, so a repeated Idempotency-Key is the same caller's. */
const ACTORS = new Map<string, string>()
const office = (tenantId: string, grants: Grant[], name = 'buyer'): SessionContext => ({ audience: 'office', tenantId, actorId: ACTORS.get(name) ?? (ACTORS.set(name, newId()), ACTORS.get(name)!), grants })
const SESSIONS: Record<string, () => SessionContext> = {
  buyer: () => office(A.tenant, [grant(BUY)]),
  buyer2: () => office(A.tenant, [grant(BUY)], 'buyer2'),
  planner: () => office(A.tenant, [grant(['purchasing.view', 'planning.view'])]),
  companyB: () => office(A.tenant, [grant(BUY, [A.companyB])]),
  brandOnly: () => office(A.tenant, [grant(BUY, 'all', [A.brand])]),
  otherTenant: () => office(seedUuid(ns.b, 'tenant'), [grant(BUY)]),
  floor: () => ({ audience: 'floor', tenantId: A.tenant, actorId: newId(), siteId: A.siteA1, deviceId: newId(), grants: [grant(['floor.work', ...BUY], [A.companyA])] }),
  partner: () => ({ audience: 'partner', tenantId: A.tenant, actorId: newId(), partyId: A.supplier, grants: [grant(['purchasing.view'], 'all', [A.supplier])] }),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `requests-test-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, idempotencyKey = method === 'GET' ? undefined : key()) =>
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
const queue = async (session = 'buyer', query = '') => (await ok(session, 'GET', `/purchasing/requests${query}`)).requests as Json[]
const today = () => businessDate(new Date())

beforeAll(async () => {
  db = await migratedDatabase('requests')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: database, namespace })
  await seedPlanning({ db: database, namespace: ns.a }) // production, inventory, supply and sales come with it
  await seedSourcing({ db: database, namespace: ns.a })
  await seedNumbering({ db: database, namespace: ns.a })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 240_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

let red: Json
let protector: Json

describe('the queue (SCM-034)', () => {
  it("lists the plan's open line: the firm planned order as fixed (4 hides from P2 by 16 Nov), its day to order by, price and netting", async () => {
    const open = await queue()
    expect(open.map((request) => request.id)).toEqual([`plan:${A.redLine}`])
    red = open[0]!
    expect(red).toMatchObject({
      kind: 'PLAN',
      refId: A.redLine,
      status: 'OPEN',
      siteId: A.siteA1,
      site: { code: 'A1' },
      item: { code: 'SEED-LEA-100' },
      colour: { code: 'RED' },
      needDate: '2026-11-16',
      needWeek: '2026-W47',
      // 16 Nov − 2 safety days (A1's leather) − 14 days (the leather's lead time from its default supplier).
      orderBy: { date: '2026-10-31', leadTimeDays: 14, closedDaysSkipped: 0 },
      quantity: '4.0000',
      uom: 'HIDE',
      baseQuantity: '210.0000',
      estimatedHides: 4,
      quantityFrom: 'FIRM',
      supplier: { id: A.supplier, code: 'SEED-S1' },
      supplierFrom: 'FIRM',
      // P2's source holds for the black leather only: the red one has none (any supplier).
      sourceId: null,
      approvedSuppliers: 0,
      supplierArticleCode: 'SEED-ART-100',
      supplierColourCode: 'S-002',
      currency: 'EUR',
      // The material's standard purchase price, 4.20 a ft² × 52.5.
      unitPrice: '220.500000',
      expectedAmount: 88_200,
      hold: null,
      plan: { runStatus: 'DONE', firm: true, why: 'Need 202.16 − usable 0 − on order 0 = short 202.16 ft²', orders: [{ number: 'SEED-SO-0001' }], purchaseOrder: null },
      reorder: null,
    })
    // Every status: the two ORDERED lines of run 1 (on PO1); the lining set aside has nothing to buy.
    const all = await queue('buyer', '?status=ALL')
    expect(all.map((request) => [request.item.code, request.colour?.code ?? null, request.status])).toEqual(
      expect.arrayContaining([
        ['SEED-LEA-100', 'BLK', 'CONVERTED'],
        ['SEED-PRO-300', null, 'CONVERTED'],
        ['SEED-LEA-100', 'RED', 'OPEN'],
      ]),
    )
    expect(all.find((request) => request.colour?.code === 'BLK')).toMatchObject({ hold: { code: 'NOT_OPEN' }, plan: { purchaseOrder: { number: 'SEED-PO-0001' } }, warnings: [] })
  })

  it('a reorder point that asks for an order: the protectors once the draft PO2 is cancelled (position 24 = the reorder point)', async () => {
    const detail = await ok('buyer', 'GET', `/purchasing/requests/reorder/${A.protectorRule}`)
    expect(detail.request).toMatchObject({ kind: 'REORDER', hold: { code: 'NOT_NEEDED' }, reorder: { position: '34.0000', onOrder: '34.0000', level: '24.0000', triggered: false } })
    expect(detail.onOrder.map((line: Json) => line.number).sort()).toEqual(['SEED-PO-0001', 'SEED-PO-0002'])

    const po2 = (await ok('buyer', 'GET', `/purchasing/orders/${A.po2}`)).order
    await ok('buyer', 'POST', `/purchasing/orders/${A.po2}/cancel`, { version: po2.version, reason: 'The brand ships its protectors itself' })
    const open = await queue()
    protector = open.find((request) => request.kind === 'REORDER')!
    expect(protector).toMatchObject({
      id: `reorder:${A.protectorRule}`,
      status: 'OPEN',
      item: { code: 'SEED-PRO-300' },
      // Ordered today, needed when the goods can come: A1's 7 days.
      orderBy: { date: today(), leadTimeDays: 7, passed: false },
      needDate: addDays(today(), 7),
      quantity: '48.0000',
      uom: 'PCS',
      quantityFrom: 'ITEM',
      rounding: [{ rule: 'LOT_SIZE', quantity: '48.0000' }],
      supplier: { id: A.supplier },
      supplierFrom: 'DEFAULT',
      supplierArticleCode: 'SEED-ART-300',
      unitPrice: '6.500000',
      expectedAmount: 31_200,
      hold: null,
      reorder: { method: 'REORDER_POINT', position: '24.0000', usable: '0.0000', onOrder: '24.0000', reserved: '0.0000', level: '24.0000', triggered: true, quantity: '48.0000' },
    })
    expect(protector.reorder.why).toBe('Stock 24 PCS (usable 0 + on order 24 − reserved 0) is at or below the reorder point 24: order 48 PCS.')
    expect((await ok('buyer', 'GET', '/purchasing/requests/counts')).open).toBe(2)
    expect((await queue('buyer', '?kind=REORDER')).map((request) => request.id)).toEqual([protector.id])
    expect((await queue('buyer', '?q=so-0001')).map((request) => request.id)).toEqual([red.id])
  })

  it('the planner sees the queue without prices; another company, tenant or a role kept to other suppliers does not; the floor and partners have no route', async () => {
    const planned = await queue('planner')
    expect(planned.map((request) => request.id).sort()).toEqual([red.id, protector.id].sort())
    for (const request of planned) {
      expect(request).not.toHaveProperty('unitPrice')
      expect(request).not.toHaveProperty('expectedAmount')
    }
    expect(await queue('companyB')).toEqual([])
    expect(await queue('brandOnly')).toEqual([])
    expect((await call('otherTenant', 'GET', `/purchasing/requests/plan/${A.redLine}`)).statusCode).toBe(404)
    expect((await call('companyB', 'GET', `/purchasing/requests/plan/${A.redLine}`)).statusCode).toBe(404)
    for (const session of ['floor', 'partner']) {
      expect((await call(session, 'GET', '/purchasing/requests')).statusCode, session).toBe(403)
      expect((await call(session, 'POST', '/purchasing/requests/convert', { requests: [{ kind: 'PLAN', id: A.redLine, version: red.version }] })).statusCode, session).toBe(403)
    }
  })
})

describe('Draft POs for n (SCM-036)', () => {
  const both = () => [
    { kind: 'PLAN', id: A.redLine, version: red.version },
    { kind: 'REORDER', id: A.protectorRule, version: protector.version },
  ]

  it('previews one card for P2 at A1: a new draft (none is open), both lines with their prices; nothing is written', async () => {
    const orders = (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "PurchaseOrder"`))[0]!.n
    const preview = await ok('buyer', 'POST', '/purchasing/requests/preview', { requests: both() })
    expect(preview.held).toEqual([])
    expect(preview.cards).toEqual([
      expect.objectContaining({
        siteId: A.siteA1,
        supplier: expect.objectContaining({ id: A.supplier }),
        currency: 'EUR',
        into: 'NEW',
        draft: null,
        openDraft: null,
        mayDraft: true,
        expectedAmount: 88_200 + 31_200,
        lines: [expect.objectContaining({ requestId: red.id, quantity: '4.0000', uom: 'HIDE', unitPrice: '220.500000' }), expect.objectContaining({ requestId: protector.id, quantity: '48.0000', uom: 'PCS' })],
      }),
    ])
    expect((await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "PurchaseOrder"`))[0]!.n).toBe(orders)
    const planner = await ok('planner', 'POST', '/purchasing/requests/preview', { requests: both() })
    expect(planner.cards[0]).toMatchObject({ mayDraft: false })
    expect(planner.cards[0]).not.toHaveProperty('expectedAmount')
  })

  it('drafts both into ONE new purchase order in one command: the plan line ORDERED, the reorder row gone from the queue; a repeat answers the same', async () => {
    // The seed's run decided its lines on a fixed day: "drafted today" counts them only on that day.
    const before = (await ok('buyer', 'GET', '/purchasing/requests/counts')).convertedToday as number
    const idempotencyKey = key()
    const converted = await ok('buyer', 'POST', '/purchasing/requests/convert', { requests: both() }, idempotencyKey)
    expect(converted.orders).toHaveLength(1)
    const [order] = converted.orders
    expect(order).toMatchObject({ created: true, siteId: A.siteA1, supplierId: A.supplier, lineCount: 2 })
    expect(converted.lines.map((line: Json) => line.requestId)).toEqual([red.id, protector.id])
    expect(await ok('buyer', 'POST', '/purchasing/requests/convert', { requests: both() }, idempotencyKey)).toEqual(converted)

    const detail = (await ok('buyer', 'GET', `/purchasing/orders/${order.id}`)).order
    expect(detail).toMatchObject({ status: 'DRAFT', partyId: A.supplier, netAmount: 88_200 + 31_200 })
    expect(detail.lines.map((line: Json) => [line.quantity, line.uom, line.unitPrice, line.needDate])).toEqual([
      ['4.0000', 'HIDE', '220.500000', '2026-11-16'],
      ['48.0000', 'PCS', '6.500000', addDays(today(), 7)],
    ])
    expect(detail.lines[0].plan).toEqual([expect.objectContaining({ requirementId: A.redLine, decision: 'ORDERED' })])

    expect(await queue()).toEqual([])
    const now = await ok('buyer', 'GET', `/purchasing/requests/plan/${A.redLine}`)
    expect(now.request).toMatchObject({ status: 'CONVERTED', plan: { purchaseOrder: { id: order.id, status: 'DRAFT' } } })
    expect((await ok('buyer', 'GET', `/purchasing/requests/reorder/${A.protectorRule}`)).request.reorder).toMatchObject({ position: '72.0000', triggered: false })
    expect((await ok('buyer', 'GET', '/purchasing/requests/counts')).convertedToday).toBe(before + 1)

    const events = (await admin<{ type: string }>(`SELECT type FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id`, [order.id])).map((row) => row.type)
    expect(events).toEqual(['purchase_order.created', 'purchase_order.lines_changed', 'purchase_requests.converted'])
    const audit = await admin<{ action: string; after: Json }>(`SELECT action, after FROM "AuditLog" WHERE action = 'purchasing.convertRequests' AND "recordType" = 'PurchaseOrderLine' ORDER BY at, id`)
    expect(audit.map((row) => [row.after.kind, row.after.requestId])).toEqual([
      ['PLAN', red.id],
      ['REORDER', protector.id],
    ])
  })

  it('refuses in words: the same requests again, a stale version, a party that is not a supplier, a caller without purchasing.manage', async () => {
    const latest = (await ok('buyer', 'GET', `/purchasing/requests/plan/${A.redLine}`)).request
    expect((await refused('buyer', 'POST', '/purchasing/requests/convert', { requests: [{ kind: 'PLAN', id: A.redLine, version: latest.version }] }, 409)).message).toBe('It is on a purchase order already.')
    expect((await refused('buyer', 'POST', '/purchasing/requests/convert', { requests: [{ kind: 'REORDER', id: A.protectorRule, version: protector.version }] }, 409)).message).toBe(
      'The stock is above its reorder level now (the reorder point, or the minimum): nothing to buy.',
    )
    // The reorder point raised: it asks again; an older version is refused.
    await admin(`UPDATE "ItemPlanning" SET "reorderPoint" = 100, version = version + 1 WHERE id = $1`, [A.protectorRule])
    expect((await refused('buyer', 'POST', '/purchasing/requests/convert', { requests: [{ kind: 'REORDER', id: A.protectorRule, version: protector.version }] }, 409)).message).toMatch(/changed since it was read/)
    const brand = await refused('buyer', 'POST', '/purchasing/requests/convert', { requests: [{ kind: 'REORDER', id: A.protectorRule, version: protector.version + 1, supplierId: A.brand }] }, 400)
    expect(brand.issues).toEqual([{ path: 'body/requests/0/supplierId', message: 'Seed Racing is not a supplier: pick an approved source.' }])
    expect((await call('planner', 'POST', '/purchasing/requests/convert', { requests: [{ kind: 'REORDER', id: A.protectorRule, version: protector.version + 1 }] })).statusCode).toBe(403)
    expect((await refused('buyer', 'POST', '/purchasing/requests/convert', { requests: [{ kind: 'PLAN', id: A.redLine, version: 1 }, { kind: 'PLAN', id: A.redLine, version: 1 }] }, 400)).message).toBe('A request is listed twice.')
    expect((await refused('buyer', 'POST', '/purchasing/requests/convert', { requests: [{ kind: 'PLAN', id: newId(), version: 1 }] }, 404)).message).toBe('Request not found.')
  })

  it('two buyers converting the same reorder row at once: one drafts, the other finds it covered', async () => {
    const request = { kind: 'REORDER', id: A.protectorRule, version: protector.version + 1 }
    const answers = await Promise.all(['buyer', 'buyer2'].map((session) => call(session, 'POST', '/purchasing/requests/convert', { requests: [request], into: [{ supplierId: A.supplier, purchaseOrderId: null }] })))
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 409])
    const lost = answers.find((answer) => answer.statusCode === 409)!.json().error
    expect(lost.message).toBe('The stock is above its reorder level now (the reorder point, or the minimum): nothing to buy.')
    const won = answers.find((answer) => answer.statusCode === 200)!.json()
    expect(won.orders[0]).toMatchObject({ created: true, lineCount: 1 })
  })
})
