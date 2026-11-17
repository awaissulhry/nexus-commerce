import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedSalesIntake, type SalesIntakeSeed } from '../seed/sales-intake'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * The customer's request (TH-1b, threads schema wave 1/9, B-TH-009; …_sales_intake_portal_th_guards and the generated policy
 * migration), on a database built from the migrations and seeded twice, through the real login and the scoped client:
 *   - the brand wall (W01, W37): a customer's portal people read their own inquiries and lines and nothing of another customer's
 *     or a prospect's, in their tenant or another; never the office's columns (assignee, office note, close words, decline
 *     reason, prospect, mail, tech pack, target price, who typed it); they write nothing;
 *   - a line carries its inquiry's party, copied by the database whatever the writer gives, and when the inquiry's party is set;
 *   - PR-05: a line names our own collection or the inquiry's customer's private label (or its team's, for a rider), never
 *     another customer's, and a prospect's names none; an inquiry does not move to another party with such a line;
 *   - the customer's PO is one line up to 100 characters; the delivery address one of its party's SHIP_TO addresses, not
 *     archived, and none for a prospect; the price shown 0 or more.
 * The refusals are check_violation (23514); their messages are read through raw SQL.
 */

const NS = 'th-009-a'
const NS_B = 'th-009-b'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let b: CoreSeed
let s: SalesIntakeSeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  P1: key('party:P1'),
  P2: key('party:P2'),
  P3: key('party:P3'),
  jacket: key('product:style:JKT-01'),
  black: key('product:colourway:JKT-01:BLK'),
  p1Workshop: key('party-address:P1:workshop'),
  p1Office: key('party-address:P1:office'),
  p3Office: key('party-address:P3:office'),
}
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const partner = (partyId: string, tenant: CoreSeed = a): FactoryScope => ({ audience: 'partner', tenantId: tenant.tenantId, actorId: tenant.actorId, partyId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const one = async (text: string, values: unknown[] = []) => (await admin(text, values))[0]!
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
/** A line of `inquiryId`: a copy of the prospect's first line (in words) with `changes`. */
async function newLine(inquiryId: string, changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  expect(await copyRow(office(), 'InquiryLine', s.inquiryLineIds[0], { id, inquiryId, seq: 100 + Math.floor(Math.random() * 100_000), ...changes })).toBe(1)
  return id
}
const partyOfLine = async (id: string) => (await one(`SELECT "partyId" FROM "InquiryLine" WHERE id = $1::uuid`, [id])).partyId as string | null

beforeAll(async () => {
  db = await migratedDatabase('portalrequeststh')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  b = await seedCore({ db: factory, namespace: NS_B })
  s = await seedSalesIntake({ db: factory, namespace: NS })
  await seedSalesIntake({ db: factory, namespace: NS_B })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the brand wall (W01, W37)', () => {
  it("a customer reads its own requests and their lines, never another customer's, a prospect's or another tenant's", async () => {
    const own = await sql(partner(A.P1), `SELECT id, number, "customerRef", status::text AS status FROM "Inquiry" ORDER BY number`)
    expect(own).toEqual([{ id: s.inquiryIds.quoted, number: 'SEED-INQ-0004', customerRef: 'SEED-BA-PO-12', status: 'QUOTED' }])
    const lines = await sql(partner(A.P1), `SELECT id, "styleId", "unitPriceShown"::text AS shown FROM "InquiryLine"`)
    expect(lines).toEqual([{ id: s.inquiryLineIds[3], styleId: A.jacket, shown: '420.000000' }])
    // P3 sees its phone request and its line only; P2 (a supplier) nothing at all.
    expect((await sql(partner(A.P3), `SELECT number FROM "Inquiry" ORDER BY number`)).map((row) => row.number)).toEqual(['SEED-INQ-0002', 'SEED-INQ-0005'])
    expect((await sql(partner(A.P3), `SELECT id FROM "InquiryLine"`)).map((row) => row.id)).toEqual([s.inquiryLineIds[2]])
    expect(await sql(partner(A.P2), `SELECT id FROM "Inquiry"`)).toEqual([])
    expect(await sql(partner(A.P2), `SELECT id FROM "InquiryLine"`)).toEqual([])
    // P1's request asked by id: nothing for P3, nothing for tenant B's P1 (another tenant).
    expect(await sql(partner(A.P3), `SELECT id FROM "Inquiry" WHERE id = $1::uuid`, s.inquiryIds.quoted)).toEqual([])
    expect(await sql(partner(A.P3), `SELECT id FROM "InquiryLine" WHERE id = $1::uuid`, s.inquiryLineIds[3])).toEqual([])
    expect(await sql(partner(seedUuid(NS_B, 'party:P1'), b), `SELECT id FROM "Inquiry" WHERE id = $1::uuid`, s.inquiryIds.quoted)).toEqual([])
    // A prospect's request and lines reach no partner (no party yet).
    for (const party of [A.P1, A.P3]) expect(await sql(partner(party), `SELECT id FROM "Inquiry" WHERE "partyId" IS NULL`)).toEqual([])
  })

  it("never the office's columns, and writes nothing", async () => {
    for (const column of ['note', 'closeNote', 'declineReason', 'closedById', 'assigneeId', 'assignedAt', 'targetUnitPrice', 'prospectName', 'prospectEmail', 'prospectPhone', 'sourceEmailId', 'techPackFileIds', 'techPackVersion', 'createdById']) {
      await expect(sql(partner(A.P1), `SELECT "${column}" FROM "Inquiry" LIMIT 1`), column).rejects.toThrow(/permission denied/)
    }
    await expect(sql(partner(A.P1), `SELECT "createdById" FROM "InquiryLine" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(as(partner(A.P1), (client) => client.inquiry.findMany())).rejects.toThrow(/permission denied/)
    await expect(run(partner(A.P1), `UPDATE "Inquiry" SET request = request WHERE id = $1::uuid`, s.inquiryIds.quoted)).rejects.toThrow(/permission denied/)
    await expect(run(partner(A.P1), `INSERT INTO "Inquiry" (id) VALUES (NULL)`)).rejects.toThrow(/permission denied/)
    await expect(run(partner(A.P1), `INSERT INTO "InquiryLine" (id) VALUES (NULL)`)).rejects.toThrow(/permission denied/)
    await expect(run(partner(A.P1), `DELETE FROM "InquiryLine" WHERE false`)).rejects.toThrow(/permission denied/)
  })
})

describe("a line's party", () => {
  it("is its inquiry's, whatever the writer gives, and follows the inquiry when a prospect is matched to a customer", async () => {
    const id = await newInquiry()
    const line = await newLine(id, { partyId: A.P1 })
    expect(await partyOfLine(line)).toBeNull()
    expect(await update(office(), 'InquiryLine', line, `"partyId" = $2::uuid`, A.P3)).toBe(1)
    expect(await partyOfLine(line)).toBeNull()
    // Matched to P3: the line is P3's, and P3's portal people read it; P1's never.
    expect(await update(office(), 'Inquiry', id, `"partyId" = $2::uuid, "prospectName" = NULL, "prospectCompany" = NULL, "prospectEmail" = NULL, "prospectPhone" = NULL, "prospectLawfulBasis" = NULL`, A.P3)).toBe(1)
    expect(await partyOfLine(line)).toBe(A.P3)
    expect((await sql(partner(A.P3), `SELECT id FROM "InquiryLine" WHERE id = $1::uuid`, line)).length).toBe(1)
    expect(await sql(partner(A.P1), `SELECT id FROM "InquiryLine" WHERE id = $1::uuid`, line)).toEqual([])
    // A new line of a customer's inquiry is the customer's at once.
    expect(await partyOfLine(await newLine(id))).toBe(A.P3)
  })
})

describe("another customer's private label (PR-05)", () => {
  it("is refused on a prospect's or another customer's request; the brand's own and its team rider's pass", async () => {
    await expect(newLine(await newInquiry(), { styleId: A.jacket, colourwayId: A.black })).rejects.toThrow(/another customer's private-label style/)
    await expect(newLine(await customerInquiry(A.P3), { styleId: A.jacket, colourwayId: A.black })).rejects.toThrow(/another customer's private-label style/)
    const own = await customerInquiry(A.P1)
    const line = await newLine(own, { styleId: A.jacket, colourwayId: A.black, unitPriceShown: '395.5' })
    expect(await partyOfLine(line)).toBe(A.P1)
    // The rider of P1's team buys the team's kit.
    expect(await partyOfLine(await newLine(await customerInquiry(s.riderPartyId), { styleId: A.jacket }))).toBe(s.riderPartyId)
    // A line in words of P3's request does not become the jacket later.
    const words = await newLine(await customerInquiry(A.P3))
    await expect(update(office(), 'InquiryLine', words, `"styleId" = $2::uuid`, A.jacket)).rejects.toThrow(/another customer's private-label style/)
    // P1's request with the jacket never moves to P3 (the office API refuses a change of customer first).
    await expect(update(office(), 'Inquiry', own, `"partyId" = $2::uuid`, A.P3)).rejects.toThrow(/private-label style/)
  })
})

describe("the customer's PO, delivery address and price shown (L2-G01, L2-G08)", () => {
  it('keeps them in shape: one line of PO, a SHIP_TO address of its own party not archived, none for a prospect, a price of 0 or more', async () => {
    const id = await customerInquiry(A.P1)
    expect(await update(office(), 'Inquiry', id, `"customerRef" = 'BA-PO-4521', "shipToAddressId" = $2::uuid`, A.p1Workshop)).toBe(1)
    await expect(update(office(), 'Inquiry', id, `"customerRef" = $2`, 'x'.repeat(101))).rejects.toThrow(/one line of 1 to 100 characters/)
    await expect(update(office(), 'Inquiry', id, `"customerRef" = $2`, 'PO\n1')).rejects.toThrow(/one line of 1 to 100 characters/)
    await expect(update(office(), 'Inquiry', id, `"shipToAddressId" = $2::uuid`, A.p1Office)).rejects.toThrow(/SHIP_TO addresses, not archived/)
    // Another party's address: the reference names the inquiry's party.
    await expect(update(office(), 'Inquiry', id, `"shipToAddressId" = $2::uuid`, A.p3Office)).rejects.toThrow(/Inquiry_tenantId_partyId_shipToAddressId_fkey|foreign key/)
    const archived = randomUUID()
    expect(await copyRow(office(), 'PartyAddress', A.p1Workshop, { id: archived, isDefaultShipTo: false, isDefaultBillTo: false })).toBe(1)
    expect(await update(office(), 'PartyAddress', archived, `status = 'ARCHIVED'`)).toBe(1)
    await expect(update(office(), 'Inquiry', id, `"shipToAddressId" = $2::uuid`, archived)).rejects.toThrow(/SHIP_TO addresses, not archived/)
    // A prospect has no address of its own.
    await expect(newInquiry({ shipToAddressId: A.p1Workshop })).rejects.toThrow(/delivery address only with its customer/)
    await expect(newLine(id, { unitPriceShown: '-1' })).rejects.toThrow(/price shown as 0 or more/)
    // P1's portal people read the PO and the address.
    expect(await sql(partner(A.P1), `SELECT "customerRef", "shipToAddressId" FROM "Inquiry" WHERE id = $1::uuid`, id)).toEqual([{ customerRef: 'BA-PO-4521', shipToAddressId: A.p1Workshop }])
  })
})
