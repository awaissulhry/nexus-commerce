import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/planning/buy'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPlanning } from '../../../../../../packages/factory-db/seed/planning'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { textOf } from '../../../adapters/ses/fake'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * The expediting worklist, the demand each line serves and the chase (B-W2b-305; SCM-068, SCM-064) on the local stack: a
 * throwaway PostgreSQL 17 database from the migrations, the real app with the real office sign-in (a buyer with two-factor),
 * the supplier's confirm link, the FAKE SES mailbox. The planning seed's finished run of plant A1 is the plan the worklist
 * reads; its pegging onto this test's own order lines, and the days that make them late, are written past the guards
 * (test data only: the planner's run and the supplier's dates are other steps' routes). Every name, number and day is made
 * up. Run with `node scripts/factory/run-pg-tests.mjs modules/purchasing/expediting`.
 */

let h: Harness
let buyer: Browser

const NS = 'expediting'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const siteA1 = seedId('site:A1')
const P2 = seedId('party:P2')
const leather = seedId('product:item:leather')
const lining = seedId('product:item:lining')
const leatherBLK = seedId('product:item-colour:leather:BLK')
const liningGRY = seedId('product:item-colour:lining:GRY')
const FAKE_VAT = '12345670009'
const today = () => businessDate(new Date())

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
let counter = 0
const key = (): string => `expedite-${++counter}-${newId()}`
async function as(method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await buyer.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': key() } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}
const orderUrl = (id: string) => `/purchasing/orders/${id}`
const tokenOf = (outboundId: string): string => {
  const mail = h.ses.mails.find((entry) => entry.outboundId === outboundId)
  return mail ? decodeURIComponent(/#token=(\S+)/.exec(textOf(mail.raw))?.[1] ?? '') : ''
}
const viaLink = (token: string, url: string, payload: unknown) => h.app.inject({ method: 'POST', url, headers: { 'x-factory-link': token, 'user-agent': 'SeedBrowser/1.0', 'idempotency-key': key() }, payload: payload as object })

async function draft(lines: readonly { itemId: string; colourId: string; quantity: string; uom: string; days: number }[]): Promise<Json> {
  let order = (await as('POST', '/purchasing/orders', { companyId: companyA, siteId: siteA1, partyId: P2 }, 201)).order
  for (const line of lines) order = (await as('POST', `${orderUrl(order.id)}/lines`, { version: order.version, itemId: line.itemId, itemColourId: line.colourId, quantity: line.quantity, uom: line.uom, needDate: addDays(today(), line.days), unitPrice: '2.500000' }, 201)).order
  return order
}
async function send(orderId: string): Promise<{ order: Json; token: string }> {
  const order = (await as('GET', orderUrl(orderId))).order
  const answer = await as('POST', `${orderUrl(orderId)}/send`, { version: order.version })
  return { order: answer.order, token: tokenOf(answer.sent.emailId) }
}

let X: Json
let Y: Json
let soNumber = ''
let woNumber = ''

beforeAll(async () => {
  h = await startHarness('expediting')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedPlanning({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenant])
  const ses = newId()
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'SES', 'ses', 'Mail', 'FAKE', 6000, 1000)`, [ses, tenant])
  await admin(
    `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "displayNamePolicy", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
     VALUES ($1, $2, $3, 'CONVERSATION', 'mail.seed-a.example.com', 'acquisti@mail.seed-a.example.com', 'Seed A', 'COMPANY', 'reply.seed-a.example.com', $4, 'SUCCESS', 'SUCCESS', true)`,
    [newId(), tenant, companyA, ses],
  )
  await admin(`UPDATE "Company" SET "vatNumber" = $2, "fiscalCode" = $3, "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA, `IT${FAKE_VAT}`, FAKE_VAT])
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  const buyerUser = await addUser(h, seedTenant, { email: 'bea.buyer@seed-a.example.com', role: 'buyer' })
  buyer = new Browser(h.app)
  expect((await buyer.signIn(NS, buyerUser.email, buyerUser.password)).status).toBe(200)
  await enrolTotp(h, buyer)

  // X: confirmed by the supplier's link as asked; then its leather confirmed 3 days later than asked (needed by a customer
  // order line and a work order), its lining expected 2 days ago. Y: sent, still unanswered after its confirm-by time.
  X = await draft([
    { itemId: leather, colourId: leatherBLK, quantity: '100', uom: 'FT2', days: 5 },
    { itemId: lining, colourId: liningGRY, quantity: '30', uom: 'M', days: 6 },
  ])
  const sentX = await send(X.id)
  const confirmed = await viaLink(sentX.token, '/link/purchase-order/confirm', { version: sentX.order.version, mode: 'ALL_AS_ASKED', typedName: 'Mario Rossi', supplierRef: 'OC-9' })
  expect(confirmed.statusCode, confirmed.body).toBe(200)
  X = (await as('GET', orderUrl(X.id))).order
  expect(X.status).toBe('CONFIRMED')
  await force(`UPDATE "PurchaseOrderLine" SET "confirmedDate" = $2::date WHERE id = $1`, [X.lines[0].id, addDays(today(), 8)])
  await force(`UPDATE "PurchaseOrderLine" SET "needDate" = $2::date, "confirmedDate" = $3::date WHERE id = $1`, [X.lines[1].id, addDays(today(), -4), addDays(today(), -2)])
  Y = await draft([{ itemId: lining, colourId: liningGRY, quantity: '40', uom: 'M', days: 10 }])
  await send(Y.id)
  await force(`UPDATE "PurchaseOrder" SET "sentAt" = now() - interval '3 hours', "confirmBy" = now() - interval '1 hour' WHERE id = $1`, [Y.id])

  const [run] = await admin<{ id: string }>(`SELECT id FROM "PlanningRun" WHERE "tenantId" = $1 AND "siteId" = $2 AND status = 'DONE' ORDER BY "finishedAt" DESC, id DESC LIMIT 1`, [tenant, siteA1])
  const [requirement] = await admin<{ id: string }>(`SELECT id FROM "MaterialRequirement" WHERE "runId" = $1 ORDER BY id LIMIT 1`, [run!.id])
  const [orderLine] = await admin<{ id: string; partyId: string; number: string }>(
    `SELECT l.id, o."partyId", o.number FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o.id = l."orderId" WHERE o."tenantId" = $1 AND o.number = 'SEED-SO-0001' ORDER BY l.seq LIMIT 1`,
    [tenant],
  )
  const [workOrder] = await admin<{ id: string; number: string }>(`SELECT id, number FROM "WorkOrder" WHERE "tenantId" = $1 AND "siteId" = $2 ORDER BY number LIMIT 1`, [tenant, siteA1])
  soNumber = orderLine!.number
  woNumber = workOrder!.number
  const peg = `INSERT INTO "RequirementPegging" (id, "tenantId", "siteId", "runId", "requirementId", seq, "demandKind", "salesOrderLineId", "partyId", size, "workOrderId", "demandDate", quantity, "supplyKind", "purchaseOrderLineId", "supplyDate", "createdAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7::"PeggingDemandKind", $8, $9, $10, $11, $12::date, $13, 'PURCHASE_ORDER', $14, $15::date, now())`
  await force(peg, [newId(), tenant, siteA1, run!.id, requirement!.id, 901, 'ORDER_LINE', orderLine!.id, orderLine!.partyId, '52', null, addDays(today(), 5), '40.0000', X.lines[0].id, addDays(today(), 8)])
  await force(peg, [newId(), tenant, siteA1, run!.id, requirement!.id, 902, 'WORK_ORDER', null, null, null, workOrder!.id, addDays(today(), 6), '20.0000', X.lines[0].id, addDays(today(), 8)])
}, 300_000)

afterAll(async () => {
  await h?.close()
}, 60_000)

const rowOf = (rows: readonly Json[], lineId: string) => rows.find((row) => row.lineId === lineId)

describe('the expediting worklist (SCM-068)', () => {
  it('lists the lines late, unconfirmed or confirmed later than needed, with what they block, the customer order at risk first', async () => {
    const list = await as('GET', `/purchasing/expediting?siteId=${siteA1}&limit=200`)
    const x10 = rowOf(list.rows, X.lines[0].id)
    const x20 = rowOf(list.rows, X.lines[1].id)
    const y10 = rowOf(list.rows, Y.lines[0].id)
    expect(x10).toMatchObject({ number: X.number, seq: 10, reasons: ['CONFIRMED_LATE'], confirmedLaterBy: 3, expectedDate: addDays(today(), 8), daysLate: 0, blocks: { salesOrdersAtRisk: 1, workOrdersAtRisk: 1, earliestPromise: expect.any(String) } })
    expect(x10!.blocks.entries).toEqual([
      expect.objectContaining({ kind: 'ORDER_LINE', salesOrder: expect.objectContaining({ number: soNumber }), demandDate: addDays(today(), 5), lateBy: 3 }),
      expect.objectContaining({ kind: 'WORK_ORDER', workOrder: expect.objectContaining({ number: woNumber }), demandDate: addDays(today(), 6), lateBy: 2 }),
    ])
    expect(x20).toMatchObject({ reasons: ['LATE', 'CONFIRMED_LATE'], daysLate: 2, confirmedLaterBy: 2, blocks: { entries: [], salesOrdersAtRisk: 0 } })
    expect(y10).toMatchObject({ reasons: ['NOT_CONFIRMED'], status: 'SENT', confirmedDate: null })
    const order = list.rows.map((row: Json) => row.lineId)
    expect(order.indexOf(X.lines[0].id)).toBeLessThan(order.indexOf(X.lines[1].id))
    expect(order.indexOf(X.lines[1].id)).toBeLessThan(order.indexOf(Y.lines[0].id))
    expect(list.tiles.late).toBeGreaterThanOrEqual(1)
    expect(list.tiles.notConfirmed).toBeGreaterThanOrEqual(1)
    expect(list.tiles.salesOrdersAtRisk).toBeGreaterThanOrEqual(1)
    expect(list.plans).toEqual([expect.objectContaining({ siteId: siteA1, runId: expect.any(String) })])
    // No money on the list.
    expect(JSON.stringify(list)).not.toMatch(/unitPrice|netAmount/)
  })

  it('filters by reason and by what is put at risk', async () => {
    const unconfirmed = (await as('GET', `/purchasing/expediting?siteId=${siteA1}&reason=NOT_CONFIRMED`)).rows.map((row: Json) => row.lineId)
    expect(unconfirmed).toContain(Y.lines[0].id)
    expect(unconfirmed).not.toContain(X.lines[0].id)
    const atRisk = (await as('GET', `/purchasing/expediting?siteId=${siteA1}&atRisk=true`)).rows.map((row: Json) => row.lineId)
    expect(atRisk).toContain(X.lines[0].id)
    expect(atRisk).not.toContain(Y.lines[0].id)
    const page = await as('GET', `/purchasing/expediting?siteId=${siteA1}&limit=1`)
    expect(page.rows).toHaveLength(1)
    expect(page.nextCursor).toBe('o:1')
    const whole = (await as('GET', `/purchasing/expediting?siteId=${siteA1}&limit=200`)).rows.map((row: Json) => row.lineId)
    expect((await as('GET', `/purchasing/expediting?siteId=${siteA1}&limit=1&cursor=o:1`)).rows[0].lineId).toBe(whole[1])
  })
})

describe('the demand each line serves (SCM-064)', () => {
  it('per line: the customer order lines and work orders the plan pegs on it, late by the days it is expected after', async () => {
    const demand = (await as('GET', `${orderUrl(X.id)}/demand`)).demand
    expect(demand.plan.runId).toEqual(expect.any(String))
    expect(demand.lines.map((line: Json) => [line.seq, line.demands.length, line.salesOrdersAtRisk, line.workOrdersAtRisk])).toEqual([
      [10, 2, 1, 1],
      [20, 0, 0, 0],
    ])
    expect(demand.salesOrders.map((entry: Json) => entry.number)).toEqual([soNumber])
    expect(demand.workOrders.map((entry: Json) => entry.number)).toEqual([woNumber])
    // A draft is planned as supply too: its lines are read, with nothing pegged yet.
    const fresh = await draft([{ itemId: lining, colourId: liningGRY, quantity: '5', uom: 'M', days: 12 }])
    expect((await as('GET', `${orderUrl(fresh.id)}/demand`)).demand.lines).toEqual([expect.objectContaining({ seq: 10, demands: [], expectedDate: addDays(today(), 12) })])
  })
})

describe('chase the supplier', () => {
  it('previews the lines to chase and the mail in the supplier’s language; sends it for the lines chosen', async () => {
    const preview = (await as('GET', `${orderUrl(X.id)}/chase`)).chase
    expect(preview).toMatchObject({ allowed: true, why: null, recipient: { email: 'orders.p2@example.com' } })
    expect(preview.lines.map((line: Json) => line.seq)).toEqual([10, 20])
    expect(preview.body).toContain('Line 20')
    expect(preview.body).not.toMatch(/#token=/)
    const current = (await as('GET', orderUrl(X.id))).order
    const chased = await as('POST', `${orderUrl(X.id)}/chase`, { version: current.version, lineIds: [X.lines[1].id], message: 'Grazie (made-up).' })
    expect(chased.chase).toMatchObject({ lineIds: [X.lines[1].id], to: 'orders.p2@example.com', emailId: expect.any(String) })
    const [outbound] = await admin<{ subject: string; recordId: string }>(`SELECT subject, "recordId" FROM "EmailOutbound" WHERE id = $1`, [chased.chase.emailId])
    expect(outbound).toEqual({ subject: preview.subject, recordId: X.id })
    const events = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'purchase_order.chased' AND subject = $1`, [X.id])
    expect(events.map((row) => row.payload)).toEqual([{ purchaseOrderId: X.id, number: X.number, lineIds: [X.lines[1].id], outboundId: chased.chase.emailId }])
  })

  it('REFUSED: a line not to chase, and an order that waits for no goods', async () => {
    const current = (await as('GET', orderUrl(X.id))).order
    const wrong = await as('POST', `${orderUrl(X.id)}/chase`, { version: current.version, lineIds: [Y.lines[0].id] }, 400)
    expect(wrong.error.issues).toEqual([{ path: 'body/lineIds/0', message: 'Not a line to chase.' }])
    const fresh = await draft([{ itemId: lining, colourId: liningGRY, quantity: '5', uom: 'M', days: 12 }])
    expect((await as('GET', `${orderUrl(fresh.id)}/chase`)).chase).toMatchObject({ allowed: false, why: 'The order does not wait for goods from its supplier: there is nothing to chase.' })
    await as('POST', `${orderUrl(fresh.id)}/chase`, { version: fresh.version }, 409)
  })
})
