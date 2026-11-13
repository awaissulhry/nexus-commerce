import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedShipping } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../core/command'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld, type PortalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Browser, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../platform/outbox/system'
import { changePromise, followOrder } from '../orders/moves'
import { forgetProgress } from './progress'

/**
 * Customer orders in the portal on the local stack (B-W2b-175; SAL-075, SAL-076, SAL-080, SAL-081), through the real app
 * and the real portal sign-in by code: the factory-db seeds up to shipping (SEED-SO-0001/0002/0003 of the brand SEED-C1;
 * SEED-SO-0002: 7 jackets, WO-0001 released, quality released 3 less 1 taken back, SH-0001 SHIPPED with 2 in two
 * parcels, DDT 143 cancelled and 144 live, the carrier's tracking; SEED-SO-0003's SH-0002 still a DRAFT), its portal and
 * another customer's switched on; the customer's buyer, viewer and designer, the other customer's buyer. Every name,
 * number and price is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/portal-orders`.
 */

let h: Harness
let tenant: TestTenant
let world: PortalWorld
const NS = 'portal-orders-a'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const TODAY = businessDate(new Date())

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const orderId = (number: string) => one<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2', [T, number]).then((row) => row.id)

const people = { buyer: 'bianca.buyer@seed-racing.example', viewer: 'vito.viewer@seed-racing.example', designer: 'dora.designer@seed-racing.example', other: 'otto.buyer@brand-alpha.example' }
const browsers = {} as Record<keyof typeof people, Browser>

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<void> {
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    const id = newId()
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const key of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
}

async function signedIn(email: string): Promise<Browser> {
  const browser = await portalBrowser(h)
  h.clock.advance(61_000)
  expect((await browser.post('/portal/signin/start', { tenant: NS, company: 'SCA', email })).status).toBe(200)
  await h.auth.settled()
  const answer = await browser.post('/portal/signin/code', { tenant: NS, company: 'SCA', email, code: mailedCode(h, email)!.code })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const terms = await browser.get('/portal/terms?locale=en')
  expect((await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
  return browser
}

async function ok(browser: Browser, url: string): Promise<Json> {
  const answer = await browser.get(url)
  expect(answer.status, `${url}: ${JSON.stringify(answer.body)}`).toBe(200)
  return answer.body as Json
}

const office = () => callerFor(h.database, { audience: 'office', tenantId: T, actorId: newId(), requestId: newId(), grants: [{ permissions: ['orders.view', 'orders.manage'], companies: 'all', sites: 'all', parties: 'all' }] })
const setShared = (on: boolean) => admin('UPDATE "PortalSettings" SET "progressShared" = $2, version = version + 1 WHERE "partyId" = $1', [P1, on])

beforeAll(async () => {
  h = await startHarness('portal_sales_orders')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedShipping({ db: h.database, namespace: NS })
  tenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    // The portal's sign-in mail sender (as tenant set-up makes it): a FAKE SES account and company A's NOTIFICATION identity.
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-portal', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'NOTIFICATION', domain, fromAddress: `noreply@${domain}`, displayName: 'Seed A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
    await client.portalSettings.create({ data: { id: P1, partyId: P1, portalOn: true }, select: { id: true } })
  })
  // Company A's portal terms and another customer (Brand Alpha, no orders) with its portal on.
  world = await portalWorld(h, tenant)
  freshGuard(h)
  await partnerPerson(people.buyer, P1, ['customer-buyer', 'partner-comment', 'partner-upload', 'partner-approve'])
  await partnerPerson(people.viewer, P1, ['customer-viewer'])
  await partnerPerson(people.designer, P1, ['customer-designer'])
  await partnerPerson(people.other, world.partyId, ['customer-buyer'])
  for (const key of Object.keys(people) as (keyof typeof people)[]) browsers[key] = await signedIn(people[key])
}, 240_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  forgetProgress()
  await h?.close()
})

describe('the orders list (SAL-075, SAL-081)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('lists the customer orders, their PO first, in customer words, with pieces, value and the next shipment', async () => {
    const list = await ok(browsers.buyer, '/portal/sales-orders')
    expect(list).toMatchObject({ seesPrices: true, progressShared: false, chip: 'OPEN', count: 3 })
    expect(list.items.map((row: Json) => [row.customerRef, row.number, row.status])).toEqual([
      ['SEED-PO-78', 'SEED-SO-0002', 'CONFIRMED'],
      ['SEED-PO-91', 'SEED-SO-0003', 'CONFIRMED'],
      ['SEED-PO-77', 'SEED-SO-0001', 'CONFIRMED'],
    ])
    const so2 = list.items[0]
    expect(so2).toMatchObject({ kind: 'ORDER', words: { en: 'Confirmed', it: 'Confermato' }, pieces: { ordered: 7, shipped: 2, open: 5 }, promiseMoved: false, movedLately: false, progressPercent: null })
    expect(typeof so2.netAmount).toBe('number')
    expect(so2.nextShipment).toMatchObject({ number: 'SEED-SH-0001', status: 'IN_TRANSIT', words: { en: 'On the way' } })
    // SH-0002 is a DRAFT: not something the customer waits for yet.
    expect(list.items[1].nextShipment).toBeNull()
    expect(Object.fromEntries(list.chips.map((chip: Json) => [chip.chip, chip.count]))).toMatchObject({ OPEN: 3, REQUESTED: 0, ALL: 3, DELIVERED: 0, DATE_MOVED: 0 })
  })

  it('finds an order by their PO, our number or a style; a viewer sees no price; the designer and another customer see none', async () => {
    expect((await ok(browsers.buyer, '/portal/sales-orders?q=po-78')).items.map((row: Json) => row.number)).toEqual(['SEED-SO-0002'])
    expect((await ok(browsers.buyer, '/portal/sales-orders?q=SO-0001')).items.map((row: Json) => row.number)).toEqual(['SEED-SO-0001'])
    expect((await ok(browsers.buyer, '/portal/sales-orders?q=SEED-JKT-03')).items.map((row: Json) => row.number)).toEqual(['SEED-SO-0003'])
    expect((await ok(browsers.buyer, '/portal/sales-orders?q=nothing-like-this')).count).toBe(0)
    const viewer = await ok(browsers.viewer, '/portal/sales-orders')
    expect(viewer.seesPrices).toBe(false)
    expect(viewer.count).toBe(3)
    expect(viewer.items.every((row: Json) => !('netAmount' in row))).toBe(true)
    expect((await browsers.designer.get('/portal/sales-orders')).status).toBe(403)
    expect((await ok(browsers.other, '/portal/sales-orders?chip=ALL')).count).toBe(0)
    expect((await browsers.buyer.get('/portal/sales-orders?chip=SOON')).status).toBe(400)
  })
})

describe('the order: status, promise, lines (SAL-075, SAL-081)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('follows the status in customer words with the days it moved; the promise moves in curated words, never the office text', async () => {
    const so2 = await orderId('SEED-SO-0002')
    const so1 = await orderId('SEED-SO-0001')
    // The system follows the facts: WO-0001 released → in production; SH-0001 left with 2 of 7 → partly shipped.
    expect((await followOrder(callerFor(h.database, systemContext(T, newId())), so2, { what: 'test' })).moved).toEqual(['IN_PRODUCTION', 'PARTLY_SHIPPED'])
    const current = await one<{ version: number; promise: string }>('SELECT version, "promiseDate"::text AS promise FROM "SalesOrder" WHERE id = $1', [so2])
    // B-W2b-F45: a week after the seed's promise, or after today once that promise has passed (a new promise is a day from
    // today on).
    const moved = addDays(current.promise > TODAY ? current.promise : TODAY, 7)
    await changePromise(office(), so2, { version: current.version, promiseDate: moved, reason: 'MATERIAL_LATE: the tannery batch 12 is late, chase Marco' })
    const line = await one<{ id: string; seq: number }>('SELECT id, seq FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq LIMIT 1', [so1])
    const so1Version = (await one<{ version: number }>('SELECT version FROM "SalesOrder" WHERE id = $1', [so1])).version
    await changePromise(office(), so1, { version: so1Version, promiseDate: addDays(TODAY, 90), reason: 'Buyer pays late: keep them waiting', lineIds: [line.id] })

    const record = await ok(browsers.buyer, `/portal/sales-orders/${so2}`)
    expect(record.order).toMatchObject({ number: 'SEED-SO-0002', customerRef: 'SEED-PO-78', status: 'PARTLY_SHIPPED', words: { en: 'Partly shipped' }, promiseDate: moved, promiseMoved: true, reconfirmNeeded: false })
    expect(typeof record.order.netAmount).toBe('number')
    const today = businessDate(new Date())
    expect(record.milestones.map((step: Json) => [step.key, step.state, step.current])).toEqual([
      ['REQUESTED', 'DONE', false],
      ['CONFIRMED', 'DONE', false],
      ['IN_PRODUCTION', 'DONE', false],
      ['READY', 'DONE', false],
      ['SHIPPED', 'PARTLY', true],
      ['DELIVERED', 'TODO', false],
    ])
    expect(record.milestones[2].date).toBe(today)
    expect(record.milestones[4]).toMatchObject({ date: '2026-11-24', expected: moved })
    expect(record.promiseHistory).toEqual([{ on: today, from: current.promise, to: moved, lines: [], reason: { code: 'MATERIAL_LATE', words: { it: 'Consegna dei materiali in ritardo', en: 'Material delivery late' } } }])
    const so1Record = await ok(browsers.buyer, `/portal/sales-orders/${so1}`)
    expect(so1Record.promiseHistory).toEqual([expect.objectContaining({ lines: [line.seq], reason: expect.objectContaining({ code: 'PLANNING' }) })])
    expect(JSON.stringify([record, so1Record])).not.toMatch(/tannery|Marco|pays late|createdById|internalNote|costAmount/)
    // The list marks it moved, in the "Date moved" chip.
    const list = await ok(browsers.buyer, '/portal/sales-orders?chip=DATE_MOVED')
    expect(list.items.map((row: Json) => row.number).sort()).toEqual(['SEED-SO-0001', 'SEED-SO-0002'])
  })

  it('shows the lines and sizes with what is open; prices only for the buyer; another customer gets 404', async () => {
    const so2 = await orderId('SEED-SO-0002')
    const record = await ok(browsers.buyer, `/portal/sales-orders/${so2}`)
    expect(record.pieces).toEqual({ ordered: 7, shipped: 2, open: 5, closedShort: 0 })
    const blk = record.lines.find((line: Json) => line.colourway?.code === 'BLK')
    expect(blk).toMatchObject({ style: { code: 'SEED-JKT-02' }, pieces: { ordered: 4, shipped: 1, open: 3 } })
    expect(blk.sizes.map((size: Json) => [size.size, size.ordered, size.shipped, size.open])).toEqual([
      ['50', 1, 1, 0],
      ['52', 2, 0, 2],
      ['54', 1, 0, 1],
    ])
    expect(typeof blk.unitPrice).toBe('string')
    const viewer = await ok(browsers.viewer, `/portal/sales-orders/${so2}`)
    expect(viewer.seesPrices).toBe(false)
    expect(viewer.lines[0]).not.toHaveProperty('unitPrice')
    expect(viewer.order).not.toHaveProperty('netAmount')
    expect((await browsers.other.get(`/portal/sales-orders/${so2}`)).status).toBe(404)
    expect((await browsers.designer.get(`/portal/sales-orders/${so2}`)).status).toBe(403)
  })
})

describe('production progress per customer switch (SAL-076, C1)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('is not there while the customer does not share it, counts per line and size once it does, at most once a minute', async () => {
    const so2 = await orderId('SEED-SO-0002')
    expect((await ok(browsers.buyer, `/portal/sales-orders/${so2}`)).progressShared).toBe(false)
    expect((await browsers.buyer.get(`/portal/sales-orders/${so2}/progress`)).status).toBe(404)
    await setShared(true)
    const progress = await ok(browsers.viewer, `/portal/sales-orders/${so2}/progress`)
    expect(progress.refreshSeconds).toBe(60)
    expect(progress.stages.map((stage: Json) => [stage.key, stage.words.en])).toEqual([
      ['CUT', 'Cut'],
      ['SEWN', 'Sewn'],
      ['INSPECTED', 'Inspected'],
      ['PACKED', 'Packed'],
    ])
    const figures = (line: Json) => Object.fromEntries(line.sizes.map((size: Json) => [size.size, [size.inspected, size.packed, size.cut]]))
    const blk = progress.lines.find((line: Json) => line.colourway?.code === 'BLK')
    const red = progress.lines.find((line: Json) => line.colourway?.code === 'RED')
    // Released BLK 50 ×1, BLK 52 ×2 less 1 taken back, RED 52 ×1; SH-0001 packed BLK 50 and RED 52; a later stage implies the cut.
    expect(figures(blk)).toEqual({ '50': [1, 1, 1], '52': [1, 0, 1], '54': [0, 0, 0] })
    expect(figures(red)).toEqual({ '50': [0, 0, 0], '52': [1, 1, 1], '54': [0, 0, 0] })
    expect(progress.whole).toMatchObject({ ordered: 7, inspected: 3, packed: 2 })
    expect(JSON.stringify(progress)).not.toMatch(/worker|operator|station|employee|displayName/i)
    // Kept for a minute: the same answer; read again after it.
    const again = await ok(browsers.buyer, `/portal/sales-orders/${so2}/progress`)
    expect(again.asOf).toBe(progress.asOf)
    h.clock.advance(61_000)
    const later = await ok(browsers.buyer, `/portal/sales-orders/${so2}/progress`)
    expect(later.asOf).not.toBe(progress.asOf)
    // The list's next deliveries carry the percent; Home counts.
    const list = await ok(browsers.buyer, '/portal/sales-orders?limit=5&progress=true')
    expect(list.progressShared).toBe(true)
    expect(list.items.find((row: Json) => row.id === so2).progressPercent).toBeGreaterThan(0)
    // Switched off: gone at once, even while counts are kept.
    await setShared(false)
    expect((await browsers.buyer.get(`/portal/sales-orders/${so2}/progress`)).status).toBe(404)
    expect((await ok(browsers.buyer, '/portal/sales-orders?limit=5&progress=true')).items.every((row: Json) => row.progressPercent === null)).toBe(true)
    expect((await browsers.other.get(`/portal/sales-orders/${so2}/progress`)).status).toBe(404)
  })
})

describe('shipments, tracking and what is still to ship (SAL-080, SAL-081)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('shows each shipment that left with its live DDT, parcels and tracking, and what is still to ship', async () => {
    const so2 = await orderId('SEED-SO-0002')
    const answer = await ok(browsers.viewer, `/portal/sales-orders/${so2}/shipments`)
    expect(answer.shipments).toHaveLength(1)
    const shipment = answer.shipments[0]
    expect(shipment).toMatchObject({ number: 'SEED-SH-0001', status: 'IN_TRANSIT', words: { en: 'On the way' }, ddt: { number: expect.stringMatching(/^144/) } })
    expect(shipment.milestones.map((step: Json) => [step.key, step.done])).toEqual([
      ['PACKED', true],
      ['COLLECTED', true],
      ['IN_TRANSIT', true],
      ['DELIVERED', false],
    ])
    expect(shipment.parcels).toHaveLength(2)
    expect(shipment.parcels.every((parcel: Json) => parcel.trackingNumber && parcel.status === 'IN_TRANSIT')).toBe(true)
    expect(shipment.events[0].status).toBe('IN_TRANSIT')
    expect(shipment.lines.map((line: Json) => [line.colourway?.code, line.size, line.quantity]).sort()).toEqual([
      ['BLK', '50', 1],
      ['RED', '52', 1],
    ])
    expect(JSON.stringify(answer)).not.toMatch(/freight|internalNote|createdById|18\.50/)
    expect(answer.stillToShip.map((row: Json) => [row.colourway?.code, row.size, row.open]).sort()).toEqual([
      ['BLK', '52', 2],
      ['BLK', '54', 1],
      ['RED', '50', 1],
      ['RED', '54', 1],
    ])
    expect(answer.stillToShip.every((row: Json) => row.expected === answer.stillToShip[0].expected && row.expected !== null)).toBe(true)
    expect(answer.firstExpected).toBeNull()
    // SEED-SO-0003: its only shipment is a DRAFT: nothing shown, the first day expected instead.
    const so3 = await ok(browsers.buyer, `/portal/sales-orders/${await orderId('SEED-SO-0003')}/shipments`)
    expect(so3.shipments).toEqual([])
    expect(so3.firstExpected).toBe(so3.stillToShip[0].expected)
    expect((await browsers.other.get(`/portal/sales-orders/${so2}/shipments`)).status).toBe(404)
  })

  it('lists what is on the way across the orders, and counts it on Home', async () => {
    const transit = await ok(browsers.buyer, '/portal/sales-orders/in-transit')
    expect(transit.items.map((row: Json) => [row.number, row.order.customerRef, row.status])).toEqual([['SEED-SH-0001', 'SEED-PO-78', 'IN_TRANSIT']])
    expect(transit.items[0].trackingNumbers).toHaveLength(2)
    expect((await ok(browsers.other, '/portal/sales-orders/in-transit')).items).toEqual([])
    // This source's own four counts (other sources also use 'orders.' keys, e.g. approvals-out's orders.to_reconfirm).
    const own = ['orders.open', 'orders.in_production', 'orders.shipping_this_week', 'orders.in_transit']
    const counts = (home: Json) => Object.fromEntries(home.counts.filter((count: Json) => own.includes(count.key)).map((count: Json) => [count.key, count.value]))
    expect(counts(await ok(browsers.buyer, '/portal/home'))).toEqual({ 'orders.open': 3, 'orders.in_production': 0, 'orders.shipping_this_week': expect.any(Number), 'orders.in_transit': 1 })
    expect(counts(await ok(browsers.designer, '/portal/home'))).toEqual({ 'orders.open': null, 'orders.in_production': null, 'orders.shipping_this_week': null, 'orders.in_transit': null })
    expect(counts(await ok(browsers.other, '/portal/home'))).toEqual({ 'orders.open': 0, 'orders.in_production': 0, 'orders.shipping_this_week': 0, 'orders.in_transit': 0 })
  })

  it("B-W2b-F14: shows the carrier's expected delivery while on the way, and \"Track on the carrier's site\" only for an https page", async () => {
    const so2 = await orderId('SEED-SO-0002')
    const shipment = await one<{ id: string }>('SELECT id FROM "Shipment" WHERE "tenantId" = $1 AND number = $2', [T, 'SEED-SH-0001'])
    const parcels = await admin<{ id: string; trackingNumber: string }>('SELECT id, "trackingNumber" FROM "Parcel" WHERE "shipmentId" = $1 ORDER BY seq', [shipment.id])
    const eta = new Date(Date.UTC(2026, 10, 20, 12, 0)).toISOString()
    // As a label bought then would have kept them (the seeded parcels left before the columns existed): written around the
    // guards, which let a parcel change only until the goods leave. Parcel 2 has no page.
    await admin('SET session_replication_role = replica')
    try {
      await admin('UPDATE "Parcel" SET "trackingUrl" = $2 WHERE id = $1', [parcels[0]!.id, `https://tracking.example.com/${parcels[0]!.trackingNumber}`])
      await admin('UPDATE "Shipment" SET "expectedDeliveryAt" = $2 WHERE id = $1', [shipment.id, eta])
    } finally {
      await admin('SET session_replication_role = DEFAULT')
    }
    const answer = await ok(browsers.viewer, `/portal/sales-orders/${so2}/shipments`)
    expect(answer.shipments[0]).toMatchObject({ number: 'SEED-SH-0001', status: 'IN_TRANSIT', expectedDeliveryAt: eta })
    expect(answer.shipments[0].parcels.map((parcel: Json) => parcel.trackingLink)).toEqual([
      { url: `https://tracking.example.com/${parcels[0]!.trackingNumber}`, words: { it: 'Segui sul sito del corriere', en: "Track on the carrier's site" } },
      null,
    ])
    const transit = await ok(browsers.buyer, '/portal/sales-orders/in-transit')
    expect(transit.items[0]).toMatchObject({ number: 'SEED-SH-0001', expectedDeliveryAt: eta, trackingLinks: [{ trackingNumber: parcels[0]!.trackingNumber, url: `https://tracking.example.com/${parcels[0]!.trackingNumber}` }] })
    const list = await ok(browsers.buyer, '/portal/sales-orders?chip=ALL')
    expect(list.items.find((row: Json) => row.id === so2).nextShipment).toMatchObject({ number: 'SEED-SH-0001', expectedDeliveryAt: eta })
    // The database never keeps an http page (Parcel_tracking_url_check, every login): there is none to show.
    await expect(admin('UPDATE "Parcel" SET "trackingUrl" = $2 WHERE id = $1', [parcels[1]!.id, 'http://tracking.example.com/plain'])).rejects.toThrow(/https address|parcels are added and removed/)
    // Once delivered, the customer sees the day it arrived, not an expected one.
    await admin('SET session_replication_role = replica')
    try {
      await admin(`UPDATE "Shipment" SET status = 'DELIVERED', "deliveredAt" = now() WHERE id = $1`, [shipment.id])
      const delivered = await ok(browsers.viewer, `/portal/sales-orders/${so2}/shipments`)
      expect(delivered.shipments[0]).toMatchObject({ status: 'DELIVERED', expectedDeliveryAt: null })
    } finally {
      await admin(`UPDATE "Shipment" SET status = 'SHIPPED', "deliveredAt" = NULL WHERE id = $1`, [shipment.id])
      await admin('SET session_replication_role = DEFAULT')
    }
  })
})
