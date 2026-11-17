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
 * Each customer's own running number (TH-1b, threads schema wave 2/9, B-TH-104; Owner decision PR-06, pick A;
 * …_sales_customer_numbers_th_guards), on a database built from the migrations and seeded, through the real login:
 *   - Inquiry, Quote and SalesOrder take customerSeq 1, 2, 3 … per company and customer, from the database, whatever the
 *     writer gave; a prospect's inquiry none until it is matched to a customer, then the next of that customer's;
 *   - plan §0 counts (W05): customer B's requests, quotes and orders never move customer A's next number, and another company
 *     keeps a series of its own;
 *   - the number never changes once given; the customer's portal people read it.
 */

const NS = 'th-104-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let sales: SalesSeed
let s: SalesIntakeSeed

const key = (name: string): string => seedUuid(NS, name)
const A = { company: key('company:A'), companyB: key('company:B'), P1: key('party:P1'), P3: key('party:P3') }
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const partner = (partyId: string): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) =>
  run(scope, `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
const seqOf = async (table: string, id: string) => (await admin(`SELECT "customerSeq" FROM "${table}" WHERE id = $1::uuid`, [id]))[0]!.customerSeq as number | null
const highest = async (table: string, companyId: string, partyId: string) =>
  Number((await admin(`SELECT coalesce(max("customerSeq"), 0) AS n FROM "${table}" WHERE "companyId" = $1::uuid AND "partyId" = $2::uuid`, [companyId, partyId]))[0]!.n)

const PROSPECT_CLEARED = { prospectName: null, prospectCompany: null, prospectEmail: null, prospectPhone: null, prospectLawfulBasis: null }
/** A new open inquiry of company A: a copy of SEED-INQ-0001 (a prospect) with `changes`. */
async function newInquiry(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  expect(await copyRow(office(), 'Inquiry', s.inquiryIds.prospect, { id, number: tag('T-INQ'), ...changes })).toBe(1)
  return id
}
/** A new quote: a copy of the seeded draft quote Q2 with `changes`. */
async function newQuote(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  expect(await copyRow(office(), 'Quote', sales.draftQuoteId, { id, number: tag('T-Q'), status: 'DRAFT', ...changes })).toBe(1)
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('customernumbersth')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  s = await seedSalesIntake({ db: factory, namespace: NS })
  sales = await seedSales({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe("each customer's own running number", () => {
  it('numbers the seeded rows 1, 2, 3 … per company and customer, each once, with no gap; none for a prospect', async () => {
    const rows = await admin(`SELECT "partyId", "customerSeq" FROM "Inquiry" WHERE "tenantId" = $1::uuid ORDER BY "createdAt", id`, [a.tenantId])
    for (const row of rows) expect(row.customerSeq === null).toBe(row.partyId === null)
    for (const table of ['Inquiry', 'Quote', 'SalesOrder']) {
      const groups = await admin(`SELECT array_agg("customerSeq" ORDER BY "customerSeq") AS seqs FROM "${table}" WHERE "tenantId" = $1::uuid AND "partyId" IS NOT NULL GROUP BY "companyId", "partyId"`, [a.tenantId])
      expect(groups.length, table).toBeGreaterThan(0)
      for (const group of groups) expect(group.seqs, table).toEqual((group.seqs as number[]).map((_, index) => index + 1))
    }
  })

  it("never moves customer A's next number when customer B asks, is quoted or orders (plan §0 counts, W05)", async () => {
    const p1Inquiries = await highest('Inquiry', A.company, A.P1)
    const p1Quotes = await highest('Quote', A.company, A.P1)
    const p3Before = await highest('Inquiry', A.company, A.P3)
    // P3 asks twice and is quoted (whatever number the writer gives, the database gives P3's next).
    const first = await newInquiry({ partyId: A.P3, ...PROSPECT_CLEARED, customerSeq: 99 })
    const second = await newInquiry({ partyId: A.P3, ...PROSPECT_CLEARED })
    expect([await seqOf('Inquiry', first), await seqOf('Inquiry', second)]).toEqual([p3Before + 1, p3Before + 2])
    const p3Quote = await newQuote({ partyId: A.P3, contactId: null })
    expect(await seqOf('Quote', p3Quote)).toBe((await highest('Quote', A.company, A.P3)))
    // P1's next numbers did not move.
    expect(await highest('Inquiry', A.company, A.P1)).toBe(p1Inquiries)
    expect(await highest('Quote', A.company, A.P1)).toBe(p1Quotes)
    expect(await seqOf('Inquiry', await newInquiry({ partyId: A.P1, ...PROSPECT_CLEARED }))).toBe(p1Inquiries + 1)
    expect(await seqOf('Quote', await newQuote())).toBe(p1Quotes + 1)
    // Another company keeps a series of its own for the same customer.
    const elsewhere = await newQuote({ companyId: A.companyB })
    expect(await seqOf('Quote', elsewhere)).toBe(1)
  })

  it("gives a prospect's inquiry its number when it is matched to a customer, and never changes it after", async () => {
    const id = await newInquiry()
    expect(await seqOf('Inquiry', id)).toBeNull()
    const next = (await highest('Inquiry', A.company, A.P3)) + 1
    expect(await update(office(), 'Inquiry', id, `"partyId" = $2::uuid, "prospectName" = NULL, "prospectCompany" = NULL, "prospectEmail" = NULL, "prospectPhone" = NULL, "prospectLawfulBasis" = NULL`, A.P3)).toBe(1)
    expect(await seqOf('Inquiry', id)).toBe(next)
    await expect(update(office(), 'Inquiry', id, `"customerSeq" = 1`)).rejects.toThrow(/given by the database once and never changes/)
    await expect(update(office(), 'Quote', sales.quoteId, `"customerSeq" = 77`)).rejects.toThrow(/given by the database once and never changes/)
    await expect(update(office(), 'SalesOrder', sales.orderId, `"customerSeq" = 77`)).rejects.toThrow(/given by the database once and never changes/)
    // An update that names the customer without changing it keeps the number.
    expect(await update(office(), 'Inquiry', id, `"partyId" = "partyId", note = 'Made-up: same customer.'`)).toBe(1)
    expect(await seqOf('Inquiry', id)).toBe(next)
  })

  it("is read by the customer's own portal people, for their rows only", async () => {
    const own = await sql(partner(A.P1), `SELECT id, "customerSeq" FROM "SalesOrder" WHERE id = $1::uuid`, sales.orderId)
    expect(own).toEqual([{ id: sales.orderId, customerSeq: await seqOf('SalesOrder', sales.orderId) }])
    expect((await sql(partner(A.P1), `SELECT "customerSeq" FROM "Quote" WHERE id = $1::uuid`, sales.quoteId)).length).toBe(1)
    expect(await sql(partner(A.P3), `SELECT "customerSeq" FROM "SalesOrder" WHERE id = $1::uuid`, sales.orderId)).toEqual([])
    expect(await sql(partner(A.P3), `SELECT "customerSeq" FROM "Inquiry" WHERE "partyId" = $1::uuid`, A.P1)).toEqual([])
  })
})
