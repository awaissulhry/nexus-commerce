import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedBuyingDepth, type BuyingDepthSeed } from '../seed/buying-depth'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedInventory, type InventorySeed } from '../seed/inventory'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels, partnerWalledColumns } from './ownership'
import { FLOOR_ROLE, PARTNER_ROLE, RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * Buying and subcontracting in depth (W2b-5 schema wave 40/44, B-W2b-285, …_buying_depth_w2b_guards) on a database built
 * from the migrations and seeded (the new seed twice, with the isolation tests' partnerScope), through the real login and
 * the scoped client:
 *   - a purchase order waits for its yes (PENDING_APPROVAL) with its approval task, frozen, then is sent with it or goes
 *     back to DRAFT; the send's checks run when it asks the yes too: deliveries that add up;
 *   - a SAMPLE order's style and round, the rate and the value in the company's currency, the third party it ships to;
 *   - a line's rolls, a protector's certificate, a material variant (and a lot's);
 *   - a delivery schedule: written while DRAFT, each delivery confirmed once (a partner session too), a confirmed date moved
 *     only with its PoDateChange (a line's too), the history append-only;
 *   - delivery tolerances and variants kept (never deleted); requests to buy; a kit line's material balance; the workshop's
 *     cost entries and their reversal;
 *   - the walls: what the floor and a partner session read.
 * The refusals are check_violation (23514), restrict_violation (23001) or a key's violation; their messages are read through
 * raw SQL.
 */

const NS = 'w2b-285-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let inv: InventorySeed
let x: BuyingDepthSeed

const key = (name: string): string => seedUuid(NS, name)
const lateKey = (name: string): string => `ffffffff${key(name).slice(8)}`
const A = {
  company: key('company:A'),
  companyB: key('company:B'),
  site: key('site:A1'),
  siteB: key('site:B1'),
  P1: key('party:P1'),
  P2: key('party:P2'),
  protector: key('product:item:protector'),
  lining: key('product:item:lining'),
  leather: key('product:item:leather'),
  liningGRY: key('product:item-colour:lining:GRY'),
  style: key('product:style:JKT-01'),
  certificate: key('compliance:certificate:PRO-300'),
  jacketCertificate: key('compliance:certificate:JKT-01'),
}
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (siteId = A.site): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId })
const partner = (partyId = A.P1): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: randomUUID(), partyId })
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
/** Several statements in one transaction (the deferred checks run at its end). */
const together = (scope: FactoryScope, ...statements: [string, ...unknown[]][]) =>
  as(scope, (client) => client.$transaction(async (tx) => { for (const [text, ...values] of statements) await tx.$executeRawUnsafe(text, ...values) }))
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`

/** A new DRAFT copy of the sample order SEED-PO-0101 (plant B1) with a copy of its protector line (10 pieces, 7.00, need 2026-12-07). */
async function newOrder(changes: Record<string, unknown> = {}): Promise<{ orderId: string; lineId: string }> {
  const orderId = randomUUID()
  const lineId = randomUUID()
  await copyRow(office(), 'PurchaseOrder', x.sampleOrder.orderId, { id: orderId, number: tag('PO'), netAmount: 7000, ...changes })
  await copyRow(office(), 'PurchaseOrderLine', x.sampleOrder.protectorLineId, { id: lineId, purchaseOrderId: orderId })
  return { orderId, lineId }
}
/** A new DRAFT copy of SEED-PO-0103 (plant A1, a SAMPLE order for SEED-JKT-01's fit round) with a copy of its line. */
async function newPlantOrder(): Promise<{ orderId: string; lineId: string }> {
  const orderId = randomUUID()
  const lineId = randomUUID()
  await copyRow(office(), 'PurchaseOrder', x.plantOrder.orderId, { id: orderId, number: tag('PO') })
  await copyRow(office(), 'PurchaseOrderLine', x.plantOrder.lineId, { id: lineId, purchaseOrderId: orderId })
  return { orderId, lineId }
}
const send = (orderId: string) => update(office(), 'PurchaseOrder', orderId, `status = 'SENT', "sentAt" = now()`)
const status = async (table: string, id: string) => String((await one(`SELECT status::text AS s FROM "${table}" WHERE id = $1`, [id])).s)
/** A new, sent and confirmed copy: the line confirmed on 2026-12-07, its two deliveries on 2026-12-07 and 2026-12-14. */
async function confirmedOrder(): Promise<{ orderId: string; lineId: string; deliveries: [string, string] }> {
  const { orderId, lineId } = await newOrder()
  const deliveries: [string, string] = [randomUUID(), randomUUID()]
  await copyRow(office(), 'PurchaseOrderLineDelivery', x.sampleOrder.deliveryIds[0], { id: deliveries[0], purchaseOrderLineId: lineId })
  await copyRow(office(), 'PurchaseOrderLineDelivery', x.sampleOrder.deliveryIds[1], { id: deliveries[1], purchaseOrderLineId: lineId })
  await send(orderId)
  await update(office(), 'PurchaseOrderLine', lineId, `"confirmedQuantity" = 10, "confirmedDate" = '2026-12-07'`)
  await update(office(), 'PurchaseOrderLineDelivery', deliveries[0], `"confirmedDate" = '2026-12-07'`)
  await update(office(), 'PurchaseOrderLineDelivery', deliveries[1], `"confirmedDate" = '2026-12-14'`)
  await update(office(), 'PurchaseOrder', orderId, `status = 'CONFIRMED', "confirmedAt" = now(), "confirmedVia" = 'OFFICE'`)
  return { orderId, lineId, deliveries }
}
const DATE_CHANGE = `INSERT INTO "PoDateChange" (id, "purchaseOrderLineId", "partyId", "siteId", "deliveryId", seq, "fromDate", "toDate", source, "changedAt", reason)
  VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::date, $8::date, $9::"PoDateChangeSource", now(), $10)`
const dateChange = (lineId: string, deliveryId: string | null, seq: number, from: string, to: string, reason = 'The supplier is late (made-up).'): [string, ...unknown[]] =>
  [DATE_CHANGE, randomUUID(), lineId, A.P1, A.siteB, deliveryId, seq, from, to, 'SUPPLIER', reason]

beforeAll(async () => {
  db = await migratedDatabase('buyingdepthw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  inv = await seedInventory({ db: factory, namespace: NS })
  x = await seedBuyingDepth({ db: factory, namespace: NS }, { partnerScope: true })
  // Run twice: the new seed is idempotent.
  await seedBuyingDepth({ db: factory, namespace: NS }, { partnerScope: true })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the seed', () => {
  it('writes each part once', async () => {
    const counts = await one(`SELECT (SELECT count(*) FROM "ItemVariant")::int AS variants, (SELECT count(*) FROM "DeliveryTolerance")::int AS tolerances,
      (SELECT count(*) FROM "PurchaseOrderLineDelivery")::int AS deliveries, (SELECT count(*) FROM "PoDateChange")::int AS changes,
      (SELECT count(*) FROM "PurchaseRequest")::int AS requests, (SELECT count(*) FROM "SubcontractCostEntry")::int AS costs,
      (SELECT count(*) FROM "SubcontractConsumption")::int AS balance`)
    expect(counts).toEqual({ variants: 3, tolerances: 3, deliveries: 6, changes: 1, requests: 4, costs: 4, balance: 2 })
    expect(await one(`SELECT status::text AS status, "rateAtOrder"::text AS rate, "companyNetAmount" AS value FROM "PurchaseOrder" WHERE id = $1`, [x.usdOrder.orderId])).toEqual({ status: 'CONFIRMED', rate: '1.08500000', value: 6636 })
    expect((await one(`SELECT "confirmedDate"::text AS d FROM "PurchaseOrderLineDelivery" WHERE id = $1`, [x.usdOrder.deliveryIds[1]])).d).toBe('2027-02-01')
  })
})

describe('a purchase order waiting for its yes', () => {
  it('asks with its approval task, stays frozen while it waits, then is sent with the yes', async () => {
    const { orderId, lineId } = await newOrder()
    await expect(update(office(), 'PurchaseOrder', orderId, `status = 'PENDING_APPROVAL'`)).rejects.toThrow(/waits for a yes \(PENDING_APPROVAL\) and names its approval task/)
    await expect(update(office(), 'PurchaseOrder', orderId, `status = 'PENDING_APPROVAL', "approvalTaskId" = $2::uuid, "sentAt" = now()`, randomUUID())).rejects.toThrow(/gets its send time when it is sent/)
    const task = randomUUID()
    expect(await update(office(), 'PurchaseOrder', orderId, `status = 'PENDING_APPROVAL', "approvalTaskId" = $2::uuid`, task)).toBe(1)
    await expect(update(office(), 'PurchaseOrder', orderId, `note = 'Changed while waiting'`)).rejects.toThrow(/its terms change only while it is DRAFT/)
    await expect(update(office(), 'PurchaseOrder', orderId, `"approvalTaskId" = $2::uuid`, randomUUID())).rejects.toThrow(/its terms change only while it is DRAFT/)
    await expect(update(office(), 'PurchaseOrderLine', lineId, `quantity = 11`)).rejects.toThrow(/its lines change only while it is DRAFT/)
    await expect(update(office(), 'PurchaseOrder', orderId, `status = 'CONFIRMED', "confirmedAt" = now(), "confirmedVia" = 'OFFICE'`)).rejects.toThrow(/cannot move from PENDING_APPROVAL to CONFIRMED/)
    // Refused: back to DRAFT, its revision as it was (never sent); asked again with a new task; then sent with the yes.
    expect(await update(office(), 'PurchaseOrder', orderId, `status = 'DRAFT'`)).toBe(1)
    expect(await one(`SELECT revision, "approvalTaskId"::text AS task FROM "PurchaseOrder" WHERE id = $1`, [orderId])).toEqual({ revision: 1, task })
    expect(await update(office(), 'PurchaseOrder', orderId, `status = 'PENDING_APPROVAL', "approvalTaskId" = $2::uuid`, randomUUID())).toBe(1)
    await expect(update(office(), 'PurchaseOrder', orderId, `status = 'SENT'`)).rejects.toThrow(/with the wrong send time/)
    expect(await update(office(), 'PurchaseOrder', orderId, `status = 'SENT', "sentAt" = now()`)).toBe(1)
    expect(await status('PurchaseOrder', orderId)).toBe('SENT')
  })

  it('runs the send checks when it asks: the lines add up, deliveries add up; a foreign currency\'s rate with its value, frozen once sent', async () => {
    const ask = (orderId: string) => update(office(), 'PurchaseOrder', orderId, `status = 'PENDING_APPROVAL', "approvalTaskId" = $2::uuid`, randomUUID())
    const wrongSum = await newOrder({ netAmount: 6999 })
    await expect(ask(wrongSum.orderId)).rejects.toThrow(/is not the sum of its lines/)
    const scheduled = await newOrder()
    const delivery = randomUUID()
    await copyRow(office(), 'PurchaseOrderLineDelivery', x.sampleOrder.deliveryIds[0], { id: delivery, purchaseOrderLineId: scheduled.lineId })
    await expect(ask(scheduled.orderId)).rejects.toThrow(/deliveries of line 10 of purchase order .* do not add up to the line/)
    await copyRow(office(), 'PurchaseOrderLineDelivery', x.sampleOrder.deliveryIds[1], { id: randomUUID(), purchaseOrderLineId: scheduled.lineId, needDate: '2026-12-01' })
    await expect(send(scheduled.orderId)).rejects.toThrow(/the first delivery on its need date/)
    await update(office(), 'PurchaseOrderLine', scheduled.lineId, `"needDate" = '2026-12-01'`)
    expect(await ask(scheduled.orderId)).toBe(1)
    // The rate of a foreign currency: with its value or neither, frozen with the terms once sent. Not required at the send
    // (W1 sends an order in the supplier's currency; B-W2b-296 asks for the rate first).
    const usd = await newOrder({ currency: 'USD' })
    await expect(update(office(), 'PurchaseOrder', usd.orderId, `"rateAtOrder" = 1.085`)).rejects.toThrow(/its rate at order \(above 0\) and its value in the company's currency \(0 or more\) together/)
    await expect(update(office(), 'PurchaseOrder', usd.orderId, `"rateAtOrder" = 0, "companyNetAmount" = 6452`)).rejects.toThrow(/together, or neither/)
    expect(await update(office(), 'PurchaseOrder', usd.orderId, `"rateAtOrder" = 1.085, "companyNetAmount" = 6452`)).toBe(1)
    expect(await send(usd.orderId)).toBe(1)
    await expect(update(office(), 'PurchaseOrder', usd.orderId, `"rateAtOrder" = 1.09, "companyNetAmount" = 6422`)).rejects.toThrow(/its terms change only while it is DRAFT/)
    const usdWithout = await newOrder({ currency: 'USD' })
    expect(await send(usdWithout.orderId)).toBe(1)
    const eur = await newOrder()
    await expect(update(office(), 'PurchaseOrder', eur.orderId, `"rateAtOrder" = 1, "companyNetAmount" = 7000`)).rejects.toThrow(/in its company's own currency \(EUR\); it takes no rate at order/)
  })
})

describe('what a purchase order is for and where it goes', () => {
  it('a SAMPLE order names its style and a round of that style, of its own company; a STANDARD order neither', async () => {
    const other = await newOrder()
    await expect(update(office(), 'PurchaseOrder', other.orderId, `"sampleRoundId" = $2::uuid`, `00000000${key('samples:round:JKT-01:FIT:1').slice(8)}`)).rejects.toThrow(/buys for a sample round of another company/)
    const { orderId } = await newPlantOrder()
    await expect(update(office(), 'PurchaseOrder', orderId, `kind = 'STANDARD'`)).rejects.toThrow(/only a SAMPLE order names a development style or sample round/)
    await expect(update(office(), 'PurchaseOrder', orderId, `"developmentStyleId" = NULL`)).rejects.toThrow(/names a sample round with its style/)
    await expect(update(office(), 'PurchaseOrder', orderId, `"developmentStyleId" = $2::uuid`, key('product:style:JKT-02'))).rejects.toThrow(/foreign key/)
    expect(await update(office(), 'PurchaseOrder', orderId, `kind = 'STANDARD', "developmentStyleId" = NULL, "sampleRoundId" = NULL`)).toBe(1)
  })

  it('ships to a third party (not the supplier) at an address of its own that may be used, a workshop at its own place', async () => {
    const { orderId } = await newPlantOrder()
    const p2Office = key('party-address:P2:office')
    await expect(update(office(), 'PurchaseOrder', orderId, `"shipToPartyId" = $2::uuid`, A.P1)).rejects.toThrow(/ships to a third party other than its supplier/)
    await expect(update(office(), 'PurchaseOrder', orderId, `"shipToAddressId" = $2::uuid`, p2Office)).rejects.toThrow(/names an address or a workshop location only with that party/)
    await expect(update(office(), 'PurchaseOrder', orderId, `"shipToPartyId" = $2::uuid, "shipToAddressId" = $3::uuid`, A.P2, key('party-address:P1:workshop'))).rejects.toThrow(/foreign key/)
    // A workshop place of the order's site: P2's SUBCONTRACTOR location, not the store.
    await expect(update(office(), 'PurchaseOrder', orderId, `"shipToPartyId" = $2::uuid, "shipToLocationId" = $3::uuid`, A.P2, inv.locations.store)).rejects.toThrow(/an active SUBCONTRACTOR place of the party it ships to/)
    await expect(update(office(), 'PurchaseOrder', orderId, `"shipToPartyId" = $2::uuid, "shipToLocationId" = $3::uuid`, A.P2, lateKey('portal-supply:P1:location'))).rejects.toThrow(/an active SUBCONTRACTOR place of the party it ships to/)
    expect(await update(office(), 'PurchaseOrder', orderId, `"shipToPartyId" = $2::uuid, "shipToAddressId" = $3::uuid, "shipToLocationId" = $4::uuid`, A.P2, p2Office, key('subcontract:location:A1-TERZ-P2'))).toBe(1)
    // An address that waits for the office's check is not used.
    const waiting = randomUUID()
    await copyRow(office(), 'PartyAddress', p2Office, { id: waiting, kinds: ['SHIP_TO'], isDefaultBillTo: false, approvalStatus: 'WAITING', requestedAt: new Date().toISOString(), requestedByUserId: key('portal:user:P2:orders') })
    await expect(update(office(), 'PurchaseOrder', orderId, `"shipToAddressId" = $2::uuid`, waiting)).rejects.toThrow(/which is ACTIVE \(WAITING\); an order uses an active address/)
  })
})

describe('a line by kind', () => {
  it('fabric by whole rolls with their length and width', async () => {
    const { lineId } = await newOrder()
    await expect(update(office(), 'PurchaseOrderLine', lineId, `"rollLengthM" = 50`)).rejects.toThrow(/a length or width only with the rolls/)
    await expect(update(office(), 'PurchaseOrderLine', lineId, `rolls = 0`)).rejects.toThrow(/buys whole rolls \(above 0\)/)
    expect(await update(office(), 'PurchaseOrderLine', lineId, `rolls = 2, "rollLengthM" = 50, "rollWidthCm" = 150`)).toBe(1)
  })

  it('a protector names a VALID certificate that covers it; only a PPE component names one', async () => {
    const { lineId } = await newOrder()
    await expect(update(office(), 'PurchaseOrderLine', lineId, `"certificateId" = $2::uuid`, A.jacketCertificate)).rejects.toThrow(/must be VALID and cover the line's item/)
    await expect(copyRow(office(), 'PurchaseOrderLine', x.sampleOrder.liningLineId, { id: randomUUID(), purchaseOrderId: (await newOrder()).orderId, seq: 30, certificateId: A.certificate })).rejects.toThrow(/only a PPE component's line \(a protector\) does/)
    await update(office(), 'PurchaseOrderLine', lineId, `"certificateId" = NULL`)
    await admin(`UPDATE "Certificate" SET status = 'SUSPENDED', "statusReason" = 'Made-up audit' WHERE id = $1`, [A.certificate])
    await expect(update(office(), 'PurchaseOrderLine', lineId, `"certificateId" = $2::uuid`, A.certificate)).rejects.toThrow(/\(SUSPENDED\), which must be VALID/)
    await admin(`UPDATE "Certificate" SET status = 'VALID', "statusReason" = NULL WHERE id = $1`, [A.certificate])
    expect(await update(office(), 'PurchaseOrderLine', lineId, `"certificateId" = $2::uuid`, A.certificate)).toBe(1)
  })

  it('a variant of the line\'s own item, ACTIVE, of the line\'s colour', async () => {
    const { lineId } = await newOrder()
    await expect(update(office(), 'PurchaseOrderLine', lineId, `"variantCode" = $2`, x.variantCodes.archived)).rejects.toThrow(/an ACTIVE variant of its item/)
    await expect(update(office(), 'PurchaseOrderLine', lineId, `"variantCode" = 'NO-SUCH-VARIANT'`)).rejects.toThrow(/foreign key/)
    // A lining variant in grey: a line in another colour may not buy it.
    const grey = tag('LIN-GRY-150')
    await run(office(), `INSERT INTO "ItemVariant" (id, "itemId", "itemColourId", size, code) VALUES ($1::uuid, $2::uuid, $3::uuid, '150 cm', $4)`, randomUUID(), A.lining, A.liningGRY, grey)
    const lining = randomUUID()
    const order = await newOrder()
    await copyRow(office(), 'PurchaseOrderLine', x.sampleOrder.liningLineId, { id: lining, purchaseOrderId: order.orderId, seq: 30, itemColourId: null })
    await expect(update(office(), 'PurchaseOrderLine', lining, `"variantCode" = $2`, grey)).rejects.toThrow(/of the line's colour when the variant has one/)
    expect(await update(office(), 'PurchaseOrderLine', lining, `"itemColourId" = $2::uuid, "variantCode" = $3`, A.liningGRY, grey)).toBe(1)
  })
})

describe('the delivery schedule and the confirmed dates', () => {
  it('is planned while DRAFT, then confirmed once per delivery; a partner session confirms while SENT', async () => {
    const { orderId, lineId } = await newOrder()
    const first = randomUUID()
    const second = randomUUID()
    await copyRow(office(), 'PurchaseOrderLineDelivery', x.sampleOrder.deliveryIds[0], { id: first, purchaseOrderLineId: lineId })
    await expect(copyRow(office(), 'PurchaseOrderLineDelivery', x.sampleOrder.deliveryIds[1], { id: randomUUID(), purchaseOrderLineId: lineId, seq: 3, confirmedDate: '2026-12-20' })).rejects.toThrow(/the supplier has not confirmed it yet/)
    await expect(copyRow(office(), 'PurchaseOrderLineDelivery', x.sampleOrder.deliveryIds[1], { id: randomUUID(), purchaseOrderLineId: lineId, seq: 3, quantity: 0 })).rejects.toThrow(/quantities above 0/)
    await copyRow(office(), 'PurchaseOrderLineDelivery', x.sampleOrder.deliveryIds[1], { id: second, purchaseOrderLineId: lineId })
    await expect(update(office(), 'PurchaseOrderLineDelivery', first, `"confirmedDate" = '2026-12-07'`)).rejects.toThrow(/is set while its order is SENT, CHANGES_PROPOSED or CONFIRMED \(it is DRAFT\)/)
    await send(orderId)
    await expect(update(office(), 'PurchaseOrderLineDelivery', first, `quantity = 5`)).rejects.toThrow(/its deliveries change only while it is DRAFT/)
    await expect(copyRow(office(), 'PurchaseOrderLineDelivery', first, { id: randomUUID(), seq: 9 })).rejects.toThrow(/deliveries are planned only while it is DRAFT/)
    await expect(run(office(), `DELETE FROM "PurchaseOrderLineDelivery" WHERE id = $1::uuid`, first)).rejects.toThrow(/removed only while it is DRAFT/)
    // The supplier's link (the partner scope of its party) confirms each delivery once.
    expect(await update(partner(), 'PurchaseOrderLineDelivery', first, `"confirmedDate" = '2026-12-07'`)).toBe(1)
    await expect(update(partner(), 'PurchaseOrderLineDelivery', first, `"confirmedDate" = '2026-12-09'`)).rejects.toThrow(/only with its date change|only confirms the date of a delivery of its SENT purchase order, once/)
    await expect(update(partner(), 'PurchaseOrderLineDelivery', second, `note = 'Our note'`)).rejects.toThrow(/its deliveries change only while it is DRAFT|only confirms the date/)
    expect(await update(partner(A.P2), 'PurchaseOrderLineDelivery', second, `"confirmedDate" = '2026-12-14'`)).toBe(0)
  })

  it('moves a confirmed date only with its date change, both ways, and keeps the history', async () => {
    const { lineId, deliveries } = await confirmedOrder()
    await expect(update(office(), 'PurchaseOrderLineDelivery', deliveries[1], `"confirmedDate" = '2026-12-21'`)).rejects.toThrow(/moves from 2026-12-14 to 2026-12-21 only with its date change/)
    await expect(update(office(), 'PurchaseOrderLine', lineId, `"confirmedDate" = '2026-12-09'`)).rejects.toThrow(/moves from 2026-12-07 to 2026-12-09 only with its date change/)
    // The delivery: the change, then the date, in one command.
    await together(office(), dateChange(lineId, deliveries[1], 1, '2026-12-14', '2026-12-21'), [`UPDATE "PurchaseOrderLineDelivery" SET "confirmedDate" = '2026-12-21' WHERE id = $1::uuid`, deliveries[1]])
    // A change recorded but not made (the other way) is refused at commit.
    await expect(together(office(), dateChange(lineId, deliveries[0], 2, '2026-12-07', '2026-12-08'))).rejects.toThrow(/move the date in the same command/)
    // The line: its own change (no delivery).
    await together(office(), dateChange(lineId, null, 2, '2026-12-07', '2026-12-09', 'We asked to bring it forward (made-up).'), [`UPDATE "PurchaseOrderLine" SET "confirmedDate" = '2026-12-09' WHERE id = $1::uuid`, lineId])
    expect((await one(`SELECT "confirmedDate"::text AS d, "needDate"::text AS asked FROM "PurchaseOrderLine" WHERE id = $1`, [lineId]))).toEqual({ d: '2026-12-09', asked: '2026-12-07' })
    // The history: a place above the last, two different days, a reason; a first confirmation is no change.
    await expect(together(office(), dateChange(lineId, deliveries[1], 2, '2026-12-21', '2026-12-28'))).rejects.toThrow(/takes a place above the line's last one \(2\)/)
    await expect(together(office(), dateChange(lineId, deliveries[1], 3, '2026-12-21', '2026-12-21'))).rejects.toThrow(/moves the date \(from 2026-12-21 to the same day\)/)
    await expect(together(office(), dateChange(lineId, deliveries[1], 3, '2026-12-21', '2026-12-28', ' '))).rejects.toThrow(/says why \(1 to 2000 characters\)/)
    const draft = await newOrder()
    await expect(together(office(), dateChange(draft.lineId, null, 1, '2026-12-07', '2026-12-08'))).rejects.toThrow(/is DRAFT; a confirmed date moves only while it is SENT/)
    const change = (await one(`SELECT id::text AS id FROM "PoDateChange" WHERE "purchaseOrderLineId" = $1 ORDER BY seq LIMIT 1`, [lineId])).id as string
    await expect(update(office(), 'PoDateChange', change, `reason = 'Rewritten'`)).rejects.toThrow(/permission denied/)
    await expect(admin(`UPDATE "PoDateChange" SET reason = 'Rewritten' WHERE id = $1`, [change])).rejects.toThrow(/append-only: UPDATE on "PoDateChange" is refused/)
    await expect(admin(`DELETE FROM "PoDateChange" WHERE id = $1`, [change])).rejects.toThrow(/append-only: DELETE on "PoDateChange" is refused/)
  })

  it('a new revision clears the confirmed dates; the send refuses one left over', async () => {
    const { orderId, deliveries } = await confirmedOrder()
    await update(office(), 'PurchaseOrder', orderId, `status = 'DRAFT', revision = revision + 1, "sentAt" = NULL, "sentById" = NULL, "confirmedAt" = NULL, "confirmedVia" = NULL`)
    await run(office(), `UPDATE "PurchaseOrderLine" SET "confirmedQuantity" = NULL, "confirmedDate" = NULL WHERE "purchaseOrderId" = $1::uuid`, orderId)
    await expect(send(orderId)).rejects.toThrow(/2 delivery\(ies\) of purchase order .* still hold the confirmed date of an earlier revision/)
    await run(office(), `UPDATE "PurchaseOrderLineDelivery" SET "confirmedDate" = NULL WHERE id = ANY($1::uuid[])`, deliveries)
    expect(await send(orderId)).toBe(1)
  })
})

describe('delivery tolerances and material variants', () => {
  it('keeps a tolerance from 0 to 100 percent, for a material or a kind, never deleted', async () => {
    const id = x.toleranceIds.tenant
    await expect(update(office(), 'DeliveryTolerance', id, `"overPct" = 101`)).rejects.toThrow(/from 0 to 100 percent/)
    await expect(update(office(), 'DeliveryTolerance', id, `"itemKind" = 'LEATHER', "itemId" = $2::uuid`, A.leather)).rejects.toThrow(/not both/)
    await expect(update(office(), 'DeliveryTolerance', id, `"itemKind" = 'FINISHED'`)).rejects.toThrow(/not finished garments/)
    expect(await update(office(), 'DeliveryTolerance', id, `status = 'ARCHIVED'`)).toBe(1)
    await expect(run(office(), `DELETE FROM "DeliveryTolerance" WHERE id = $1::uuid`, id)).rejects.toThrow(/permission denied/)
    await expect(admin(`DELETE FROM "DeliveryTolerance" WHERE id = $1`, [id])).rejects.toThrow(/is never deleted \(archive it\)/)
  })

  it('keeps a variant what it is: a colour or a size, a code without spaces; only archived', async () => {
    const insert = (changes: string, values: unknown[]) => run(office(), `INSERT INTO "ItemVariant" (id, "itemId", "itemColourId", size, code) VALUES ($1::uuid, ${changes})`, randomUUID(), ...values)
    await expect(insert(`$2::uuid, NULL, NULL, $3`, [A.protector, tag('PRO')])).rejects.toThrow(/names a colour, a size/)
    await expect(insert(`$2::uuid, NULL, 'L', $3`, [A.protector, 'PRO 300 L'])).rejects.toThrow(/a code of 1 to 60 characters without spaces/)
    await expect(insert(`$2::uuid, NULL, 'L', $3`, [A.protector, x.variantCodes.small])).rejects.toThrow(/unique/)
    const variant = (await one(`SELECT id::text AS id FROM "ItemVariant" WHERE code = $1`, [x.variantCodes.medium])).id as string
    await expect(update(office(), 'ItemVariant', variant, `size = 'L'`)).rejects.toThrow(/stays what it is/)
    // In use by a line: its code never changes (the key).
    await expect(admin(`UPDATE "ItemVariant" SET code = 'SEED-PRO-300-MM' WHERE id = $1`, [variant])).rejects.toThrow(/stays what it is|foreign key/)
    expect(await update(office(), 'ItemVariant', variant, `"supplierCode" = 'NEW-300-M'`)).toBe(1)
    await expect(admin(`DELETE FROM "ItemVariant" WHERE id = $1`, [variant])).rejects.toThrow(/is never deleted \(archive it\)/)
  })

  it('a lot of a variant: ACTIVE, of its colour, set once; a lot from a variant\'s line is of that variant', async () => {
    const lot = inv.liningLotId
    const grey = tag('LIN-GRY')
    const red = tag('LIN-NONE')
    await run(office(), `INSERT INTO "ItemVariant" (id, "itemId", "itemColourId", size, code) VALUES ($1::uuid, $2::uuid, $3::uuid, '150 cm', $4)`, randomUUID(), A.lining, A.liningGRY, grey)
    await run(office(), `INSERT INTO "ItemVariant" (id, "itemId", size, code, status) VALUES ($1::uuid, $2::uuid, '140 cm', $3, 'ARCHIVED')`, randomUUID(), A.lining, red)
    await expect(update(office(), 'Lot', lot, `"variantCode" = $2`, red)).rejects.toThrow(/an ACTIVE variant of its item/)
    expect(await update(office(), 'Lot', lot, `"variantCode" = $2`, grey)).toBe(1)
    await expect(update(office(), 'Lot', lot, `"variantCode" = NULL`)).rejects.toThrow(/its variant never changes/)
    // R2's open receipt line is of PO1's protector line: give that line a variant, then a lot of it must carry it.
    const r2 = await one(`SELECT l.id::text AS line, l."purchaseOrderLineId"::text AS po FROM "GoodsReceiptLine" l WHERE l."receiptId" = $1 LIMIT 1`, [inv.openReceiptId])
    await admin(`ALTER TABLE "PurchaseOrderLine" DISABLE TRIGGER USER`)
    await admin(`UPDATE "PurchaseOrderLine" SET "variantCode" = $2 WHERE id = $1`, [r2.po, x.variantCodes.small])
    await admin(`ALTER TABLE "PurchaseOrderLine" ENABLE TRIGGER USER`)
    const lotRow = (variant: string | null) =>
      run(floor(), `INSERT INTO "Lot" (id, "companyId", "siteId", "itemId", code, "receiptLineId", "variantCode") VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid, $7)`, randomUUID(), A.company, A.site, A.protector, tag('LOT'), r2.line, variant)
    await expect(lotRow(null)).rejects.toThrow(/comes from a purchase order line of variant SEED-PRO-300-S; it is of that variant/)
    expect(await lotRow(x.variantCodes.small)).toBe(1)
  })
})

describe('requests to buy', () => {
  it('moves OPEN → PENDING_APPROVAL → OPEN → CONVERTED (into a line of its material on its plant) or CANCELLED, each step written once; what was asked is frozen after OPEN', async () => {
    const id = randomUUID()
    await copyRow(office(), 'PurchaseRequest', x.requestIds.open, { id })
    await expect(update(office(), 'PurchaseRequest', id, `status = 'PENDING_APPROVAL'`)).rejects.toThrow(/with the wrong approval task/)
    expect(await update(office(), 'PurchaseRequest', id, `status = 'PENDING_APPROVAL', "approvalTaskId" = $2::uuid`, randomUUID())).toBe(1)
    await expect(update(office(), 'PurchaseRequest', id, `quantity = 31`)).rejects.toThrow(/changes only while it is OPEN \(it is PENDING_APPROVAL\)/)
    await expect(update(office(), 'PurchaseRequest', id, `status = 'CONVERTED', "convertedAt" = now(), "convertedById" = $2::uuid, "purchaseOrderLineId" = $3::uuid`, a.actorId, x.sampleOrder.liningLineId)).rejects.toThrow(/cannot move from PENDING_APPROVAL to CONVERTED/)
    expect(await update(office(), 'PurchaseRequest', id, `status = 'OPEN'`)).toBe(1)
    // The lining asked for is not converted into a line of protectors (SEED-PO-0103's, on the request's plant A1).
    await expect(update(office(), 'PurchaseRequest', id, `status = 'CONVERTED', "convertedAt" = now(), "convertedById" = $2::uuid, "purchaseOrderLineId" = $3::uuid`, a.actorId, x.plantOrder.lineId)).rejects.toThrow(/into a purchase order line of its own material/)
    await expect(update(office(), 'PurchaseRequest', id, `status = 'CONVERTED', "convertedAt" = now(), "convertedById" = $2::uuid, "purchaseOrderLineId" = $3::uuid`, a.actorId, x.sampleOrder.liningLineId)).rejects.toThrow(/foreign key/)
    const protectors = randomUUID()
    await copyRow(office(), 'PurchaseRequest', x.requestIds.open, { id: protectors, itemId: A.protector, itemColourId: null, uom: 'PCS', quantity: '10' })
    expect(await update(office(), 'PurchaseRequest', protectors, `status = 'CONVERTED', "convertedAt" = now(), "convertedById" = $2::uuid, "purchaseOrderLineId" = $3::uuid`, a.actorId, x.plantOrder.lineId)).toBe(1)
    expect(await update(office(), 'PurchaseRequest', id, `status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'Bought with the protectors'`)).toBe(1)
    await expect(update(office(), 'PurchaseRequest', protectors, `"rejectReason" = 'Too late'`)).rejects.toThrow(/is CONVERTED; it changes no more/)
    await expect(update(office(), 'PurchaseRequest', id, `"cancelReason" = 'Another reason'`)).rejects.toThrow(/is CANCELLED; it changes no more/)
    await expect(update(office(), 'PurchaseRequest', protectors, `"requestedById" = $2::uuid`, randomUUID())).rejects.toThrow(/who asked for request to buy .* never change/)
    await expect(admin(`DELETE FROM "PurchaseRequest" WHERE id = $1`, [id])).rejects.toThrow(/is never deleted \(cancel it\)/)
  })

  it('starts OPEN, names a material or words, a shortage with its work order; refused and cancelled with the reason', async () => {
    await expect(copyRow(office(), 'PurchaseRequest', x.requestIds.converted, { id: randomUUID() })).rejects.toThrow(/starts OPEN \(or PENDING_APPROVAL when a rule asks a yes\)/)
    await expect(copyRow(office(), 'PurchaseRequest', x.requestIds.open, { id: randomUUID(), itemId: null, itemColourId: null })).rejects.toThrow(/names a material \(its colour only with it\) or says what in words/)
    await expect(copyRow(office(), 'PurchaseRequest', x.requestIds.open, { id: randomUUID(), source: 'SHORTAGE' })).rejects.toThrow(/from a shortage names its work order, its material and the shortage as seen/)
    await expect(copyRow(office(), 'PurchaseRequest', x.requestIds.open, { id: randomUUID(), requestedAt: '2099-01-01T00:00:00Z' })).rejects.toThrow(/not in the future/)
    const id = randomUUID()
    await copyRow(office(), 'PurchaseRequest', x.requestIds.open, { id })
    await expect(update(office(), 'PurchaseRequest', id, `status = 'REJECTED', "rejectedAt" = now(), "rejectedById" = $2::uuid`, a.actorId)).rejects.toThrow(/with the wrong approval task, refusal/)
    expect(await update(office(), 'PurchaseRequest', id, `status = 'REJECTED', "rejectedAt" = now(), "rejectedById" = $2::uuid, "rejectReason" = 'Enough in stock'`, a.actorId)).toBe(1)
    const cancelled = randomUUID()
    await copyRow(office(), 'PurchaseRequest', x.requestIds.open, { id: cancelled })
    await expect(update(office(), 'PurchaseRequest', cancelled, `status = 'CANCELLED', "cancelledAt" = now()`)).rejects.toThrow(/cancellation/)
    expect(await update(office(), 'PurchaseRequest', cancelled, `status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'Found some in the sample room'`)).toBe(1)
  })
})

describe('at the workshop', () => {
  const balanceRow = (changes: Record<string, unknown>) => copyRow(office(), 'SubcontractConsumption', x.balance.declaredId, { id: randomUUID(), ...changes })

  it('balances a SENT kit line: never more than was sent, never below 0; an adjustment after the declaration, with its reason', async () => {
    const last = Number((await one(`SELECT max(seq) AS s FROM "SubcontractConsumption" WHERE "kitLineId" = $1`, [x.balance.kitLineId])).s)
    // Sent 2 m; the rows hold used 1.4, returned 0.3, scrapped 0.2 (after the seed's adjustment).
    await expect(balanceRow({ seq: last + 1, usedQuantity: '0.2', returnedQuantity: '0', scrappedQuantity: '0' })).rejects.toThrow(/sent 2\.0000; used 1\.6000 \+ returned 0\.3000 \+ scrapped 0\.2000 would pass it/)
    await expect(balanceRow({ seq: last + 1, kind: 'ADJUSTMENT', usedQuantity: '-1.5', returnedQuantity: '0', scrappedQuantity: '0', reason: 'Recounted' })).rejects.toThrow(/would pass it or go below 0/)
    await expect(balanceRow({ seq: last + 1, kind: 'ADJUSTMENT', usedQuantity: '-0.1', returnedQuantity: '0.1', scrappedQuantity: '0' })).rejects.toThrow(/comes after the workshop's declaration and says why/)
    await expect(balanceRow({ seq: last, usedQuantity: '0.1', returnedQuantity: '0', scrappedQuantity: '0' })).rejects.toThrow(/takes a place above the line's last one/)
    await expect(balanceRow({ seq: last + 1, usedQuantity: '0', returnedQuantity: '0', scrappedQuantity: '0' })).rejects.toThrow(/at least one above 0/)
    await expect(balanceRow({ seq: last + 1, usedQuantity: '0.1', returnedQuantity: '0', scrappedQuantity: '0', reasonCode: 'NO GOOD', reason: 'x' })).rejects.toThrow(/a code of at most 40 characters without spaces/)
    expect(await balanceRow({ seq: last + 1, usedQuantity: '0.1', returnedQuantity: '0', scrappedQuantity: '0' })).toBe(1)
    await expect(admin(`UPDATE "SubcontractConsumption" SET "usedQuantity" = 0 WHERE id = $1`, [x.balance.declaredId])).rejects.toThrow(/append-only: UPDATE on "SubcontractConsumption" is refused/)
  })

  it('starts once the kit line is SENT', async () => {
    const planned = lateKey('portal-supply:P1:SC-0003:kit:10')
    await expect(balanceRow({ kitLineId: planned, seq: 1 })).rejects.toThrow(/kit line .* is PLANNED; its material balance starts once it is SENT/)
  })

  it('books the workshop\'s cost in the order\'s currency: a FEE of its operation, a reversal once', async () => {
    const entry = (changes: Record<string, unknown>) => copyRow(office(), 'SubcontractCostEntry', x.costEntryIds.fee, { id: randomUUID(), ...changes })
    await expect(entry({ currency: 'USD' })).rejects.toThrow(/is in its order's currency \(EUR\)/)
    await expect(entry({ subcontractOperationId: null })).rejects.toThrow(/is a FEE with its operation/)
    await expect(entry({ kind: 'TRANSPORT' })).rejects.toThrow(/is a FEE with its operation \(another kind names none\)/)
    await expect(entry({ amount: -200 })).rejects.toThrow(/has an amount of 0 or more/)
    await expect(entry({ occurredAt: '2099-01-01T00:00:00Z' })).rejects.toThrow(/incurred not in the future/)
    await expect(entry({ kind: 'OTHER', subcontractOperationId: null, reason: null })).rejects.toThrow(/OTHER says what it is/)
    await expect(entry({ amount: -200, reversalOfId: x.costEntryIds.fee })).rejects.toThrow(/takes back entry .* the reason/)
    await expect(entry({ amount: -300, reversalOfId: x.costEntryIds.twice, kind: 'OTHER', subcontractOperationId: null, unitPrice: '3', reason: 'Again' })).rejects.toThrow(/unique|takes back/)
    await expect(entry({ amount: 300, reversalOfId: x.costEntryIds.reversal, kind: 'OTHER', subcontractOperationId: null, unitPrice: '3', reason: 'Back again' })).rejects.toThrow(/a reversal is never taken back/)
    expect(await entry({ amount: -200, reversalOfId: x.costEntryIds.fee, reason: 'The good set was a defective one (made-up).' })).toBe(1)
    // A DRAFT order's work costs nothing yet (the W2a seed's SEED-SC-0001).
    await expect(entry({ subcontractOrderId: key('subcontract:SC-0001'), subcontractOperationId: null, receiptId: null, kind: 'TRANSPORT' })).rejects.toThrow(/is DRAFT; its work costs nothing yet|foreign key/)
    await expect(admin(`DELETE FROM "SubcontractCostEntry" WHERE id = $1`, [x.costEntryIds.fee])).rejects.toThrow(/append-only: DELETE on "SubcontractCostEntry" is refused/)
  })
})

describe('the walls', () => {
  const FILES = new Set(['buying-depth.prisma'])
  const models = classifiedModels(loadSchema(), loadOwnership()).filter(({ model }) => FILES.has(model.file))

  it('the floor reads the schedule, tolerances and variants; a partner its own deliveries; the rest is the office\'s', async () => {
    expect(models.map(({ model }) => model.name).sort()).toEqual([
      'DeliveryTolerance',
      'ItemVariant',
      'PoDateChange',
      'PurchaseOrderLineDelivery',
      'PurchaseRequest',
      'SubcontractConsumption',
      'SubcontractCostEntry',
    ])
    for (const { model, ownership } of models) {
      const floorAccess = ownership.access[FLOOR_ROLE]
      expect(floorAccess?.privileges ?? [], model.name).toEqual(['PurchaseOrderLineDelivery', 'DeliveryTolerance', 'ItemVariant'].includes(model.name) ? ['select'] : [])
      const partnerAccess = ownership.access[PARTNER_ROLE]
      expect(partnerAccess?.privileges ?? [], model.name).toEqual(model.name === 'PurchaseOrderLineDelivery' ? ['select', 'update'] : [])
      for (const { column } of partnerWalledColumns(model)) expect(partnerAccess?.hiddenColumns ?? [column], `${model.name}.${column}`).toContain(column)
    }
    // The cost columns of the new tables.
    expect(models.flatMap(({ model }) => partnerWalledColumns(model).map(({ column }) => `${model.name}.${column}`)).sort()).toEqual(['SubcontractCostEntry.amount', 'SubcontractCostEntry.unitPrice'])
    await expect(sql(floor(), `SELECT 1 FROM "PoDateChange" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(partner(), `SELECT 1 FROM "PurchaseRequest" LIMIT 1`)).rejects.toThrow(/permission denied/)
    expect((await sql(floor(), `SELECT count(*)::int AS n FROM "PurchaseOrderLineDelivery"`))[0]!.n).toBeGreaterThan(0)
    expect((await sql(floor(A.siteB), `SELECT count(*)::int AS n FROM "PurchaseOrderLineDelivery" WHERE "siteId" = $1::uuid`, A.site))[0]!.n).toBe(0)
    expect((await sql(partner(A.P2), `SELECT count(*)::int AS n FROM "PurchaseOrderLineDelivery"`))[0]!.n).toBe(0)
    // The rate and the value in the company's currency stay with the office; a partner reads where to deliver, not the task.
    await expect(sql(floor(), `SELECT "companyNetAmount" FROM "PurchaseOrder" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(partner(), `SELECT "rateAtOrder" FROM "PurchaseOrder" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(partner(), `SELECT "approvalTaskId" FROM "PurchaseOrder" LIMIT 1`)).rejects.toThrow(/permission denied/)
    expect(await sql(partner(), `SELECT kind::text AS kind, "shipToPartyId"::text AS "shipTo" FROM "PurchaseOrder" WHERE id = $1::uuid`, x.usdOrder.orderId)).toEqual([{ kind: 'STANDARD', shipTo: A.P2 }])
  })
})
