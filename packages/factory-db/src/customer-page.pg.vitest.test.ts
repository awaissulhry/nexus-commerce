import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedAuth, type AuthSeed } from '../seed/auth'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedPortalAuth, type PortalAuthSeed } from '../seed/portal-auth'
import { seed as seedTwoBrands, type TwoBrandsSeed } from '../seed/two-brands'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { seedCustomerPage, type CustomerPageFixture } from './testing/customer-page'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * B-CP-005 (customer page plan, schema wave "customer page 1/1"; 15-steps-notes §2 rows M1-M6, S1-S4, F1, G1-G5, D1, P1;
 * lead change: no PROFILE way, "Saved measurements" comes later): the wave's rules (…_customer_page_guards), on a database
 * built from the migrations and seeded, through the real login and the scoped client. Two customers of tenant A: P1 (Brand
 * Alpha, the seeds' customer: SEED-SO-0001 and its DRAFT portal request, testing/customer-page.ts) and Brand Beta (Seed Brand
 * Two of seed/two-brands.ts: SEED-SO-B001, its file and its portal buyer).
 *   - OrderBrandPrice: the shapes (a line row one of unit price and line total, the total row an amount, at least 0, one
 *     total row per order), the order's currency, a line of its own order, the order's company and customer (the key),
 *     never on a CLOSED or CANCELLED order (READY, SHIPPED, DELIVERED stay open), the source file of its own order (never
 *     Beta's), who typed it exactly when the factory did, the portal's PORTAL line rows and the office's carry (inserted,
 *     moved with its line by a split, never changed), the line held by its row (Restrict), the partner role's grants (no
 *     enteredById), the brand wall;
 *   - PortalOrderRequestLine: CATALOGUE · DESCRIBED · MADE_TO_MEASURE shapes, the customer's own price frozen at Send, a
 *     by-person line keeps its people; OD s.1 (schema wave "order start 1/1", …_order_start_guards; addendum R1-R3): every
 *     cell optional (a catalogue line's colourway, a described line's words, a made-to-measure line's garment type may
 *     wait), made to measure exactly when its sizing says so, its kind changes with its sizing; Send needs nothing (no line,
 *     no pieces: was "Send counts a line's pieces by its kind");
 *   - PortalOrderRequest: the parts sent later each once, who saved it last with when, the subject (OD s.1: 1 to 200 trimmed
 *     characters), all only while DRAFT (OD s.1: the office edits a draft too, Owner's yes 1a);
 *   - PortalOrderRequestPerson: DRAFT only, on a by-person line of its own request, SIZE · SHEET · LATER, the sheet a
 *     MEASUREMENTS file of its own request (never Beta's), removed with its line; OD s.1: the office writes them too, and
 *     the floor reads none of them (WS-OD-7);
 *   - od-ts (the order start's walls, design order-start-2026-11-25 13-backend §7; each case titled with its WS-OD id): a line's
 *     open choices (WS-OD-11); SENT → SENT the office's move for the style drafts only (WS-OD-11); the style drafts made for
 *     a draft (PortalOrderRequest.styleIds): only added, each once, at most 50, none at insert, never another customer's
 *     own label (WS-OD-3), office only — the partner role neither reads nor writes them (WS-OD-4);
 *   - PortalSettings: the factory designer slot (active office people, a backup only beside a designer and never the same,
 *     a customer or a brand only), mtmDraftsOn on by default;
 *   - StoredFile.priced: changes on a live file, a superseded version and a deleted one; a superseded version still keeps
 *     everything else;
 *   - the data step (D1): the priced documents, their copies and versions; two-factor on custom price roles.
 * The refusals are check_violation (SQLSTATE 23514; a key a unique_violation or a foreign_key_violation, a grant
 * "permission denied", a wall "row-level security"); their messages are read through raw SQL. Rows only time reaches (an
 * order in another state, a file of a record, a superseded version) are planted by the owner with triggers off. Not run in
 * the build (Owner rule: checks at the end).
 */

const NS = 'cp05-customer-page'
const DENIED = /permission denied/
const RLS = /row-level security/
const UNIQUE = /Unique constraint|duplicate key|unique/i
// A reference that fails (the constraint's name, or Prisma's or PostgreSQL's words for it).
const FOREIGN = /_fkey|foreign key/i
// OrderBrandPrice
const ROW_SHAPE = /is a line's unit price or line total \(exactly one\), or the order's total \(an amount\), at least 0/
const ISO_NOTE = /has an ISO currency and a note of up to 1000/
const ORDER_CURRENCY = /is in the order's currency/
const CLOSED = /the customer's prices stay as they were/
const OWN_LINE = /is of a line of its own order/
const PORTAL_ONLY = /the portal writes the customer's own price per line \(PORTAL\); a price the factory typed is removed first/
const CARRY = /came from the portal; the factory carries it with its line or types its own \(CUSTOMER_PO, OFFICE\)/
const ENTERED = /names who in the factory typed it exactly when the factory typed it \(CUSTOMER_PO, OFFICE\)/
const MOVE = /moves to another order only with its line \(a split of the order\)/
const SOURCE_FILE = /the source of customer's price .* is a file of its own order/
const TOTAL_IS_OURS = /the customer's total of order .* is the factory's to remove/
// The portal draft
// OD s.1 (addendum R3): every cell optional — a catalogue line's colourway, a described line's words, a garment type may wait.
const KIND_SHAPE = /names its style when from the catalogue \(its colourway may wait\), its people when made to measure; a colourway only with its style/
const SIZING_KIND = /is made to measure exactly when its sizing is MADE_TO_MEASURE/
const SUBJECT = /has a subject of 1 to 200 trimmed characters, or none/
const LINE_WORDS = /has words of up to 2000, colours in words of up to 200, a garment type of 1 to 40 trimmed characters, a total of 1 to 100000 pieces only when described, its own price of at least 0/
const LINES_DRAFT = /the lines of order request .* change only while it is a DRAFT/
const KEEPS_PEOPLE = /has its people; remove them before it is no longer by person/
const LATER_PARTS = /names the parts it sends later each once, and who saved it last together with when \(both or neither\)/
// OD s.1 (…_order_start_guards): SENT → SENT is the office's move for the style drafts only; the customer changes nothing of it.
// owb G1 (b) (order workflow, …_order_workflow_guards): but the order's picture, which both doors change while SENT (was: "only the
// office names the style drafts it made for it"; the office's list was "styleIds, version, updatedAt").
const NOT_SENT_AGAIN = /was sent; the customer changes only its picture \(the office names the style drafts it made for it\)/
const SENT_STYLES_ONLY = /\(SENT → SENT\) changes only styleIds, pictureFileId, pictureSetAt, pictureSetById, version, updatedAt/
const DECIDED_FROZEN = /is REFUSED; it never changes again/
// OD s.1 (…_order_start_guards): a line's open choices (factory_portal_draft_choices_ok).
const CHOICES = /has its open choices as 1 to 10 entries, each a topic of 1 to 60 trimmed characters, 2 to 6 distinct options of 1 to 60 trimmed characters, and the one picked \(one of them\) or none yet; no choice at all is null/
// OD s.1: the style drafts made for a request (PortalOrderRequest_guard, factory_portal_order_request_style_drafts_check).
const STYLES_NONE_AT_START = /starts with no style draft made for it yet/
const STYLES_AT_MOST = /are at most 50 styles, each once/
const STYLES_ONLY_ADDED = /are only added, after the ones named before; none is taken off or moved/
const STYLE_OF_TENANT = /which is not a style of the tenant, as a style draft made for it/
const STYLE_OF_COMPANY = /of another company as a style draft made for it/
const STYLE_PRIVATE_LABEL = /names another customer's private-label style as a style draft made for it; a private-label style is made only for its own customer/
const PEOPLE_DRAFT = /the people of order request .* change only while it is a DRAFT/
const BY_PERSON_LINE = /is on a by-person line of its own request/
const PERSON_SHAPE = /has its place \(1 or more\), a name of 1 to 120 trimmed characters, a number of up to 10, a note of up to 1000/
const MEASURE = /is measured by a size \(1 to 40 trimmed characters\), a measurement sheet or later, exactly one way/
const SHEET = /the measurement sheet of person .* is a measurement sheet of its own request/
// The factory designer slot
const DESIGNER_SINCE = /name a factory designer together with since when, or neither/
const BACKUP_BESIDE = /name a factory designer's backup only beside a factory designer, and never the designer/
const DESIGNER_ACTIVE = /the factory designer of the portal settings .* is an active office person/
const BACKUP_ACTIVE = /the factory designer's backup of the portal settings .* is an active office person/
const DESIGNER_PARTY = /a factory designer is named only for a customer or a brand/
// Files
const SUPERSEDED = /is a superseded version: it stays as it is/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let auth: AuthSeed
let portal: PortalAuthSeed
let two: TwoBrandsSeed
let cp: CustomerPageFixture

const key = (name: string): string => seedUuid(NS, name)
const P1 = key('party:P1')
const companyA = key('company:A')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: key('site:A1') })
const p1 = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: portal.userIds.p1Buyer, partyId: P1 })
const beta = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: two.portalUserIds.buyer, partyId: two.second.partyId })
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
/** A new row of `table` (every NOT NULL column named), planted. */
const plantRow = (table: string, row: Record<string, unknown>) => replica(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, [JSON.stringify(row)])
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
const refusalOf = (work: Promise<unknown>): Promise<string | null> => work.then(() => null, (error: Error) => error.message)
/** Neutral words: no customer id, code or name in a refusal (the brand wall). */
async function expectNeutral(words: string | null): Promise<void> {
  expect(words).not.toBeNull()
  const parties = await admin(`SELECT id::text AS id, code, "legalName" AS legal, coalesce("tradeName", '') AS trade FROM "Party" WHERE id IN ($1::uuid, $2::uuid)`, [P1, two.second.partyId])
  for (const party of parties) for (const word of [party.id, party.code, party.legal, party.trade].map(String).filter((entry) => entry.length > 0)) expect(words).not.toContain(word)
}

/** An order of P1 (a copy of SEED-SO-0001 in `status`, with `changes`) and its two lines, planted. */
interface OrderFixture {
  readonly order: string
  readonly lines: readonly [string, string]
}
async function order(status: string, changes: Record<string, unknown> = {}): Promise<OrderFixture> {
  const fixture: OrderFixture = { order: randomUUID(), lines: [randomUUID(), randomUUID()] }
  const now = new Date().toISOString()
  await plant('SalesOrder', cp.orderId, {
    id: fixture.order,
    number: tag('T-SO'),
    customerSeq: null,
    status,
    closedAt: status === 'CLOSED' || status === 'CANCELLED' ? now : null,
    cancelReason: status === 'CANCELLED' ? 'Made-up: the customer withdrew it.' : null,
    deliveredAt: status === 'DELIVERED' ? now : null,
    confirmationSentAt: null,
    confirmationVersion: null,
    ...changes,
  })
  await plant('SalesOrderLine', cp.lineIds[0], { id: fixture.lines[0], orderId: fixture.order })
  await plant('SalesOrderLine', cp.lineIds[1], { id: fixture.lines[1], orderId: fixture.order })
  return fixture
}
/** A customer's price row of `o` (its first line, a unit price, PORTAL), with `extra`. */
const priceRow = (o: OrderFixture, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: companyA,
  partyId: P1,
  salesOrderId: o.order,
  salesOrderLineId: o.lines[0],
  unitPrice: '41.500000',
  currency: 'EUR',
  source: 'PORTAL',
  ...extra,
})
/** The same row as the office types it from the customer's PO. */
const officeRow = (o: OrderFixture, extra: Record<string, unknown> = {}): Record<string, unknown> => priceRow(o, { source: 'CUSTOMER_PO', enteredById: a.actorId, ...extra })
/** A file planted as a copy of Beta's seeded file (AVAILABLE, unscanned), of `recordType`/`recordId`, office only. */
async function plantFile(changes: Record<string, unknown>): Promise<string> {
  const id = randomUUID()
  await plant('StoredFile', two.second.fileId, {
    id,
    storageKey: `t/${a.tenantId}/c/${companyA}/2026/${randomUUID()}`,
    visibility: ['OFFICE'],
    partyId: null,
    category: null,
    priced: false,
    seriesId: null,
    versionNo: 1,
    supersededAt: null,
    sourceFileId: null,
    thumbnailKey: null,
    exifStrippedAt: null,
    ...changes,
  })
  return id
}
/** A file shared with P1's portal (as its own uploads are). */
const p1File = (changes: Record<string, unknown>) => plantFile({ visibility: ['OFFICE', 'PARTNER'], partyId: P1, ...changes })

/** A new DRAFT of P1, made in its portal; its id. */
async function newDraft(): Promise<string> {
  const id = randomUUID()
  expect(await insert(p1(), 'PortalOrderRequest', { id, companyId: companyA, partyId: P1, currency: 'EUR', createdById: portal.userIds.p1Buyer })).toBe(1)
  return id
}
let catalogue: { styleId: string; colourwayId: string }
/** A line of `requestId` (CATALOGUE by default, the seeded draft's style and colourway), with `extra`. */
const draftLine = (requestId: string, seq: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  partyId: P1,
  requestId,
  seq,
  kind: 'CATALOGUE',
  styleId: catalogue.styleId,
  colourwayId: catalogue.colourwayId,
  ...extra,
})
/** A made-to-measure line of `requestId`; its id. */
async function mtmLine(requestId: string, seq = 1): Promise<string> {
  const row = draftLine(requestId, seq, { kind: 'MADE_TO_MEASURE', sizing: 'MADE_TO_MEASURE' /* OD s.1 */, styleId: null, colourwayId: null, garmentType: 'JACKET', byPerson: true })
  expect(await insert(p1(), 'PortalOrderRequestLine', row)).toBe(1)
  return row.id as string
}
const person = (requestId: string, lineId: string, seq: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  partyId: P1,
  requestId,
  lineId,
  seq,
  name: 'Test Rider',
  measureBy: 'LATER',
  ...extra,
})
/** P1's portal sends `requestId` (its number and when), as the portal does. */
const send = (requestId: string) =>
  update(p1(), 'PortalOrderRequest', requestId, `status = 'SENT', number = $2, "sentAt" = now(), "sentById" = $3::uuid, version = version + 1`, tag('T-RQ'), portal.userIds.p1Buyer)
/** P1's own label: the product seed's jacket SEED-JKT-01 (tenant-wide, its brand P1). */
const OWN_LABEL = key('product:style:JKT-01')
/**
 * A style copied from SEED-JKT-01 in the office scope, as the style library makes one: our own collection (no brand), tenant-wide,
 * unless `changes` say otherwise; its id.
 */
async function newStyle(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  const row = { id, code: tag('T-STY'), brandPartyId: null, soldUnderOurName: false, replacedById: null, ...changes }
  expect(await run(office(), `INSERT INTO "Style" SELECT * FROM jsonb_populate_record(NULL::"Style", (SELECT to_jsonb(r) || $1::jsonb FROM "Style" r WHERE r.id = $2::uuid))`, JSON.stringify(row), OWN_LABEL)).toBe(1)
  return id
}
/** The style drafts named on request `requestId`, read as the owner. */
const styleIdsOf = async (requestId: string): Promise<string[]> => (await admin(`SELECT "styleIds"::text[] AS ids FROM "PortalOrderRequest" WHERE id = $1::uuid`, [requestId]))[0]!.ids as string[]

beforeAll(async () => {
  db = await migratedDatabase('custpage')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  auth = await seedAuth({ db: factory, namespace: NS })
  portal = await seedPortalAuth({ db: factory, namespace: NS })
  cp = await seedCustomerPage({ db: factory, namespace: NS })
  two = await seedTwoBrands({ db: factory, namespace: NS })
  const [line] = await admin(`SELECT "styleId"::text AS style, "colourwayId"::text AS colourway FROM "PortalOrderRequestLine" WHERE "requestId" = $1::uuid AND seq = 1`, [cp.draftId])
  catalogue = { styleId: line!.style as string, colourwayId: line!.colourway as string }
}, 1_500_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 120_000)

// ---------------------------------------------------------------------------------------------------------------------------
describe("the customer's price of an order (OrderBrandPrice)", () => {
  it("the portal writes its own price per line; the office types its rows from the PO and names who typed them", async () => {
    const o = await order('CONFIRMED')
    const own = priceRow(o, { note: 'As on our PO 77.' })
    expect(await insert(p1(), 'OrderBrandPrice', own)).toBe(1)
    expect(await sql(p1(), `SELECT source::text AS source, "unitPrice"::text AS price, note FROM "OrderBrandPrice" WHERE id = $1::uuid`, own.id)).toEqual([
      { source: 'PORTAL', price: '41.500000', note: 'As on our PO 77.' },
    ])
    expect(await insert(office(), 'OrderBrandPrice', officeRow(o, { salesOrderLineId: o.lines[1], unitPrice: null, netAmount: 125_000 }))).toBe(1)
    expect(await insert(office(), 'OrderBrandPrice', officeRow(o, { salesOrderLineId: null, unitPrice: null, netAmount: 250_000, source: 'OFFICE' }))).toBe(1)
    // The fixture's rows: P1's PORTAL row of SEED-SO-0001's first line (no office person), the office's total (with one).
    expect(await admin(`SELECT source::text AS source, ("enteredById" IS NOT NULL) AS typed FROM "OrderBrandPrice" WHERE id IN ($1::uuid, $2::uuid) ORDER BY id`, [cp.priceIds.portalLine, cp.priceIds.officeTotal])).toEqual([
      { source: 'PORTAL', typed: false },
      { source: 'OFFICE', typed: true },
    ])
  })

  it('holds the shapes: a line row one of unit price and line total, the total row an amount, at least 0, an ISO currency, a note of up to 1000', async () => {
    const o = await order('CONFIRMED')
    for (const extra of [
      { unitPrice: '1.000000', netAmount: 100 },
      { unitPrice: null, netAmount: null },
      { unitPrice: '-0.010000' },
      { unitPrice: null, netAmount: -1 },
    ]) {
      expect(await refusalOf(insert(office(), 'OrderBrandPrice', officeRow(o, extra))), JSON.stringify(extra)).toMatch(ROW_SHAPE)
    }
    for (const extra of [{ salesOrderLineId: null, unitPrice: '10.000000' }, { salesOrderLineId: null, unitPrice: '10.000000', netAmount: 100 }, { salesOrderLineId: null, unitPrice: null }]) {
      expect(await refusalOf(insert(office(), 'OrderBrandPrice', officeRow(o, extra))), JSON.stringify(extra)).toMatch(ROW_SHAPE)
    }
    for (const extra of [{ currency: 'eur' }, { currency: 'EURO' }, { note: '   ' }, { note: 'x'.repeat(1001) }]) {
      expect(await refusalOf(insert(office(), 'OrderBrandPrice', officeRow(o, extra))), JSON.stringify(extra)).toMatch(ISO_NOTE)
    }
    expect(await insert(office(), 'OrderBrandPrice', officeRow(o, { unitPrice: '0.000000', note: 'x'.repeat(1000) }))).toBe(1)
  })

  it("is in the order's currency: no exchange rate, ever", async () => {
    const dollars = await order('CONFIRMED', { currency: 'USD' })
    const words = await refusalOf(insert(office(), 'OrderBrandPrice', officeRow(dollars)))
    expect(words).toMatch(ORDER_CURRENCY)
    await expectNeutral(words)
    expect(await insert(office(), 'OrderBrandPrice', officeRow(dollars, { currency: 'USD' }))).toBe(1)
  })

  it('one row per line, one total row per order (the partial unique index)', async () => {
    const o = await order('CONFIRMED')
    expect(await insert(office(), 'OrderBrandPrice', officeRow(o))).toBe(1)
    expect(await refusalOf(insert(office(), 'OrderBrandPrice', officeRow(o, { unitPrice: '50.000000' })))).toMatch(UNIQUE)
    const total = { salesOrderLineId: null, unitPrice: null, netAmount: 100_000 }
    expect(await insert(office(), 'OrderBrandPrice', officeRow(o, total))).toBe(1)
    expect(await refusalOf(insert(office(), 'OrderBrandPrice', officeRow(o, { ...total, netAmount: 90_000 })))).toMatch(/OrderBrandPrice_one_total/)
    // Another order takes its own total.
    expect(await insert(office(), 'OrderBrandPrice', officeRow(await order('CONFIRMED'), total))).toBe(1)
  })

  it("is of a line of its own order, of the order's own company and customer (the keys)", async () => {
    const o = await order('CONFIRMED')
    const other = await order('CONFIRMED')
    const words = await refusalOf(insert(office(), 'OrderBrandPrice', officeRow(o, { salesOrderLineId: other.lines[0] })))
    expect(words).toMatch(OWN_LINE)
    await expectNeutral(words)
    expect(await refusalOf(insert(p1(), 'OrderBrandPrice', priceRow(o, { salesOrderLineId: other.lines[0] })))).toMatch(OWN_LINE)
    // Beta's line on P1's order (the guard reads it first: a line of another order), P1's order with Beta's key or another
    // company (the references refuse them).
    expect(await refusalOf(insert(office(), 'OrderBrandPrice', officeRow(o, { salesOrderLineId: two.salesOrderLineId })))).toMatch(OWN_LINE)
    expect(await refusalOf(insert(office(), 'OrderBrandPrice', officeRow(o, { partyId: two.second.partyId })))).toMatch(FOREIGN)
    expect(await refusalOf(insert(office(), 'OrderBrandPrice', officeRow(o, { companyId: key('company:B') })))).toMatch(FOREIGN)
  })

  it('is never written on a CLOSED or CANCELLED order; READY, PARTLY_SHIPPED, SHIPPED and DELIVERED stay open (the price is checked at invoicing)', async () => {
    for (const status of ['CLOSED', 'CANCELLED']) {
      const o = await order(status)
      const words = await refusalOf(insert(office(), 'OrderBrandPrice', officeRow(o)))
      expect(words, status).toMatch(CLOSED)
      await expectNeutral(words)
      expect(await refusalOf(insert(p1(), 'OrderBrandPrice', priceRow(o))), status).toMatch(CLOSED)
    }
    for (const status of ['PENDING_APPROVAL', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED', 'DELIVERED']) {
      expect(await insert(p1(), 'OrderBrandPrice', priceRow(await order(status))), status).toBe(1)
    }
    // A row of an order closed later stays as it was: no change, no removal.
    const o = await order('CONFIRMED')
    const row = officeRow(o)
    expect(await insert(office(), 'OrderBrandPrice', row)).toBe(1)
    await replica(`UPDATE "SalesOrder" SET status = 'CLOSED', "closedAt" = now() WHERE id = $1::uuid`, [o.order])
    expect(await refusalOf(update(office(), 'OrderBrandPrice', row.id as string, `"unitPrice" = 40, version = version + 1`))).toMatch(CLOSED)
    expect(await refusalOf(remove(office(), 'OrderBrandPrice', row.id as string))).toMatch(CLOSED)
  })

  it("the portal writes PORTAL line rows only, changes only its own, and replaces the factory's by removing it first", async () => {
    const o = await order('CONFIRMED')
    for (const extra of [{ source: 'CUSTOMER_PO' }, { source: 'OFFICE' }, { salesOrderLineId: null, unitPrice: null, netAmount: 100_000 }]) {
      expect(await refusalOf(insert(p1(), 'OrderBrandPrice', priceRow(o, extra))), JSON.stringify(extra)).toMatch(PORTAL_ONLY)
    }
    const typed = officeRow(o)
    expect(await insert(office(), 'OrderBrandPrice', typed)).toBe(1)
    expect(await refusalOf(update(p1(), 'OrderBrandPrice', typed.id as string, `"unitPrice" = 39, source = 'PORTAL', version = version + 1`))).toMatch(PORTAL_ONLY)
    expect(await remove(p1(), 'OrderBrandPrice', typed.id as string)).toBe(1)
    const own = priceRow(o)
    expect(await insert(p1(), 'OrderBrandPrice', own)).toBe(1)
    expect(await update(p1(), 'OrderBrandPrice', own.id as string, `"unitPrice" = 39, note = 'Corrected.', version = version + 1`)).toBe(1)
    expect(await refusalOf(update(p1(), 'OrderBrandPrice', own.id as string, `source = 'OFFICE', version = version + 1`))).toMatch(PORTAL_ONLY)
    // The order's total is the factory's: the portal neither writes nor removes it.
    const total = officeRow(o, { salesOrderLineId: null, unitPrice: null, netAmount: 100_000 })
    expect(await insert(office(), 'OrderBrandPrice', total)).toBe(1)
    expect(await refusalOf(remove(p1(), 'OrderBrandPrice', total.id as string))).toMatch(TOTAL_IS_OURS)
  })

  it("the office writes PORTAL only as a carry (inserted, or moved with its line by a split); a change makes the row the office's", async () => {
    const o = await order('CONFIRMED')
    const split = await order('CONFIRMED')
    const carried = priceRow(o)
    expect(await insert(office(), 'OrderBrandPrice', carried)).toBe(1)
    const id = carried.id as string
    const words = await refusalOf(update(office(), 'OrderBrandPrice', id, `"unitPrice" = 40, version = version + 1`))
    expect(words).toMatch(CARRY)
    await expectNeutral(words)
    expect(await refusalOf(update(office(), 'OrderBrandPrice', id, `note = 'Ours.', version = version + 1`))).toMatch(CARRY)
    // A split: the order and its line move together, nothing else.
    expect(await update(office(), 'OrderBrandPrice', id, `"salesOrderId" = $2::uuid, "salesOrderLineId" = $3::uuid, version = version + 1`, split.order, split.lines[0])).toBe(1)
    expect(await refusalOf(update(office(), 'OrderBrandPrice', id, `"salesOrderLineId" = $2::uuid, version = version + 1`, split.lines[1]))).toMatch(MOVE)
    expect(await refusalOf(update(office(), 'OrderBrandPrice', id, `"salesOrderId" = $2::uuid, version = version + 1`, o.order))).toMatch(MOVE)
    expect(await refusalOf(update(p1(), 'OrderBrandPrice', id, `"salesOrderId" = $2::uuid, "salesOrderLineId" = $3::uuid, version = version + 1`, o.order, o.lines[0]))).toMatch(MOVE)
    // The factory types its own price over it: then it is the factory's, with who typed it.
    expect(await update(office(), 'OrderBrandPrice', id, `"unitPrice" = 40, source = 'OFFICE', "enteredById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    // The total row never moves.
    const total = officeRow(o, { salesOrderLineId: null, unitPrice: null, netAmount: 1 })
    expect(await insert(office(), 'OrderBrandPrice', total)).toBe(1)
    expect(await refusalOf(update(office(), 'OrderBrandPrice', total.id as string, `"salesOrderId" = $2::uuid, version = version + 1`, split.order))).toMatch(MOVE)
  })

  it('names who in the factory typed it exactly when the factory typed it; the version goes up by one', async () => {
    const o = await order('CONFIRMED')
    expect(await refusalOf(insert(office(), 'OrderBrandPrice', officeRow(o, { enteredById: null })))).toMatch(ENTERED)
    expect(await refusalOf(insert(office(), 'OrderBrandPrice', priceRow(o, { enteredById: a.actorId })))).toMatch(ENTERED)
    const row = officeRow(o)
    expect(await insert(office(), 'OrderBrandPrice', row)).toBe(1)
    expect(await refusalOf(update(office(), 'OrderBrandPrice', row.id as string, `"unitPrice" = 1, version = version + 2`))).toMatch(/goes up by one/)
    expect(await refusalOf(update(office(), 'OrderBrandPrice', row.id as string, `"partyId" = $2::uuid, version = version + 1`, two.second.partyId))).toMatch(/never change|_fkey|foreign key/i)
    expect(await refusalOf(insert(office(), 'OrderBrandPrice', officeRow(o, { salesOrderLineId: o.lines[1], version: 2 })))).toMatch(/at version 1/)
  })

  it("its source file is a file of its own order, not deleted, never another customer's (a Beta PO cannot price an Alpha order)", async () => {
    const o = await order('CONFIRMED')
    const po = await plantFile({ recordType: 'SalesOrder', recordId: o.order })
    expect(await insert(office(), 'OrderBrandPrice', officeRow(o, { sourceFileId: po }))).toBe(1)
    const otherOrder = await plantFile({ recordType: 'SalesOrder', recordId: (await order('CONFIRMED')).order })
    const sharedWithBeta = await plantFile({ recordType: 'SalesOrder', recordId: o.order, visibility: ['OFFICE', 'PARTNER'], partyId: two.second.partyId })
    const deleted = await plantFile({ recordType: 'SalesOrder', recordId: o.order, status: 'DELETED', deletedAt: new Date().toISOString() })
    for (const fileId of [two.second.fileId, otherOrder, sharedWithBeta, deleted]) {
      const words = await refusalOf(insert(office(), 'OrderBrandPrice', officeRow(o, { salesOrderLineId: o.lines[1], sourceFileId: fileId })))
      expect(words, fileId).toMatch(SOURCE_FILE)
      await expectNeutral(words)
    }
    // The portal names only a file it sees: its own order's, shared with it.
    const sharedPo = await p1File({ recordType: 'SalesOrder', recordId: o.order })
    expect(await refusalOf(insert(p1(), 'OrderBrandPrice', priceRow(o, { salesOrderLineId: o.lines[1], sourceFileId: po })))).toMatch(SOURCE_FILE)
    expect(await insert(p1(), 'OrderBrandPrice', priceRow(o, { salesOrderLineId: o.lines[1], sourceFileId: sharedPo }))).toBe(1)
  })

  it('holds its line: a line with a customer price is not removed (Restrict) until the row goes', async () => {
    const o = await order('CONFIRMED')
    const row = officeRow(o)
    expect(await insert(office(), 'OrderBrandPrice', row)).toBe(1)
    expect(await refusalOf(remove(office(), 'SalesOrderLine', o.lines[0]))).toMatch(/OrderBrandPrice_tenantId_partyId_salesOrderLineId_fkey/)
    expect(await remove(office(), 'OrderBrandPrice', row.id as string)).toBe(1)
    expect(await remove(office(), 'SalesOrderLine', o.lines[0])).toBe(1)
  })

  it("the portal never reads or writes who in the factory typed a row; the floor reaches none of it", async () => {
    await expect(sql(p1(), `SELECT "enteredById" FROM "OrderBrandPrice" LIMIT 1`)).rejects.toThrow(DENIED)
    const o = await order('CONFIRMED')
    await expect(insert(p1(), 'OrderBrandPrice', priceRow(o, { enteredById: null }))).rejects.toThrow(DENIED)
    await expect(sql(floor(), `SELECT id FROM "OrderBrandPrice" LIMIT 1`)).rejects.toThrow(DENIED)
    await expect(sql(floor(), `SELECT id FROM "PortalOrderRequestPerson" LIMIT 1`)).rejects.toThrow(DENIED)
  })

  it("the brand wall: Beta reads none of P1's prices and cannot write one for P1's order", async () => {
    expect(await sql(beta(), `SELECT id FROM "OrderBrandPrice" WHERE id IN ($1::uuid, $2::uuid)`, cp.priceIds.portalLine, cp.priceIds.officeTotal)).toEqual([])
    expect(await sql(beta(), `SELECT id FROM "OrderBrandPrice" WHERE "partyId" = $1::uuid`, P1)).toEqual([])
    const o = await order('CONFIRMED')
    expect(await refusalOf(insert(beta(), 'OrderBrandPrice', priceRow(o)))).toMatch(RLS)
    // With its own party on P1's order: an order it does not see (the guard), which the order's key refuses too.
    const words = await refusalOf(insert(beta(), 'OrderBrandPrice', priceRow(o, { partyId: two.second.partyId })))
    expect(words).toMatch(/is of an order this session does not see|_fkey|foreign key/i)
    await expectNeutral(words)
    expect(await run(beta(), `UPDATE "OrderBrandPrice" SET note = 'Beta' WHERE id = $1::uuid`, cp.priceIds.portalLine)).toBe(0)
    expect(await run(beta(), `DELETE FROM "OrderBrandPrice" WHERE id = $1::uuid`, cp.priceIds.portalLine)).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('the portal draft: line kinds, the parts sent later, Send', () => {
  // OD s.1 (addendum R3): every cell optional — was also refused: a catalogue line without its colourway, a described one
  // without words, a made-to-measure one without a garment type (each now inserts, below); made to measure exactly by its sizing.
  it('holds each kind of line to its shape', async () => {
    const draft = await newDraft()
    for (const extra of [
      { styleId: null, colourwayId: null },
      { kind: 'MADE_TO_MEASURE', sizing: 'MADE_TO_MEASURE', garmentType: 'JACKET', byPerson: false },
      { kind: 'DESCRIBED', description: 'Our own jacket', styleId: null },
    ]) {
      expect(await refusalOf(insert(p1(), 'PortalOrderRequestLine', draftLine(draft, 1, extra))), JSON.stringify(extra)).toMatch(KIND_SHAPE)
    }
    for (const extra of [
      { kind: 'MADE_TO_MEASURE', styleId: null, colourwayId: null, garmentType: 'JACKET', byPerson: true },
      { kind: 'MADE_TO_MEASURE', sizing: 'STANDARD', styleId: null, colourwayId: null, garmentType: 'JACKET', byPerson: true },
      { sizing: 'MADE_TO_MEASURE' },
      { kind: 'DESCRIBED', sizing: 'MADE_TO_MEASURE', styleId: null, colourwayId: null, byPerson: true },
    ]) {
      expect(await refusalOf(insert(p1(), 'PortalOrderRequestLine', draftLine(draft, 1, extra))), JSON.stringify(extra)).toMatch(SIZING_KIND)
    }
    for (const extra of [
      { quantity: 10 },
      { kind: 'DESCRIBED', description: 'Thirty vests', quantity: 0 },
      { kind: 'DESCRIBED', description: 'Thirty vests', quantity: 100_001 },
      { kind: 'DESCRIBED', description: 'x'.repeat(2001) },
      { kind: 'DESCRIBED', description: '  ' },
      { colourText: 'x'.repeat(201) },
      { kind: 'MADE_TO_MEASURE', sizing: 'MADE_TO_MEASURE', styleId: null, colourwayId: null, garmentType: ' JACKET', byPerson: true },
      { brandUnitPrice: '-1.000000' },
    ]) {
      expect(await refusalOf(insert(p1(), 'PortalOrderRequestLine', draftLine(draft, 1, extra))), JSON.stringify(extra)).toMatch(LINE_WORDS)
    }
    expect(await insert(p1(), 'PortalOrderRequestLine', draftLine(draft, 1, { brandUnitPrice: '399.000000' }))).toBe(1)
    expect(await insert(p1(), 'PortalOrderRequestLine', draftLine(draft, 2, { kind: 'DESCRIBED', styleId: null, colourwayId: null, description: 'Thirty vests, our logo on the back', colourText: 'Navy and white', quantity: 30 }))).toBe(1)
    expect(await insert(p1(), 'PortalOrderRequestLine', draftLine(draft, 3, { kind: 'DESCRIBED', description: 'In our own style, a shorter sleeve', colourwayId: null }))).toBe(1)
    expect(await insert(p1(), 'PortalOrderRequestLine', draftLine(draft, 4, { kind: 'MADE_TO_MEASURE', sizing: 'MADE_TO_MEASURE', colourwayId: null, garmentType: 'JACKET', byPerson: true }))).toBe(1)
    // OD s.1 (addendum R3): every cell optional — these were refused before the order start wave.
    expect(await insert(p1(), 'PortalOrderRequestLine', draftLine(draft, 5, { colourwayId: null, sizing: 'STANDARD' }))).toBe(1)
    expect(await insert(p1(), 'PortalOrderRequestLine', draftLine(draft, 6, { kind: 'DESCRIBED', styleId: null, colourwayId: null, description: null }))).toBe(1)
    const mtm = draftLine(draft, 7, { kind: 'MADE_TO_MEASURE', sizing: 'MADE_TO_MEASURE', styleId: null, colourwayId: null, garmentType: null, byPerson: true })
    expect(await insert(p1(), 'PortalOrderRequestLine', mtm)).toBe(1)
    // A line's kind changes with its sizing in one update, while DRAFT (nothing pins the kind); never one without the other.
    expect(await update(p1(), 'PortalOrderRequestLine', mtm.id as string, `kind = 'DESCRIBED', sizing = NULL, version = version + 1`)).toBe(1)
    expect(await refusalOf(update(p1(), 'PortalOrderRequestLine', mtm.id as string, `kind = 'MADE_TO_MEASURE', version = version + 1`))).toMatch(SIZING_KIND)
    expect(await update(office(), 'PortalOrderRequestLine', mtm.id as string, `kind = 'MADE_TO_MEASURE', sizing = 'MADE_TO_MEASURE', version = version + 1`)).toBe(1)
    expect(await admin(`SELECT kind::text AS kind, sizing::text AS sizing, "garmentType" FROM "PortalOrderRequestLine" WHERE id = $1::uuid`, [mtm.id])).toEqual([{ kind: 'MADE_TO_MEASURE', sizing: 'MADE_TO_MEASURE', garmentType: null }])
  })

  // OD s.1 (addendum R2): the draft's subject, as a mail's — a draft column of both doors, frozen at Send.
  it('keeps a subject of 1 to 200 trimmed characters or none, written by both doors while it is a DRAFT', async () => {
    const draft = await newDraft()
    expect(await update(p1(), 'PortalOrderRequest', draft, `subject = $2, version = version + 1`, 'x'.repeat(200))).toBe(1)
    expect(await update(office(), 'PortalOrderRequest', draft, `subject = 'Custom motorcycle suit for our race team', version = version + 1`)).toBe(1)
    for (const subject of ['x'.repeat(201), ' Suits', 'Suits ', '']) {
      expect(await refusalOf(update(p1(), 'PortalOrderRequest', draft, `subject = $2, version = version + 1`, subject)), JSON.stringify(subject)).toMatch(SUBJECT)
    }
    expect(await send(draft)).toBe(1)
    expect(await refusalOf(update(p1(), 'PortalOrderRequest', draft, `subject = NULL, version = version + 1`))).toMatch(NOT_SENT_AGAIN)
    expect(await refusalOf(update(office(), 'PortalOrderRequest', draft, `subject = NULL, version = version + 1`))).toMatch(SENT_STYLES_ONLY)
    expect(await admin(`SELECT subject FROM "PortalOrderRequest" WHERE id = $1::uuid`, [draft])).toEqual([{ subject: 'Custom motorcycle suit for our race team' }])
  })

  it('WS-OD-11: names the parts sent later each once and who saved it last with when, both only while it is a DRAFT; the office edits a draft too', async () => {
    const draft = await newDraft()
    expect(await update(p1(), 'PortalOrderRequest', draft, `"laterParts" = ARRAY['LOGOS', 'PEOPLE']::"PortalDraftPart"[], "lastEditedById" = $2::uuid, "lastEditedAt" = now(), version = version + 1`, portal.userIds.p1Buyer)).toBe(1)
    for (const set of [`"laterParts" = ARRAY['LOGOS', 'LOGOS']::"PortalDraftPart"[]`, `"laterParts" = NULL`, `"lastEditedAt" = NULL`]) {
      expect(await refusalOf(update(p1(), 'PortalOrderRequest', draft, `${set}, version = version + 1`)), set).toMatch(LATER_PARTS)
    }
    // OD s.1 (Owner's yes 1a): the office edits a draft too — its draft columns only.
    expect(await update(office(), 'PortalOrderRequest', draft, `"laterParts" = ARRAY['REFERENCES']::"PortalDraftPart"[], "lastEditedById" = $2::uuid, "lastEditedAt" = now(), version = version + 1`, a.actorId)).toBe(1)
    expect(await admin(`SELECT "laterParts"::text[] AS later, "lastEditedById"::text AS editor FROM "PortalOrderRequest" WHERE id = $1::uuid`, [draft])).toEqual([{ later: ['REFERENCES'], editor: a.actorId }])
    expect(await refusalOf(update(office(), 'PortalOrderRequest', draft, `"laterParts" = ARRAY['LOGOS', 'LOGOS']::"PortalDraftPart"[], version = version + 1`))).toMatch(LATER_PARTS)
    expect(await refusalOf(update(office(), 'PortalOrderRequest', draft, `"decidedAt" = now(), version = version + 1`))).toMatch(/\(DRAFT → DRAFT\) changes only source, customerRef/)
    expect(await insert(p1(), 'PortalOrderRequestLine', draftLine(draft, 1))).toBe(1)
    expect(await insert(p1(), 'PortalOrderRequestSize', { id: randomUUID(), partyId: P1, lineId: (await admin(`SELECT id::text AS id FROM "PortalOrderRequestLine" WHERE "requestId" = $1::uuid`, [draft]))[0]!.id, size: '52', quantity: 2 })).toBe(1)
    expect(await send(draft)).toBe(1)
    expect(await refusalOf(update(p1(), 'PortalOrderRequest', draft, `"laterParts" = ARRAY[]::"PortalDraftPart"[], version = version + 1`))).toMatch(NOT_SENT_AGAIN)
    expect(await refusalOf(update(office(), 'PortalOrderRequest', draft, `"laterParts" = ARRAY[]::"PortalDraftPart"[], version = version + 1`))).toMatch(SENT_STYLES_ONLY)
  })

  it("freezes the customer's own price at Send with the rest of the line", async () => {
    const draft = await newDraft()
    const line = draftLine(draft, 1, { brandUnitPrice: '410.000000' })
    expect(await insert(p1(), 'PortalOrderRequestLine', line)).toBe(1)
    expect(await update(p1(), 'PortalOrderRequestLine', line.id as string, `"brandUnitPrice" = 405, version = version + 1`)).toBe(1)
    expect(await insert(p1(), 'PortalOrderRequestSize', { id: randomUUID(), partyId: P1, lineId: line.id, size: '50', quantity: 3 })).toBe(1)
    expect(await send(draft)).toBe(1)
    expect(await refusalOf(update(p1(), 'PortalOrderRequestLine', line.id as string, `"brandUnitPrice" = 400, version = version + 1`))).toMatch(LINES_DRAFT)
    expect(await admin(`SELECT "brandUnitPrice"::text AS price FROM "PortalOrderRequestLine" WHERE id = $1::uuid`, [line.id])).toEqual([{ price: '405.000000' }])
  })

  // OD s.1 (…_order_start_guards; addendum R1 "we should not keep any requirements at all"): Send needs nothing — no line, no
  // pieces (the office asks what the order needs at its Confirm). Was: "sends a line with its pieces by its kind" (a line
  // without pieces, and a request without a line, were refused).
  it('WS-OD-11: sends with nothing at all (no line), or lines with their pieces by their kind or not decided yet', async () => {
    // No line at all: sent (OD s.1; was refused).
    const none = await newDraft()
    expect(await send(none)).toBe(1)
    // A described line with a total, no sizes.
    const described = await newDraft()
    expect(await insert(p1(), 'PortalOrderRequestLine', draftLine(described, 1, { kind: 'DESCRIBED', styleId: null, colourwayId: null, description: 'Thirty vests', quantity: 30 }))).toBe(1)
    expect(await send(described)).toBe(1)
    // A described line with neither (only the customer's words): sent (OD s.1; was refused).
    const wordsOnly = await newDraft()
    expect(await insert(p1(), 'PortalOrderRequestLine', draftLine(wordsOnly, 1, { kind: 'DESCRIBED', styleId: null, colourwayId: null, description: 'Some vests' }))).toBe(1)
    expect(await send(wordsOnly)).toBe(1)
    // A made-to-measure line: sent without its people yet (OD s.1; was refused), with one person, or with a sheet on the line.
    const nobody = await newDraft()
    await mtmLine(nobody)
    expect(await send(nobody)).toBe(1)
    const withPeople = await newDraft()
    const line = await mtmLine(withPeople)
    expect(await insert(p1(), 'PortalOrderRequestPerson', person(withPeople, line, 1, { measureBy: 'SIZE', size: '52' }))).toBe(1)
    expect(await send(withPeople)).toBe(1)
    const withSheet = await newDraft()
    const sheetLine = await mtmLine(withSheet)
    await p1File({ recordType: 'PortalOrderRequestLine', recordId: sheetLine, category: 'MEASUREMENTS' })
    expect(await send(withSheet)).toBe(1)
    // A catalogue line without its sizes yet: sent (OD s.1; was refused).
    const noSizes = await newDraft()
    expect(await insert(p1(), 'PortalOrderRequestLine', draftLine(noSizes, 1))).toBe(1)
    expect(await send(noSizes)).toBe(1)
    expect(await admin(`SELECT status::text AS status FROM "PortalOrderRequest" WHERE id IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid) ORDER BY id`, [none, wordsOnly, nobody, noSizes])).toEqual([{ status: 'SENT' }, { status: 'SENT' }, { status: 'SENT' }, { status: 'SENT' }])
  })

  // WS-OD-11 (OD s.1 (1) of the line guard, factory_portal_draft_choices_ok; 13-backend §1a, §1d): a line's open choices
  // ("Leather: Cowhide · Kangaroo · Not decided yet"), names only — none (null) or 1 to 10 {topic, options, picked}; '[]' is
  // refused (none is null, one way only). Written by both doors while it is a DRAFT, frozen at Send.
  it("WS-OD-11: a line's open choices are none (null) or 1 to 10 {topic, options, picked}; a bad shape fails", async () => {
    const draft = await newDraft()
    const leather = { topic: 'Leather', options: ['Cowhide', 'Kangaroo'], picked: null }
    const protection = { topic: 'Protection class', options: ['AA', 'AAA'], picked: 'AAA' }
    const eleven = Array.from({ length: 11 }, (_, index) => ({ topic: `Choice ${index + 1}`, options: ['Yes', 'No'], picked: null }))
    for (const choices of [
      [],
      eleven,
      [{ ...leather, options: ['Cowhide', 'Cowhide'] }],
      [{ ...leather, picked: 'Goat' }],
      [{ ...leather, picked: 'cowhide' }],
      [{ ...leather, options: ['Cowhide'] }],
      [{ ...leather, options: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] }],
      [{ ...leather, options: ['Cowhide', 'Kangaroo '] }],
      [{ ...leather, options: ['Cowhide', ''] }],
      [{ ...leather, options: ['Cowhide', 'x'.repeat(61)] }],
      [{ ...leather, options: ['Cowhide', 7] }],
      [{ ...leather, topic: '' }],
      [{ ...leather, topic: ' Leather' }],
      [{ ...leather, topic: 'x'.repeat(61) }],
      [{ ...leather, picked: 7 }],
      [{ topic: 'Leather', options: ['Cowhide', 'Kangaroo'] }],
      // Names only: no other key beside them (a price).
      [{ ...leather, price: '10.000000' }],
      [leather, 'Protection class'],
      { ...leather },
      'Leather',
    ]) {
      expect(await refusalOf(insert(p1(), 'PortalOrderRequestLine', draftLine(draft, 1, { choices }))), JSON.stringify(choices)).toMatch(CHOICES)
    }
    const line = draftLine(draft, 1, { choices: [leather, protection] })
    expect(await insert(p1(), 'PortalOrderRequestLine', line)).toBe(1)
    expect(await admin(`SELECT choices FROM "PortalOrderRequestLine" WHERE id = $1::uuid`, [line.id])).toEqual([{ choices: [leather, protection] }])
    // At the limits: ten choices, six options each, a topic and an option of 60 characters.
    const limits = Array.from({ length: 10 }, (_, index) => ({ topic: index === 0 ? 'x'.repeat(60) : `Choice ${index + 1}`, options: ['A', 'B', 'C', 'D', 'E', index === 0 ? 'y'.repeat(60) : 'F'], picked: index === 0 ? 'y'.repeat(60) : null }))
    expect(await insert(p1(), 'PortalOrderRequestLine', draftLine(draft, 2, { choices: limits }))).toBe(1)
    // The office writes them too (OD s.1: both doors); none is null.
    expect(await update(office(), 'PortalOrderRequestLine', line.id as string, `choices = $2::jsonb, version = version + 1`, JSON.stringify([{ ...leather, picked: 'Kangaroo' }]))).toBe(1)
    expect(await refusalOf(update(office(), 'PortalOrderRequestLine', line.id as string, `choices = '[]'::jsonb, version = version + 1`))).toMatch(CHOICES)
    expect(await update(p1(), 'PortalOrderRequestLine', line.id as string, `choices = NULL, version = version + 1`)).toBe(1)
    expect(await update(p1(), 'PortalOrderRequestLine', line.id as string, `choices = $2::jsonb, version = version + 1`, JSON.stringify([leather]))).toBe(1)
    // Frozen at Send with the rest of the line, for both doors.
    expect(await send(draft)).toBe(1)
    expect(await refusalOf(update(office(), 'PortalOrderRequestLine', line.id as string, `choices = NULL, version = version + 1`))).toMatch(LINES_DRAFT)
    expect(await refusalOf(update(p1(), 'PortalOrderRequestLine', line.id as string, `choices = $2::jsonb, version = version + 1`, JSON.stringify([protection])))).toMatch(LINES_DRAFT)
    expect(await admin(`SELECT choices FROM "PortalOrderRequestLine" WHERE id = $1::uuid`, [line.id])).toEqual([{ choices: [leather] }])
  })

  // WS-OD-11 (OD s.1 (1)-(2) of the request guard; 13-backend §1c): the office edits a DRAFT (its draft columns and the style
  // drafts in one write); SENT → SENT is the office's move for the style drafts only (design work goes on after the customer's
  // Send): nothing else of a sent request changes, beside them or alone, and the customer changes nothing of it; decided, frozen.
  it('WS-OD-11: office SENT → SENT changes only styleIds; the customer changes nothing of a sent request; decided, nothing changes', async () => {
    const draft = await newDraft()
    expect(await update(office(), 'PortalOrderRequest', draft, `subject = 'Made-up team jackets', "styleIds" = ARRAY[$2::uuid], version = version + 1`, OWN_LABEL)).toBe(1)
    expect(await send(draft)).toBe(1)
    expect(await update(office(), 'PortalOrderRequest', draft, `"styleIds" = "styleIds" || $2::uuid, version = version + 1`, catalogue.styleId)).toBe(1)
    expect(await refusalOf(update(office(), 'PortalOrderRequest', draft, `note = 'Office words after the Send.', version = version + 1`))).toMatch(SENT_STYLES_ONLY)
    expect(await refusalOf(update(office(), 'PortalOrderRequest', draft, `"styleIds" = "styleIds" || $2::uuid, "customerRef" = 'PO-T-LATE', version = version + 1`, await newStyle()))).toMatch(SENT_STYLES_ONLY)
    // A sent request names no other customer's own label either (the style drafts check reads every added style).
    expect(await refusalOf(update(office(), 'PortalOrderRequest', draft, `"styleIds" = "styleIds" || $2::uuid, version = version + 1`, two.styleId))).toMatch(STYLE_PRIVATE_LABEL)
    for (const set of [`note = 'Later words.'`, `subject = 'Another subject'`, `"customerRef" = 'PO-T-LATE'`]) {
      expect(await refusalOf(update(p1(), 'PortalOrderRequest', draft, `${set}, version = version + 1`)), set).toMatch(NOT_SENT_AGAIN)
    }
    expect(await styleIdsOf(draft)).toEqual([OWN_LABEL, catalogue.styleId])
    expect(await admin(`SELECT status::text AS status, subject, note, "customerRef" AS ref FROM "PortalOrderRequest" WHERE id = $1::uuid`, [draft])).toEqual([{ status: 'SENT', subject: 'Made-up team jackets', note: null, ref: null }])
    // Decided (refused in words): frozen, its style drafts too.
    expect(await update(office(), 'PortalOrderRequest', draft, `status = 'REFUSED', "refuseReason" = 'Made-up: not this season.', "decidedAt" = now(), "decidedById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    expect(await refusalOf(update(office(), 'PortalOrderRequest', draft, `"styleIds" = "styleIds" || $2::uuid, version = version + 1`, await newStyle()))).toMatch(DECIDED_FROZEN)
    expect(await styleIdsOf(draft)).toEqual([OWN_LABEL, catalogue.styleId])
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
// OD s.1 (schema wave "order start 1/1", …_order_start_guards; 13-backend §1a, §1c, §7 W6): the style drafts the office makes
// for a customer's draft (Make style draft) are named in PortalOrderRequest.styleIds — office only, only added, each once, at
// most 50, none at insert; each a style of the tenant, of the request's company or tenant-wide, our own collection or the
// request's customer's own label, never another customer's (factory_intake_style_allowed: the brand wall).
describe('the style drafts made for a draft (PortalOrderRequest.styleIds)', () => {
  it("WS-OD-3: a draft names no other customer's own-label style; our own or the customer's own label pass; only added, each once, at most 50, none at insert", async () => {
    const ours = await newStyle()
    const ofCompanyA = await newStyle({ companyId: companyA })
    const otherCompany = await newStyle({ companyId: key('company:B') })
    // None at insert, from either door (OD s.1: the office starts a draft too).
    const started = randomUUID()
    const officeDraft = { id: started, companyId: companyA, partyId: P1, currency: 'EUR', createdById: a.actorId }
    expect(await refusalOf(insert(office(), 'PortalOrderRequest', { ...officeDraft, styleIds: [OWN_LABEL] }))).toMatch(STYLES_NONE_AT_START)
    expect(await insert(office(), 'PortalOrderRequest', officeDraft)).toBe(1)
    expect(await styleIdsOf(started)).toEqual([])
    // Seed Brand Two's own label is never named on P1's draft; the words name no customer.
    const words = await refusalOf(update(office(), 'PortalOrderRequest', started, `"styleIds" = "styleIds" || $2::uuid, version = version + 1`, two.styleId))
    expect(words).toMatch(STYLE_PRIVATE_LABEL)
    await expectNeutral(words)
    // P1's own label and our own collection (tenant-wide, or of the request's company): named, in the order they were made.
    expect(await update(office(), 'PortalOrderRequest', started, `"styleIds" = ARRAY[$2::uuid], version = version + 1`, OWN_LABEL)).toBe(1)
    expect(await update(office(), 'PortalOrderRequest', started, `"styleIds" = "styleIds" || ARRAY[$2::uuid, $3::uuid], version = version + 1`, ours, ofCompanyA)).toBe(1)
    expect(await styleIdsOf(started)).toEqual([OWN_LABEL, ours, ofCompanyA])
    // Beta's own label after the ones named: still refused (every added style is checked).
    expect(await refusalOf(update(office(), 'PortalOrderRequest', started, `"styleIds" = "styleIds" || $2::uuid, version = version + 1`, two.styleId))).toMatch(STYLE_PRIVATE_LABEL)
    // Only added: none taken off, none moved, none named twice, never cleared.
    expect(await refusalOf(update(office(), 'PortalOrderRequest', started, `"styleIds" = ARRAY[$2::uuid, $3::uuid], version = version + 1`, OWN_LABEL, ours))).toMatch(STYLES_ONLY_ADDED)
    expect(await refusalOf(update(office(), 'PortalOrderRequest', started, `"styleIds" = ARRAY[$2::uuid, $3::uuid, $4::uuid], version = version + 1`, ours, OWN_LABEL, ofCompanyA))).toMatch(STYLES_ONLY_ADDED)
    expect(await refusalOf(update(office(), 'PortalOrderRequest', started, `"styleIds" = ARRAY[]::uuid[], version = version + 1`))).toMatch(STYLES_ONLY_ADDED)
    expect(await refusalOf(update(office(), 'PortalOrderRequest', started, `"styleIds" = "styleIds" || $2::uuid, version = version + 1`, ours))).toMatch(STYLES_AT_MOST)
    expect(await refusalOf(update(office(), 'PortalOrderRequest', started, `"styleIds" = NULL, version = version + 1`))).toMatch(STYLES_AT_MOST)
    // Of the request's company or tenant-wide, and a style of the tenant.
    expect(await refusalOf(update(office(), 'PortalOrderRequest', started, `"styleIds" = "styleIds" || $2::uuid, version = version + 1`, otherCompany))).toMatch(STYLE_OF_COMPANY)
    expect(await refusalOf(update(office(), 'PortalOrderRequest', started, `"styleIds" = "styleIds" || $2::uuid, version = version + 1`, randomUUID()))).toMatch(STYLE_OF_TENANT)
    expect(await styleIdsOf(started)).toEqual([OWN_LABEL, ours, ofCompanyA])
    // The same wall the other way: on Seed Brand Two's own draft its own label is named, P1's never.
    const betaDraft = randomUUID()
    expect(await insert(office(), 'PortalOrderRequest', { ...officeDraft, id: betaDraft, partyId: two.second.partyId })).toBe(1)
    expect(await refusalOf(update(office(), 'PortalOrderRequest', betaDraft, `"styleIds" = ARRAY[$2::uuid], version = version + 1`, OWN_LABEL))).toMatch(STYLE_PRIVATE_LABEL)
    expect(await update(office(), 'PortalOrderRequest', betaDraft, `"styleIds" = ARRAY[$2::uuid, $3::uuid], version = version + 1`, two.styleId, ours)).toBe(1)
    // At most 50.
    const many = await newDraft()
    const fiftyOne: string[] = []
    for (let index = 0; index < 51; index++) fiftyOne.push(await newStyle())
    expect(await update(office(), 'PortalOrderRequest', many, `"styleIds" = $2::uuid[], version = version + 1`, fiftyOne.slice(0, 50))).toBe(1)
    expect(await refusalOf(update(office(), 'PortalOrderRequest', many, `"styleIds" = "styleIds" || $2::uuid, version = version + 1`, fiftyOne[50]))).toMatch(STYLES_AT_MOST)
    expect(await styleIdsOf(many)).toEqual(fiftyOne.slice(0, 50))
  })

  // WS-OD-4 (DB half; 13-backend §1b, §7): the partner role has no column grant on styleIds (ownership/portal-sales.json
  // hiddenColumns). The generated isolation tests read every hidden column of every model; this is the explicit case.
  it('WS-OD-4: the partner role can neither select nor write styleIds', async () => {
    const draft = await newDraft()
    expect(await update(office(), 'PortalOrderRequest', draft, `"styleIds" = ARRAY[$2::uuid], version = version + 1`, OWN_LABEL)).toBe(1)
    await expect(sql(p1(), `SELECT "styleIds" FROM "PortalOrderRequest" WHERE id = $1::uuid`, draft)).rejects.toThrow(DENIED)
    await expect(sql(p1(), `SELECT id FROM "PortalOrderRequest" WHERE cardinality("styleIds") > 0`)).rejects.toThrow(DENIED)
    await expect(sql(p1(), `SELECT to_jsonb(r) AS row FROM "PortalOrderRequest" r WHERE r.id = $1::uuid`, draft)).rejects.toThrow(DENIED)
    await expect(update(p1(), 'PortalOrderRequest', draft, `"styleIds" = ARRAY[]::uuid[], version = version + 1`)).rejects.toThrow(DENIED)
    await expect(update(p1(), 'PortalOrderRequest', draft, `"styleIds" = ARRAY[$2::uuid, $3::uuid], version = version + 1`, OWN_LABEL, catalogue.styleId)).rejects.toThrow(DENIED)
    await expect(insert(p1(), 'PortalOrderRequest', { id: randomUUID(), companyId: companyA, partyId: P1, currency: 'EUR', createdById: portal.userIds.p1Buyer, styleIds: [] })).rejects.toThrow(DENIED)
    // Its other columns it reads and writes as before; the office's list stays as it was.
    expect(await update(p1(), 'PortalOrderRequest', draft, `note = 'Our words.', version = version + 1`)).toBe(1)
    expect(await sql(p1(), `SELECT id::text AS id, note, version FROM "PortalOrderRequest" WHERE id = $1::uuid`, draft)).toEqual([{ id: draft, note: 'Our words.', version: 3 }])
    expect(await styleIdsOf(draft)).toEqual([OWN_LABEL])
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('the people of a by-person line (PortalOrderRequestPerson)', () => {
  it('are measured by a size, a measurement sheet of its own request, or later — one way', async () => {
    const draft = await newDraft()
    const line = await mtmLine(draft)
    const ownSheet = await p1File({ recordType: 'PortalOrderRequest', recordId: draft, category: 'MEASUREMENTS' })
    const lineSheet = await p1File({ recordType: 'PortalOrderRequestLine', recordId: line, category: 'MEASUREMENTS' })
    expect(await insert(p1(), 'PortalOrderRequestPerson', person(draft, line, 1, { measureBy: 'SIZE', size: '52', number: '7' }))).toBe(1)
    expect(await insert(p1(), 'PortalOrderRequestPerson', person(draft, line, 2, { measureBy: 'SHEET', measurementFileId: ownSheet }))).toBe(1)
    expect(await insert(p1(), 'PortalOrderRequestPerson', person(draft, line, 3, { measureBy: 'SHEET', measurementFileId: lineSheet }))).toBe(1)
    expect(await insert(p1(), 'PortalOrderRequestPerson', person(draft, line, 4, { measureBy: 'LATER', note: 'Sends hers next week.' }))).toBe(1)
    for (const extra of [
      { measureBy: 'SIZE' },
      { measureBy: 'SIZE', size: ' 52' },
      { measureBy: 'SHEET' },
      { measureBy: 'LATER', size: '52' },
      { measureBy: 'LATER', measurementFileId: ownSheet },
    ]) {
      expect(await refusalOf(insert(p1(), 'PortalOrderRequestPerson', person(draft, line, 9, extra))), JSON.stringify(extra)).toMatch(MEASURE)
    }
    for (const extra of [{ name: '' }, { name: ' Rider' }, { name: 'x'.repeat(121) }, { number: '12345678901' }, { note: ' ' }]) {
      expect(await refusalOf(insert(p1(), 'PortalOrderRequestPerson', person(draft, line, 9, extra))), JSON.stringify(extra)).toMatch(PERSON_SHAPE)
    }
    expect(await refusalOf(insert(p1(), 'PortalOrderRequestPerson', person(draft, line, 0)))).toMatch(PERSON_SHAPE)
    expect(await refusalOf(insert(p1(), 'PortalOrderRequestPerson', person(draft, line, 1)))).toMatch(UNIQUE)
  })

  it("take a sheet of their own request only: not another request's, not a file of another kind, not Beta's", async () => {
    const draft = await newDraft()
    const line = await mtmLine(draft)
    const otherDraft = await newDraft()
    const othersSheet = await p1File({ recordType: 'PortalOrderRequest', recordId: otherDraft, category: 'MEASUREMENTS' })
    const notASheet = await p1File({ recordType: 'PortalOrderRequest', recordId: draft, category: null })
    const deletedSheet = await p1File({ recordType: 'PortalOrderRequest', recordId: draft, category: 'MEASUREMENTS', status: 'DELETED', deletedAt: new Date().toISOString() })
    const officeOnly = await plantFile({ recordType: 'PortalOrderRequest', recordId: draft, category: 'MEASUREMENTS' })
    for (const fileId of [othersSheet, notASheet, deletedSheet, officeOnly, two.second.fileId]) {
      const words = await refusalOf(insert(p1(), 'PortalOrderRequestPerson', person(draft, line, 1, { measureBy: 'SHEET', measurementFileId: fileId })))
      expect(words, fileId).toMatch(SHEET)
      await expectNeutral(words)
    }
  })

  it('sit on a by-person line of their own request, only while it is a DRAFT, and go with their line', async () => {
    const draft = await newDraft()
    const line = await mtmLine(draft)
    const catalogueLine = draftLine(draft, 2)
    expect(await insert(p1(), 'PortalOrderRequestLine', catalogueLine)).toBe(1)
    expect(await refusalOf(insert(p1(), 'PortalOrderRequestPerson', person(draft, catalogueLine.id as string, 1)))).toMatch(BY_PERSON_LINE)
    const otherDraft = await newDraft()
    expect(await refusalOf(insert(p1(), 'PortalOrderRequestPerson', person(otherDraft, line, 1)))).toMatch(BY_PERSON_LINE)
    const rider = person(draft, line, 1, { measureBy: 'SIZE', size: '50' })
    expect(await insert(p1(), 'PortalOrderRequestPerson', rider)).toBe(1)
    expect(await update(p1(), 'PortalOrderRequestPerson', rider.id as string, `size = '52', version = version + 1`)).toBe(1)
    expect(await refusalOf(update(p1(), 'PortalOrderRequestPerson', rider.id as string, `"lineId" = $2::uuid, version = version + 1`, catalogueLine.id))).toMatch(/stays on its line of its request/)
    // A line that has people stays by person; removing the line removes them. od-fx1: the kind change carries its sizing (OD s.1 (5):
    // made to measure exactly when sized so), so the refusal is the people's own.
    expect(await refusalOf(update(p1(), 'PortalOrderRequestLine', line, `"byPerson" = false, kind = 'DESCRIBED', sizing = 'STANDARD', description = 'Jackets', version = version + 1`))).toMatch(KEEPS_PEOPLE)
    expect(await remove(p1(), 'PortalOrderRequestLine', line)).toBe(1)
    expect(await admin(`SELECT count(*)::int AS n FROM "PortalOrderRequestPerson" WHERE "lineId" = $1::uuid`, [line])).toEqual([{ n: 0 }])
    // Once sent, they never change.
    const sent = await newDraft()
    const sentLine = await mtmLine(sent)
    const sentRider = person(sent, sentLine, 1, { measureBy: 'SIZE', size: '52' })
    expect(await insert(p1(), 'PortalOrderRequestPerson', sentRider)).toBe(1)
    expect(await send(sent)).toBe(1)
    expect(await refusalOf(update(p1(), 'PortalOrderRequestPerson', sentRider.id as string, `size = '54', version = version + 1`))).toMatch(PEOPLE_DRAFT)
    expect(await refusalOf(remove(p1(), 'PortalOrderRequestPerson', sentRider.id as string))).toMatch(PEOPLE_DRAFT)
    expect(await refusalOf(insert(p1(), 'PortalOrderRequestPerson', person(sent, sentLine, 2)))).toMatch(PEOPLE_DRAFT)
  })

  // OD s.1 (Owner's yes 1a): the office writes them too (orders.manage, checked by the API); was "the office … writes none".
  it("the office reads and writes them; Beta neither reads nor adds any of P1's", async () => {
    expect(await sql(office(), `SELECT seq, name, "measureBy"::text AS measure FROM "PortalOrderRequestPerson" WHERE "lineId" = $1::uuid ORDER BY seq`, cp.mtmLineId)).toEqual([
      { seq: 1, name: 'Rider One', measure: 'SIZE' },
      { seq: 2, name: 'Rider Two', measure: 'LATER' },
    ])
    const officeRider = person(cp.draftId, cp.mtmLineId, 9, { createdById: a.actorId })
    expect(await insert(office(), 'PortalOrderRequestPerson', officeRider)).toBe(1)
    expect(await update(office(), 'PortalOrderRequestPerson', officeRider.id as string, `"measureBy" = 'SIZE', size = '52', version = version + 1`)).toBe(1)
    expect(await refusalOf(update(office(), 'PortalOrderRequestPerson', officeRider.id as string, `"measureBy" = 'SIZE', size = NULL, version = version + 1`))).toMatch(MEASURE)
    expect(await remove(office(), 'PortalOrderRequestPerson', officeRider.id as string)).toBe(1)
    expect(await sql(beta(), `SELECT id FROM "PortalOrderRequestPerson" WHERE "requestId" = $1::uuid`, cp.draftId)).toEqual([])
    expect(await refusalOf(insert(beta(), 'PortalOrderRequestPerson', person(cp.draftId, cp.mtmLineId, 9)))).toMatch(RLS)
    expect(await refusalOf(insert(beta(), 'PortalOrderRequestPerson', person(cp.draftId, cp.mtmLineId, 9, { partyId: two.second.partyId })))).toMatch(FOREIGN)
  })

  // WS-OD-7 (DB half; 13-backend §7 "People: office reads, floor never"; the floor's no-grant case of the price describe above):
  // the people an office person adds to a draft the office started (OD s.1) are read by the office and the customer, never by
  // the floor — no grant on them, nor on the request or its lines they could be reached through.
  it('WS-OD-7: office-written people are read by the office and the customer, never by the floor', async () => {
    const draft = randomUUID()
    expect(await insert(office(), 'PortalOrderRequest', { id: draft, companyId: companyA, partyId: P1, currency: 'EUR', createdById: a.actorId })).toBe(1)
    const line = draftLine(draft, 1, { kind: 'MADE_TO_MEASURE', sizing: 'MADE_TO_MEASURE', styleId: null, colourwayId: null, byPerson: true, createdById: a.actorId })
    expect(await insert(office(), 'PortalOrderRequestLine', line)).toBe(1)
    const rider = person(draft, line.id as string, 1, { name: 'Office Test Rider', number: '9', measureBy: 'SIZE', size: '52', createdById: a.actorId })
    const later = person(draft, line.id as string, 2, { name: 'Office Later Rider', note: 'Made-up: measured at the fitting.', createdById: a.actorId })
    for (const row of [rider, later]) expect(await insert(office(), 'PortalOrderRequestPerson', row)).toBe(1)
    expect(await sql(office(), `SELECT seq, name, size, "createdById"::text AS creator FROM "PortalOrderRequestPerson" WHERE "requestId" = $1::uuid ORDER BY seq`, draft)).toEqual([
      { seq: 1, name: 'Office Test Rider', size: '52', creator: a.actorId },
      { seq: 2, name: 'Office Later Rider', size: null, creator: a.actorId },
    ])
    expect(await sql(p1(), `SELECT name FROM "PortalOrderRequestPerson" WHERE "requestId" = $1::uuid ORDER BY seq`, draft)).toEqual([{ name: 'Office Test Rider' }, { name: 'Office Later Rider' }])
    // The floor: nothing of them, not even a count, nor the line or the request they sit on; it writes none either.
    for (const [text, value] of [
      [`SELECT name FROM "PortalOrderRequestPerson" WHERE id = $1::uuid`, rider.id],
      [`SELECT count(*)::int AS n FROM "PortalOrderRequestPerson" WHERE "requestId" = $1::uuid`, draft],
      [`SELECT id FROM "PortalOrderRequestLine" WHERE id = $1::uuid`, line.id],
      [`SELECT id FROM "PortalOrderRequest" WHERE id = $1::uuid`, draft],
    ] as const) {
      await expect(sql(floor(), text, value), text).rejects.toThrow(DENIED)
    }
    await expect(update(floor(), 'PortalOrderRequestPerson', rider.id as string, `name = 'Floor words', version = version + 1`)).rejects.toThrow(DENIED)
    await expect(insert(floor(), 'PortalOrderRequestPerson', person(draft, line.id as string, 3))).rejects.toThrow(DENIED)
    // Another customer reads none of them.
    expect(await sql(beta(), `SELECT id FROM "PortalOrderRequestPerson" WHERE "requestId" = $1::uuid`, draft)).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe("the customer's factory designer (PortalSettings)", () => {
  const settings = () => portal.settingsIds.p1
  const clear = () => update(office(), 'PortalSettings', settings(), `"factoryDesignerBackupId" = NULL, "factoryDesignerId" = NULL, "factoryDesignerSetAt" = NULL, version = version + 1`)

  it('names an active office person with since when, a backup beside it, never the same person', async () => {
    expect(await update(office(), 'PortalSettings', settings(), `"factoryDesignerId" = $2::uuid, "factoryDesignerSetAt" = now(), "factoryDesignerBackupId" = $3::uuid, version = version + 1`, auth.memberId, auth.ownerId)).toBe(1)
    expect(await refusalOf(update(office(), 'PortalSettings', settings(), `"factoryDesignerSetAt" = NULL, version = version + 1`))).toMatch(DESIGNER_SINCE)
    expect(await refusalOf(update(office(), 'PortalSettings', settings(), `"factoryDesignerBackupId" = "factoryDesignerId", version = version + 1`))).toMatch(BACKUP_BESIDE)
    expect(await refusalOf(update(office(), 'PortalSettings', settings(), `"factoryDesignerId" = NULL, "factoryDesignerSetAt" = NULL, version = version + 1`))).toMatch(BACKUP_BESIDE)
    expect(await clear()).toBe(1)
    expect(await refusalOf(update(office(), 'PortalSettings', settings(), `"factoryDesignerId" = $2::uuid, version = version + 1`, auth.memberId))).toMatch(DESIGNER_SINCE)
  })

  // Office-only refusals (the partner role has no grant on PortalSettings): they may name the settings' own party.
  it('refuses an invited person, a portal person, and a party that is not a customer or a brand', async () => {
    for (const userId of [auth.invitedId, portal.userIds.p1Buyer]) {
      const words = await refusalOf(update(office(), 'PortalSettings', settings(), `"factoryDesignerId" = $2::uuid, "factoryDesignerSetAt" = now(), version = version + 1`, userId))
      expect(words, userId).toMatch(DESIGNER_ACTIVE)
    }
    expect(
      await refusalOf(update(office(), 'PortalSettings', settings(), `"factoryDesignerId" = $2::uuid, "factoryDesignerSetAt" = now(), "factoryDesignerBackupId" = $3::uuid, version = version + 1`, auth.memberId, auth.invitedId)),
    ).toMatch(BACKUP_ACTIVE)
    expect(await refusalOf(update(office(), 'PortalSettings', portal.settingsIds.p2, `"factoryDesignerId" = $2::uuid, "factoryDesignerSetAt" = now(), version = version + 1`, auth.memberId))).toMatch(DESIGNER_PARTY)
    expect(await admin(`SELECT ("factoryDesignerId" IS NULL) AS cleared FROM "PortalSettings" WHERE id IN ($1::uuid, $2::uuid)`, [settings(), portal.settingsIds.p2])).toEqual([{ cleared: true }, { cleared: true }])
  })

  it('keeps made-to-measure drafts on by default; the portal reads none of the slot', async () => {
    expect(await admin(`SELECT DISTINCT "mtmDraftsOn" AS mtm FROM "PortalSettings" WHERE "tenantId" = $1::uuid`, [a.tenantId])).toEqual([{ mtm: true }])
    expect(await update(office(), 'PortalSettings', settings(), `"mtmDraftsOn" = false, version = version + 1`)).toBe(1)
    expect(await update(office(), 'PortalSettings', settings(), `"mtmDraftsOn" = true, version = version + 1`)).toBe(1)
    await expect(sql(p1(), `SELECT "factoryDesignerId" FROM "PortalSettings" LIMIT 1`)).rejects.toThrow(DENIED)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('StoredFile.priced (the money wall’s lock flag)', () => {
  it('changes on a live file, on a superseded version and on a deleted one; a superseded version keeps everything else', async () => {
    const live = await plantFile({ recordType: 'SalesOrder', recordId: cp.orderId })
    expect(await update(office(), 'StoredFile', live, `priced = true, version = version + 1`)).toBe(1)
    expect(await update(office(), 'StoredFile', live, `priced = false, version = version + 1`)).toBe(1)
    const first = await plantFile({ recordType: 'SalesOrder', recordId: cp.orderId, supersededAt: new Date().toISOString() })
    await plantFile({ recordType: 'SalesOrder', recordId: cp.orderId, seriesId: first, versionNo: 2 })
    expect(await update(office(), 'StoredFile', first, `priced = true, version = version + 1`)).toBe(1)
    expect(await refusalOf(update(office(), 'StoredFile', first, `category = 'MEASUREMENTS', version = version + 1`))).toMatch(SUPERSEDED)
    const gone = await plantFile({ recordType: 'SalesOrder', recordId: cp.orderId, status: 'DELETED', deletedAt: new Date().toISOString() })
    expect(await update(office(), 'StoredFile', gone, `priced = true, version = version + 1`)).toBe(1)
    expect(await admin(`SELECT priced FROM "StoredFile" WHERE id IN ($1::uuid, $2::uuid, $3::uuid) ORDER BY priced`, [live, first, gone])).toEqual([{ priced: false }, { priced: true }, { priced: true }])
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
// Last: the data step runs again over rows planted now (it is written to run once; every statement is safe to repeat).
describe('the data step (D1): priced documents and two-factor on price roles', () => {
  const dataStep = (): string => {
    // The folder by its name, whatever its timestamp (the lead may renumber it when it lands).
    const migrations = new URL('../prisma/migrations/', import.meta.url)
    const folder = readdirSync(migrations).find((name) => name.endsWith('_customer_page_guards'))
    expect(folder).toBeDefined()
    const text = readFileSync(new URL(`${folder}/migration.sql`, migrations), 'utf8')
    const at = text.indexOf('-- Data (D1), once.')
    expect(at).toBeGreaterThan(0)
    return text.slice(at)
  }

  it('marks the documents that show prices (CN22 / CN23 and the invoices\' XML too), their copies and versions; nothing else', async () => {
    const now = new Date().toISOString()
    const confirmation = await plantFile({ recordType: 'SalesOrder', recordId: cp.orderId })
    await plantRow('GeneratedDocument', { id: randomUUID(), tenantId: a.tenantId, companyId: companyA, recordType: 'SalesOrder', recordId: cp.orderId, kind: 'ORDER_CONFIRMATION', version: 901, fingerprint: 'test', language: 'it', fileId: confirmation, createdAt: now })
    const copy = await plantFile({ recordType: 'Shipment', recordId: randomUUID(), sourceFileId: confirmation })
    const copyOfCopy = await plantFile({ recordType: 'Shipment', recordId: randomUUID(), sourceFileId: copy })
    const later = await plantFile({ recordType: 'SalesOrder', recordId: cp.orderId, seriesId: confirmation, versionNo: 2 })
    const quote = await plantFile({ recordType: 'Quote', recordId: randomUUID(), kind: 'FISCAL_ARCHIVE', storageKey: `legal/t/${a.tenantId}/${randomUUID()}`, retainUntil: '2037-01-01T00:00:00.000Z' })
    const reminder = await plantFile({ recordType: 'PaymentReminder', recordId: randomUUID() })
    const statement = await plantFile({ recordType: 'Party', recordId: P1 })
    await plantRow('AuditLog', { id: randomUUID(), tenantId: a.tenantId, at: now, audience: 'OFFICE', actorId: a.actorId, action: 'receivables.sendStatement', recordType: 'Party', recordId: P1, after: { fileId: statement }, requestId: 'test' })
    const packList = await plantFile({ recordType: 'Shipment', recordId: randomUUID() })
    await plantRow('GeneratedDocument', { id: randomUUID(), tenantId: a.tenantId, companyId: companyA, recordType: 'Shipment', recordId: randomUUID(), kind: 'PACKING_LIST', version: 1, fingerprint: 'test', language: 'it', fileId: packList, createdAt: now })
    const plain = await plantFile({ recordType: 'SalesOrder', recordId: cp.orderId })
    // Lead decision 11-19: the customs papers' values and the invoices' FatturaPA XML are prices too.
    const cn22 = await plantFile({ recordType: 'Shipment', recordId: randomUUID() })
    await plantRow('GeneratedDocument', { id: randomUUID(), tenantId: a.tenantId, companyId: companyA, recordType: 'Shipment', recordId: randomUUID(), kind: 'CN22', version: 1, fingerprint: 'test', language: 'it', fileId: cn22, createdAt: now })
    const cn23 = await plantFile({ recordType: 'Shipment', recordId: randomUUID() })
    await plantRow('GeneratedDocument', { id: randomUUID(), tenantId: a.tenantId, companyId: companyA, recordType: 'Shipment', recordId: randomUUID(), kind: 'CN23', version: 1, fingerprint: 'test', language: 'it', fileId: cn23, createdAt: now })
    await db.admin.query(dataStep())
    // The seeded invoices' XML (seed/money.ts).
    const xml = await admin(`SELECT f.priced FROM "Invoice" i JOIN "StoredFile" f ON f."tenantId" = i."tenantId" AND f.id = i."xmlFileId" WHERE i."tenantId" = $1::uuid`, [a.tenantId])
    expect(xml.length).toBeGreaterThan(0)
    expect(xml.every((row) => row.priced === true)).toBe(true)
    const priced = await admin(`SELECT id::text AS id, priced FROM "StoredFile" WHERE id = ANY($1::uuid[])`, [[confirmation, copy, copyOfCopy, later, quote, reminder, statement, cn22, cn23, packList, plain]])
    const of = (id: string) => priced.find((row) => row.id === id)?.priced
    for (const id of [confirmation, copy, copyOfCopy, later, quote, reminder, statement, cn22, cn23]) expect(of(id), id).toBe(true)
    for (const id of [packList, plain]) expect(of(id), id).toBe(false)
  })

  it('asks two-factor of the custom office roles that see prices, costs or margins (with since when); no other role moves', async () => {
    const now = new Date().toISOString()
    const role = (grains: string[], extra: Record<string, unknown> = {}) => ({
      id: randomUUID(),
      tenantId: a.tenantId,
      key: tag('custom.test'),
      name: tag('Test role'),
      system: false,
      audience: 'OFFICE',
      requireMfa: false,
      permissions: [],
      grains,
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...extra,
    })
    const prices = role(['price'])
    const margins = role(['margin', 'wages'])
    const wages = role(['wages'])
    const archived = role(['cost'], { archivedAt: now, archivedById: a.actorId })
    for (const row of [prices, margins, wages, archived]) await plantRow('Role', row)
    await db.admin.query(dataStep())
    const rows = await admin(`SELECT id::text AS id, "requireMfa" AS mfa, ("requireMfaSince" IS NOT NULL) AS since FROM "Role" WHERE id = ANY($1::uuid[])`, [[prices.id, margins.id, wages.id, archived.id]])
    const of = (id: string) => rows.find((row) => row.id === id)
    expect(of(prices.id)).toEqual({ id: prices.id, mfa: true, since: true })
    expect(of(margins.id)).toEqual({ id: margins.id, mfa: true, since: true })
    expect(of(wages.id)).toEqual({ id: wages.id, mfa: false, since: false })
    expect(of(archived.id)).toEqual({ id: archived.id, mfa: false, since: false })
  })
})
