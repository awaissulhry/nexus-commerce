import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedSalesIntake, type SalesIntakeSeed } from '../seed/sales-intake'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Sales intake and customers (W2b-5, schema wave 37/44, B-W2b-279, …_sales_intake_w2b_guards) on a database built from the
 * migrations and seeded twice, through the real login and the scoped client:
 *   - inquiries: logged open, numbered once, a party or a prospect with its lawful basis, one per mail and one per quote, the
 *     assignee an active office user, QUOTED with its quote, DECLINED with its reason, LOST with its words, then frozen but
 *     the note and the prospect's erasure, which is set once and keeps the prospect blank; the tech pack's files of the
 *     inquiry or its mail; their lines only while open, sizes and totals that agree;
 *   - customer requirements: of a customer, fixed once written, ended once, replaced by a new row that supersedes an ended
 *     one, once;
 *   - holds: placed with words, never edited, released once with words, one in force per party, company and reason;
 *   - terms per company: of a tenant-wide customer or one of the company, the library's terms and list of the company, a
 *     credit limit with its currency, one live row per party and company, frozen once ended;
 *   - seasons: a code of one line, days in order, closed with its time; quote versions and orders name an OPEN season of
 *     their company;
 *   - riders: a person under an organisation that buys from us; a team with riders stays an organisation;
 *   - contacts: consent with when and how, erasure set once, the erased contact blank and archived for good;
 *   - grants: the office only on the new tables (the floor and partners read nothing); the partner never reads who erased a
 *     contact; nothing deleted but an open inquiry's lines.
 * The refusals are check_violation (23514); their messages are read through raw SQL.
 */

const NS = 'w2b-279-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: SalesIntakeSeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  company: key('company:A'),
  companyB: key('company:B'),
  site: key('site:A1'),
  P1: key('party:P1'),
  P2: key('party:P2'),
  P3: key('party:P3'),
  P4: key('party:P4'),
  member: key('user:member'),
  invited: key('user:invited'),
  p1Buyer: key('party-contact:P1:buyer'),
  p3Buyer: key('party-contact:P3:buyer'),
}
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: A.site })
const partner = (partyId: string): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const one = async (text: string, values: unknown[] = []) => (await admin(text, values))[0]!
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) =>
  run(scope, `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
/** UPDATE row `id` of `table`: `set` is the SET list. */
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
/** A DELETE the office has no grant for, and that the guard refuses for the owner too. */
const refusedDelete = async (table: string, id: string) => {
  await expect(run(office(), `DELETE FROM "${table}" WHERE id = $1::uuid`, id)).rejects.toThrow(/permission denied/)
  await expect(admin(`DELETE FROM "${table}" WHERE id = $1::uuid`, [id])).rejects.toThrow(/never deleted/)
}

/** A new open inquiry of company A: a copy of SEED-INQ-0001 (NEW, a prospect) with `changes`. */
async function newInquiry(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  expect(await copyRow(office(), 'Inquiry', s.inquiryIds.prospect, { id, number: tag('T-INQ'), ...changes })).toBe(1)
  return id
}
/** A new customer party of company A only (the walls of "another company"). */
async function companyCustomer(): Promise<string> {
  const id = randomUUID()
  expect(await copyRow(office(), 'Party', A.P3, { id, code: tag('T-C'), companyId: A.company })).toBe(1)
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('salesintakew2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  s = await seedSalesIntake({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the seed', () => {
  it('is idempotent and writes what it says', async () => {
    const count = async () =>
      one(`SELECT (SELECT count(*) FROM "Inquiry")::int AS i, (SELECT count(*) FROM "InquiryLine")::int AS l, (SELECT count(*) FROM "CustomerRequirement")::int AS r,
                  (SELECT count(*) FROM "PartyHold")::int AS h, (SELECT count(*) FROM "PartyCompanyTerms")::int AS t, (SELECT count(*) FROM "Season")::int AS s`)
    const before = await count()
    await seedSalesIntake({ db: factory, namespace: NS })
    expect(await count()).toEqual(before)
    expect(before).toEqual({ i: 6, l: 3, r: 5, h: 2, t: 4, s: 4 })
    const statuses = await admin(`SELECT number, status::text AS status FROM "Inquiry" ORDER BY number`)
    expect(statuses.map((row) => row.status)).toEqual(['NEW', 'ASSIGNED', 'NEED_INFO', 'QUOTED', 'DECLINED', 'LOST'])
    // FW27 on Q2's draft version and on SO1.
    expect(await one(`SELECT (SELECT count(*) FROM "QuoteVersion" WHERE "seasonId" = $1::uuid)::int AS v, (SELECT count(*) FROM "SalesOrder" WHERE "seasonId" = $1::uuid)::int AS o`, [s.seasonIds.fw27])).toEqual({ v: 1, o: 1 })
  })
})

describe('grants', () => {
  it('are the office only on the new tables; the partner reads contacts without who erased one', async () => {
    for (const table of ['Inquiry', 'InquiryLine', 'CustomerRequirement', 'PartyHold', 'PartyCompanyTerms', 'Season']) {
      expect((await sql(office(), `SELECT count(*)::int AS n FROM "${table}"`))[0]!.n).toBeGreaterThan(0)
      await expect(sql(floor(), `SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
      await expect(sql(partner(A.P1), `SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
    }
    await expect(sql(partner(A.P1), `SELECT "erasedById" FROM "PartyContact" LIMIT 1`)).rejects.toThrow(/permission denied/)
    const erased = await sql(partner(A.P1), `SELECT name, "erasedAt" IS NOT NULL AS erased, "lawfulBasis"::text AS basis FROM "PartyContact" WHERE id = $1::uuid`, s.erasedContactId)
    expect(erased).toEqual([{ name: '', erased: true, basis: 'CONTRACT' }])
    expect(await sql(partner(A.P1), `SELECT "seasonId" IS NOT NULL AS named FROM "SalesOrder" WHERE "seasonId" = $1::uuid`, s.seasonIds.fw27)).toHaveLength(1)
  })
})

describe('inquiries', () => {
  it('are logged open, by a party or a prospect with its lawful basis, a MAIL one with its mail', async () => {
    await expect(newInquiry({ status: 'QUOTED' })).rejects.toThrow(/logged open/)
    await expect(newInquiry({ status: 'NEED_INFO' })).rejects.toThrow(/logged open/)
    await expect(newInquiry({ prospectErasedAt: new Date().toISOString(), prospectErasedById: A.member })).rejects.toThrow(/logged open/)
    await expect(newInquiry({ number: '' })).rejects.toThrow(/has its number/)
    await expect(newInquiry({ source: 'MAIL' })).rejects.toThrow(/exactly when its source is MAIL/)
    await expect(newInquiry({ prospectName: null, prospectCompany: null, prospectEmail: null })).rejects.toThrow(/names its customer/)
    await expect(newInquiry({ prospectLawfulBasis: null })).rejects.toThrow(/lawful basis/)
    await expect(newInquiry({ prospectEmail: 'Someone@Example.com' })).rejects.toThrow(/an e-mail address/)
    await expect(newInquiry({ prospectPhone: 'call me' })).rejects.toThrow(/a phone number/)
    await expect(newInquiry({ contactId: A.p1Buyer })).rejects.toThrow(/a contact only with the party/)
    await expect(newInquiry({ request: '' })).rejects.toThrow(/says what is asked/)
    await expect(newInquiry({ targetUnitPrice: -1 })).rejects.toThrow(/target price of 0 or more/)
    await expect(newInquiry({ receivedAt: new Date(Date.now() + 86_400_000).toISOString() })).rejects.toThrow(/not in the future/)
    // A supplier is not a customer; a party of the company or tenant-wide, with its contact.
    await expect(newInquiry({ partyId: A.P2 })).rejects.toThrow(/not a customer or a brand/)
    expect(await newInquiry({ partyId: A.P1, contactId: A.p1Buyer, prospectName: null, prospectCompany: null, prospectEmail: null, prospectPhone: null, prospectLawfulBasis: null })).toBeTruthy()
    // One inquiry per mail; the mail of the tenant.
    await expect(newInquiry({ source: 'MAIL', sourceEmailId: s.mailId })).rejects.toThrow(/Inquiry_one_per_mail/)
    await expect(newInquiry({ source: 'MAIL', sourceEmailId: randomUUID() })).rejects.toThrow(/not a mail received by the tenant/)
    await expect(newInquiry({ companyId: A.companyB, source: 'MAIL', sourceEmailId: key('email-in:waiting') })).rejects.toThrow(/mail of another company/)
  })

  it('keep their number, company, source and time; are assigned to an active office user', async () => {
    const id = await newInquiry()
    await expect(update(office(), 'Inquiry', id, `number = 'T-OTHER'`)).rejects.toThrow(/never changes/)
    await expect(update(office(), 'Inquiry', id, `source = 'PHONE'`)).rejects.toThrow(/never change/)
    await expect(update(office(), 'Inquiry', id, `status = 'ASSIGNED'`)).rejects.toThrow(/ASSIGNED with its assignee/)
    await expect(update(office(), 'Inquiry', id, `"assigneeId" = $2::uuid, "assignedAt" = now()`, A.member)).rejects.toThrow(/NEW with nobody assigned/)
    await expect(update(office(), 'Inquiry', id, `status = 'ASSIGNED', "assigneeId" = $2::uuid, "assignedAt" = now()`, A.invited)).rejects.toThrow(/active office user/)
    expect(await update(office(), 'Inquiry', id, `status = 'ASSIGNED', "assigneeId" = $2::uuid, "assignedAt" = now()`, A.member)).toBe(1)
    expect(await update(office(), 'Inquiry', id, `status = 'NEED_INFO'`)).toBe(1)
    expect(await update(office(), 'Inquiry', id, `status = 'NEW', "assigneeId" = NULL, "assignedAt" = NULL`)).toBe(1)
    await refusedDelete('Inquiry', id)
  })

  it('end QUOTED with their quote, DECLINED with a reason, LOST with words; then frozen but the note', async () => {
    const id = await newInquiry({ partyId: A.P1, prospectName: null, prospectCompany: null, prospectEmail: null, prospectPhone: null, prospectLawfulBasis: null })
    await expect(update(office(), 'Inquiry', id, `status = 'LOST', "closedAt" = now()`)).rejects.toThrow(/why it was lost/)
    await expect(update(office(), 'Inquiry', id, `status = 'DECLINED', "closedAt" = now()`)).rejects.toThrow(/DECLINED exactly with its reason/)
    await expect(update(office(), 'Inquiry', id, `status = 'DECLINED', "declineReason" = 'OTHER', "closedAt" = now()`)).rejects.toThrow(/why it was lost or declined/)
    await expect(update(office(), 'Inquiry', id, `status = 'DECLINED', "declineReason" = 'PRICE'`)).rejects.toThrow(/closing time/)
    await expect(update(office(), 'Inquiry', id, `status = 'QUOTED', "closedAt" = now()`)).rejects.toThrow(/QUOTED exactly with the quote/)
    // The quote of the seed's QUOTED inquiry is taken (one inquiry per quote).
    const taken = (await one(`SELECT "quoteId" FROM "Inquiry" WHERE id = $1::uuid`, [s.inquiryIds.quoted])).quoteId as string
    await expect(update(office(), 'Inquiry', id, `status = 'QUOTED', "quoteId" = $2::uuid, "closedAt" = now()`, taken)).rejects.toThrow(/Inquiry_one_per_quote/)
    expect(await update(office(), 'Inquiry', id, `status = 'DECLINED', "declineReason" = 'CAPACITY', "closedAt" = now(), "closedById" = $2::uuid, "closeNote" = 'Full until spring.'`, A.member)).toBe(1)
    await expect(update(office(), 'Inquiry', id, `request = 'Changed.'`)).rejects.toThrow(/DECLINED and never changes/)
    await expect(update(office(), 'Inquiry', id, `status = 'NEW', "declineReason" = NULL, "closedAt" = NULL, "closedById" = NULL, "closeNote" = NULL`)).rejects.toThrow(/final/)
    expect(await update(office(), 'Inquiry', id, `note = 'Asked again next season.'`)).toBe(1)
    await expect(update(office(), 'Inquiry', s.inquiryIds.quoted, `"quoteId" = NULL, status = 'NEW', "closedAt" = NULL, "closedById" = NULL`)).rejects.toThrow(/final|named once/)
  })

  it("erase a prospect once, and keep it blank for good", async () => {
    const id = await newInquiry()
    await expect(update(office(), 'Inquiry', id, `"prospectErasedAt" = now(), "prospectErasedById" = $2::uuid`, A.member)).rejects.toThrow(/stay blank for good/)
    await expect(update(office(), 'Inquiry', id, `"prospectName" = NULL, "prospectCompany" = NULL, "prospectEmail" = NULL, "prospectPhone" = NULL, "prospectErasedAt" = now()`)).rejects.toThrow(/both or neither|names its customer/)
    expect(
      await update(office(), 'Inquiry', id, `"prospectName" = NULL, "prospectCompany" = NULL, "prospectEmail" = NULL, "prospectPhone" = NULL, "prospectErasedAt" = now(), "prospectErasedById" = $2::uuid`, A.member),
    ).toBe(1)
    await expect(update(office(), 'Inquiry', id, `"prospectName" = 'Back again'`)).rejects.toThrow(/stay blank for good/)
    await expect(update(office(), 'Inquiry', id, `"prospectErasedAt" = NULL, "prospectErasedById" = NULL`)).rejects.toThrow(/never changed or undone/)
    // The seed's LOST inquiry was erased after it closed: a closed inquiry takes the erasure, nothing else.
    const lost = await one(`SELECT "prospectName", "prospectErasedAt" IS NOT NULL AS erased FROM "Inquiry" WHERE id = $1::uuid`, [s.inquiryIds.lost])
    expect(lost).toEqual({ prospectName: null, erased: true })
    const declined = await newInquiry()
    expect(await update(office(), 'Inquiry', declined, `status = 'LOST', "closedAt" = now(), "closeNote" = 'No answer.'`)).toBe(1)
    await expect(update(office(), 'Inquiry', declined, `"prospectName" = 'Renamed'`)).rejects.toThrow(/only erased now/)
    expect(
      await update(office(), 'Inquiry', declined, `"prospectName" = NULL, "prospectCompany" = NULL, "prospectEmail" = NULL, "prospectPhone" = NULL, "prospectErasedAt" = now(), "prospectErasedById" = $2::uuid`, A.member),
    ).toBe(1)
  })

  it("name a tech pack of their own files or their mail's, each once", async () => {
    const id = await newInquiry()
    await expect(update(office(), 'Inquiry', id, `"techPackFileIds" = ARRAY[$2::uuid]`, s.fileIds.techPack)).rejects.toThrow(/files of the inquiry or of the mail/)
    await expect(update(office(), 'Inquiry', id, `"techPackFileIds" = ARRAY[$2::uuid, $2::uuid]`, s.fileIds.techPack)).rejects.toThrow(/each once/)
    const own = randomUUID()
    expect(await copyRow(office(), 'StoredFile', s.fileIds.techPack, { id: own, recordType: 'Inquiry', recordId: id, storageKey: tag('t/test/tech-pack') })).toBe(1)
    expect(await update(office(), 'Inquiry', id, `"techPackFileIds" = ARRAY[$2::uuid], "techPackVersion" = 'TP 2'`, own)).toBe(1)
    expect((await one(`SELECT "techPackFileIds" FROM "Inquiry" WHERE id = $1::uuid`, [s.inquiryIds.mail])).techPackFileIds).toEqual([s.fileIds.techPack])
  })
})

describe('inquiry lines', () => {
  const add = (inquiryId: string, changes: Record<string, unknown> = {}) =>
    copyRow(office(), 'InquiryLine', s.inquiryLineIds[0], { id: randomUUID(), inquiryId, seq: 100 + Math.floor(Math.random() * 100_000), ...changes })

  it('are written only while the inquiry is open, with sizes and a total that agree', async () => {
    const id = await newInquiry()
    await expect(add(id, { sizes: { '50': 0 } })).rejects.toThrow(/pieces by size/)
    await expect(add(id, { sizes: { '50': 2.5 } })).rejects.toThrow(/pieces by size/)
    await expect(add(id, { sizes: ['50'] })).rejects.toThrow(/pieces by size/)
    await expect(add(id, { quantity: 21 })).rejects.toThrow(/the sum of its sizes/)
    await expect(add(id, { styleId: null, colourwayId: null, description: null })).rejects.toThrow(/names a style or says what is asked/)
    await expect(add(id, { styleId: null, description: 'Gloves' })).rejects.toThrow(/colourway only with its style/)
    const line = randomUUID()
    expect(await add(id, { id: line, sizes: {}, quantity: null })).toBe(1)
    expect(await update(office(), 'InquiryLine', line, `sizes = '{"52": 4}'::jsonb, quantity = 4`)).toBe(1)
    await expect(update(office(), 'InquiryLine', line, `"inquiryId" = $2::uuid`, s.inquiryIds.prospect)).rejects.toThrow(/never moves/)
    expect(await run(office(), `DELETE FROM "InquiryLine" WHERE id = $1::uuid`, line)).toBe(1)
    expect(await update(office(), 'Inquiry', id, `status = 'LOST', "closedAt" = now(), "closeNote" = 'Gone.'`)).toBe(1)
    await expect(add(id)).rejects.toThrow(/its lines change only while it is open/)
  })
})

describe('customer requirements', () => {
  const add = (changes: Record<string, unknown> = {}) => copyRow(office(), 'CustomerRequirement', s.requirementIds.packing, { id: randomUUID(), ...changes })

  it('are of a customer, made in force, with their stages and styles each once', async () => {
    await expect(add({ partyId: A.P2 })).rejects.toThrow(/not a customer or a brand/)
    await expect(add({ partyId: await companyCustomer(), companyId: A.companyB })).rejects.toThrow(/belongs to another company/)
    await expect(add({ active: false, endedAt: new Date().toISOString(), endedById: A.member })).rejects.toThrow(/made in force/)
    await expect(add({ appliesAt: [] })).rejects.toThrow(/one or more stages/)
    await expect(add({ appliesAt: ['ORDER', 'ORDER'] })).rejects.toThrow(/one or more stages/)
    await expect(add({ words: ' ' })).rejects.toThrow(/the rule in words/)
    await expect(add({ styleIds: [randomUUID()] })).rejects.toThrow(/styles of its company/)
    await expect(add({ fileId: s.fileIds.techPack })).rejects.toThrow(/a file of the requirement or of its party/)
    expect(await add({ companyId: null, fileId: null })).toBe(1)
  })

  it('are fixed once written, ended once, and replaced by a new row that supersedes an ended one, once', async () => {
    const id = randomUUID()
    expect(await add({ id })).toBe(1)
    await expect(update(office(), 'CustomerRequirement', id, `words = 'Changed.'`)).rejects.toThrow(/fixed once written/)
    await expect(update(office(), 'CustomerRequirement', id, `active = false`)).rejects.toThrow(/exactly with when and by whom/)
    await expect(add({ supersedesId: id })).rejects.toThrow(/end it first/)
    expect(await update(office(), 'CustomerRequirement', id, `active = false, "endedAt" = now(), "endedById" = $2::uuid, "endReason" = 'Replaced.'`, A.member)).toBe(1)
    await expect(update(office(), 'CustomerRequirement', id, `active = true, "endedAt" = NULL, "endedById" = NULL, "endReason" = NULL`)).rejects.toThrow(/ended and never changes/)
    expect(await add({ supersedesId: id })).toBe(1)
    await expect(add({ supersedesId: id })).rejects.toThrow(/CustomerRequirement_replaced_once/)
    // Another customer's requirement is not one to supersede (the reference names the same party).
    const other = randomUUID()
    expect(await add({ id: other })).toBe(1)
    expect(await update(office(), 'CustomerRequirement', other, `active = false, "endedAt" = now(), "endedById" = $2::uuid`, A.member)).toBe(1)
    await expect(add({ partyId: A.P3, companyId: null, supersedesId: other })).rejects.toThrow(/CustomerRequirement_tenantId_partyId_supersedesId_fkey/)
    await refusedDelete('CustomerRequirement', id)
  })
})

describe('holds', () => {
  const add = (changes: Record<string, unknown> = {}) =>
    copyRow(office(), 'PartyHold', s.holdIds.released, { id: randomUUID(), releasedAt: null, releasedById: null, releaseWords: null, ...changes })

  it('are placed on a customer with words, at most one in force per party, company and reason', async () => {
    await expect(add({ partyId: A.P2 })).rejects.toThrow(/not a customer or a brand/)
    await expect(add({ words: '' })).rejects.toThrow(/says why in words/)
    await expect(add({ placedAt: new Date(Date.now() + 86_400_000).toISOString() })).rejects.toThrow(/not in the future/)
    const id = randomUUID()
    expect(await add({ id })).toBe(1)
    await expect(add()).rejects.toThrow(/PartyHold_one_in_force/)
    expect(await add({ reason: 'LEGAL' })).toBe(1)
    // Every company is a key of its own.
    expect(await add({ companyId: null })).toBe(1)
    await expect(add({ companyId: null })).rejects.toThrow(/PartyHold_one_in_force/)
    await expect(update(office(), 'PartyHold', id, `words = 'Changed.'`)).rejects.toThrow(/never edited/)
    await expect(update(office(), 'PartyHold', id, `"releasedAt" = now(), "releasedById" = $2::uuid`, A.member)).rejects.toThrow(/all three or none/)
    await expect(update(office(), 'PartyHold', id, `"releasedAt" = "placedAt" - interval '1 day', "releasedById" = $2::uuid, "releaseWords" = 'x'`, A.member)).rejects.toThrow(/not before it was placed/)
    expect(await update(office(), 'PartyHold', id, `"releasedAt" = now(), "releasedById" = $2::uuid, "releaseWords" = 'Paid.'`, A.member)).toBe(1)
    await expect(update(office(), 'PartyHold', id, `"releaseWords" = 'Paid in full.'`)).rejects.toThrow(/was released and never changes/)
    expect(await add()).toBe(1)
    await refusedDelete('PartyHold', id)
  })
})

describe('terms per company', () => {
  const add = (changes: Record<string, unknown> = {}) => copyRow(office(), 'PartyCompanyTerms', s.termsIds.p1A, { id: randomUUID(), ...changes })

  it('are one live row per party and company, of the company, with a credit limit in its currency', async () => {
    await expect(add()).rejects.toThrow(/PartyCompanyTerms_one_live/)
    await expect(add({ partyId: await companyCustomer(), companyId: A.companyB, paymentTermsId: null, priceListId: null })).rejects.toThrow(/belongs to another company/)
    await expect(add({ partyId: A.P2 })).rejects.toThrow(/not a customer or a brand/)
    // The seed's P1 list is company A's: not a list of company B.
    const party = await companyCustomer()
    await expect(add({ partyId: party, depositPct: 0 })).rejects.toThrow(/above 0 and at most 100/)
    await expect(add({ partyId: party, depositPct: 100.5 })).rejects.toThrow(/above 0 and at most 100/)
    await expect(add({ partyId: party, creditLimitCurrency: null })).rejects.toThrow(/both or neither/)
    await expect(add({ partyId: party, creditLimitCurrency: 'eur' })).rejects.toThrow(/ISO 4217/)
    await expect(add({ partyId: party, creditLimitAmount: -1 })).rejects.toThrow(/0 or more/)
    await expect(add({ partyId: A.P3, companyId: A.companyB, paymentTermsId: null })).rejects.toThrow(/price list that is ACTIVE or of another company/)
    const id = randomUUID()
    expect(await add({ id, partyId: party })).toBe(1)
    await expect(update(office(), 'PartyCompanyTerms', id, `"companyId" = $2::uuid`, A.companyB)).rejects.toThrow(/never change/)
    expect(await update(office(), 'PartyCompanyTerms', id, `"creditLimitAmount" = 100000, "updatedById" = $2::uuid`, A.member)).toBe(1)
    expect(await update(office(), 'PartyCompanyTerms', id, `"endedAt" = now(), "endedById" = $2::uuid`, A.member)).toBe(1)
    await expect(update(office(), 'PartyCompanyTerms', id, `"poNumberRequired" = false`)).rejects.toThrow(/were ended and never change/)
    expect(await add({ partyId: party })).toBe(1)
    await refusedDelete('PartyCompanyTerms', id)
  })
})

describe('seasons', () => {
  const add = (changes: Record<string, unknown> = {}) => copyRow(office(), 'Season', s.seasonIds.fw27, { id: randomUUID(), code: tag('S').slice(0, 10), ...changes })

  it('have a code of one line, days in order, closed with their time; company and code never change', async () => {
    await expect(add({ code: 'A season code far too long' })).rejects.toThrow(/1 to 20 characters/)
    await expect(add({ code: 'FW27\n' })).rejects.toThrow(/1 to 20 characters/)
    await expect(add({ code: 'FW27' })).rejects.toThrow(/Season_tenantId_companyId_code_key/)
    await expect(add({ endsOn: '2027-08-01' })).rejects.toThrow(/order book closes on or before its end|not before it/)
    await expect(add({ orderBookClosesOn: '2028-03-01' })).rejects.toThrow(/order book closes on or before its end/)
    await expect(add({ status: 'CLOSED' })).rejects.toThrow(/CLOSED exactly with when/)
    const id = randomUUID()
    expect(await add({ id, code: 'FW29' })).toBe(1)
    await expect(update(office(), 'Season', id, `code = 'FW30'`)).rejects.toThrow(/never change/)
    expect(await update(office(), 'Season', id, `status = 'CLOSED', "closedAt" = now(), "closedById" = $2::uuid`, A.member)).toBe(1)
    expect(await update(office(), 'Season', id, `status = 'OPEN', "closedAt" = NULL, "closedById" = NULL`)).toBe(1)
    await refusedDelete('Season', id)
  })

  it('are named by quote versions and orders only while OPEN, of their own company', async () => {
    const draft = (await one(`SELECT id FROM "QuoteVersion" WHERE "seasonId" = $1::uuid AND status = 'DRAFT'`, [s.seasonIds.fw27])).id as string
    await expect(update(office(), 'QuoteVersion', draft, `"seasonId" = $2::uuid`, s.seasonIds.fw26)).rejects.toThrow(/which is CLOSED/)
    await expect(update(office(), 'QuoteVersion', draft, `"seasonId" = $2::uuid`, s.seasonIds.fw27B)).rejects.toThrow(/season of another company/)
    expect(await update(office(), 'QuoteVersion', draft, `"seasonId" = $2::uuid`, s.seasonIds.ss28)).toBe(1)
    expect(await update(office(), 'QuoteVersion', draft, `"seasonId" = $2::uuid`, s.seasonIds.fw27)).toBe(1)
    // A sent version is frozen whole (W1's guard): its season too.
    const sent = (await one(`SELECT id FROM "QuoteVersion" WHERE status = 'ACCEPTED' ORDER BY id LIMIT 1`)).id as string
    await expect(update(office(), 'QuoteVersion', sent, `"seasonId" = $2::uuid`, s.seasonIds.fw27)).rejects.toThrow(/never changes/)
    const order = (await one(`SELECT id FROM "SalesOrder" WHERE "seasonId" = $1::uuid`, [s.seasonIds.fw27])).id as string
    await expect(update(office(), 'SalesOrder', order, `"seasonId" = $2::uuid`, s.seasonIds.fw27B)).rejects.toThrow(/SalesOrder_tenantId_companyId_seasonId_fkey/)
    await expect(update(office(), 'SalesOrder', order, `"seasonId" = $2::uuid`, s.seasonIds.fw26)).rejects.toThrow(/which is CLOSED/)
    expect(await update(office(), 'SalesOrder', order, `"seasonId" = NULL`)).toBe(1)
    expect(await update(office(), 'SalesOrder', order, `"seasonId" = $2::uuid`, s.seasonIds.fw27)).toBe(1)
  })
})

describe('riders under a team', () => {
  it('are persons under an organisation that buys from us; a team with riders stays an organisation', async () => {
    const rider = await one(`SELECT kind::text AS kind, "teamPartyId" FROM "Party" WHERE id = $1::uuid`, [s.riderPartyId])
    expect(rider).toEqual({ kind: 'PERSON', teamPartyId: A.P1 })
    const id = randomUUID()
    expect(await copyRow(office(), 'Party', A.P4, { id, code: tag('T-R'), teamPartyId: A.P3 })).toBe(1)
    await expect(update(office(), 'Party', id, `"teamPartyId" = $2::uuid`, A.P4)).rejects.toThrow(/the team of rider/)
    await expect(update(office(), 'Party', id, `"teamPartyId" = $2::uuid`, A.P2)).rejects.toThrow(/the team of rider/)
    await expect(update(office(), 'Party', id, `"teamPartyId" = id`)).rejects.toThrow(/never its own team/)
    await expect(update(office(), 'Party', id, `kind = 'ORGANISATION'`)).rejects.toThrow(/it is a person/)
    await expect(copyRow(office(), 'Party', A.P3, { id: randomUUID(), code: tag('T-O'), teamPartyId: A.P1 })).rejects.toThrow(/it is a person/)
    await expect(update(office(), 'Party', A.P3, `kind = 'PERSON'`)).rejects.toThrow(/has riders, so it stays an organisation/)
    expect(await update(office(), 'Party', id, `"teamPartyId" = NULL`)).toBe(1)
    expect(await update(office(), 'Party', A.P3, `kind = 'PERSON'`)).toBe(1)
    expect(await update(office(), 'Party', A.P3, `kind = 'ORGANISATION'`)).toBe(1)
  })
})

describe('contacts', () => {
  const add = (changes: Record<string, unknown> = {}) => copyRow(office(), 'PartyContact', A.p3Buyer, { id: randomUUID(), objectedAt: null, ...changes })

  it('record consent with when and how, and times not in the future', async () => {
    await expect(add({ lawfulBasis: 'CONSENT' })).rejects.toThrow(/a CONSENT basis has them/)
    await expect(add({ lawfulBasis: 'CONSENT', consentAt: new Date().toISOString() })).rejects.toThrow(/both or neither/)
    await expect(add({ lawfulBasis: 'CONSENT', consentAt: new Date(Date.now() + 86_400_000).toISOString(), consentSource: 'Form' })).rejects.toThrow(/not in the future/)
    expect(await add({ lawfulBasis: 'CONSENT', consentAt: new Date().toISOString(), consentSource: 'Signed the consent form (test).' })).toBe(1)
    expect(await add({ lawfulBasis: null })).toBe(1)
  })

  it('are erased once: archived, the name, e-mail and phone blank for good', async () => {
    const id = randomUUID()
    expect(await add({ id, lawfulBasis: 'CONTRACT' })).toBe(1)
    await expect(update(office(), 'PartyContact', id, `"erasedAt" = now(), "erasedById" = $2::uuid`, A.member)).rejects.toThrow(/was erased; its name, e-mail and phone stay blank/)
    await expect(update(office(), 'PartyContact', id, `name = '', email = NULL, phone = NULL, status = 'ARCHIVED', "erasedAt" = now()`)).rejects.toThrow(/both or neither/)
    expect(await update(office(), 'PartyContact', id, `name = '', email = NULL, phone = NULL, status = 'ARCHIVED', "erasedAt" = now(), "erasedById" = $2::uuid`, A.member)).toBe(1)
    await expect(update(office(), 'PartyContact', id, `email = 'back@example.com'`)).rejects.toThrow(/was erased; its name, e-mail and phone stay blank/)
    await expect(update(office(), 'PartyContact', id, `status = 'ACTIVE'`)).rejects.toThrow(/stays archived/)
    await expect(update(office(), 'PartyContact', id, `"erasedAt" = NULL, "erasedById" = NULL`)).rejects.toThrow(/never changed or undone/)
    // What does not name the person still changes (the roles), and the seed's erased contact stays as it is.
    expect(await update(office(), 'PartyContact', id, `roles = ARRAY['QUALITY']::"PartyContactRole"[]`)).toBe(1)
    await expect(update(office(), 'PartyContact', s.erasedContactId, `name = 'Seed Former Buyer'`)).rejects.toThrow(/stay blank/)
  })
})
