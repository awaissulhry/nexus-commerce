import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
import { AUTOMATIC_REASONS } from '@nexus/factory-domain/sales/amendments/reasons' // B-OL-004
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedShipping } from '../../../../../../packages/factory-db/seed/shipping'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files' // of-fx4s (B-OF-005): the file store and its portal file of P1
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
// B-SA-030: the one reader of the order's own cells (the office's order read shares it).
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { readLines as readOrderLines } from '../orders/store'
import { officeProgressFor, readCellCounts, readStageCounts, stageCountsOf } from './progress'
import { seedDay } from '@nexus/factory-db/testing' // B-W2b-F53: the seeds' future follows the calendar
import { readableText } from '../../../testing/readable' // cw-fx9

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
// B-PR-40: sharing progress is the share level (PROGRESS on, STATUS off), the old switch dropped.
const setShared = (on: boolean) => admin('UPDATE "PortalSettings" SET "productionLevel" = $2::"ProductionShareLevel", version = version + 1 WHERE "partyId" = $1', [P1, on ? 'PROGRESS' : 'STATUS'])

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
    expect(list).toMatchObject({ seesPrices: true, chip: 'OPEN', count: 3 })
    expect(list).not.toHaveProperty('progressShared') // B-PR-40
    // fix-portal-numbers-1 (B-TH-303, plan §0.5): an order answers the customer's own number, never the office's series (null).
    expect(list.items.map((row: Json) => [row.customerRef, row.number, row.status])).toEqual([
      ['SEED-PO-78', null, 'CONFIRMED'],
      ['SEED-PO-91', null, 'CONFIRMED'],
      ['SEED-PO-77', null, 'CONFIRMED'],
    ])
    expect(list.items.every((row: Json) => row.yourNumber?.seq > 0)).toBe(true)
    expect(JSON.stringify(list)).not.toMatch(/SEED-SO-/)
    const so2 = list.items[0]
    expect(so2).toMatchObject({ kind: 'ORDER', words: { en: 'Confirmed', it: 'Confermato' }, pieces: { ordered: 7, shipped: 2, open: 5 }, promiseMoved: false, movedLately: false, progressPercent: null })
    expect(typeof so2.netAmount).toBe('number')
    // pg-s1 S1.3 (Owner D6): named by its order ("Your order 12 · parcel 1"), never the office's shipment series (SEED-SH-0001).
    expect(so2.nextShipment).toMatchObject({ number: null, parcel: 1, status: 'IN_TRANSIT', words: { en: 'On the way' } })
    expect(JSON.stringify(list)).not.toMatch(/SEED-SH-/)
    // SH-0002 is a DRAFT: not something the customer waits for yet.
    expect(list.items[1].nextShipment).toBeNull()
    expect(Object.fromEntries(list.chips.map((chip: Json) => [chip.chip, chip.count]))).toMatchObject({ OPEN: 3, REQUESTED: 0, ALL: 3, DELIVERED: 0, DATE_MOVED: 0 })
  })

  it('finds an order by their PO, our number or a style; a viewer sees no price; the designer and another customer see none', async () => {
    // fix-portal-numbers-1: our number still finds the order (it is printed on its confirmation); the row names it by the customer's PO.
    expect((await ok(browsers.buyer, '/portal/sales-orders?q=po-78')).items.map((row: Json) => row.customerRef)).toEqual(['SEED-PO-78'])
    expect((await ok(browsers.buyer, '/portal/sales-orders?q=SO-0001')).items.map((row: Json) => row.customerRef)).toEqual(['SEED-PO-77'])
    expect((await ok(browsers.buyer, '/portal/sales-orders?q=SEED-JKT-03')).items.map((row: Json) => row.customerRef)).toEqual(['SEED-PO-91'])
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
    expect(record.milestones[4]).toMatchObject({ date: seedDay('2026-11-24'), expected: moved })
    expect(record.promiseHistory).toEqual([{ on: today, from: current.promise, to: moved, lines: [], reason: { code: 'MATERIAL_LATE', words: { it: 'Consegna dei materiali in ritardo', en: 'Material delivery late' } } }])
    const so1Record = await ok(browsers.buyer, `/portal/sales-orders/${so1}`)
    expect(so1Record.promiseHistory).toEqual([expect.objectContaining({ lines: [line.seq], reason: expect.objectContaining({ code: 'PLANNING' }) })])
    expect(JSON.stringify([record, so1Record])).not.toMatch(/tannery|Marco|pays late|createdById|internalNote|costAmount/)
    // The list marks it moved, in the "Date moved" chip.
    const list = await ok(browsers.buyer, '/portal/sales-orders?chip=DATE_MOVED')
    expect(list.items.map((row: Json) => row.customerRef).sort()).toEqual(['SEED-PO-77', 'SEED-PO-78']) // fix-portal-numbers-1
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

  // ── B-OM-005 (order money tab M3-B6, M1-S4): a part payment shows to the customer, with what is still to pay ──
  it('B-OM-005: a deposit paid in part shows what is paid and the order’s still to pay; a viewer reads neither; another customer gets 404', async () => {
    const so1 = await orderId('SEED-SO-0001')
    const request = await one<{ id: string; amount: number }>(`SELECT id, amount FROM "DepositRequest" WHERE "orderId" = $1 AND status = 'OPEN' ORDER BY "createdAt", id LIMIT 1`, [so1])
    // Nothing else is paid, invoiced or closed short on the order in this world: what is still to pay is its gross less this payment.
    expect(await admin(`SELECT 1 FROM "PaymentAllocation" a JOIN "DepositRequest" r ON r.id = a."depositRequestId" WHERE r."orderId" = $1`, [so1])).toEqual([])
    expect(await admin(`SELECT 1 FROM "Invoice" WHERE "salesOrderId" = $1 AND status <> 'DRAFT'`, [so1])).toEqual([])
    expect(await admin(`SELECT 1 FROM "SalesOrderLine" WHERE "orderId" = $1 AND "closedShortQuantity" IS NOT NULL`, [so1])).toEqual([])
    const paymentId = newId()
    // Written with the database's rules off: a part payment of 100.00 on the request (as the office's Record a payment does).
    await h.db.admin.query('BEGIN')
    try {
      await h.db.admin.query("SET LOCAL session_replication_role = 'replica'")
      await h.db.admin.query(`INSERT INTO "Payment" (id, "tenantId", "companyId", "partyId", amount, "receivedOn", "externalRef") VALUES ($1, $2, $3, $4, 10000, $5::date, 'OM-PORTAL-0001')`, [paymentId, T, companyA, P1, TODAY])
      await h.db.admin.query(`INSERT INTO "PaymentAllocation" (id, "tenantId", "companyId", "partyId", "paymentId", "depositRequestId", amount) VALUES ($1, $2, $3, $4, $5, $6, 10000)`, [newId(), T, companyA, P1, paymentId, request.id])
      await h.db.admin.query('COMMIT')
    } catch (error) {
      await h.db.admin.query('ROLLBACK')
      throw error
    }
    const record = await ok(browsers.buyer, `/portal/sales-orders/${so1}`)
    expect(record.deposits.find((row: Json) => row.id === request.id)).toMatchObject({ status: 'OPEN', amount: request.amount, paidAmount: 10000 })
    expect(record.order.stillToPay).toBe(record.order.grossAmount - 10000)
    const viewer = await ok(browsers.viewer, `/portal/sales-orders/${so1}`)
    expect(viewer.deposits.find((row: Json) => row.id === request.id)).not.toHaveProperty('paidAmount')
    expect(viewer.order).not.toHaveProperty('stillToPay')
    expect((await browsers.other.get(`/portal/sales-orders/${so1}`)).status).toBe(404)
  })

  // ── B-OO-009 (order overview N10): the office picks a curated reason; the customer reads its words, never the office's note ──
  it('B-OO-009: a promise moved with CAPACITY and a note shows CAPACITY in the customer words, and never the note', async () => {
    const so3 = await orderId('SEED-SO-0003')
    const current = await one<{ version: number; promise: string | null }>('SELECT version, "promiseDate"::text AS promise FROM "SalesOrder" WHERE id = $1', [so3])
    const moved = addDays(current.promise !== null && current.promise > TODAY ? current.promise : TODAY, 9)
    await changePromise(office(), so3, { version: current.version, promiseDate: moved, reasonCode: 'CAPACITY', reason: 'line 2 down, call Marco' })
    const record = await ok(browsers.buyer, `/portal/sales-orders/${so3}`)
    expect(record.promiseHistory[0]).toMatchObject({ to: moved, lines: [], reason: { code: 'CAPACITY', words: { it: 'Capacità produttiva', en: 'Production capacity' } } })
    expect(JSON.stringify(record)).not.toMatch(/line 2 down|Marco/)
    const viewer = await ok(browsers.viewer, `/portal/sales-orders/${so3}`)
    expect(viewer.promiseHistory[0].reason.code).toBe('CAPACITY')
    expect(JSON.stringify(viewer)).not.toMatch(/line 2 down|Marco/)
  })
  // ── end B-OO-009 ──

  // ── B-OL-004 (order lines plan D2; 18 F23): a promise moved with no reason shows no reason — never "Our planning changed" ──
  it('B-OL-004: a promise moved with no reason given shows the move with no reason to the customer', async () => {
    const so3 = await orderId('SEED-SO-0003')
    const current = await one<{ version: number; promise: string | null }>('SELECT version, "promiseDate"::text AS promise FROM "SalesOrder" WHERE id = $1', [so3])
    const moved = addDays(current.promise !== null && current.promise > TODAY ? current.promise : TODAY, 5)
    await changePromise(office(), so3, { version: current.version, promiseDate: moved })
    const stored = await one<{ reason: string }>(`SELECT reason FROM "AuditLog" WHERE action = 'orders.changePromise' AND "recordId" = $1 ORDER BY at DESC, id DESC LIMIT 1`, [so3])
    expect(stored.reason).toBe(AUTOMATIC_REASONS.promise)
    const record = await ok(browsers.buyer, `/portal/sales-orders/${so3}`)
    expect(record.promiseHistory[0]).toEqual({ on: expect.any(String), from: current.promise, to: moved, lines: [], reason: null })
    expect(JSON.stringify(record)).not.toMatch(/order page|Our planning changed|La nostra pianificazione/)
    // The earlier move with its code keeps its reason.
    expect(record.promiseHistory.slice(1).map((move: Json) => move.reason?.code ?? null)).toContain('CAPACITY')
  })
  // ── end B-OL-004 ──
})

describe('production progress per customer switch (SAL-076, C1)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('is not there while the customer does not share it, counts per line and size once it does, at most once a minute', async () => {
    const so2 = await orderId('SEED-SO-0002')
    expect((await ok(browsers.buyer, `/portal/sales-orders/${so2}`)).productionLevel).toBe('STATUS')
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
    expect(list.items.find((row: Json) => row.id === so2).progressPercent).toBeGreaterThan(0)
    // Switched off: gone at once, even while counts are kept.
    await setShared(false)
    expect((await browsers.buyer.get(`/portal/sales-orders/${so2}/progress`)).status).toBe(404)
    expect((await ok(browsers.buyer, '/portal/sales-orders?limit=5&progress=true')).items.every((row: Json) => row.progressPercent === null)).toBe(true)
    expect((await browsers.other.get(`/portal/sales-orders/${so2}/progress`)).status).toBe(404)
  })
})

// ── B-SA-030 (Sales page plan P2, P16, P17): the office's order read counts the same cells, kept under the same key ──────────
describe('B-SA-030 one reader of the order’s own cells', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('readStageCounts is the fold of readCellCounts, each cell with its work order; the office and the portal share the kept minute', async () => {
    const so2 = await orderId('SEED-SO-0002')
    forgetProgress()
    const caller = office()
    const lines = await caller.withClient((client) => readOrderLines(client, so2))
    const cells = await caller.withClient((client) => readCellCounts(client, so2, lines))
    // The fold is what the portal has always answered (its expectations above are unchanged).
    expect(await caller.withClient((client) => readStageCounts(client, so2, lines))).toEqual(stageCountsOf(lines, cells))
    const lineIds = new Set(lines.map((line) => line.id))
    expect(cells.cells.length).toBeGreaterThan(0)
    expect(cells.cells.every((cell) => lineIds.has(cell.lineId) && isUuid(cell.workOrderId) && cell.quantity > 0)).toBe(true)
    // One key per tenant and order: the office's read is the portal's next minute (and the other way round).
    const officeAnswer = await caller.withClient((client) => officeProgressFor(client, T, so2, lines, h.clock.now()))
    await setShared(true)
    const portal = await ok(browsers.buyer, `/portal/sales-orders/${so2}/progress`)
    expect(portal.asOf).toBe(toUtcIso(officeAnswer.computedAt))
    expect(portal.whole).toEqual(officeAnswer.view.whole)
    await setShared(false)
    forgetProgress()
  })
})
// ── end B-SA-030 ──

// B-PR-14: the progress read asks the customer's share level (PROGRESS or more). B-PR-40: the record says the level itself (the
// old progressShared switch is dropped from the database and from every answer).
describe('production progress by the share level (B-PR-14)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const setLevel = (level: 'STATUS' | 'PROGRESS' | 'GATES' | 'QUALITY') => admin('UPDATE "PortalSettings" SET "productionLevel" = $2::"ProductionShareLevel", version = version + 1 WHERE "partyId" = $1', [P1, level])

  it('shows the progress from PROGRESS on (GATES and QUALITY too), not at STATUS; the record says the level, no answer says progressShared', async () => {
    const so2 = await orderId('SEED-SO-0002')
    await setLevel('GATES')
    expect((await browsers.buyer.get(`/portal/sales-orders/${so2}/progress`)).status).toBe(200)
    const record = await ok(browsers.buyer, `/portal/sales-orders/${so2}`)
    expect(record.productionLevel).toBe('GATES')
    expect(record).not.toHaveProperty('progressShared')
    const list = await ok(browsers.buyer, '/portal/sales-orders?limit=5&progress=true')
    expect(list).not.toHaveProperty('progressShared')
    expect(list.items.find((row: Json) => row.id === so2).progressPercent).not.toBeNull()
    await setLevel('QUALITY')
    expect((await browsers.buyer.get(`/portal/sales-orders/${so2}/progress`)).status).toBe(200)
    await setLevel('STATUS')
    expect((await browsers.buyer.get(`/portal/sales-orders/${so2}/progress`)).status).toBe(404)
    expect((await ok(browsers.buyer, `/portal/sales-orders/${so2}`)).productionLevel).toBe('STATUS')
    // B-PR-40: the database holds the level alone (the old switch's column is dropped).
    expect(await admin(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'PortalSettings' AND column_name = 'progressShared'`)).toEqual([{ n: 0 }])
    // Another customer's level never opens this customer's order.
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
    // cw-fx9: the freight cost is looked for in what the customer reads — a time such as "…:18.507Z" is no amount (testing/readable).
    expect(readableText(answer)).not.toMatch(/freight|internalNote|createdById|18\.50/)
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
    // fix-portal-numbers-1 (B-TH-303): its order by the customer's own number, never the office's series.
    expect(transit.items[0].order).toEqual({ id: await orderId('SEED-SO-0002'), customerRef: 'SEED-PO-78', yourNumber: { seq: expect.any(Number), words: expect.any(Object) } })
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
    expect(list.items.find((row: Json) => row.id === so2).nextShipment).toMatchObject({ number: null, parcel: 1, expectedDeliveryAt: eta }) // pg-s1 S1.3 (D6)
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

// ---- B-OP-031 (order page plan N5): the number typed for a carrier booked by hand, on the customer's own shipments only ------------
describe('B-OP-031: the customer sees the number typed for a carrier booked by hand ("No live tracking")', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('its own shipment carries the typed number (the labelled one none); "On the way" too; another customer sees nothing of it', async () => {
    const so3 = await orderId('SEED-SO-0003')
    const sh2 = await one<{ id: string }>('SELECT id FROM "Shipment" WHERE "tenantId" = $1 AND number = $2', [T, 'SEED-SH-0002'])
    // SEED-SH-0002 left with a carrier booked by hand, its number typed (written around the guards: the read is what is tested).
    await admin('SET session_replication_role = replica')
    try {
      await admin(`UPDATE "Shipment" SET status = 'SHIPPED', "packedAt" = now() - interval '1 day', "shippedAt" = now() - interval '1 day', "manualTrackingNumber" = 'T-OP031-BRT-0001' WHERE id = $1`, [sh2.id])
    } finally {
      await admin('SET session_replication_role = DEFAULT')
    }
    const own = await ok(browsers.buyer, `/portal/sales-orders/${so3}/shipments`)
    expect(own.shipments).toEqual([expect.objectContaining({ number: 'SEED-SH-0002', typedTrackingNumber: 'T-OP031-BRT-0001' })])
    const so2 = await ok(browsers.viewer, `/portal/sales-orders/${await orderId('SEED-SO-0002')}/shipments`)
    expect(so2.shipments[0]).toMatchObject({ number: 'SEED-SH-0001', typedTrackingNumber: null })
    const transit = await ok(browsers.buyer, '/portal/sales-orders/in-transit')
    expect(transit.items.find((row: Json) => row.number === 'SEED-SH-0002')).toMatchObject({ typedTrackingNumber: 'T-OP031-BRT-0001' })
    expect(transit.items.find((row: Json) => row.number === 'SEED-SH-0001')).toMatchObject({ typedTrackingNumber: null })
    // The wall: another customer finds neither the order nor the number.
    expect((await browsers.other.get(`/portal/sales-orders/${so3}/shipments`)).status).toBe(404)
    const theirs = await ok(browsers.other, '/portal/sales-orders/in-transit')
    expect(theirs.items).toEqual([])
    expect(JSON.stringify(theirs)).not.toContain('T-OP031')
  })

  // B-OP-034 (set C): the tracking link typed beside it — "Track ›" in the portal, https only; another customer never.
  it('B-OP-034: its typed tracking link shows beside the number (order and On the way); another customer sees none', async () => {
    const so3 = await orderId('SEED-SO-0003')
    const sh2 = await one<{ id: string }>('SELECT id FROM "Shipment" WHERE "tenantId" = $1 AND number = $2', [T, 'SEED-SH-0002'])
    await admin('SET session_replication_role = replica')
    try {
      await admin(`UPDATE "Shipment" SET "manualTrackingNumber" = 'T-OP031-BRT-0001', "manualTrackingUrl" = 'https://track.example.com/T-OP031-BRT-0001' WHERE id = $1`, [sh2.id])
    } finally {
      await admin('SET session_replication_role = DEFAULT')
    }
    const own = await ok(browsers.buyer, `/portal/sales-orders/${so3}/shipments`)
    expect(own.shipments.find((row: Json) => row.number === 'SEED-SH-0002')).toMatchObject({ typedTrackingNumber: 'T-OP031-BRT-0001', typedTrackingUrl: 'https://track.example.com/T-OP031-BRT-0001' })
    const transit = await ok(browsers.buyer, '/portal/sales-orders/in-transit')
    expect(transit.items.find((row: Json) => row.number === 'SEED-SH-0002')).toMatchObject({ typedTrackingUrl: 'https://track.example.com/T-OP031-BRT-0001' })
    expect(JSON.stringify(await ok(browsers.other, '/portal/sales-orders/in-transit'))).not.toContain('track.example.com')
  })
})
// ---- end B-OP-031

// ---- B-OP-044 (order page N6, lines-derived): a shared shipment on every order it carries, naming only the customer's own orders.
// One garment of SEED-SO-0003 is put on SEED-SH-0001 (SEED-SO-0002's) past the guards (the API refuses it until B-OP-047).
describe('B-OP-044: a shared shipment in the portal', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const lineId = newId()
  const forced = async (sql: string, values: unknown[] = []) => {
    await admin('SET session_replication_role = replica')
    try {
      await admin(sql, values)
    } finally {
      await admin('SET session_replication_role = DEFAULT')
    }
  }

  it("shows on both orders: each its own lines, and \"also N pieces of your order #12\" for the other; another customer gets 404", async () => {
    await forced(`INSERT INTO "ShipmentLine" (id, "tenantId", "siteId", "partyId", "shipmentId", "workOrderId", "workOrderSizeId", "salesOrderLineId", size, quantity)
       SELECT $1, c."tenantId", c."siteId", s."partyId", s.id, c."workOrderId", c.id, c."salesOrderLineId", c.size, 1
         FROM "WorkOrderSize" c JOIN "SalesOrderLine" l ON l.id = c."salesOrderLineId" JOIN "SalesOrder" o ON o.id = l."orderId", "Shipment" s
        WHERE o."tenantId" = $2 AND o.number = 'SEED-SO-0003' AND s."tenantId" = $2 AND s.number = 'SEED-SH-0001' LIMIT 1`, [lineId, T])
    try {
      const so2 = await orderId('SEED-SO-0002')
      const so3 = await orderId('SEED-SO-0003')
      const seqOf = async (id: string) => (await one<{ customerSeq: number | null }>('SELECT "customerSeq" FROM "SalesOrder" WHERE id = $1', [id])).customerSeq
      const second = (await ok(browsers.buyer, `/portal/sales-orders/${so3}/shipments`)).shipments.find((row: Json) => row.number === 'SEED-SH-0001')
      expect(second).toBeDefined()
      expect(second.lines.map((line: Json) => line.quantity)).toEqual([1])
      expect(second.otherOrders).toEqual([{ yourNumber: (await seqOf(so2)) === null ? null : expect.objectContaining({ seq: await seqOf(so2) }), customerRef: 'SEED-PO-78', pieces: 2 }])
      const first = (await ok(browsers.viewer, `/portal/sales-orders/${so2}/shipments`)).shipments.find((row: Json) => row.number === 'SEED-SH-0001')
      expect(first.lines.map((line: Json) => [line.colourway?.code, line.size, line.quantity]).sort()).toEqual([
        ['BLK', '50', 1],
        ['RED', '52', 1],
      ])
      expect(first.otherOrders).toEqual([expect.objectContaining({ pieces: 1 })])
      // Never the office's SO-… numbers.
      expect(JSON.stringify([first, second])).not.toMatch(/SEED-SO-000/)
      // Another customer finds neither order.
      expect((await browsers.other.get(`/portal/sales-orders/${so3}/shipments`)).status).toBe(404)
      expect((await browsers.other.get(`/portal/sales-orders/${so2}/shipments`)).status).toBe(404)
    } finally {
      await forced('DELETE FROM "ShipmentLine" WHERE id = $1', [lineId])
    }
  })
})
// ---- end B-OP-044

// ---- B-OS-006 (order shipments tab; X2-B1): a TEST label's number never reaches the customer. SEED-SH-0001's second parcel is given
// a TEST label (test mode) past the guards: the read is what is tested.
describe('B-OS-006: a TEST label is never shown to the customer', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('its parcel is listed untracked (no number, no link); On the way lists the carrier labels only', async () => {
    const so2 = await orderId('SEED-SO-0002')
    const shipment = await one<{ id: string }>('SELECT id FROM "Shipment" WHERE "tenantId" = $1 AND number = $2', [T, 'SEED-SH-0001'])
    const parcels = await admin<{ id: string; seq: number; trackingNumber: string; carrierParcelId: string | null }>('SELECT id, seq, "trackingNumber", "carrierParcelId" FROM "Parcel" WHERE "shipmentId" = $1 ORDER BY seq', [shipment.id])
    const [real, test] = [parcels[0]!, parcels[1]!]
    const relabel = async (providerId: string | null, number: string) => {
      await admin('SET session_replication_role = replica')
      try {
        await admin('UPDATE "Parcel" SET "carrierParcelId" = $2, "trackingNumber" = $3 WHERE id = $1', [test.id, providerId, number])
      } finally {
        await admin('SET session_replication_role = DEFAULT')
      }
    }
    await relabel('test:os-006-parcel-2', 'TEST-OS006-0002')
    try {
      const answer = await ok(browsers.viewer, `/portal/sales-orders/${so2}/shipments`)
      const row = (answer.shipments as Json[]).find((entry) => entry.number === 'SEED-SH-0001')!
      expect(row.parcels).toHaveLength(2)
      expect((row.parcels as Json[]).find((parcel) => parcel.seq === test.seq)).toMatchObject({ trackingNumber: null, trackingLink: null })
      expect((row.parcels as Json[]).find((parcel) => parcel.seq === real.seq)).toMatchObject({ trackingNumber: real.trackingNumber })
      expect(JSON.stringify(answer)).not.toContain('TEST-OS006')
      const transit = await ok(browsers.buyer, '/portal/sales-orders/in-transit')
      const item = (transit.items as Json[]).find((entry) => entry.number === 'SEED-SH-0001')!
      expect(item.trackingNumbers).toEqual([real.trackingNumber])
      expect((item.trackingLinks as Json[]).map((link) => link.trackingNumber)).not.toContain('TEST-OS006-0002')
      expect(JSON.stringify(transit)).not.toContain('TEST-OS006')
    } finally {
      await relabel(test.carrierParcelId, test.trackingNumber)
    }
  })
})
// ---- end B-OS-006

// ---- B-OS-022 (order shipments 1/1; Owner D4): a parcel's number typed by hand reaches its own customer's portal (the order's
// shipments and On the way), never another customer's. SEED-SH-0002 (left with a carrier booked by hand, B-OP-031 above) gets its
// parcel's number typed past the guards: the read is what is tested.
describe('B-OS-022: a parcel number typed by hand in the portal', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("A's buyer reads it with its typed link on the parcel and On the way; B's buyer never", async () => {
    const so3 = await orderId('SEED-SO-0003')
    const sh2 = await one<{ id: string }>('SELECT id FROM "Shipment" WHERE "tenantId" = $1 AND number = $2', [T, 'SEED-SH-0002'])
    const type = async (number: string | null, url: string | null) => {
      await admin('SET session_replication_role = replica')
      try {
        await admin('UPDATE "Parcel" SET "manualTrackingNumber" = $2, "manualTrackingUrl" = $3 WHERE "shipmentId" = $1 AND seq = 1', [sh2.id, number, url])
      } finally {
        await admin('SET session_replication_role = DEFAULT')
      }
    }
    await type('AWB-OS022-P001', 'https://track.example.com/AWB-OS022-P001')
    try {
      const own = await ok(browsers.buyer, `/portal/sales-orders/${so3}/shipments`)
      const row = (own.shipments as Json[]).find((entry) => entry.number === 'SEED-SH-0002')!
      expect((row.parcels as Json[]).find((parcel) => parcel.seq === 1)).toMatchObject({ trackingNumber: 'AWB-OS022-P001', trackingLink: { url: 'https://track.example.com/AWB-OS022-P001' } })
      const transit = await ok(browsers.buyer, '/portal/sales-orders/in-transit')
      const item = (transit.items as Json[]).find((entry) => entry.number === 'SEED-SH-0002')!
      expect(item.trackingNumbers).toContain('AWB-OS022-P001')
      expect((item.trackingLinks as Json[]).map((link) => link.trackingNumber)).toContain('AWB-OS022-P001')
      // The wall: another customer finds neither the order nor the number.
      expect((await browsers.other.get(`/portal/sales-orders/${so3}/shipments`)).status).toBe(404)
      expect(JSON.stringify(await ok(browsers.other, '/portal/sales-orders/in-transit'))).not.toContain('AWB-OS022')
      // Another customer's scope reads no row of these parcels at all (row-level security), so none of their typed numbers.
      const read = (partyId: string) => h.database.withScope({ audience: 'partner', tenantId: T, actorId: newId(), partyId }, (client) => client.parcel.findMany({ where: { shipmentId: sh2.id }, select: { manualTrackingNumber: true } }))
      expect(await read(newId())).toEqual([])
    } finally {
      await type(null, null)
    }
  })
})
// ---- end B-OS-022

// ---- B-OF-005 (order files tab, PR S3.2; P2-B1): a priced file is not named to a customer person who does not see prices ----------
describe('B-OF-005: the order’s files in the portal leave a priced file out for a person without prices', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('the viewer does not get the priced proforma’s name (left out, uncounted); the buyer does', async () => {
    const so2 = await orderId('SEED-SO-0002')
    // of-fx4s: this world (the seeds up to shipping) holds no stored file and no file store; the files seed adds both (on company,
    // plant and tenant records: SO-0002 gains none). The planted proforma is a copy of its file of P1 (company A, AVAILABLE).
    await seedFiles({ db: h.database, namespace: NS })
    const source = await one<{ id: string }>(`SELECT id FROM "StoredFile" WHERE id = $1 AND status = 'AVAILABLE' AND "partyId" = $2`, [seedUuid(NS, 'files:partner:P1'), P1])
    expect(source, 'the files seed’s portal file of P1').toBeDefined()
    const id = newId()
    const changes = { id, companyId: companyA, recordType: 'SalesOrder', recordId: so2, kind: 'DOCUMENT', contentType: 'application/pdf', originalName: 'T-OF005 proforma with prices.pdf', visibility: ['OFFICE', 'PARTNER'], partyId: P1, floorSiteId: null, priced: true, seriesId: null, versionNo: 1, sourceFileId: null, thumbnailKey: null, exifStrippedAt: null, category: null, storageKey: `t/${T}/c/${companyA}/2026/${newId()}` }
    await admin('BEGIN')
    try {
      await admin("SET LOCAL session_replication_role = 'replica'")
      await admin(`INSERT INTO "StoredFile" SELECT * FROM jsonb_populate_record(NULL::"StoredFile", (SELECT to_jsonb(f) || $1::jsonb FROM "StoredFile" f WHERE f.id = $2::uuid))`, [JSON.stringify(changes), source!.id])
      await admin('COMMIT')
    } catch (error) {
      await admin('ROLLBACK')
      throw error
    }
    expect(JSON.stringify(await ok(browsers.viewer, `/portal/sales-orders/${so2}/files`))).not.toContain('T-OF005 proforma with prices.pdf')
    expect(JSON.stringify(await ok(browsers.buyer, `/portal/sales-orders/${so2}/files`))).toContain('T-OF005 proforma with prices.pdf')
    // of-fx6s: the name reached the viewer through the customer-documents library (a plain document is of the group OTHER, which
    // has no price rule), which the order's Files read too — the Documents page itself leaves it out for the viewer, lists it for the buyer.
    expect(JSON.stringify(await ok(browsers.viewer, '/portal/customer-documents?versions=all'))).not.toContain('T-OF005 proforma with prices.pdf')
    expect(JSON.stringify(await ok(browsers.buyer, '/portal/customer-documents?versions=all'))).toContain('T-OF005 proforma with prices.pdf')
  })
})
// ---- end B-OF-005
