import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { CarrierCall, CarrierLabel } from '@nexus/factory-domain/ports/carrier'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedReturns } from '../../../../../../packages/factory-db/seed/returns'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { textOf } from '../../../adapters/ses/fake'
import { FakeSendcloud } from '../../../adapters/sendcloud/fake'
import { callerFor, command } from '../../../core/command'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { createGateway } from '../../../platform/gateway/gateway'
import { fanOut } from '../../../platform/notifications/fan-out'
import { systemContext } from '../../../platform/outbox/system'
import { SECRET_PURPOSES, storeSecret } from '../../../platform/secrets/store'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { followOrder } from '../../sales/orders/moves'
import { runDeliveryCheck, trackingProblemsHandler } from '../exceptions/check'
import { createCarrierRuntime, useCarrier, type CarrierRuntime } from '../labels/carrier'
import { pollShipment } from '../labels/poll'
import { customerNoticeHandler } from '../notices/handler'
import { returnLabelsUsedHandler } from '../return-labels/used'
import { trackingLinkHandler } from '../tracking-link/handler'
import { carrierPodHandler } from './handler'

/**
 * Delivery and return labels (B-W2b-398; LOG-061, LOG-063, LOG-065, LOG-067, LOG-112; TK1:01) on the local stack: a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security, the grants, B-W2b-372's
 * …_delivery_customs_w2b_guards real), the factory-db seeds of one tenant up to returns (SH-0001 of SO-0002, SEED-RMA-0001), real
 * office sign-in, the real link authenticator, the gateway (Redis limits, the call ledger), FAKE SES, the local file store and the
 * FAKE Sendcloud. The worker's handlers run in the test with the tenant's system caller. Every name and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/shipping/pod`.
 *
 *   notice      the customer notice goes by itself only with the site's switch on, once; never for a TEST label (nor the
 *               tracking link mail); Send again by hand
 *   problems    the daily check raises NO_SCAN with its task and tells the dispatch desk; a carrier exception raises an address
 *               problem; resolved once; a TEST-labelled shipment raises nothing
 *   delivery    the carrier delivers: the shipment DELIVERED, its problems resolved by themselves, the carrier's proof (signer,
 *               time, image) stored once; the order DELIVERED with its time and the on-delivery step's due day
 *   returns     a label booked now (the addresses swapped, a file of the return); refused in test mode; a link offered and
 *               booked by the customer, downloaded; withdrawn; USED when the goods reach the dock
 */

let h: Harness
let fake: FakeSendcloud
let carrier: CarrierRuntime
const NS = 'delivery-returns-a'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const siteA1 = seedUuid(NS, 'site:A1')
const tenant: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
const BUYER_MAIL = 'buyer.p1@example.com'
const HOUR = 3_600_000
const DAY = 24 * HOUR

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const asReplica = async (work: () => Promise<unknown>) => {
  await admin('SET session_replication_role = replica')
  try {
    await work()
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
const system = () => callerFor(h.database, systemContext(T, newId()))
const handle = (handler: { handle: (event: never, tools: never) => Promise<void> }, type: string, payload: Json) =>
  handler.handle({ eventId: newId(), type, version: 1, tenantId: T, payload } as never, { caller: system(), attempt: 1 } as never)
const notices = (to = BUYER_MAIL) => h.ses.mails.filter((mail) => mail.templateKey === 'shipping.customer_notice' && mail.to.includes(to))

let keys = 0
const key = () => `w2b398-${process.pid}-${++keys}-${Date.now()}`
const linkCall = (token: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  h.app.inject({ method, url, headers: { 'x-factory-link': token, 'user-agent': 'DemoPhone/1.0', ...(method === 'POST' ? { 'idempotency-key': key() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
const tokenOf = (url: string): string => decodeURIComponent(url.split('#token=')[1] ?? '')

let desk: Browser
let viewer: Browser
const post = (browser: Browser, url: string, body: unknown = {}) => browser.post(url, body, { headers: { 'idempotency-key': key() } })
async function put(browser: Browser, url: string, body: unknown) {
  const cookie = [...browser.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  const response = await h.app.inject({ method: 'PUT', url, headers: { cookie, 'x-csrf-token': browser.csrfToken ?? '', 'idempotency-key': key() }, payload: body as object })
  return { status: response.statusCode, body: response.json() as Json }
}

async function officeBrowser(email: string, role: string): Promise<Browser> {
  await addUser(h, tenant, { email, role })
  const browser = new Browser(h.app)
  const signed = await browser.signIn(NS, email, 'quiet-harbour-lantern-58')
  expect(signed.status, JSON.stringify(signed.body)).toBe(200)
  return browser
}

const fakeCall = (accountId: string): CarrierCall => ({
  account: { id: accountId, provider: 'SENDCLOUD', mode: 'FAKE' } as CarrierCall['account'],
  attempt: 1,
  signal: new AbortController().signal,
  idempotencyKey: null,
  credentials: async () => null,
  answer: () => undefined,
})

let accountId: string
let SH1: string
let SO2: string
let RMA1: string
const labels: CarrierLabel[] = []

/** A shipment of SO-0002 that left 4 days ago with labels of the FAKE carrier (its times moved into the past: the seeds' are in late November). */
async function setUpTravelling() {
  for (const [index, parcelId] of (await admin<{ id: string }>(`SELECT id FROM "Parcel" WHERE "shipmentId" = $1 ORDER BY seq`, [SH1])).map((row) => row.id).entries()) {
    const label = await fake.createLabel(fakeCall(accountId), {
      shipmentNumber: 'SEED-SH-0001',
      seq: index + 1,
      parcels: 2,
      externalReference: `w2b398-${parcelId}`,
      from: { name: 'Demo Factory', companyName: null, line1: 'Via dei Campioni 1', line2: null, postalCode: '61100', city: 'Pesaro', province: null, country: 'IT', phone: null, email: null },
      to: { name: 'Demo Shop', companyName: null, line1: 'Via Demo 2', line2: null, postalCode: '40121', city: 'Bologna', province: null, country: 'IT', phone: null, email: null },
      carrierCode: 'brt',
      serviceCode: 'brt:standard',
      weightKg: '2',
      lengthCm: null,
      widthCm: null,
      heightCm: null,
    })
    labels.push(label)
    await asReplica(() => admin(`UPDATE "Parcel" SET "carrierParcelId" = $1, "trackingNumber" = $2, "trackingUrl" = $3, "labelledAt" = now() - interval '5 days' WHERE id = $4`, [label.providerId, label.trackingNumber, label.trackingUrl, parcelId]))
  }
  await asReplica(async () => {
    await admin(`UPDATE "Shipment" SET "integrationAccountId" = $1, "packedAt" = now() - interval '5 days', "shippedAt" = now() - interval '4 days', "expectedDeliveryAt" = NULL WHERE id = $2`, [accountId, SH1])
    await admin(`UPDATE "TrackingEvent" SET "occurredAt" = now() - interval '4 days', "recordedAt" = now() - interval '4 days' WHERE "shipmentId" = $1`, [SH1])
    // SO-0002 shipped in full by SH-0001 (its other sizes taken out: made-up facts the seeds do not have), with a step due on delivery.
    await admin(`DELETE FROM "SalesOrderLineSize" z USING "SalesOrderLine" l WHERE z."lineId" = l.id AND l."orderId" = $1 AND NOT ((l.seq = 10 AND z.size = '50') OR (l.seq = 20 AND z.size = '52'))`, [SO2])
    await admin(`UPDATE "SalesOrderLineSize" z SET quantity = 1 FROM "SalesOrderLine" l WHERE z."lineId" = l.id AND l."orderId" = $1`, [SO2])
    await admin(`UPDATE "SalesOrderLine" SET quantity = 1 WHERE "orderId" = $1`, [SO2])
    await admin(`UPDATE "SalesOrder" SET status = 'SHIPPED' WHERE id = $1`, [SO2])
  })
  await admin(`INSERT INTO "SalesOrderMilestone" (id, "tenantId", "companyId", "orderId", "partyId", seq, kind, amount, status) SELECT $1, "tenantId", "companyId", id, "partyId", 20, 'ON_DELIVERY', 12345, 'OPEN' FROM "SalesOrder" WHERE id = $2`, [newId(), SO2])
}

beforeAll(async () => {
  h = await startHarness('delivery_returns')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  const seeded = await seedReturns({ db: h.database, namespace: NS })
  SH1 = seeded.money.shipping.shipmentId
  RMA1 = seeded.waitingReturnId
  SO2 = (await one<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0002'`, [T])).id
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    const sesId = newId()
    await client.integrationAccount.create({ data: { id: sesId, provider: 'SES', code: 'ses-398', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    for (const kind of ['NOTIFICATION', 'CONVERSATION'] as const) {
      await client.emailIdentity.create({
        data: { id: newId(), companyId: companyA, kind, domain, fromAddress: `${kind.toLowerCase()}@${domain}`, displayName: 'Demo A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId: sesId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
      })
    }
  })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  accountId = newId()
  await command(callerFor(h.database, { audience: 'office', tenantId: T, actorId: newId(), grants: [], requestId: newId() }), { name: 'integration.createAccount', input: { id: accountId } }, async (tools) => {
    const webhook = await storeSecret(tools, h.secrets, { purpose: SECRET_PURPOSES.webhook, plaintext: 'made-up-delivery-returns-webhook-secret' })
    await tools.tx.integrationAccount.create({ data: { id: accountId, companyId: companyA, provider: 'SENDCLOUD', code: 'sc-398', label: 'Sendcloud (made-up test)', mode: 'FAKE', webhookSecretId: webhook.id, rateLimitPerMinute: 6000, rateLimitBurst: 1000 }, select: { id: true } })
    tools.audit({ recordType: 'IntegrationAccount', recordId: accountId })
    return { id: accountId }
  })
  // The fake carrier made its labels five days ago (its own clock), so every event the test plays is newer than the label's.
  fake = new FakeSendcloud({ now: () => new Date(h.clock.now().getTime() - 5 * DAY) })
  const gateway = createGateway({ environment: 'test', redis: h.redis, prefix: h.redisPrefix, secrets: h.secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  carrier = createCarrierRuntime({ gateway, environment: 'test', fake })
  useCarrier(carrier)
  // Site A1 makes live labels (as the golden scenario sets it), with its customer notice OFF (the default).
  await admin(`UPDATE "ShippingSettings" SET "testMode" = false, "liveSince" = now() - interval '30 days', "liveSetById" = $1, "integrationAccountId" = $2, "defaultServiceCode" = 'brt:standard', "defaultCarrierCode" = 'brt' WHERE id = $3`, [actorId, accountId, siteA1])
  await setUpTravelling()
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, "requireMfa") VALUES ($1, $2, 'desk-398', 'Dispatch and returns desk (test)', $3, false), ($4, $2, 'viewer-398', 'Viewer (test)', $5, false)`, [
    newId(),
    T,
    ['home.view', 'shipping.view', 'shipping.manage', 'sales.returns.view', 'sales.returns.manage', 'orders.view', 'files.read'],
    newId(),
    ['home.view', 'shipping.view', 'sales.returns.view', 'orders.view'],
  ])
  desk = await officeBrowser('dora.desk.398@example.com', 'desk-398')
  viewer = await officeBrowser('vic.viewer.398@example.com', 'viewer-398')
}, 300_000)

afterAll(async () => {
  useCarrier(undefined)
  await h?.close()
}, 60_000)

describe('the shipping notice to the customer (LOG-061)', () => {
  it('goes by itself only with the site switch on, once, in the customer language with the tracking numbers', async () => {
    await handle(customerNoticeHandler({ clock: h.clock }), 'shipment.status_changed', { shipmentId: SH1, number: 'SEED-SH-0001', from: 'PACKED', to: 'SHIPPED' })
    expect(notices()).toHaveLength(0)
    const off = await desk.get(`/shipping/shipments/${SH1}/notice`)
    expect(off.status).toBe(200)
    expect(off.body).toMatchObject({ switchOn: false, automaticHeld: 'SWITCH_OFF', sendHeld: null, mayManage: true, mails: [] })

    await admin(`UPDATE "ShippingSettings" SET "customerNoticeOn" = true WHERE id = $1`, [siteA1])
    await handle(customerNoticeHandler({ clock: h.clock }), 'shipment.status_changed', { shipmentId: SH1, number: 'SEED-SH-0001', from: 'PACKED', to: 'SHIPPED' })
    expect(notices()).toHaveLength(1)
    const text = textOf(notices()[0]!.raw)
    expect(text).toContain(labels[0]!.trackingNumber)
    expect(text).toContain(labels[1]!.trackingNumber)
    // A second event sends nothing again.
    await handle(customerNoticeHandler({ clock: h.clock }), 'shipment.status_changed', { shipmentId: SH1, number: 'SEED-SH-0001', from: 'PACKED', to: 'SHIPPED' })
    expect(notices()).toHaveLength(1)
    const read = await desk.get(`/shipping/shipments/${SH1}/notice`)
    expect(read.body.mails).toHaveLength(1)
    expect(read.body.mails[0]).toMatchObject({ to: [BUYER_MAIL], automatic: true })
  }, SLOW_TEST_TIMEOUT_MS)

  it('Send again by hand (shipping.manage); a viewer is refused', async () => {
    const again = await post(desk, `/shipping/shipments/${SH1}/notice`)
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body.sent).toBe(1)
    expect(notices()).toHaveLength(2)
    expect((await post(viewer, `/shipping/shipments/${SH1}/notice`)).status).toBe(403)
  }, SLOW_TEST_TIMEOUT_MS)

  it('never gives a customer a TEST tracking number: notice and tracking link held for a TEST-labelled shipment', async () => {
    const parcel = (await one<{ id: string; carrierParcelId: string; trackingNumber: string }>(`SELECT id, "carrierParcelId", "trackingNumber" FROM "Parcel" WHERE "shipmentId" = $1 ORDER BY seq LIMIT 1`, [SH1]))
    await asReplica(() => admin(`UPDATE "Parcel" SET "carrierParcelId" = 'test:' || id || '.v1', "trackingNumber" = 'TEST-0a1b2c3d4e-1' WHERE id = $1`, [parcel.id]))
    try {
      const refused = await post(desk, `/shipping/shipments/${SH1}/notice`)
      expect(refused.status).toBe(409)
      expect(refused.body.error.issues[0].path).toBe('refusal/TEST_LABELS')
      expect((await desk.get(`/shipping/shipments/${SH1}/notice`)).body.sendHeld).toBe('TEST_LABELS')
      const before = h.ses.mails.length
      await handle(trackingLinkHandler({ clock: h.clock }), 'shipment.status_changed', { shipmentId: SH1, number: 'SEED-SH-0001', from: 'PACKED', to: 'SHIPPED' })
      expect(h.ses.mails.length).toBe(before)
      // The daily check raises nothing for it either (no carrier ever had it).
      const run = await runDeliveryCheck({ database: h.database, log: { info() {}, warn() {}, error() {} } as never, clock: h.clock })
      expect(run.raised).toBe(0)
    } finally {
      await asReplica(() => admin(`UPDATE "Parcel" SET "carrierParcelId" = $1, "trackingNumber" = $2 WHERE id = $3`, [parcel.carrierParcelId, parcel.trackingNumber, parcel.id]))
    }
  }, SLOW_TEST_TIMEOUT_MS)
})

describe('tracking problems (LOG-063)', () => {
  it('the daily check raises NO_SCAN after 3 days without carrier news, with its task, and tells the dispatch desk', async () => {
    const run = await runDeliveryCheck({ database: h.database, log: { info() {}, warn() {}, error() {} } as never, clock: h.clock })
    expect(run.raised).toBe(1)
    const row = await one(`SELECT id, kind, "taskId", "resolvedAt" FROM "TrackingException" WHERE "shipmentId" = $1`, [SH1])
    expect(row).toMatchObject({ kind: 'NO_SCAN', resolvedAt: null })
    expect(await one(`SELECT "recordType", "recordId", status FROM "Task" WHERE id = $1`, [row.taskId])).toMatchObject({ recordType: 'Shipment', recordId: SH1, status: 'OPEN' })
    // Again the same day: nothing more.
    expect((await runDeliveryCheck({ database: h.database, log: { info() {}, warn() {}, error() {} } as never, clock: h.clock })).raised).toBe(0)
    const raised = await one<{ id: string; type: string }>(`SELECT id, type FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'shipment.tracking_problem_raised' ORDER BY "occurredAt" DESC LIMIT 1`, [T])
    await fanOut(system(), { eventId: raised.id, type: raised.type, payload: { shipmentId: SH1, number: 'SEED-SH-0001', exceptionId: row.id, kind: 'NO_SCAN', taskId: row.taskId } } as never)
    const told = await admin(`SELECT n."messageKey" FROM "Notification" n JOIN "User" u ON u.id = n."userId" WHERE u.email = 'dora.desk.398@example.com' AND n."messageKey" = 'notifications.shipping.noScan'`)
    expect(told).toHaveLength(1)
    expect(await admin(`SELECT 1 FROM "Notification" n JOIN "User" u ON u.id = n."userId" WHERE u.email = 'vic.viewer.398@example.com' AND n."messageKey" LIKE 'notifications.shipping.%'`)).toHaveLength(0)
  }, SLOW_TEST_TIMEOUT_MS)

  it('a carrier exception raises an address problem; resolved once by a person', async () => {
    fake.advance(labels[0]!.trackingNumber, 'IN_TRANSIT', 'made-up-delivery-returns-webhook-secret', new Date(h.clock.now().getTime() - 3 * HOUR))
    fake.advance(labels[0]!.trackingNumber, 'EXCEPTION', 'made-up-delivery-returns-webhook-secret', new Date(h.clock.now().getTime() - 2 * HOUR))
    await admin(`UPDATE "Parcel" SET "labelledAt" = "labelledAt" WHERE "shipmentId" = $1`, [SH1])
    const polled = await pollShipment(carrier, system(), SH1)
    expect(polled.recorded).toBeGreaterThan(0)
    await handle(trackingProblemsHandler(), 'shipment.tracking_recorded', { shipmentId: SH1, number: 'SEED-SH-0001', events: polled.recorded, status: 'EXCEPTION', source: 'POLL' })
    const list = await desk.get(`/shipping/shipments/${SH1}/tracking-problems`)
    expect(list.status).toBe(200)
    const address = (list.body.problems as Json[]).find((problem) => problem.kind === 'ADDRESS_PROBLEM')!
    expect(address).toMatchObject({ resolvedAt: null, raisedBySystem: true, taskStatus: 'OPEN' })
    // The carrier's expected day (moved a day by the failed attempt) passed too: DELAYED beside it.
    expect((await desk.get('/shipping/tracking-problems')).body.problems.map((problem: Json) => problem.kind).sort()).toEqual(['ADDRESS_PROBLEM', 'DELAYED', 'NO_SCAN'])
    expect((await post(viewer, `/shipping/shipments/${SH1}/tracking-problems/${address.id}/resolve`, { note: 'Called the carrier.' })).status).toBe(403)
    const done = await post(desk, `/shipping/shipments/${SH1}/tracking-problems/${address.id}/resolve`, { note: 'Called the carrier: the address was corrected.' })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    // Its task is done with it, by that person.
    expect((done.body.problems as Json[]).find((problem) => problem.id === address.id)).toMatchObject({ resolvedAt: expect.any(String), taskStatus: 'DONE' })
    const again = await post(desk, `/shipping/shipments/${SH1}/tracking-problems/${address.id}/resolve`, {})
    expect(again.status).toBe(409)
    expect(again.body.error.issues[0].path).toBe('refusal/RESOLVED')
  }, SLOW_TEST_TIMEOUT_MS)
})

describe('delivered (LOG-065, LOG-067)', () => {
  it('the carrier delivers: the shipment DELIVERED, its problems resolved by themselves, the proof stored once', async () => {
    const at = h.clock.now().getTime() - HOUR
    for (const label of labels) fake.advance(label.trackingNumber, 'DELIVERED', 'made-up-delivery-returns-webhook-secret', new Date(at))
    const polled = await pollShipment(carrier, system(), SH1)
    expect(polled.moved).toBe('DELIVERED')
    await handle(trackingProblemsHandler(), 'shipment.status_changed', { shipmentId: SH1, number: 'SEED-SH-0001', from: 'SHIPPED', to: 'DELIVERED' })
    expect(await admin(`SELECT 1 FROM "TrackingException" WHERE "shipmentId" = $1 AND "resolvedAt" IS NULL`, [SH1])).toHaveLength(0)
    expect(await admin(`SELECT 1 FROM "Task" t JOIN "TrackingException" e ON e."taskId" = t.id WHERE e."shipmentId" = $1 AND t.status = 'OPEN'`, [SH1])).toHaveLength(0)

    await handle(carrierPodHandler({ carrier: () => carrier, files: () => h.files }), 'shipment.status_changed', { shipmentId: SH1, number: 'SEED-SH-0001', from: 'SHIPPED', to: 'DELIVERED' })
    const pod = await desk.get(`/shipping/shipments/${SH1}/pod`)
    expect(pod.status).toBe(200)
    expect(pod.body).toMatchObject({ deliveredVia: 'CARRIER', carrierAsked: true, recordHeld: 'KEPT', pod: { signedBy: 'FAKE RECIPIENT', file: { contentType: 'application/pdf' } } })
    // Kept as first recorded: a person cannot change it; asking the carrier again changes nothing.
    const changed = await put(desk, `/shipping/shipments/${SH1}/pod`, { signedBy: 'Someone else' })
    expect(changed.status).toBe(409)
    expect(changed.body.error.issues[0].path).toBe('refusal/KEPT')
    await handle(carrierPodHandler({ carrier: () => carrier, files: () => h.files }), 'shipment.status_changed', { shipmentId: SH1, number: 'SEED-SH-0001', from: 'SHIPPED', to: 'DELIVERED' })
    expect(await admin(`SELECT 1 FROM "StoredFile" WHERE "recordType" = 'Shipment' AND "recordId" = $1 AND "originalName" LIKE 'proof-of-delivery-%'`, [SH1])).toHaveLength(1)
    const download = await desk.get(`/shipping/shipments/${SH1}/pod/file`)
    expect(download.status).toBe(200)
    expect(download.body.download.url).toContain('token=')
  }, SLOW_TEST_TIMEOUT_MS)

  it('the order follows: DELIVERED with its time, the on-delivery step gets its due day', async () => {
    const moved = await followOrder(system(), SO2, { what: 'shipment SEED-SH-0001 delivered' })
    expect(moved.moved).toEqual(['DELIVERED'])
    const order = await one<{ status: string; deliveredAt: Date }>(`SELECT status, "deliveredAt" FROM "SalesOrder" WHERE id = $1`, [SO2])
    expect(order.status).toBe('DELIVERED')
    expect(order.deliveredAt).not.toBeNull()
    const step = await one<{ dueDate: Date | null }>(`SELECT "dueDate" FROM "SalesOrderMilestone" WHERE "orderId" = $1 AND kind = 'ON_DELIVERY'`, [SO2])
    expect(step.dueDate).not.toBeNull()
    const read = await viewer.get(`/sales/orders/${SO2}/deliveries`)
    expect(read.status, JSON.stringify(read.body)).toBe(200)
    expect(read.body.order.status).toBe('DELIVERED')
    expect(read.body.shipments[0]).toMatchObject({ number: 'SEED-SH-0001', status: 'DELIVERED', deliveredVia: 'CARRIER', pod: { signedBy: 'FAKE RECIPIENT', image: true }, openProblems: 0, mayOpen: true })
    expect(read.body.steps[0].dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // Nothing more to follow.
    expect((await followOrder(system(), SO2, { what: 'again' })).moved).toEqual([])
  }, SLOW_TEST_TIMEOUT_MS)
})

describe('return labels (LOG-112, TK1:01)', () => {
  it('holds a label while the return names no order, then books one now from the shipment, the addresses swapped', async () => {
    const before = await desk.get(`/sales/returns/${RMA1}/return-labels`)
    expect(before.status).toBe(200)
    expect(before.body.make.held).toBe('NO_SHIPMENT')
    await asReplica(() => admin(`UPDATE "ReturnAuthorisation" SET "salesOrderId" = $1 WHERE id = $2`, [SO2, RMA1]))
    const read = await desk.get(`/sales/returns/${RMA1}/return-labels`)
    expect(read.body.make).toMatchObject({ held: null, shipment: { number: 'SEED-SH-0001' }, carrierCode: 'seed-express' })
    expect((await post(viewer, `/sales/returns/${RMA1}/return-labels`, { mode: 'LABEL' })).status).toBe(403)
    const made = await post(desk, `/sales/returns/${RMA1}/return-labels`, { mode: 'LABEL' })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const label = (made.body.labels.labels as Json[])[0]!
    expect(label).toMatchObject({ status: 'BOOKED', mode: 'LABEL', carrierCode: 'seed-express', bookingReference: expect.stringMatching(/^FK/), link: null })
    // The addresses swapped: from the customer (the shipment's ship-to) back to the site.
    const booking = fake.labelOf(label.bookingReference).request
    const shipTo = await one<{ city: string; postalCode: string }>(`SELECT "shipTo"->>'city' AS city, "shipTo"->>'postalCode' AS "postalCode" FROM "Shipment" WHERE id = $1`, [SH1])
    expect(booking.from).toMatchObject({ city: shipTo.city, postalCode: shipTo.postalCode })
    const site = await one<{ line1: string }>(`SELECT coalesce("returnAddress", "senderAddress")->>'line1' AS line1 FROM "ShippingSettings" WHERE id = $1`, [siteA1])
    expect(booking.to.line1).toBe(site.line1)
    const pdf = await desk.get(`/sales/returns/${RMA1}/return-labels/${label.id}/pdf`)
    expect(pdf.status).toBe(200)
    expect(pdf.response.headers['content-type']).toBe('application/pdf')
  }, SLOW_TEST_TIMEOUT_MS)

  it('never makes a TEST label for a customer: refused while the site is in test mode', async () => {
    const live = await one<{ liveSince: Date; liveSetById: string }>(`SELECT "liveSince", "liveSetById" FROM "ShippingSettings" WHERE id = $1`, [siteA1])
    await admin(`UPDATE "ShippingSettings" SET "testMode" = true, "liveSince" = NULL, "liveSetById" = NULL WHERE id = $1`, [siteA1])
    try {
      const refused = await post(desk, `/sales/returns/${RMA1}/return-labels`, { mode: 'LABEL' })
      expect(refused.status).toBe(409)
      expect(refused.body.error.issues[0].path).toBe('refusal/TEST_MODE')
    } finally {
      await admin(`UPDATE "ShippingSettings" SET "testMode" = false, "liveSince" = $1, "liveSetById" = $2 WHERE id = $3`, [live.liveSince, live.liveSetById, siteA1])
    }
  }, SLOW_TEST_TIMEOUT_MS)

  it('offers a label by link (nothing booked); the customer books it, downloads it; the office withdraws another', async () => {
    const offered = await post(desk, `/sales/returns/${RMA1}/return-labels`, { mode: 'LINK', send: false })
    expect(offered.status, JSON.stringify(offered.body)).toBe(201)
    expect(offered.body.url).toMatch(/#token=/)
    const row = (offered.body.labels.labels as Json[]).find((entry) => entry.mode === 'LINK')!
    expect(row).toMatchObject({ status: 'OFFERED', bookingReference: null, file: null })
    const token = tokenOf(offered.body.url)
    expect((await linkCall(token, 'POST', '/link/open', {})).statusCode).toBe(200)
    const page = await linkCall(token, 'GET', '/link/return-label')
    expect(page.statusCode, page.body).toBe(200)
    expect(page.json()).toMatchObject({ return: { number: 'SEED-RMA-0001' }, label: { status: 'OFFERED', hasPdf: false }, bookHeld: null, from: { city: expect.any(String) }, to: { line1: expect.any(String) } })
    // The customer's own address shows only its town, postcode and country.
    expect(Object.keys(page.json().from).sort()).toEqual(['city', 'country', 'postalCode'])
    expect(JSON.stringify(page.json())).not.toMatch(/"(unitPrice|price|amount|total)"/)
    expect((await linkCall(token, 'POST', '/link/return-label/download', {})).statusCode).toBe(404)
    const booked = await linkCall(token, 'POST', '/link/return-label/book', {})
    expect(booked.statusCode, booked.body).toBe(200)
    expect(booked.json().label).toMatchObject({ status: 'BOOKED', hasPdf: true, bookingReference: expect.stringMatching(/^FK/) })
    // Pressed again: the same label, nothing booked twice.
    const requests = fake.requests.length
    expect((await linkCall(token, 'POST', '/link/return-label/book', {})).json().label.bookingReference).toBe(booked.json().label.bookingReference)
    expect(fake.requests.length).toBe(requests)
    const download = await linkCall(token, 'POST', '/link/return-label/download', {})
    expect(download.statusCode, download.body).toBe(200)
    expect(download.json().download.url).toContain('token=')
    expect(await admin(`SELECT action FROM "LinkEvidence" WHERE "linkId" = (SELECT "linkId" FROM "ReturnLabel" WHERE id = $1) ORDER BY at`, [row.id])).toEqual(expect.arrayContaining([{ action: 'OPENED' }, { action: 'CONFIRMED' }, { action: 'DOWNLOADED' }]))

    // A second link, mailed to the orders contact, then withdrawn: its link opens nothing.
    const mailed = await post(desk, `/sales/returns/${RMA1}/return-labels`, { mode: 'LINK' })
    expect(mailed.status).toBe(201)
    expect(mailed.body.url).toBeNull()
    const sent = h.ses.mails.filter((mail) => mail.templateKey === 'shipping.return_label_link' && mail.to.includes(BUYER_MAIL))
    expect(sent).toHaveLength(1)
    const mailedToken = decodeURIComponent(/#token=(\S+)/.exec(textOf(sent[0]!.raw))![1]!)
    const second = (mailed.body.labels.labels as Json[]).find((entry) => entry.status === 'OFFERED')!
    const withdrawn = await post(desk, `/sales/returns/${RMA1}/return-labels/${second.id}/cancel`, {})
    expect(withdrawn.status).toBe(200)
    expect((withdrawn.body.labels.labels as Json[]).find((entry) => entry.id === second.id)!.status).toBe('CANCELLED')
    expect((await linkCall(mailedToken, 'GET', '/link/return-label')).statusCode).toBe(404)
    const final = await post(desk, `/sales/returns/${RMA1}/return-labels/${second.id}/cancel`, {})
    expect(final.status).toBe(409)
    expect(final.body.error.issues[0].path).toBe('refusal/FINAL')
  }, SLOW_TEST_TIMEOUT_MS)

  it('a booked label is USED when the goods reach the dock', async () => {
    const receiptId = newId()
    await handle(returnLabelsUsedHandler(), 'return.received', { returnId: RMA1, number: 'SEED-RMA-0001', receiptId, lineIds: [], pieces: 1, first: true })
    const rows = await admin<{ status: string; usedAt: Date | null }>(`SELECT status, "usedAt" FROM "ReturnLabel" WHERE "returnId" = $1 ORDER BY "createdAt"`, [RMA1])
    expect(rows.map((row) => row.status).sort()).toEqual(['CANCELLED', 'USED', 'USED'])
    expect(rows.filter((row) => row.status === 'USED').every((row) => row.usedAt !== null)).toBe(true)
  }, SLOW_TEST_TIMEOUT_MS)
})
