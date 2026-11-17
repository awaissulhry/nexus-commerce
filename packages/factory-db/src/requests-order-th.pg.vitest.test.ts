import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedSales, type SalesSeed } from '../seed/sales'
import { seed as seedSalesIntake, type SalesIntakeSeed } from '../seed/sales-intake'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * A request becomes an order (TH-2, threads schema wave 3/9, B-TH-022; …_sales_intake_orders_th_guards and the generated policy
 * migration), on a database built from the migrations and seeded twice, through the real login and the scoped client:
 *   - the brand wall (W01): the customer's portal people read the order its request became (salesOrderId) and the ORDERED state,
 *     never the style drafts made from it (styleIds) or the decline reason; another customer reads nothing of it;
 *   - ORDERED exactly with the order: reached only from an open state, never at insert, an order of the request's own company and
 *     customer (the reference), never a prospect's, named once, one request per order, closed with when and by whom, then final;
 *   - "Not an order": DECLINED with NOT_AN_ORDER needs no words;
 *   - the style drafts: none at insert, then only added at the end, each once, at most 50, styles of the request's company or
 *     tenant-wide, our own collection or the request's customer's private label, never another customer's.
 * The refusals are check_violation (23514); their messages are read through raw SQL.
 */

const NS = 'th-022-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: SalesIntakeSeed
let sales: SalesSeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  companyB: key('company:B'),
  P1: key('party:P1'),
  P3: key('party:P3'),
  jacket: key('product:style:JKT-01'),
}
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const partner = (partyId: string): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const one = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows[0] as Record<string, unknown>
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) =>
  run(scope, `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`

/** A new open inquiry of company A: a copy of SEED-INQ-0001 (NEW, a prospect) with `changes`. */
async function newInquiry(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  expect(await copyRow(office(), 'Inquiry', s.inquiryIds.prospect, { id, number: tag('T-INQ'), ...changes })).toBe(1)
  return id
}
/** An open inquiry of a customer (the prospect columns cleared). */
const customerInquiry = (partyId: string, changes: Record<string, unknown> = {}) =>
  newInquiry({ partyId, prospectName: null, prospectCompany: null, prospectEmail: null, prospectPhone: null, prospectLawfulBasis: null, ...changes })
/** Make `id` ORDERED with `orderId`, closed now by the office user. */
const order = (id: string, orderId: string, set = '') =>
  update(office(), 'Inquiry', id, `status = 'ORDERED', "salesOrderId" = $2::uuid, "closedAt" = now(), "closedById" = $3::uuid${set}`, orderId, a.actorId)
/** A style of company A copied from the jacket, with `changes` (our own collection unless a brand is given). */
async function newStyle(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  expect(await copyRow(office(), 'Style', A.jacket, { id, code: tag('T-STY'), brandPartyId: null, ...changes })).toBe(1)
  return id
}
/** A new order of P1 in company A: a copy of the seeded order (its number given anew). */
async function newOrder(): Promise<string> {
  const id = randomUUID()
  expect(await copyRow(office(), 'SalesOrder', sales.orderId, { id, number: tag('T-SO'), customerSeq: null })).toBe(1)
  return id
}
const styleIdsOf = async (id: string) => (await one(`SELECT "styleIds"::text[] AS ids FROM "Inquiry" WHERE id = $1::uuid`, [id])).ids as string[]

beforeAll(async () => {
  db = await migratedDatabase('requestsorderth')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  s = await seedSalesIntake({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedSalesIntake({ db: factory, namespace: NS })
  sales = await seedSales({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the brand wall (W01)', () => {
  it('the customer reads the order its request became, never the style drafts or the decline reason; another customer nothing', async () => {
    const id = await customerInquiry(A.P1)
    const draft = await newStyle()
    expect(await update(office(), 'Inquiry', id, `"styleIds" = ARRAY[$2::uuid]`, draft)).toBe(1)
    const made = await newOrder()
    expect(await order(id, made)).toBe(1)
    expect(await sql(partner(A.P1), `SELECT status::text AS status, "salesOrderId" FROM "Inquiry" WHERE id = $1::uuid`, id)).toEqual([{ status: 'ORDERED', salesOrderId: made }])
    await expect(sql(partner(A.P1), `SELECT "styleIds" FROM "Inquiry" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(partner(A.P1), `SELECT "declineReason" FROM "Inquiry" LIMIT 1`)).rejects.toThrow(/permission denied/)
    expect(await sql(partner(A.P3), `SELECT id FROM "Inquiry" WHERE id = $1::uuid OR "salesOrderId" = $2::uuid`, id, made)).toEqual([])
  })
})

describe('ORDERED exactly with the order', () => {
  it('is reached from an open state with an order of its own customer, named once, one request per order, then final', async () => {
    const made = await newOrder()
    // Not at insert, and never without its order or an order without the state.
    await expect(customerInquiry(A.P1, { status: 'ORDERED', salesOrderId: made })).rejects.toThrow(/logged open .* not closed, quoted, ordered or erased/)
    await expect(customerInquiry(A.P1, { salesOrderId: made })).rejects.toThrow(/logged open .* not closed, quoted, ordered or erased/)
    const id = await customerInquiry(A.P1)
    await expect(update(office(), 'Inquiry', id, `status = 'ORDERED', "closedAt" = now(), "closedById" = $2::uuid`, a.actorId)).rejects.toThrow(/ORDERED exactly with the order it became/)
    await expect(update(office(), 'Inquiry', id, `"salesOrderId" = $2::uuid`, made)).rejects.toThrow(/ORDERED exactly with the order it became/)
    // Closed with when and by whom, as QUOTED, DECLINED and LOST.
    await expect(update(office(), 'Inquiry', id, `status = 'ORDERED', "salesOrderId" = $2::uuid`, made)).rejects.toThrow(/wrong closing time \(QUOTED, ORDERED, DECLINED, LOST and WITHDRAWN have one/) // B-TH-090: WITHDRAWN
    // Another customer's order: the reference holds the request's company and customer.
    await expect(order(await customerInquiry(A.P3), made)).rejects.toThrow(/Inquiry_tenantId_companyId_partyId_salesOrderId_fkey|foreign key/)
    // A prospect's request is matched to its customer first.
    await expect(order(await newInquiry(), made)).rejects.toThrow(/ORDERED exactly with the order it became \(an order of its customer\)/)
    expect(await order(id, made)).toBe(1)
    // One request per order.
    await expect(order(await customerInquiry(A.P1), made)).rejects.toThrow(/Inquiry_one_per_order|duplicate key/)
    // Final and frozen: no way back, no other order, only its note.
    await expect(update(office(), 'Inquiry', id, `status = 'ASSIGNED', "salesOrderId" = NULL, "closedAt" = NULL, "closedById" = NULL, "assigneeId" = $2::uuid, "assignedAt" = now()`, a.actorId)).rejects.toThrow(/cannot move from ORDERED to ASSIGNED \(QUOTED, ORDERED, DECLINED, LOST and WITHDRAWN are final\)/) // B-TH-090: WITHDRAWN
    await expect(update(office(), 'Inquiry', id, `"salesOrderId" = NULL`)).rejects.toThrow(/is ORDERED and never changes/)
    await expect(update(office(), 'Inquiry', id, `request = 'changed'`)).rejects.toThrow(/is ORDERED and never changes/)
    expect(await update(office(), 'Inquiry', id, `note = 'Order made from the request.'`)).toBe(1)
    // A QUOTED request stays QUOTED: the order of its quote is the quote's, never the request's.
    await expect(order(s.inquiryIds.quoted, await newOrder())).rejects.toThrow(/cannot move from QUOTED to ORDERED/)
  })
})

describe('"Not an order" (NOT_AN_ORDER)', () => {
  it('declines a request that asks nothing to make, without words', async () => {
    const id = await customerInquiry(A.P3)
    expect(await update(office(), 'Inquiry', id, `status = 'DECLINED', "declineReason" = 'NOT_AN_ORDER', "closedAt" = now(), "closedById" = $2::uuid`, a.actorId)).toBe(1)
    expect(await one(`SELECT status::text AS status, "declineReason"::text AS reason, "closeNote" FROM "Inquiry" WHERE id = $1::uuid`, [id])).toEqual({ status: 'DECLINED', reason: 'NOT_AN_ORDER', closeNote: null })
    // The customer reads it closed, never the reason.
    expect(await sql(partner(A.P3), `SELECT status::text AS status FROM "Inquiry" WHERE id = $1::uuid`, id)).toEqual([{ status: 'DECLINED' }])
  })
})

describe('the style drafts made from a request (B-TH-026)', () => {
  it('are only added, each once, at most 50, of its company or tenant-wide, never another customer\'s private label', async () => {
    const own = await newStyle()
    const second = await newStyle()
    const tenantWide = await newStyle({ companyId: null })
    const otherCompany = await newStyle({ companyId: A.companyB })
    // None at insert.
    await expect(customerInquiry(A.P3, { styleIds: [own] })).rejects.toThrow(/logged with no style draft made from it yet/)
    const id = await customerInquiry(A.P3)
    expect(await update(office(), 'Inquiry', id, `"styleIds" = ARRAY[$2::uuid]`, own)).toBe(1)
    expect(await update(office(), 'Inquiry', id, `"styleIds" = ARRAY[$2::uuid, $3::uuid, $4::uuid]`, own, second, tenantWide)).toBe(1)
    expect(await styleIdsOf(id)).toEqual([own, second, tenantWide])
    // Never taken off, moved or named twice.
    await expect(update(office(), 'Inquiry', id, `"styleIds" = ARRAY[$2::uuid]`, own)).rejects.toThrow(/only added, after the ones named before/)
    await expect(update(office(), 'Inquiry', id, `"styleIds" = ARRAY[$2::uuid, $3::uuid, $4::uuid]`, second, own, tenantWide)).rejects.toThrow(/only added, after the ones named before/)
    await expect(update(office(), 'Inquiry', id, `"styleIds" = "styleIds" || $2::uuid`, own)).rejects.toThrow(/at most 50 styles, each once/)
    await expect(update(office(), 'Inquiry', id, `"styleIds" = NULL`)).rejects.toThrow(/at most 50 styles, each once/)
    // Of the request's company or tenant-wide, a style that exists.
    await expect(update(office(), 'Inquiry', id, `"styleIds" = "styleIds" || $2::uuid`, otherCompany)).rejects.toThrow(/of another company as a style draft/)
    await expect(update(office(), 'Inquiry', id, `"styleIds" = "styleIds" || $2::uuid`, randomUUID())).rejects.toThrow(/not a style of the tenant/)
    // P1's private-label jacket never on P3's request; on P1's own it is.
    await expect(update(office(), 'Inquiry', id, `"styleIds" = "styleIds" || $2::uuid`, A.jacket)).rejects.toThrow(/another customer's private-label style as a style draft/)
    const p1 = await customerInquiry(A.P1)
    expect(await update(office(), 'Inquiry', p1, `"styleIds" = ARRAY[$2::uuid]`, A.jacket)).toBe(1)
    // A request with P1's jacket never moves to P3.
    await expect(update(office(), 'Inquiry', p1, `"partyId" = $2::uuid`, A.P3)).rejects.toThrow(/private-label style/)
    // At most 50.
    const many = await customerInquiry(A.P3)
    const fifty: string[] = []
    for (let index = 0; index < 51; index++) fifty.push(await newStyle())
    expect(await update(office(), 'Inquiry', many, `"styleIds" = $2::uuid[]`, fifty.slice(0, 50))).toBe(1)
    await expect(update(office(), 'Inquiry', many, `"styleIds" = $2::uuid[]`, fifty)).rejects.toThrow(/at most 50 styles, each once/)
    // Frozen with the request once it is closed.
    expect(await order(p1, await newOrder())).toBe(1)
    await expect(update(office(), 'Inquiry', p1, `"styleIds" = "styleIds" || $2::uuid`, own)).rejects.toThrow(/is ORDERED and never changes/)
  })
})
