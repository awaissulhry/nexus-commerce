import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/planning/buy'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedSamples, type SamplesSeed } from '../../../../../../packages/factory-db/seed/samples'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { readPurchases } from '../../planning/store'
import { openDraftOf } from '../from-plan'
import { assertTakesPlanLines } from './store'

/**
 * Sample and development orders (B-W2b-347; SCM-043; SCR-222) on the local stack: a throwaway PostgreSQL 17 database from the
 * migrations (row-level security and the …_buying_depth_w2b_guards triggers are real), the real app with the real office sign-in
 * (a buyer with two-factor), the FAKE file store and SES mailbox, and a second app with test sessions (a planner without the cost
 * grain). The factory-db seeds up to the sample rounds (SEED-SR-0001 an open fit round of SEED-JKT-01, SEED-SR-0002 its decided
 * proto, SEED-SR-0003 a round of SEED-JKT-02). Every name, number and price is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/purchasing/sample-orders`.
 */

let h: Harness
let walls: FastifyInstance
let buyer: Browser
let samples: SamplesSeed

const NS = 'sample-orders'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const siteA1 = seedId('site:A1')
const P2 = seedId('party:P2')
const leather = seedId('product:item:leather')
const lining = seedId('product:item:lining')
const FAKE_VAT = '12345670009'
const today = () => businessDate(new Date())
let jkt01 = ''
let jkt02 = ''

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
let counter = 0
const key = (label = 'k'): string => `sample-orders-${label}-${++counter}-${newId()}`

async function as(method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await buyer.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': key() } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, () => SessionContext> = {
  planner: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['purchasing.view'])] }),
}
const wall = async (session: string, method: Method, url: string, payload?: unknown, status = 200) => {
  const answer = await walls.inject({ method, url, headers: { 'x-test-session': session, 'idempotency-key': key('wall') }, ...(payload === undefined ? {} : { payload: payload as object }) })
  expect(answer.statusCode, answer.body).toBe(status)
  return answer
}
const eventsOf = async (subject: string) => (await admin<{ type: string }>('SELECT type FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])).map((row) => row.type)
const refusalOf = (body: Json): string | undefined => (body.error?.issues as { path: string }[] | undefined)?.find((issue) => issue.path.startsWith('refusal/'))?.path

const body = (over: Json = {}) => ({
  companyId: companyA,
  siteId: siteA1,
  partyId: P2,
  developmentStyleId: jkt01,
  sampleRoundId: samples.roundIds.fit,
  requestedDate: addDays(today(), 14),
  note: 'Campioni per il primo prototipo.',
  lines: [
    { what: 'HIDE', itemId: leather, quantity: '2', uom: 'HIDE', needDate: addDays(today(), 14) },
    { what: 'SWATCH', itemId: lining, quantity: '1', uom: 'M', needDate: addDays(today(), 10), description: '20 × 20 cm' },
    { what: 'COLOUR_CARD', itemId: leather, quantity: '1', uom: 'FT2', needDate: addDays(today(), 7) },
  ],
  ...over,
})

beforeAll(async () => {
  h = await startHarness('sample_orders')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  samples = await seedSamples({ db: h.database, namespace: NS })
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
  jkt01 = (await admin<{ id: string }>(`SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-01'`, [tenant]))[0]!.id
  jkt02 = (await admin<{ id: string }>(`SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-02'`, [tenant]))[0]!.id
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  const buyerUser = await addUser(h, seedTenant, { email: 'bruna.buyer@seed-a.example.com', role: 'buyer' })
  buyer = new Browser(h.app)
  expect((await buyer.signIn(NS, buyerUser.email, buyerUser.password)).status).toBe(200)
  await enrolTotp(h, buyer)
  walls = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 180_000)

afterAll(async () => {
  await walls?.close()
  await h?.close()
}, 60_000)

describe('New sample order (SCM-043)', () => {
  let orderId = ''

  it('offers the sites, suppliers, styles with their open rounds of the company, and the materials with their units', async () => {
    const choices = await as('GET', `/purchasing/sample-orders/choices?companyId=${companyA}`)
    expect(choices.sites.map((site: Json) => site.id)).toContain(siteA1)
    expect(choices.suppliers.map((party: Json) => party.id)).toContain(P2)
    const style = choices.styles.find((row: Json) => row.id === jkt01)
    // The decided proto round (SEED-SR-0002) is closed: only the open fit round is offered.
    expect(style.rounds.map((round: Json) => round.number)).toEqual(['SEED-SR-0001'])
    const hide = choices.materials.find((row: Json) => row.id === leather)
    expect(hide).toMatchObject({ kind: 'LEATHER', purchaseUom: 'HIDE' })
    expect(hide.units).toEqual(expect.arrayContaining(['FT2', 'HIDE']))
    expect(choices.complete).toBe(true)
  })

  it('refuses in words: a lining as a sample hide, a decided round, another style’s round, a past need date', async () => {
    const lines = body().lines
    const hide = await as('POST', '/purchasing/sample-orders', body({ lines: [{ ...lines[0], itemId: lining, uom: 'M' }] }), 409)
    expect(refusalOf(hide)).toBe('refusal/HIDE_NOT_LEATHER')
    expect(hide.error.issues.map((issue: Json) => issue.path)).toContain('body/lines/0/itemId')
    expect(refusalOf(await as('POST', '/purchasing/sample-orders', body({ sampleRoundId: samples.roundIds.proto }), 409))).toBe('refusal/ROUND_CLOSED')
    expect(refusalOf(await as('POST', '/purchasing/sample-orders', body({ sampleRoundId: samples.roundIds.pp }), 409))).toBe('refusal/ROUND_OF_ANOTHER_STYLE')
    const past = await as('POST', '/purchasing/sample-orders', body({ lines: [{ ...lines[1], needDate: addDays(today(), -1) }] }), 400)
    expect(past.error.issues[0].path).toBe('body/lines/0/needDate')
    const unit = await as('POST', '/purchasing/sample-orders', body({ lines: [{ ...lines[1], uom: 'KG' }] }), 400)
    expect(unit.error.issues[0].path).toBe('body/lines/0/uom')
    // Nothing was drafted by a refused call.
    expect((await admin(`SELECT id FROM "PurchaseOrder" WHERE "tenantId" = $1 AND kind = 'SAMPLE'`, [tenant])).length).toBe(0)
  })

  it('drafts ONE purchase order of kind SAMPLE for the style and its round, each line saying what it buys in the supplier’s words', async () => {
    const answer = await as('POST', '/purchasing/sample-orders', body(), 201)
    orderId = answer.order.id
    expect(answer.order).toMatchObject({ status: 'DRAFT', supplierName: expect.any(String), style: { id: jkt01, code: 'SEED-JKT-01' }, round: { number: 'SEED-SR-0001', kind: 'FIT', roundNo: 1 }, lineCount: 3 })
    expect(answer.order.items.map((item: Json) => item.description)).toEqual(['Pelle campione', 'Campione di materiale · 20 × 20 cm', 'Cartella colori'])
    expect(answer.order.netAmount).toBeGreaterThan(0)
    const [row] = await admin(`SELECT kind, "developmentStyleId", "sampleRoundId", number, note FROM "PurchaseOrder" WHERE id = $1`, [orderId])
    expect(row).toMatchObject({ kind: 'SAMPLE', developmentStyleId: jkt01, sampleRoundId: samples.roundIds.fit, note: 'Campioni per il primo prototipo.' })
    expect(await eventsOf(orderId)).toEqual(['purchase_order.created', 'purchase_order.lines_changed', 'purchase_order.updated'])
    const audit = await admin<{ action: string }>(`SELECT action FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id`, [orderId])
    expect(audit.map((entry) => entry.action)).toEqual(['purchasing.create', 'purchasing.sampleOrders.create'])
  })

  it('lists sample orders only; the planner reads them without their value', async () => {
    const standard = (await as('POST', '/purchasing/orders', { companyId: companyA, siteId: siteA1, partyId: P2 }, 201)).order
    const list = await as('GET', '/purchasing/sample-orders')
    expect(list.orders.map((order: Json) => order.id)).toEqual([orderId])
    expect(list.readAt).toEqual(expect.any(String))
    expect((await as('GET', '/purchasing/sample-orders?q=JKT-01')).orders).toHaveLength(1)
    expect((await as('GET', `/purchasing/sample-orders?styleId=${jkt02}`)).orders).toHaveLength(0)
    const planner = (await wall('planner', 'GET', '/purchasing/sample-orders')).json()
    expect(planner.orders[0].id).toBe(orderId)
    expect(planner.orders[0]).not.toHaveProperty('netAmount')
    // W1's record says it is a sample order; a production order is not one.
    expect((await as('GET', `/purchasing/orders/${orderId}`)).order.sample).toMatchObject({ style: { code: 'SEED-JKT-01' }, round: { number: 'SEED-SR-0001', stage: 'REQUESTED' } })
    expect((await as('GET', `/purchasing/orders/${standard.id}`)).order.sample).toBeNull()
    // The PDF of a production order is not a sample order's.
    expect(refusalOf((await buyer.get(`/purchasing/sample-orders/${standard.id}/pdf`)).body)).toBe('refusal/NOT_A_SAMPLE_ORDER')
  })

  it('the sample order PDF: the draft as the supplier would get it, then exactly the PDF sent', async () => {
    const draft = await buyer.get(`/purchasing/sample-orders/${orderId}/pdf`)
    expect(draft.status).toBe(200)
    expect(draft.response.headers['content-type']).toMatch(/application\/pdf/)
    expect(String(draft.response.headers['content-disposition'])).toMatch(/Ordine di campionatura/)
    expect((await wall('planner', 'GET', `/purchasing/sample-orders/${orderId}/pdf`, undefined, 403)).statusCode).toBe(403)

    const order = (await as('GET', `/purchasing/orders/${orderId}`)).order
    expect((await as('GET', `/purchasing/orders/${orderId}/send-check`)).ready).toBe(true)
    await as('POST', `/purchasing/orders/${orderId}/send`, { version: order.version })
    const [file] = await admin<{ id: string; originalName: string }>(`SELECT id, "originalName" FROM "StoredFile" WHERE "recordId" = $1 AND kind = 'FISCAL_ARCHIVE'`, [orderId])
    expect(file!.originalName).toMatch(/^Ordine di campionatura /)
    const [stored] = await admin<{ after: Json }>(`SELECT "after" FROM "AuditLog" WHERE "recordType" = 'StoredFile' AND "recordId" = $1`, [file!.id])
    expect(stored!.after).toMatchObject({ documentType: 'PURCHASE_ORDER', layout: 'PURCHASE_ORDER/1-SAMPLE' })
    const sent = await buyer.get(`/purchasing/sample-orders/${orderId}/pdf?language=en`)
    expect(sent.status).toBe(200)
    // As sent: the stored copy in the supplier's language, whatever the language asked.
    expect(String(sent.response.headers['content-disposition'])).toContain(encodeURIComponent(file!.originalName).slice(0, 20))
  })

  it('is no production buying: planning does not net it, and a plan’s lines never go on a sample draft', async () => {
    const actorId = newId()
    const purchases = await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, (client) => readPurchases(client, siteA1, [leather, lining]))
    expect(purchases.map((purchase) => purchase.purchaseOrderId)).not.toContain(orderId)
    const second = (await as('POST', '/purchasing/sample-orders', body({ sampleRoundId: null, lines: [body().lines[1]] }), 201)).order
    const open = await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, (client) => openDraftOf(client, { companyId: companyA, siteId: siteA1, partyId: P2, currency: 'EUR' }))
    expect(open?.id).not.toBe(second.id)
    expect(open?.id).toBeDefined()
    await expect(h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, (client) => assertTakesPlanLines(client, { id: second.id, number: second.number }))).rejects.toMatchObject({ refusal: { code: 'SAMPLE_ORDER_TAKES_NO_PLAN_LINES' } })
  })
})
