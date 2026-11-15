import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAccounting, type AccountingSeed } from '../../../../../../packages/factory-db/seed/accounting'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, COMMAND_SETTINGS } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { ensureBuiltInRules } from '../../../platform/alerts/built-in'
import { evaluateKind } from '../../../platform/alerts/engine'
import { systemContext } from '../../../platform/outbox/system'

/**
 * Margins in depth on the local stack (B-W2b-416; FIN-050 low-margin alert, FIN-053 order profitability report with
 * documents; follow-up KA3:01) with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the
 * runtime login: row-level security is real), the factory-db seeds up to accounting, with the seed's people and roles (the
 * owner made every quote and order: they hold `owner` over every company).
 *
 *   SEED-SO-0001   5,040.00, cost at quote 3,606.00: 28.45 % quoted and estimated now (its accepted version was priced
 *                  under the floor it was held to then: a yes let it through); its 30 % deposit request PAID by one
 *                  transfer and billed by the deposit invoice TD02 FT-2026-00003 (DELIVERED)
 *   SEED-SO-0002   2,800.00, SEED-WO-0001 makes all 7 (estimate at release 2,037.78): 27.22 % now; 319.94 spent (the hide
 *                  223.44 + the sewing labour 96.50); shipment SH-0001 left with DDT 144/2026, the carrier's 18.50 recorded on
 *                  it; the deferred invoice TD24 of its two shipped jackets is a DRAFT (800.00)
 *   SEED-SO-0003   no cost at quote, its work order without a complete estimate: its margin is not known
 *
 * The Sales settings floor is the company's 20 % (the sales seed's tenant row): nothing is below it until a role floor of
 * the owner (who sold them) of 29 % puts SO-0001 and SO-0002 under it. Every figure is made up and worked out by hand.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/costing/profitability`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seeded: AccountingSeed

const NS = 'costing-profitability'
const id = (key: string) => seedUuid(NS, key)
const tenant = id('tenant')
const companyB = id('company:B')
const run = randomBytes(4).toString('hex')

const grant = (permissions: readonly string[], companies: Grant['companies'] = 'all', parties: Grant['parties'] = 'all'): Grant => ({ permissions: permissions as Permission[], companies, sites: 'all', parties })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants })
const fromTemplate = (name: string): SessionContext => {
  const role = templateOf(name)!
  return office([grant([...role.permissions, ...role.grains.map((g) => `money.${g}`)])])
}
const SESSIONS: Record<string, SessionContext> = {
  finance: fromTemplate('finance'),
  sales: fromTemplate('sales'),
  production: fromTemplate('production_manager'),
  warehouse: fromTemplate('warehouse'),
  // Costs only, and no invoices, payments or shipments: those groups are held.
  costOnly: office([grant(['costing.view', 'alerts.view', 'money.cost'])]),
  companyB: office([grant(['costing.view', 'invoices.view', 'money.cost', 'money.price', 'money.margin'], [companyB])]),
  otherParty: office([grant(['costing.view', 'money.cost', 'money.price', 'money.margin'], 'all', [newId()])]),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
async function ok(session: string, url: string): Promise<Json> {
  const response = await call(session, url)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : []
const orderOf = async (number: string) => (await admin<{ id: string }>('SELECT id FROM "SalesOrder" WHERE number = $1', [number]))[0]!.id
const docs = async (session: string, number: string) => ok(session, `/costing/margins/orders/${await orderOf(number)}/documents`)
const system = () => callerFor(database, systemContext(tenant, `test-${run}-${newId()}`))
const setFloors = async (floors: Record<string, string> | null) => admin(`UPDATE "SalesSettings" SET "marginFloorByRole" = $2::jsonb WHERE "tenantId" = $1`, [tenant, floors === null ? null : JSON.stringify(floors)])

beforeAll(async () => {
  db = await migratedDatabase('costing_profit')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 16 } })
  await seedCore({ db: database, namespace: NS })
  await seedAuth({ db: database, namespace: NS })
  await seedRoles({ db: database, namespace: NS })
  await seedNumbering({ db: database, namespace: NS })
  await seedPrivacy({ db: database, namespace: NS })
  seeded = await seedAccounting({ db: database, namespace: NS })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the order profitability report with every document (FIN-053)', () => {
  it("lists SO-0001's deposit invoice and the transfer that paid its deposit request, each with the id its page opens", async () => {
    const answer = await docs('finance', 'SEED-SO-0001')
    const [deposit] = await admin<{ netTotal: number; grossTotal: number; number: string }>('SELECT "netTotal", "grossTotal", number FROM "Invoice" WHERE id = $1', [seeded.money.depositInvoiceId])
    expect(answer.invoices).toEqual({
      held: null,
      rows: [{ id: seeded.money.depositInvoiceId, kind: 'DEPOSIT_INVOICE', docType: 'TD02', number: deposit!.number, status: 'DELIVERED', issueDate: '2026-10-29', currency: 'EUR', netTotal: deposit!.netTotal, grossTotal: deposit!.grossTotal, forOrder: deposit!.netTotal, shared: false, of: null }],
    })
    expect(answer.creditNotes).toEqual({ held: null, rows: [] })
    // The deposit request is paid by its whole transfer (the gross); a deposit invoice is listed, never added to "invoiced".
    expect(answer.payments.rows).toEqual([
      { id: seeded.money.depositPaymentId, reference: 'SEED-TRN-0000001', method: 'BANK_TRANSFER', status: 'RECEIVED', receivedOn: '2026-10-29', currency: 'EUR', amount: deposit!.grossTotal, paid: deposit!.grossTotal, to: [{ type: 'DepositRequest', id: expect.any(String), number: null }], reversed: false },
    ])
    expect(answer.totals).toEqual({ invoiced: 0, credited: 0, net: 0, deposits: deposit!.netTotal, paid: deposit!.grossTotal, freightCharged: 0, freightCost: 0, otherCurrency: 0 })
    // No work order makes it, nothing shipped.
    expect(answer.costs.rows).toEqual([])
    expect(answer.freight.rows).toEqual([])
  })

  it("lists SO-0002's draft deferred invoice (listed, not counted), its work order's cost, its shipment's freight", async () => {
    const answer = await docs('finance', 'SEED-SO-0002')
    expect(answer.invoices.rows.map((row: Json) => [row.kind, row.status, row.number, row.forOrder, row.shared])).toEqual([['DEFERRED_INVOICE', 'DRAFT', null, 80_000, false]])
    expect(answer.totals.invoiced).toBe(0)
    const wo = await admin<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE number = 'SEED-WO-0001'`)
    expect(answer.costs.rows).toEqual([
      { kind: 'WORK_ORDER', record: { type: 'WorkOrder', id: wo[0]!.id, number: 'SEED-WO-0001' }, status: expect.any(String), date: expect.any(String), currency: 'EUR', amount: 31_994, entries: 2, pieces: 7, ofPieces: 7, reversed: false },
    ])
    expect(answer.freight.rows).toHaveLength(1)
    expect(answer.freight.rows[0]).toMatchObject({ shipment: { status: 'SHIPPED' }, date: expect.any(String), chargeCurrency: 'EUR', costCurrency: 'EUR', cost: 1850 })
    expect(answer.totals.freightCost).toBe(1850)
    expect(answer.notes).toEqual(['NOT_ISSUED'])
  })

  it("says a shipment that left without the carrier's cost, and adds the cost once it is recorded (the cost grain)", async () => {
    const order = await orderOf('SEED-SO-0002')
    await admin(`UPDATE "Shipment" SET "freightCost" = NULL, "freightCostCurrency" = NULL WHERE "salesOrderId" = $1`, [order])
    const missing = await docs('finance', 'SEED-SO-0002')
    expect(missing.freight.rows[0]).toMatchObject({ costCurrency: null, cost: null })
    expect(missing.notes).toEqual(['FREIGHT_COST_MISSING', 'NOT_ISSUED'])
    await admin(`UPDATE "Shipment" SET "freightCost" = 3850, "freightCostCurrency" = 'EUR' WHERE "salesOrderId" = $1`, [order])
    const answer = await docs('finance', 'SEED-SO-0002')
    expect(answer.freight.rows[0]).toMatchObject({ costCurrency: 'EUR', cost: 3850 })
    expect(answer.totals.freightCost).toBe(3850)
    expect(answer.notes).toEqual(['NOT_ISSUED'])
  })

  it('by grain and permission: sales see prices and no cost; a role without invoices, payments or shipments sees them held; out of scope is not found', async () => {
    const sales = await docs('sales', 'SEED-SO-0002')
    expect(sales.invoices.rows[0]).toHaveProperty('forOrder', 80_000)
    expect(keysOf(sales.costs)).not.toContain('amount')
    expect(sales.freight.rows[0]).not.toHaveProperty('cost')
    expect(sales.totals).not.toHaveProperty('freightCost')
    const costOnly = await docs('costOnly', 'SEED-SO-0001')
    expect([costOnly.invoices.held, costOnly.creditNotes.held, costOnly.freight.held, costOnly.payments.held, costOnly.costs.held]).toEqual(['invoices.view', 'invoices.view', 'shipping.view', 'payments.view', null])
    expect([costOnly.invoices.rows, costOnly.payments.rows]).toEqual([[], []])
    expect(costOnly.totals).toEqual({ freightCost: null, otherCurrency: 0 })
    for (const session of ['companyB', 'otherParty']) expect((await call(session, `/costing/margins/orders/${await orderOf('SEED-SO-0001')}/documents`)).statusCode).toBe(404)
    expect((await call('warehouse', `/costing/margins/orders/${await orderOf('SEED-SO-0001')}/documents`)).statusCode).toBe(403)
    expect((await call('finance', '/costing/margins/orders/not-an-id/documents')).statusCode).toBe(400)
  })
})

describe('orders below the margin floor (FIN-050; KA3:01 the Sales settings floors)', () => {
  it("reads the company's floor (20 %) when no role has one: nothing below; the floor and the flag on every row", async () => {
    await setFloors(null)
    const answer = await ok('finance', '/costing/margins')
    const by = Object.fromEntries(answer.rows.map((row: Json) => [row.order.number, row]))
    // SO-0001's accepted version was priced under its floor then (a yes let it through): said, never judged on.
    expect(by['SEED-SO-0001']).toMatchObject({ belowFloor: false, floor: { pct: '20', from: 'COMPANY', role: null, basis: 'ESTIMATE', quotedBelow: true } })
    expect(by['SEED-SO-0002']).toMatchObject({ belowFloor: false, floor: { from: 'COMPANY', basis: 'ESTIMATE', quotedBelow: false } })
    expect(by['SEED-SO-0003']).toMatchObject({ belowFloor: null, floor: { pct: '20', basis: null } })
    expect(answer.tiles.belowFloor).toBe(0)
    expect((await ok('finance', '/costing/margins?floor=below')).rows).toEqual([])
  })

  it("holds an order to its seller's role floor: the owner's 29 % puts SO-0001 (28.45 %) and SO-0002 (27.22 %) under it", async () => {
    await setFloors({ owner: '29', sales: '25' })
    const answer = await ok('finance', '/costing/margins')
    expect(answer.tiles.belowFloor).toBe(2)
    const so1 = answer.rows.find((row: Json) => row.order.number === 'SEED-SO-0001')
    expect(so1).toMatchObject({ belowFloor: true, floor: { pct: '29', from: 'ROLE', role: 'Owner', basis: 'ESTIMATE' } })
    // Newest first, as the list reads (by id).
    expect((await ok('finance', '/costing/margins?floor=below')).rows.map((row: Json) => row.order.number)).toEqual(['SEED-SO-0001', 'SEED-SO-0002'])
    // The order's profitability says the same.
    expect(await ok('finance', `/costing/margins/orders/${await orderOf('SEED-SO-0002')}`)).toMatchObject({ belowFloor: true, floor: { pct: '29', from: 'ROLE' } })
    // Sales hold the margin grain: they see the flag and the floor, never a cost.
    const sales = await ok('sales', '/costing/margins?floor=below')
    expect(sales.rows[0]).toMatchObject({ belowFloor: true, floor: { pct: '29' } })
    expect(sales.tiles.belowFloor).toBe(2)
  })

  it('never sends the floor or the flag without the margin grain (the production manager reads margins with costing.view only)', async () => {
    const answer = await ok('production', '/costing/margins')
    expect(keysOf(answer)).not.toContain('floor')
    expect(keysOf(answer)).not.toContain('belowFloor')
    expect(await ok('production', `/costing/margins/orders/${await orderOf('SEED-SO-0001')}`)).not.toHaveProperty('floor')
  })

  it('raises the low-margin alert for finance (no figure in it), hides it without the margin grain, and clears it when the floor comes back', async () => {
    await ensureBuiltInRules(system(), COMMAND_SETTINGS)
    const rule = (await admin<{ recipient: string; enabled: boolean }>(`SELECT r.key AS recipient, a.enabled FROM "AlertRule" a JOIN "Role" r ON r.id = a."recipientRoleId" WHERE a."tenantId" = $1 AND a."ruleKind" = 'MARGIN_BELOW_FLOOR' AND a."builtIn"`, [tenant]))[0]
    expect(rule).toEqual({ recipient: 'finance', enabled: true })
    expect((await evaluateKind(system(), 'MARGIN_BELOW_FLOOR', COMMAND_SETTINGS)).raised).toBe(2)
    const alerts = await admin<Json>(`SELECT "recordType", "recordLabel", state, facts FROM "Alert" WHERE "tenantId" = $1 AND "ruleKind" = 'MARGIN_BELOW_FLOOR' ORDER BY "recordLabel"`, [tenant])
    expect(alerts).toEqual([
      { recordType: 'SalesOrder', recordLabel: 'SEED-SO-0001', state: 'OPEN', facts: { basis: 'ESTIMATE', quotedBelow: true, status: expect.any(String) } },
      { recordType: 'SalesOrder', recordLabel: 'SEED-SO-0002', state: 'OPEN', facts: { basis: 'ESTIMATE', quotedBelow: false, status: expect.any(String) } },
    ])
    // A second pass raises nothing twice.
    expect((await evaluateKind(system(), 'MARGIN_BELOW_FLOOR', COMMAND_SETTINGS)).raised).toBe(0)
    const seen = (answer: Json) => (answer.items as Json[]).filter((alert) => alert.ruleKind === 'MARGIN_BELOW_FLOOR').map((alert) => alert.record.label).sort()
    const one = (await ok('finance', '/alerts?ruleKind=MARGIN_BELOW_FLOOR')).items.find((alert: Json) => alert.record.label === 'SEED-SO-0002')
    expect(one).toMatchObject({ record: { type: 'SalesOrder' }, words: { key: 'alerts.MARGIN_BELOW_FLOOR', params: { label: 'SEED-SO-0002' } }, sentence: 'The margin of order SEED-SO-0002, as estimated now, is below its margin floor.' })
    // SO-0001 was quoted under its floor with a yes: its alert says so.
    const quoted = (await ok('finance', '/alerts?ruleKind=MARGIN_BELOW_FLOOR')).items.find((alert: Json) => alert.record.label === 'SEED-SO-0001')
    expect(quoted.words.key).toBe('alerts.MARGIN_BELOW_FLOOR.QUOTED')
    expect(seen(await ok('finance', '/alerts'))).toEqual(['SEED-SO-0001', 'SEED-SO-0002'])
    expect(seen(await ok('production', '/alerts'))).toEqual([])
    expect(seen(await ok('costOnly', '/alerts'))).toEqual([])
    // The floor back under both margins: the system clears them.
    await setFloors({ owner: '25' })
    expect((await evaluateKind(system(), 'MARGIN_BELOW_FLOOR', COMMAND_SETTINGS)).cleared).toBe(2)
    expect((await admin<{ state: string }>(`SELECT state FROM "Alert" WHERE "tenantId" = $1 AND "ruleKind" = 'MARGIN_BELOW_FLOOR'`, [tenant])).map((row) => row.state)).toEqual(['RESOLVED', 'RESOLVED'])
  })
})
