import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedAuth } from '../seed/auth'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedPortalAuth, type PortalAuthSeed } from '../seed/portal-auth'
import { seed as seedTwoBrands, type TwoBrandsSeed } from '../seed/two-brands'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { seedCustomerPage, type CustomerPageFixture } from './testing/customer-page'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * B-OM-019 (order money tab, schema wave "order money 1/1"; design order-money-2026-11-22 13-backend §5; lead L2, L4; Owner D4):
 * the wave's rules (…_order_money_guards) on a database built from the migrations and seeded, through the real login and the
 * scoped client. P1 (Brand Alpha, the seeds' customer: SEED-SO-0001, testing/customer-page.ts) and Brand Beta (seed/two-brands.ts).
 *   - OrderPriceAcceptance: starts in force; never changed but for its taking back (when, by whom and why, all three, once); never
 *     deleted (no DELETE grant; the guard for the owner); both nets at least 0 and a reason of 3 to 500; never on a CLOSED or
 *     CANCELLED order (READY, SHIPPED, DELIVERED stay open); at most one in force per order; the order's company and customer
 *     (the key); TRUNCATE refused; office only (the partner and the floor are denied);
 *   - OrderCostLine: starts counted; never changed but for its removal (all three, once); never deleted; an amount above 0 in
 *     the order's currency and a reason of 3 to 500; never on a CLOSED or CANCELLED order; TRUNCATE refused; office only;
 *   - SalesOrder.targetMarginPct: set on an open order, frozen with a CLOSED one (the order's guard); hidden from the partner.
 * The refusals are check_violation (SQLSTATE 23514; a key a unique_violation or a foreign_key_violation, a grant "permission
 * denied"); their words name no customer (the brand wall). Rows only time reaches (an order in another state) are planted by the
 * owner with triggers off. Every name and figure is made up. Not run in the build (Owner rule: checks at the end).
 */

const NS = 'om019-order-money'
const DENIED = /permission denied/
const UNIQUE = /Unique constraint|duplicate key|unique/i
const FOREIGN = /_fkey|foreign key/i
// OrderPriceAcceptance
const IN_FORCE = /starts in force, not taken back/
const NEVER_CHANGES = /never changes; it is taken back once/
const TAKEN_BACK = /is taken back already/
const ALL_THREE = /is taken back with when, by whom and why \(3 to 500 characters\), all three/
const NETS = /has both nets at least 0 and a reason of 3 to 500 characters/
const PRICE_CLOSED = /its price check stays as it was/
const NOT_DELETED = /is never deleted; it is taken back/
// OrderCostLine
const COUNTED = /starts counted, not removed/
const LINE_NEVER_CHANGES = /never changes; it is removed once/
const REMOVED = /is removed already/
const REMOVE_ALL_THREE = /is removed with when, by whom and why \(3 to 500 characters\), all three/
const LINE_SHAPE = /has an amount above 0, an ISO currency and a reason of 3 to 500 characters/
const LINE_CURRENCY = /is in the order's currency/
const COST_CLOSED = /its costs stay as they were/
const LINE_NOT_DELETED = /is never deleted; it is removed with a reason/
const TRUNCATE = /TRUNCATE on .* is refused/
// SalesOrder
const ORDER_FROZEN = /it never changes/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let portal: PortalAuthSeed
let two: TwoBrandsSeed
let cp: CustomerPageFixture

const key = (name: string): string => seedUuid(NS, name)
const P1 = key('party:P1')
const companyA = key('company:A')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: key('site:A1') })
const p1 = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: portal.userIds.p1Buyer, partyId: P1 })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row).map((column) => `"${column}"`).join(', ')
  return run(scope, `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row))
}
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const remove = (scope: FactoryScope, table: string, id: string) => run(scope, `DELETE FROM "${table}" WHERE id = $1::uuid`, id)
/** The owner, with every trigger off for one statement (set-up only: rows only time reaches). */
async function replica(text: string, values: unknown[]): Promise<void> {
  await db.admin.query('BEGIN')
  try {
    await db.admin.query("SET LOCAL session_replication_role = 'replica'")
    await db.admin.query(text, values)
    await db.admin.query('COMMIT')
  } catch (error) {
    await db.admin.query('ROLLBACK')
    throw error
  }
}
/** A copy of row `id` of `table` with `changes`, planted. */
const plant = (table: string, id: string, changes: Record<string, unknown>) =>
  replica(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, [JSON.stringify(changes), id])
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
const refusalOf = (work: Promise<unknown>): Promise<string | null> => work.then(() => null, (error: Error) => error.message)
/** Neutral words: no customer id, code or name in a refusal (the brand wall). */
async function expectNeutral(words: string | null): Promise<void> {
  expect(words).not.toBeNull()
  const parties = await admin(`SELECT id::text AS id, code, "legalName" AS legal, coalesce("tradeName", '') AS trade FROM "Party" WHERE id IN ($1::uuid, $2::uuid)`, [P1, two.second.partyId])
  for (const party of parties) for (const word of [party.id, party.code, party.legal, party.trade].map(String).filter((entry) => entry.length > 0)) expect(words).not.toContain(word)
}

/** An order of P1: a copy of SEED-SO-0001 in `status` (no lines: the guards read the order only), planted; its id. */
async function order(status: string): Promise<string> {
  const id = randomUUID()
  const now = new Date().toISOString()
  await plant('SalesOrder', cp.orderId, {
    id,
    number: tag('T-SO'),
    customerSeq: null,
    status,
    closedAt: status === 'CLOSED' || status === 'CANCELLED' ? now : null,
    cancelReason: status === 'CANCELLED' ? 'Made-up: the customer withdrew it.' : null,
    deliveredAt: status === 'DELIVERED' ? now : null,
    confirmationSentAt: null,
    confirmationVersion: null,
    targetMarginPct: null,
  })
  return id
}
let currency: string
/** An accepted price difference of `orderId`, with `extra`. */
const acceptance = (orderId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: companyA,
  partyId: P1,
  salesOrderId: orderId,
  ourNet: 82_000,
  brandNet: 80_000,
  reason: 'Made-up: agreed by phone.',
  acceptedById: a.actorId,
  ...extra,
})
/** A hand cost line of `orderId`, with `extra`. */
const costLine = (orderId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: companyA,
  partyId: P1,
  salesOrderId: orderId,
  kind: 'COMMISSION',
  amount: 30_000,
  currency,
  reason: 'Made-up agent commission.',
  createdById: a.actorId,
  ...extra,
})
const withdraw = (id: string, reason = 'Made-up: not confirmed in writing.') => update(office(), 'OrderPriceAcceptance', id, `"withdrawnAt" = now(), "withdrawnById" = $2::uuid, "withdrawReason" = $3`, a.actorId, reason)
const takeOff = (id: string, reason = 'Made-up: the agent waived it.') => update(office(), 'OrderCostLine', id, `"removedAt" = now(), "removedById" = $2::uuid, "removeReason" = $3`, a.actorId, reason)

beforeAll(async () => {
  db = await migratedDatabase('ordermoney')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedAuth({ db: factory, namespace: NS })
  portal = await seedPortalAuth({ db: factory, namespace: NS })
  cp = await seedCustomerPage({ db: factory, namespace: NS })
  two = await seedTwoBrands({ db: factory, namespace: NS })
  currency = String((await admin(`SELECT currency FROM "SalesOrder" WHERE id = $1::uuid`, [cp.orderId]))[0]!.currency)
}, 1_500_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 120_000)

// ---------------------------------------------------------------------------------------------------------------------------
describe('an accepted price difference (OrderPriceAcceptance)', () => {
  it('starts in force and is taken back once, with when, by whom and why; never changed otherwise', async () => {
    const o = await order('CONFIRMED')
    const row = acceptance(o)
    expect(await insert(office(), 'OrderPriceAcceptance', row)).toBe(1)
    // An UPDATE that changes nothing passes.
    expect(await update(office(), 'OrderPriceAcceptance', row.id as string, `reason = reason`)).toBe(1)
    await expect(update(office(), 'OrderPriceAcceptance', row.id as string, `"ourNet" = 81000`)).rejects.toThrow(NEVER_CHANGES)
    await expect(update(office(), 'OrderPriceAcceptance', row.id as string, `"withdrawnAt" = now()`)).rejects.toThrow(ALL_THREE)
    await expect(withdraw(row.id as string, 'no')).rejects.toThrow(ALL_THREE)
    expect(await withdraw(row.id as string)).toBe(1)
    await expect(withdraw(row.id as string, 'Made-up: once more.')).rejects.toThrow(TAKEN_BACK)
    await expect(insert(office(), 'OrderPriceAcceptance', acceptance(o, { withdrawnAt: new Date().toISOString(), withdrawnById: a.actorId, withdrawReason: 'Made-up: born taken back.' }))).rejects.toThrow(IN_FORCE)
  })

  it('both nets at least 0 and a reason of 3 to 500; the words name no customer', async () => {
    const o = await order('CONFIRMED')
    await expect(insert(office(), 'OrderPriceAcceptance', acceptance(o, { brandNet: -1 }))).rejects.toThrow(NETS)
    await expect(insert(office(), 'OrderPriceAcceptance', acceptance(o, { reason: '  ab  ' }))).rejects.toThrow(NETS)
    await expect(insert(office(), 'OrderPriceAcceptance', acceptance(o, { reason: 'x'.repeat(501) }))).rejects.toThrow(NETS)
    await expectNeutral(await refusalOf(insert(office(), 'OrderPriceAcceptance', acceptance(o, { ourNet: -5 }))))
  })

  it('at most one in force per order; after its taking back a new one may stand', async () => {
    const o = await order('IN_PRODUCTION')
    const first = acceptance(o)
    expect(await insert(office(), 'OrderPriceAcceptance', first)).toBe(1)
    await expect(insert(office(), 'OrderPriceAcceptance', acceptance(o, { brandNet: 79_000 }))).rejects.toThrow(UNIQUE)
    expect(await withdraw(first.id as string)).toBe(1)
    expect(await insert(office(), 'OrderPriceAcceptance', acceptance(o, { brandNet: 79_000 }))).toBe(1)
  })

  it('never on a CLOSED or CANCELLED order; READY, SHIPPED and DELIVERED stay open', async () => {
    for (const status of ['CLOSED', 'CANCELLED']) {
      const o = await order(status)
      await expect(insert(office(), 'OrderPriceAcceptance', acceptance(o)), status).rejects.toThrow(PRICE_CLOSED)
    }
    for (const status of ['READY', 'SHIPPED', 'DELIVERED']) expect(await insert(office(), 'OrderPriceAcceptance', acceptance(await order(status))), status).toBe(1)
    // One accepted while open, the order closed after: it is not taken back any more.
    const o = await order('DELIVERED')
    const row = acceptance(o)
    expect(await insert(office(), 'OrderPriceAcceptance', row)).toBe(1)
    await replica(`UPDATE "SalesOrder" SET status = 'CLOSED', "closedAt" = now() WHERE id = $1::uuid`, [o])
    await expect(withdraw(row.id as string)).rejects.toThrow(PRICE_CLOSED)
  })

  it('the order’s own company and customer (the key); never deleted; TRUNCATE refused', async () => {
    const o = await order('CONFIRMED')
    await expect(insert(office(), 'OrderPriceAcceptance', acceptance(o, { partyId: two.second.partyId }))).rejects.toThrow(FOREIGN)
    const row = acceptance(o)
    expect(await insert(office(), 'OrderPriceAcceptance', row)).toBe(1)
    await expect(remove(office(), 'OrderPriceAcceptance', row.id as string)).rejects.toThrow(DENIED)
    await expect(admin(`DELETE FROM "OrderPriceAcceptance" WHERE id = $1::uuid`, [row.id])).rejects.toThrow(NOT_DELETED)
    await expect(admin(`TRUNCATE "OrderPriceAcceptance"`)).rejects.toThrow(TRUNCATE)
  })

  it('office only: the partner and the floor are denied', async () => {
    await expect(sql(p1(), `SELECT id FROM "OrderPriceAcceptance" LIMIT 1`)).rejects.toThrow(DENIED)
    await expect(insert(p1(), 'OrderPriceAcceptance', acceptance(await order('CONFIRMED')))).rejects.toThrow(DENIED)
    await expect(sql(floor(), `SELECT id FROM "OrderPriceAcceptance" LIMIT 1`)).rejects.toThrow(DENIED)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('a hand cost line of an order (OrderCostLine)', () => {
  it('starts counted and is removed once, with when, by whom and why; never changed otherwise', async () => {
    const o = await order('CONFIRMED')
    const line = costLine(o)
    expect(await insert(office(), 'OrderCostLine', line)).toBe(1)
    expect(await update(office(), 'OrderCostLine', line.id as string, `amount = amount`)).toBe(1)
    await expect(update(office(), 'OrderCostLine', line.id as string, `amount = 31000`)).rejects.toThrow(LINE_NEVER_CHANGES)
    await expect(update(office(), 'OrderCostLine', line.id as string, `"removedAt" = now()`)).rejects.toThrow(REMOVE_ALL_THREE)
    await expect(takeOff(line.id as string, 'no')).rejects.toThrow(REMOVE_ALL_THREE)
    expect(await takeOff(line.id as string)).toBe(1)
    await expect(takeOff(line.id as string, 'Made-up: once more.')).rejects.toThrow(REMOVED)
    await expect(insert(office(), 'OrderCostLine', costLine(o, { removedAt: new Date().toISOString(), removedById: a.actorId, removeReason: 'Made-up: born removed.' }))).rejects.toThrow(COUNTED)
  })

  it('an amount above 0 in the order’s currency and a reason of 3 to 500; the words name no customer', async () => {
    const o = await order('CONFIRMED')
    await expect(insert(office(), 'OrderCostLine', costLine(o, { amount: 0 }))).rejects.toThrow(LINE_SHAPE)
    await expect(insert(office(), 'OrderCostLine', costLine(o, { currency: 'eur' }))).rejects.toThrow(LINE_SHAPE)
    await expect(insert(office(), 'OrderCostLine', costLine(o, { reason: 'ab' }))).rejects.toThrow(LINE_SHAPE)
    await expect(insert(office(), 'OrderCostLine', costLine(o, { currency: currency === 'USD' ? 'GBP' : 'USD' }))).rejects.toThrow(LINE_CURRENCY)
    await expectNeutral(await refusalOf(insert(office(), 'OrderCostLine', costLine(o, { amount: -1 }))))
    // Every kind of an added line.
    for (const kind of ['FREIGHT_ESTIMATE', 'COMMISSION', 'BANK_CHARGES', 'OTHER']) expect(await insert(office(), 'OrderCostLine', costLine(o, { kind })), kind).toBe(1)
  })

  it('never on a CLOSED or CANCELLED order: neither added nor removed', async () => {
    for (const status of ['CLOSED', 'CANCELLED']) await expect(insert(office(), 'OrderCostLine', costLine(await order(status))), status).rejects.toThrow(COST_CLOSED)
    const o = await order('SHIPPED')
    const line = costLine(o)
    expect(await insert(office(), 'OrderCostLine', line)).toBe(1)
    await replica(`UPDATE "SalesOrder" SET status = 'CLOSED', "closedAt" = now() WHERE id = $1::uuid`, [o])
    await expect(takeOff(line.id as string)).rejects.toThrow(COST_CLOSED)
  })

  it('the order’s own company and customer (the key); never deleted; TRUNCATE refused; office only', async () => {
    const o = await order('CONFIRMED')
    await expect(insert(office(), 'OrderCostLine', costLine(o, { partyId: two.second.partyId }))).rejects.toThrow(FOREIGN)
    const line = costLine(o)
    expect(await insert(office(), 'OrderCostLine', line)).toBe(1)
    await expect(remove(office(), 'OrderCostLine', line.id as string)).rejects.toThrow(DENIED)
    await expect(admin(`DELETE FROM "OrderCostLine" WHERE id = $1::uuid`, [line.id])).rejects.toThrow(LINE_NOT_DELETED)
    await expect(admin(`TRUNCATE "OrderCostLine"`)).rejects.toThrow(TRUNCATE)
    await expect(sql(p1(), `SELECT id FROM "OrderCostLine" LIMIT 1`)).rejects.toThrow(DENIED)
    await expect(insert(p1(), 'OrderCostLine', costLine(o))).rejects.toThrow(DENIED)
    await expect(sql(floor(), `SELECT id FROM "OrderCostLine" LIMIT 1`)).rejects.toThrow(DENIED)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe("an order's own target margin (SalesOrder.targetMarginPct)", () => {
  it('set and cleared on an open order; frozen with a closed one; the partner never reads it', async () => {
    const o = await order('IN_PRODUCTION')
    expect(await update(office(), 'SalesOrder', o, `"targetMarginPct" = 38.5, version = version + 1`)).toBe(1)
    expect(String((await admin(`SELECT "targetMarginPct"::text AS pct FROM "SalesOrder" WHERE id = $1::uuid`, [o]))[0]!.pct)).toBe('38.5000')
    expect(await update(office(), 'SalesOrder', o, `"targetMarginPct" = NULL, version = version + 1`)).toBe(1)
    const closed = await order('CLOSED')
    await expect(update(office(), 'SalesOrder', closed, `"targetMarginPct" = 30, version = version + 1`)).rejects.toThrow(ORDER_FROZEN)
    await expect(sql(p1(), `SELECT "targetMarginPct" FROM "SalesOrder" LIMIT 1`)).rejects.toThrow(DENIED)
  })
})
