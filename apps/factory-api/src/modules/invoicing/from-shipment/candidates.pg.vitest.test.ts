import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedMoney, type MoneySeed } from '../../../../../../packages/factory-db/seed/money'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * B-TH-062 (threads plan TH-4, N21): GET /invoicing/from-ddts/candidates?orderIds=… — Finance picks orders on the orders list
 * and reads the drafts invoicing their shipped goods makes: one per customer and company, each with what
 * POST /invoicing/invoices/from-ddts takes; the orders with nothing to invoice held with why; never an invoice made.
 *
 * On a throwaway database from the migrations with the core and money seeds (SEED-SO-0001 nothing shipped, SEED-SO-0002's
 * live DDT 144 in the money seed's DRAFT TD24, SEED-SO-0003 a DRAFT shipment). Two more orders with goods left with a DDT
 * and not invoiced — one of SEED-C1 (brand A's), one of SEED-C2 (brand B's) — are copies of SEED-SO-0002, its SH-0001 and
 * its DDT, written by the admin past the guards (the copies are test data; the read under test runs as the runtime login).
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs from-shipment/candidates`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let money: MoneySeed

const ns = 'thc-a'
const A = { tenant: seedUuid(ns, 'tenant'), companyA: seedUuid(ns, 'company:A'), brandA: seedUuid(ns, 'party:P1'), brandB: seedUuid(ns, 'party:P3') }
const S: Record<string, string> = {}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]

/** Writes test data past its own guards (the admin's session only), then back. */
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}

/** A copy of a row with some columns changed (generated columns left to the database). */
async function copy(table: string, id: string, changes: Json): Promise<void> {
  const columns = (await admin<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER' ORDER BY ordinal_position`, [table]))
    .map((row) => `"${row.column_name}"`)
    .join(', ')
  await force(`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(t) || $2::jsonb FROM "${table}" t WHERE id = $1))`, [id, JSON.stringify(changes)])
}

/** A copy of SEED-SO-0002 for a customer, shipped on a copy of SH-0001 with a copy of its live DDT: goods left, not invoiced. */
async function shippedCopy(key: string, partyId: string): Promise<{ orderId: string; ddtId: string }> {
  const orderId = newId()
  const shipmentId = newId()
  const ddtId = newId()
  const source = money.shipping.quality.production.salesOrderId
  // fix-pg-2 (B-TH-104): the copy takes no customer number of its own (the source's would be the same customer's twice).
  await copy('SalesOrder', source, { id: orderId, number: `TEST-SO-${key}`, partyId, quoteVersionId: null, customerSeq: null })
  const lines = new Map<string, string>()
  for (const line of await admin<{ id: string }>('SELECT id FROM "SalesOrderLine" WHERE "orderId" = $1', [source])) {
    const lineId = newId()
    lines.set(line.id, lineId)
    await copy('SalesOrderLine', line.id, { id: lineId, orderId, partyId })
    for (const size of await admin<{ id: string }>('SELECT id FROM "SalesOrderLineSize" WHERE "lineId" = $1', [line.id])) await copy('SalesOrderLineSize', size.id, { id: newId(), lineId, partyId })
  }
  await copy('Shipment', money.shipping.shipmentId, { id: shipmentId, number: `TEST-SH-${key}`, salesOrderId: orderId, partyId })
  for (const line of await admin<{ id: string; salesOrderLineId: string }>('SELECT id, "salesOrderLineId" FROM "ShipmentLine" WHERE "shipmentId" = $1', [money.shipping.shipmentId])) {
    await copy('ShipmentLine', line.id, { id: newId(), shipmentId, salesOrderLineId: lines.get(line.salesOrderLineId), partyId })
  }
  await copy('Ddt', money.shipping.ddtId, { id: ddtId, number: `T${key}/2026`, shipmentId, partyId })
  return { orderId, ddtId }
}

const MONEY: Permission[] = ['invoices.view', 'invoices.manage', 'money.price']
const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const SESSIONS: Record<string, () => SessionContext> = {
  finance: () => office([grant(MONEY)]),
  /** Finance limited to brand B (SEED-C2). */
  brandBOnly: () => office([grant(MONEY, [A.brandB])]),
  noPrice: () => office([grant(['invoices.view', 'invoices.manage'])]),
  viewer: () => office([grant(['invoices.view', 'money.price'])]),
  partner: () => ({ audience: 'partner', tenantId: A.tenant, actorId: newId(), partyId: A.brandA, grants: [grant(MONEY)] }),
}
async function candidates(session: string, orderIds: readonly string[]): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method: 'GET', url: `/invoicing/from-ddts/candidates?orderIds=${orderIds.join(',')}`, headers: { 'x-test-session': session } })
  return { status: response.statusCode, body: response.json() as Json }
}
const invoiceCount = async (): Promise<number> => (await admin<{ n: number }>('SELECT count(*)::int AS n FROM "Invoice" WHERE "tenantId" = $1', [A.tenant]))[0]!.n

beforeAll(async () => {
  db = await migratedDatabase('from_ddts_candidates')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: ns })
  money = await seedMoney({ db: database, namespace: ns })
  // Made-up legal data of the seller (c.c. art. 2250), as the invoicing tests set it, so a draft can be made from the body.
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "regimeFiscale" = 'RF01', "reaOffice" = 'MI', "reaNumber" = '0000001', address = $2::jsonb WHERE id = $1`, [
    A.companyA,
    JSON.stringify({ line1: 'Via Esempio 1', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' }),
  ])
  const number = async (code: string) => (await admin<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2', [A.tenant, code]))[0]!.id
  S.so1 = await number('SEED-SO-0001')
  S.so2 = await number('SEED-SO-0002')
  S.so3 = await number('SEED-SO-0003')
  const a = await shippedCopy('A1', A.brandA)
  const b = await shippedCopy('B1', A.brandB)
  Object.assign(S, { orderA: a.orderId, ddtA: a.ddtId, orderB: b.orderId, ddtB: b.ddtId })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null), logger: false },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('B-TH-062: invoice the shipped goods of chosen orders (Finance)', () => {
  it('two customers → two drafts named before anything is made, each with the body From-DDTs takes; the rest held with why', async () => {
    const before = await invoiceCount()
    const answer = await candidates('finance', [S.so1!, S.so2!, S.so3!, S.orderA!, S.orderB!])
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    const { drafts, held } = answer.body
    expect(drafts.map((draft: Json) => draft.code).sort()).toEqual(['SEED-C1', 'SEED-C2'])
    const draftA = drafts.find((draft: Json) => draft.partyId === A.brandA)
    expect(draftA).toMatchObject({ companyId: A.companyA, orders: [{ id: S.orderA, number: 'TEST-SO-A1' }], body: { ddtIds: [S.ddtA] } })
    expect(draftA.ddts).toEqual([expect.objectContaining({ ddtId: S.ddtA, number: 'TA1/2026', shipmentNumber: 'TEST-SH-A1', orderNumber: 'TEST-SO-A1' })])
    expect(Number(draftA.garments)).toBeGreaterThan(0)
    expect(draftA.valueAmount).toBeGreaterThan(0)
    expect(draftA.choice.words).toEqual(expect.any(String))
    expect(draftA.choice.allowed.length + (draftA.choice.suggested === null ? 1 : 0)).toBeGreaterThan(0)
    const draftB = drafts.find((draft: Json) => draft.partyId === A.brandB)
    expect(draftB).toMatchObject({ orders: [{ id: S.orderB }], body: { ddtIds: [S.ddtB] } })
    // Nothing of brand A's in brand B's draft, nor the other way.
    expect(JSON.stringify(draftB)).not.toContain(S.orderA!)
    expect(JSON.stringify(draftA)).not.toContain(S.ddtB!)
    expect(held).toEqual([
      { orderId: S.so1, number: 'SEED-SO-0001', reason: 'NOTHING_SHIPPED', words: expect.stringContaining('SEED-SO-0001'), drafts: [] },
      { orderId: S.so2, number: 'SEED-SO-0002', reason: 'IN_DRAFT', words: expect.stringContaining('draft'), drafts: [money.draftInvoiceId] },
      { orderId: S.so3, number: 'SEED-SO-0003', reason: 'NOTHING_SHIPPED', words: expect.any(String), drafts: [] },
    ])
    // A read: no invoice was made.
    expect(await invoiceCount()).toBe(before)
  })

  it('the body opens the Finance dialog as is: From-DDTs makes exactly that draft, and the order is then held "in a draft"', async () => {
    const answer = await candidates('finance', [S.orderA!])
    const body = answer.body.drafts[0].body
    const made = await app.inject({ method: 'POST', url: '/invoicing/invoices/from-ddts', headers: { 'x-test-session': 'finance' }, payload: body })
    expect(made.statusCode, made.body).toBe(201)
    expect(made.json().invoice.lines.filter((line: Json) => line.kind === 'GOODS').map((line: Json) => line.ddtId)).toEqual(expect.arrayContaining([S.ddtA]))
    const after = await candidates('finance', [S.orderA!])
    expect(after.body.drafts).toEqual([])
    expect(after.body.held).toEqual([expect.objectContaining({ orderId: S.orderA, reason: 'IN_DRAFT', drafts: [made.json().invoice.id] })])
  })

  it('W27: a person limited to brand B gets brand B only; brand A orders are left out, never named', async () => {
    const answer = await candidates('brandBOnly', [S.so1!, S.so2!, S.orderA!, S.orderB!])
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body.drafts.map((draft: Json) => draft.partyId)).toEqual([A.brandB])
    expect(answer.body.held).toEqual([])
    for (const marker of [S.so1!, S.so2!, S.orderA!, S.ddtA!, 'SEED-C1', 'SEED-SO-0001', 'TEST-SO-A1', 'TA1/2026']) expect(JSON.stringify(answer.body)).not.toContain(marker)
  })

  it('finance only: without invoices.manage 403, a portal session 403; without the price grain no amount', async () => {
    expect((await candidates('viewer', [S.orderB!])).status).toBe(403)
    expect((await candidates('partner', [S.orderA!])).status).toBe(403)
    const noPrice = await candidates('noPrice', [S.orderB!])
    expect(noPrice.status).toBe(200)
    expect(noPrice.body.drafts[0]).not.toHaveProperty('valueAmount')
    expect(noPrice.body.drafts[0].body).toEqual({ ddtIds: [S.ddtB] })
  })

  it('asks for at least one order, at most 100, by id', async () => {
    const empty = await app.inject({ method: 'GET', url: '/invoicing/from-ddts/candidates?orderIds=', headers: { 'x-test-session': 'finance' } })
    expect(empty.statusCode).toBe(400)
    const bad = await app.inject({ method: 'GET', url: '/invoicing/from-ddts/candidates?orderIds=not-an-id', headers: { 'x-test-session': 'finance' } })
    expect(bad.statusCode).toBe(400)
    const unknown = await candidates('finance', [newId()])
    expect(unknown.body).toMatchObject({ drafts: [], held: [] })
  })
})
