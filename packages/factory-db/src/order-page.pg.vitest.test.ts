import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedAuth } from '../seed/auth'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedPortalAuth, type PortalAuthSeed } from '../seed/portal-auth'
import { seed as seedShipping, type ShippingSeed } from '../seed/shipping'
import { seed as seedTwoBrands, type TwoBrandsSeed } from '../seed/two-brands'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels } from './ownership'
import { FLOOR_ROLE, PARTNER_ROLE, RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * B-OP-005 (order page plan, schema wave "order page 1/1"; plan N5, N6 and decision D6; review R-8, R-10, R-23; 15-steps-notes
 * §3: N6 LINES-DERIVED): the wave's rules (…_order_page_guards), on a database built from the migrations and seeded, through
 * the real login and the scoped client, for every login. Two customers of tenant A: P1 (Brand Alpha, the seeds' customer:
 * SEED-SO-0002 with WO-0001, SEED-SO-0003 with the serial-tracked WO-0003, SH-0001 shipped, SH-0002 a DRAFT) and Brand Beta
 * (Seed Brand Two of seed/two-brands.ts: SEED-SO-B001, SEED-WO-B001).
 *   - N6: a line of another OPEN order of the shipment's customer and company, in the first order's currency and tax mode,
 *     joins a DRAFT shipment; the order is then on the shipment (factory_order_shipments) and leaves it with its last line;
 *     a PENDING_APPROVAL, SHIPPED, DELIVERED, CLOSED or CANCELLED order, another company, currency or tax mode, and
 *     another customer's order are refused in words that name no customer; lines change only while DRAFT;
 *   - R-8: the floor's packing writes still pass (it skips the order check and reads no sales order); the floor reads none
 *     of the wave's shipment columns;
 *   - an order is DELIVERED through its lines; a message about a shipment of two orders is a part of both orders' threads;
 *   - N5: a shipment made ELSEWHERE moves DRAFT → SHIPPED in one step, at most 60 days back, never packed or split; where it
 *     was made never changes; its paper DDT is both or neither, as printed, dated by the day it left, fixed once it left,
 *     required unless an immediate invoice travelled (R-23), once per customer (R-10); Nexus issues no DDT of it;
 *   - the typed tracking link: https, up to 500 on one line, no user name or password, only with its number.
 * The refusals are check_violation (SQLSTATE 23514; a key a unique_violation, a grant "permission denied"); their messages
 * are read through raw SQL. Fixtures that only time reaches (another order of P1 with its own released cell, a shipment that
 * left) are planted by the owner with triggers off. Not run in the build (Owner rule 2026-11-17: checks at the end).
 */

const NS = 'op05-order-page'
const DENIED = /permission denied/
const CANNOT_TRAVEL = /of an order that cannot travel in shipment .*: another order joins a DRAFT shipment only while it is open/
const NOT_A_PART = /is about a part of its own order \(not a part of this record\)/
const AS_IT_LEFT = /made elsewhere is recorded packed and shipped at the time it left \(the same time\), not in the future and at most 60 days back/
const DDT_SHAPE = /names the paper DDT it left with, number and date \(both or neither\), only when it was made elsewhere/
const DDT_NUMBER = /the paper DDT number of shipment .* is 1 to 40 characters on one line, as printed \(no space at either end\)/
const LINK = /has a tracking link typed by hand only with its typed tracking number: https, up to 500 characters on one line, no user name or password in it/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let portal: PortalAuthSeed
let shipping: ShippingSeed
let two: TwoBrandsSeed

const key = (name: string): string => seedUuid(NS, name)
const P1 = key('party:P1')
const companyA = key('company:A')
const companyB = key('company:B')
const siteA1 = key('site:A1')
const prod = () => shipping.quality.production
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: siteA1 })
const p1 = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: portal.userIds.p1Buyer, partyId: P1 })
const beta = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: two.portalUserIds.buyer, partyId: two.second.partyId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const insertSql = (table: string, row: Record<string, unknown>): [string, string] => {
  const columns = Object.keys(row).map((column) => `"${column}"`).join(', ')
  return [`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row)]
}
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => run(scope, ...insertSql(table, row))
/** INSERT a copy of row `id` of `table` with `changes`, as the office (it reads every column of these tables). */
const copyRow = (table: string, id: string, changes: Record<string, unknown>, scope: FactoryScope = office()) =>
  run(scope, `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
/** The same copy as the owner with every trigger off (set-up only: another order of P1, a shipment that already left). */
async function plant(table: string, id: string, changes: Record<string, unknown>): Promise<void> {
  await db.admin.query('BEGIN')
  try {
    await db.admin.query("SET LOCAL session_replication_role = 'replica'")
    await db.admin.query(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, [JSON.stringify(changes), id])
    await db.admin.query('COMMIT')
  } catch (error) {
    await db.admin.query('ROLLBACK')
    throw error
  }
}
/** The database server's clock, `ms` later (the container's clock drifts from the host's). */
const serverNow = async (ms = 0): Promise<string> =>
  ((await admin(`SELECT clock_timestamp() + $1::int * interval '1 millisecond' AS at`, [ms]))[0]!.at as Date).toISOString()
/** The day in Rome `back` days ago, as YYYY-MM-DD (the server's clock). */
const romeDay = async (back: number): Promise<string> =>
  (await admin(`SELECT to_char((now() AT TIME ZONE 'Europe/Rome')::date - $1::int, 'YYYY-MM-DD') AS day`, [back]))[0]!.day as string
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
/** The refusal's words, or null when it passed. */
const refusalOf = (work: Promise<unknown>): Promise<string | null> => work.then(() => null, (error: Error) => error.message)
/** Neutral words: no customer id, code or name in a refusal (the brand wall). */
async function expectNeutral(words: string | null): Promise<void> {
  expect(words).not.toBeNull()
  const parties = await admin(`SELECT id::text AS id, code, "legalName" AS legal, coalesce("tradeName", '') AS trade FROM "Party" WHERE id IN ($1::uuid, $2::uuid)`, [P1, two.second.partyId])
  for (const party of parties) for (const word of [party.id, party.code, party.legal, party.trade].map(String).filter((entry) => entry.length > 0)) expect(words).not.toContain(word)
}

/** An order of P1 and its garments: one line, a cell of WO-0001 for that line (a size of its own) with 10 released garments. */
interface OrderFixture {
  readonly order: string
  readonly line: string
  readonly cell: string
  readonly size: string
}
let nextSize = 60
let baseLine = ''
/** A copy of SEED-SO-0002 in `status` (with `changes`), planted with its line, cell and release (see OrderFixture). */
async function order(status: string, changes: Record<string, unknown> = {}): Promise<OrderFixture> {
  nextSize += 2
  const fixture: OrderFixture = { order: randomUUID(), line: randomUUID(), cell: randomUUID(), size: String(nextSize) }
  const closed = status === 'CLOSED' || status === 'CANCELLED'
  await plant('SalesOrder', prod().salesOrderId, {
    id: fixture.order,
    number: tag('T-SO'),
    customerSeq: null,
    status,
    deliveredAt: null,
    closedAt: closed ? await serverNow() : null,
    cancelReason: status === 'CANCELLED' ? 'Made-up: the customer withdrew it.' : null,
    confirmationSentAt: null,
    confirmationVersion: null,
    ...changes,
  })
  await plant('SalesOrderLine', baseLine, { id: fixture.line, orderId: fixture.order })
  await plant('WorkOrderSize', prod().cellIds['BLK-52'], { id: fixture.cell, salesOrderLineId: fixture.line, size: fixture.size, version: 1 })
  await plant('QualityRelease', shipping.quality.releaseIds['BLK-52'], { id: randomUUID(), workOrderSizeId: fixture.cell, quantity: 10, number: tag('T-REL') })
  return fixture
}
/** The shipments' first order: an open order of P1 (CONFIRMED, EUR, IT_B2B like the seeds'). */
let F: OrderFixture

const shipmentRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: companyA,
  siteId: siteA1,
  partyId: P1,
  salesOrderId: F.order,
  number: tag('T-SH'),
  shipTo: { name: 'Test workshop', line1: 'Via Test 1', postalCode: '00000', city: 'Testville', country: 'IT' },
  ...extra,
})
/** A DRAFT shipment of F (with `extra`), made by the office; its id. */
async function draft(extra: Record<string, unknown> = {}): Promise<string> {
  const row = shipmentRow(extra)
  expect(await insert(office(), 'Shipment', row)).toBe(1)
  return row.id as string
}
/** A line of `fixture`'s cell on `shipmentId`. */
const lineFor = (shipmentId: string, fixture: OrderFixture, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  siteId: siteA1,
  partyId: P1,
  shipmentId,
  workOrderId: prod().workOrderId,
  workOrderSizeId: fixture.cell,
  salesOrderLineId: fixture.line,
  size: fixture.size,
  quantity: 1,
  ...extra,
})
/** Is `orderId` on `shipmentId` (its first order, or with garments on it)? Read as the owner. */
const onShipment = async (orderId: string, shipmentId: string): Promise<boolean> =>
  (await admin(`SELECT $2::uuid IN (SELECT x.shipment_id FROM "factory_order_shipments"($3::uuid, $1::uuid) x) AS "on"`, [orderId, shipmentId, a.tenantId]))[0]!.on as boolean
/** The office records `shipmentId` as SHIPPED `back` ago (an interval), packed at the same time. */
const ship = (shipmentId: string, back: string) =>
  run(office(), `UPDATE "Shipment" SET status = 'SHIPPED', "packedAt" = now() - $2::interval, "shippedAt" = now() - $2::interval, version = version + 1 WHERE id = $1::uuid`, shipmentId, back)
/** A shipment of F that already left (`status`, three days ago) with one line of each fixture (set-up, planted); its id. */
async function gone(status: 'SHIPPED' | 'DELIVERED', fixtures: readonly OrderFixture[]): Promise<string> {
  const id = randomUUID()
  const at = await serverNow(-3 * 86_400_000)
  await plant('Shipment', await draft(), { id, number: tag('T-SH'), status, packedAt: at, shippedAt: at, deliveredAt: status === 'DELIVERED' ? at : null })
  for (const fixture of fixtures) {
    await plant('ShipmentLine', shipping.draftLineId, { id: randomUUID(), shipmentId: id, parcelId: null, workOrderId: prod().workOrderId, workOrderSizeId: fixture.cell, salesOrderLineId: fixture.line, size: fixture.size, quantity: 1 })
  }
  return id
}
/** A thread of the sales order `recordId` (made once, as the office's platform/threads does). */
async function threadOf(recordId: string): Promise<string> {
  const id = randomUUID()
  expect(await insert(office(), 'Thread', { id, companyId: companyA, partyId: P1, recordType: 'SalesOrder', recordId, replyToken: randomUUID().replace(/-/g, '') })).toBe(1)
  return id
}
/** An office internal note on `threadId`, with `extra`. */
const officeNote = async (threadId: string, extra: Record<string, unknown> = {}) =>
  insert(office(), 'Message', { id: randomUUID(), threadId, direction: 'INTERNAL_NOTE', audience: 'OFFICE', channel: 'APP', authorKind: 'USER', authorId: a.actorId, authorName: 'Test Office', bodyText: 'Made-up: see this shipment.', at: await serverNow(), ...extra })
/** A customer's own post on `threadId` (INBOUND, PARTNER, PORTAL, PARTY), as `scope` of `partyId`, with `extra`. */
const partnerPost = async (scope: FactoryScope, partyId: string, threadId: string, extra: Record<string, unknown> = {}) =>
  insert(scope, 'Message', { id: randomUUID(), threadId, partyId, direction: 'INBOUND', audience: 'PARTNER', channel: 'PORTAL', authorKind: 'PARTY', authorName: 'Bea Buyer', bodyText: 'Made-up: when does it leave?', at: await serverNow(), ...extra })

beforeAll(async () => {
  db = await migratedDatabase('orderpage')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedAuth({ db: factory, namespace: NS })
  portal = await seedPortalAuth({ db: factory, namespace: NS })
  shipping = await seedShipping({ db: factory, namespace: NS })
  two = await seedTwoBrands({ db: factory, namespace: NS })
  const [line] = await admin(`SELECT "salesOrderLineId"::text AS id FROM "WorkOrderSize" WHERE id = $1::uuid`, [prod().cellIds['BLK-52']])
  baseLine = line!.id as string
  F = await order('CONFIRMED')
}, 1_500_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 120_000)

// ---------------------------------------------------------------------------------------------------------------------------
describe('several orders of one customer in one shipment (N6, lines-derived)', () => {
  it('a line of another open order of the same customer joins a DRAFT shipment; the order is on it until its last line goes', async () => {
    const s = await draft()
    expect(await insert(office(), 'ShipmentLine', lineFor(s, F))).toBe(1)
    for (const status of ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED']) {
      const other = await order(status)
      expect(await onShipment(other.order, s), status).toBe(false)
      const line = lineFor(s, other)
      expect(await insert(office(), 'ShipmentLine', line), status).toBe(1)
      expect(await onShipment(other.order, s), status).toBe(true)
      expect(await run(office(), 'DELETE FROM "ShipmentLine" WHERE id = $1::uuid', line.id), status).toBe(1)
      expect(await onShipment(other.order, s), status).toBe(false)
    }
    // The first order stays the header's and is on its shipment even before it has a line.
    expect(await admin(`SELECT "salesOrderId"::text AS first FROM "Shipment" WHERE id = $1`, [s])).toEqual([{ first: F.order }])
    expect(await onShipment(F.order, await draft())).toBe(true)
  })

  it('refuses an order that is not open, or of another company, currency or tax mode, in words that name no customer', async () => {
    const s = await draft()
    for (const status of ['PENDING_APPROVAL', 'SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED']) {
      const words = await refusalOf(insert(office(), 'ShipmentLine', lineFor(s, await order(status))))
      expect(words, status).toMatch(CANNOT_TRAVEL)
      await expectNeutral(words)
    }
    for (const changes of [{ currency: 'USD' }, { taxMode: 'EU_B2B' }, { companyId: companyB }]) {
      const words = await refusalOf(insert(office(), 'ShipmentLine', lineFor(s, await order('CONFIRMED', changes))))
      expect(words, JSON.stringify(changes)).toMatch(CANNOT_TRAVEL)
      await expectNeutral(words)
    }
    expect(await admin(`SELECT count(*)::int AS n FROM "ShipmentLine" WHERE "shipmentId" = $1`, [s])).toEqual([{ n: 0 }])
  })

  it("never takes another customer's order: the cell, the shipment's customer and the references refuse it", async () => {
    const s = await draft()
    const [cell] = await admin(`SELECT id::text AS id, "workOrderId"::text AS wo, size FROM "WorkOrderSize" WHERE "salesOrderLineId" = $1::uuid ORDER BY size LIMIT 1`, [two.salesOrderLineId])
    // Released garments of Brand Beta's cell (set-up), so only the wall can refuse.
    await plant('QualityRelease', shipping.quality.releaseIds['BLK-52'], { id: randomUUID(), workOrderId: cell!.wo, workOrderSizeId: cell!.id, quantity: 5, number: tag('T-REL') })
    const row = (partyId: string) => ({ id: randomUUID(), siteId: siteA1, partyId, shipmentId: s, workOrderId: cell!.wo, workOrderSizeId: cell!.id, salesOrderLineId: two.salesOrderLineId, size: cell!.size, quantity: 1 })
    const asP1 = await refusalOf(insert(office(), 'ShipmentLine', row(P1)))
    expect(asP1).toMatch(/ships its work order cell .*: that cell's party, sales order line and size/)
    await expectNeutral(asP1)
    const asBeta = await refusalOf(insert(office(), 'ShipmentLine', row(two.second.partyId)))
    expect(asBeta).toMatch(new RegExp(`${CANNOT_TRAVEL.source}|ShipmentLine_tenantId_siteId_partyId_shipmentId_fkey`))
    await expectNeutral(asBeta)
    // Brand Beta's own session sees nothing of P1's shipment or its lines.
    expect(await sql(beta(), `SELECT id FROM "Shipment" WHERE id = $1::uuid`, s)).toEqual([])
    expect(await sql(beta(), `SELECT id FROM "ShipmentLine" WHERE "shipmentId" = $1::uuid`, s)).toEqual([])
  })

  it('changes lines only while the shipment is a DRAFT', async () => {
    const packed = randomUUID()
    await plant('Shipment', await draft(), { id: packed, number: tag('T-SH'), status: 'PACKED', packedAt: await serverNow() })
    await expect(insert(office(), 'ShipmentLine', lineFor(packed, await order('CONFIRMED')))).rejects.toThrow(/is PACKED; its lines change only while it is a DRAFT/)
  })

  it("keeps the floor's packing writes (R-8): the floor skips the order check, reads no sales order and none of the wave's columns", async () => {
    const s = await draft()
    const mine = lineFor(s, F)
    const theirs = lineFor(s, await order('CONFIRMED'))
    expect(await insert(floor(), 'ShipmentLine', mine)).toBe(1)
    expect(await insert(floor(), 'ShipmentLine', theirs)).toBe(1)
    expect(await run(floor(), 'UPDATE "ShipmentLine" SET quantity = 2 WHERE id = $1::uuid', theirs.id)).toBe(1)
    expect(await run(floor(), 'DELETE FROM "ShipmentLine" WHERE id = ANY ($1::uuid[])', [mine.id, theirs.id])).toBe(2)
    // Had the guard read a sales order as the floor, the writes above had failed: the floor may not read one.
    await expect(sql(floor(), 'SELECT 1 FROM "SalesOrder" LIMIT 1')).rejects.toThrow(DENIED)
    await expect(sql(floor(), 'SELECT 1 FROM "SalesOrderLine" LIMIT 1')).rejects.toThrow(DENIED)
    for (const column of ['origin', 'externalDdtNumber', 'externalDdtDate', 'manualTrackingUrl']) {
      await expect(sql(floor(), `SELECT "${column}" FROM "Shipment" LIMIT 1`), column).rejects.toThrow(DENIED)
    }
    // It still updates its site's shipment (the guard reads the row, not the columns).
    expect(await run(floor(), 'UPDATE "Shipment" SET version = version + 1 WHERE id = $1::uuid', s)).toBe(1)
    expect(await sql(floor(), 'SELECT status::text AS status, version FROM "Shipment" WHERE id = $1::uuid', s)).toEqual([{ status: 'DRAFT', version: 2 }])
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('an order is DELIVERED through its lines (N6)', () => {
  const delivered = (fixture: OrderFixture) =>
    run(office(), `UPDATE "SalesOrder" SET status = 'DELIVERED', "deliveredAt" = now() - interval '1 minute' WHERE id = $1::uuid`, fixture.order)

  it('once a shipment that carries its garments was delivered and none of its shipments still travels', async () => {
    // Its only shipment is F's, delivered, with its garments on it (it is no shipment's first order).
    const carried = await order('SHIPPED')
    await gone('DELIVERED', [carried])
    expect(await delivered(carried)).toBe(1)
    // No shipment carries it: refused, as before.
    const none = await order('SHIPPED')
    await expect(delivered(none)).rejects.toThrow(/is DELIVERED once a shipment of it was delivered and none still travels \(0 delivered, 0 on the way\)/)
    // One shipment with its garments delivered, another still travelling: refused.
    const both = await order('SHIPPED')
    await gone('DELIVERED', [both])
    await gone('SHIPPED', [both])
    await expect(delivered(both)).rejects.toThrow(/none still travels \(1 delivered, 1 on the way\)/)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('a message about a shipment of two orders (N6)', () => {
  it("is a part of each order's thread and of no other's; Brand Beta never names it", async () => {
    const other = await order('CONFIRMED')
    const stranger = await order('CONFIRMED')
    const s = await draft()
    expect(await insert(office(), 'ShipmentLine', lineFor(s, other))).toBe(1)
    const first = await threadOf(F.order)
    const second = await threadOf(other.order)
    const third = await threadOf(stranger.order)
    expect(await officeNote(first, { aboutKind: 'Shipment', aboutId: s })).toBe(1)
    expect(await officeNote(second, { aboutKind: 'Shipment', aboutId: s })).toBe(1)
    await expect(officeNote(third, { aboutKind: 'Shipment', aboutId: s })).rejects.toThrow(NOT_A_PART)
    // P1 itself, on the second order's thread: its session reads its own shipment, lines and order lines.
    expect(await partnerPost(p1(), P1, second, { aboutKind: 'Shipment', aboutId: s })).toBe(1)
    // Brand Beta, on its own order's thread: not a part of it, in the words of a record that is not there.
    const words = await refusalOf(partnerPost(beta(), two.second.partyId, two.second.threadId, { aboutKind: 'Shipment', aboutId: s }))
    expect(words).toMatch(NOT_A_PART)
    await expectNeutral(words)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('a shipment made elsewhere (N5)', () => {
  it('is recorded DRAFT → SHIPPED in one step, at most 60 days back, never packed or split; where it was made never changes', async () => {
    const e = await draft({ origin: 'ELSEWHERE', externalDdtNumber: tag('T-DDT'), externalDdtDate: await romeDay(3) })
    await expect(ship(e, '2 days')).rejects.toThrow(/made elsewhere is recorded with the garments that left \(it has no line\)/)
    expect(await insert(office(), 'ShipmentLine', lineFor(e, F))).toBe(1)
    await expect(run(office(), `UPDATE "Shipment" SET status = 'PACKED', "packedAt" = now() WHERE id = $1::uuid`, e)).rejects.toThrow(
      /was made elsewhere; it is recorded as it left \(DRAFT → SHIPPED\), never packed in Nexus/,
    )
    await expect(run(office(), `UPDATE "Shipment" SET status = 'SHIPPED', "packedAt" = now() - interval '3 days', "shippedAt" = now() - interval '2 days' WHERE id = $1::uuid`, e)).rejects.toThrow(AS_IT_LEFT)
    await expect(ship(e, '61 days')).rejects.toThrow(AS_IT_LEFT)
    await expect(ship(e, '-1 day')).rejects.toThrow(AS_IT_LEFT)
    expect(await ship(e, '2 days')).toBe(1)
    expect(await admin(`SELECT status::text AS status, origin::text AS origin, "packedAt" = "shippedAt" AS same FROM "Shipment" WHERE id = $1`, [e])).toEqual([{ status: 'SHIPPED', origin: 'ELSEWHERE', same: true }])
    // Set once: where it was made, and the paper DDT once it left.
    await expect(update(office(), 'Shipment', e, `origin = 'NEXUS'`)).rejects.toThrow(/where shipment .* was made \(ELSEWHERE\) never changes/)
    await expect(update(office(), 'Shipment', e, `"externalDdtNumber" = 'T-OTHER'`)).rejects.toThrow(/the paper DDT of shipment .* is fixed once it left/)
    await expect(update(office(), 'Shipment', e, `"externalDdtNumber" = NULL, "externalDdtDate" = NULL`)).rejects.toThrow(/is fixed once it left/)
    // The typed tracking number and its link still come after the goods left.
    expect(await update(office(), 'Shipment', e, `"manualTrackingNumber" = 'T-TRK-9', "manualTrackingUrl" = 'https://track.example.com/t/T-TRK-9', version = version + 1`)).toBe(1)
    // A shipment made in Nexus still never leaves from DRAFT.
    const nexus = await draft()
    expect(await insert(office(), 'ShipmentLine', lineFor(nexus, F))).toBe(1)
    await expect(ship(nexus, '1 day')).rejects.toThrow(/cannot move from DRAFT to SHIPPED/)
    // Recorded whole: never split from another shipment.
    await expect(insert(office(), 'Shipment', shipmentRow({ origin: 'ELSEWHERE', splitFromId: nexus, splitReason: 'PART_READY' }))).rejects.toThrow(/was made elsewhere; it is recorded whole, never split/)
  })

  it('ships a serial-tracked line only with a serial for each garment (Q31)', async () => {
    const q = shipping.quality
    const e = await draft({ origin: 'ELSEWHERE', ddtRequired: false, salesOrderId: q.serialSalesOrderId })
    // One of WO-0003's two released garments is free (SH-0002 holds the other).
    const line = { id: randomUUID(), siteId: siteA1, partyId: P1, shipmentId: e, workOrderId: q.serialWorkOrderId, workOrderSizeId: q.serialCellId, salesOrderLineId: q.serialSalesOrderLineId, size: '52', quantity: 1 }
    expect(await insert(office(), 'ShipmentLine', line)).toBe(1)
    await expect(ship(e, '1 day')).rejects.toThrow(/1 line\(s\) of a serial-tracked style without a serial for each garment \(Q31\)/)
    expect(await run(office(), 'DELETE FROM "ShipmentLine" WHERE id = $1::uuid', line.id)).toBe(1)
  })

  it('names its paper DDT as printed: both or neither, only when made elsewhere, dated on or before the day it left', async () => {
    const day = await romeDay(1)
    await expect(draft({ externalDdtNumber: 'T-1', externalDdtDate: day })).rejects.toThrow(DDT_SHAPE)
    await expect(draft({ origin: 'ELSEWHERE', externalDdtNumber: 'T-1' })).rejects.toThrow(DDT_SHAPE)
    await expect(draft({ origin: 'ELSEWHERE', externalDdtDate: day })).rejects.toThrow(DDT_SHAPE)
    for (const number of ['two\nlines', 'tab\there', ' 12/A', '12/A ', '   ', 'x'.repeat(41)]) {
      await expect(draft({ origin: 'ELSEWHERE', externalDdtNumber: number, externalDdtDate: day }), JSON.stringify(number)).rejects.toThrow(DDT_NUMBER)
    }
    expect(await draft({ origin: 'ELSEWHERE', externalDdtNumber: `T-${'x'.repeat(38)}`, externalDdtDate: day })).toBeTruthy()
    // Dated after the day the goods left: refused with the move.
    const late = await draft({ origin: 'ELSEWHERE', externalDdtNumber: tag('T-DDT'), externalDdtDate: await romeDay(0) })
    expect(await insert(office(), 'ShipmentLine', lineFor(late, F))).toBe(1)
    await expect(ship(late, '3 days')).rejects.toThrow(/the paper DDT of shipment .* is dated on or before the day the goods left/)
  })

  it('leaves with its paper DDT unless an immediate invoice travelled instead (R-23); Nexus issues no DDT of it', async () => {
    const without = await draft({ origin: 'ELSEWHERE' })
    expect(await insert(office(), 'ShipmentLine', lineFor(without, F))).toBe(1)
    // Checked at commit, like a Nexus shipment's DDT.
    await expect(ship(without, '1 day')).rejects.toThrow(/was made elsewhere and left without the number and date of its paper DDT \(DPR 472\/1996\)/)
    expect(await update(office(), 'Shipment', without, `"ddtRequired" = false, version = version + 1`)).toBe(1)
    expect(await ship(without, '1 day')).toBe(1)
    // A Nexus DDT of it (a copy of the seed's DDT 144/2026 with a number of its own): refused, no second fiscal number.
    const words = await refusalOf(copyRow('Ddt', shipping.ddtId, { id: randomUUID(), shipmentId: without, number: tag('T-DDT') }))
    expect(words).toMatch(/was made elsewhere and left with its own papers; Nexus issues no DDT of it/)
    expect(await admin(`SELECT count(*)::int AS n FROM "Ddt" WHERE "shipmentId" = $1`, [without])).toEqual([{ n: 0 }])
  })

  it('records one paper DDT once per customer; two customers may share its number and date (R-10)', async () => {
    const number = tag('T-DDT')
    const day = await romeDay(2)
    await draft({ origin: 'ELSEWHERE', externalDdtNumber: number, externalDdtDate: day })
    // The same customer twice: the key refuses it (its conflict is always the customer's own shipment).
    expect(await refusalOf(draft({ origin: 'ELSEWHERE', externalDdtNumber: number, externalDdtDate: day }))).toMatch(/Shipment_external_ddt_key/)
    // Another date: another paper DDT.
    expect(await draft({ origin: 'ELSEWHERE', externalDdtNumber: number, externalDdtDate: await romeDay(3) })).toBeTruthy()
    // Brand Beta's shipment made elsewhere with the same number and date: its own paper DDT, recorded.
    expect(await draft({ origin: 'ELSEWHERE', partyId: two.second.partyId, salesOrderId: two.second.salesOrderId, externalDdtNumber: number, externalDdtDate: day })).toBeTruthy()
    // Each customer reads its own only (with where it was made).
    expect(await sql(p1(), `SELECT origin::text AS origin, to_char("externalDdtDate", 'YYYY-MM-DD') AS day FROM "Shipment" WHERE "externalDdtNumber" = $1 ORDER BY 2`, number)).toEqual([
      { origin: 'ELSEWHERE', day: await romeDay(3) },
      { origin: 'ELSEWHERE', day },
    ])
    expect(await sql(beta(), `SELECT "partyId"::text AS party FROM "Shipment" WHERE "externalDdtNumber" = $1`, number)).toEqual([{ party: two.second.partyId }])
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('the typed tracking link (N5)', () => {
  it('is https, up to 500 characters on one line, with no user name or password, only with its typed number', async () => {
    const s = await draft()
    const link = (url: string | null, number: string | null = 'T-TRACK-1') =>
      update(office(), 'Shipment', s, `"manualTrackingNumber" = $2, "manualTrackingUrl" = $3, version = version + 1`, number, url)
    await expect(link('https://track.example.com/t?n=1', null)).rejects.toThrow(LINK)
    const bad = [
      'http://track.example.com/t?n=1',
      'https://user:secret@track.example.com/t',
      'https://user@track.example.com/t',
      'https://track.example.com/t?n=1 2',
      'https://track.example.com/t\n',
      `https://track.example.com/${'x'.repeat(480)}`,
      'https://',
      'ftp://track.example.com/t',
      'javascript:alert(1)',
    ]
    for (const url of bad) await expect(link(url), url).rejects.toThrow(LINK)
    expect(await link('https://track.example.com/t?n=T-TRACK-1#top')).toBe(1)
    expect(await link('https://track.example.com:8443/t/T-TRACK-1')).toBe(1)
    // Clearing the number alone is refused: the link goes with it.
    await expect(update(office(), 'Shipment', s, `"manualTrackingNumber" = NULL`)).rejects.toThrow(LINK)
    // P1 reads its own link; Brand Beta nothing.
    expect(await sql(p1(), `SELECT origin::text AS origin, "manualTrackingUrl" AS url FROM "Shipment" WHERE id = $1::uuid`, s)).toEqual([{ origin: 'NEXUS', url: 'https://track.example.com:8443/t/T-TRACK-1' }])
    expect(await sql(beta(), `SELECT id FROM "Shipment" WHERE id = $1::uuid`, s)).toEqual([])
    expect(await link(null, null)).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe("who reads the wave's columns (ownership/shipping.json)", () => {
  it('a portal or link session reads them on its own party; the floor none of them', () => {
    const shipment = classifiedModels(loadSchema(), loadOwnership()).find(({ model }) => model.name === 'Shipment')!
    const columns = ['origin', 'externalDdtNumber', 'externalDdtDate', 'manualTrackingUrl']
    expect(shipment.model.columns).toEqual(expect.arrayContaining(columns))
    for (const column of columns) {
      expect(shipment.ownership.access[FLOOR_ROLE]?.hiddenColumns ?? [], column).toContain(column)
      expect(shipment.ownership.access[PARTNER_ROLE]?.hiddenColumns ?? [], column).not.toContain(column)
    }
    expect(shipment.ownership.access[PARTNER_ROLE]?.scopedBy).toEqual(['party'])
  })
})
