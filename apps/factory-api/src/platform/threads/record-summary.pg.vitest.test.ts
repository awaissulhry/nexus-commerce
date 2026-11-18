import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { RECORD_TYPE_WORDS, stateWordsOf } from '@nexus/factory-domain/threads/summary'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { SLOW_TEST_TIMEOUT_MS } from '../../testing/timeouts'
import { useAbuseGuard } from '../abuse/guard'
import { usePortalOptions } from '../auth/portal/service'
import { freshGuard } from '../auth/portal/testing/portal'
import { startHarness, type Browser, type Harness } from '../auth/sessions/testing/harness'
import { inTenant, partnerWorld, signIn, type PartnerWorld, type Person } from '../search/partner/testing/world'
import { THREAD_RECORDS } from './records'
import { SUMMARIZED_TYPES } from './summary'

/**
 * B-TH-076 (threads plan TH-6, X-G01; PL5 summary row, O-REC-ANY.summary-F01, P-ANY.summary; wall test T09 / W09, W34; the Owner's
 * rule 2026-11-16: "One brand must not be able to see anything related to any other brand"): GET /records/<type>/<id>/summary.
 *
 *   the office (all customers)   type in words, label, state in words, the parent as a link (a delivery → its order; a repair → its return)
 *   the office (brand B only)    404 on brand A's record, the words of a record that does not exist
 *   brand A's portal buyer       its own delivery through the partner view: our number, the state, its order as the parent (opened
 *                                through the order's own partner view)
 *   brand B's portal buyer       404 in neutral words on brand A's order and delivery (T09); a work order (no partner view) is not found
 *
 * Base seeds in one namespace (two brands included), real portal sign-ins, office sessions by the test authenticator. Run with
 * `node scripts/factory/run-pg-tests.mjs platform/threads`.
 */

let h: Harness
let world: PartnerWorld
let app: FastifyInstance
let alpha: Browser
let beta: Browser
let brandB = ''
const NS = 'th076sum'
const ids = { order: '', shipment: '', repair: '', rma: '', workOrder: '' }
const office = { all: newId(), betaOnly: newId() }

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[]): Promise<T> => {
  const rows = await admin<T>(sql, values)
  expect(rows.length, sql).toBeGreaterThan(0)
  return rows[0]!
}
const sessions = (): Record<string, SessionContext> => ({
  all: { audience: 'office', tenantId: world.tenantId, actorId: office.all, grants: [{ permissions: ['threads.read'], companies: 'all', sites: 'all', parties: 'all' }] },
  betaOnly: { audience: 'office', tenantId: world.tenantId, actorId: office.betaOnly, grants: [{ permissions: ['threads.read'], companies: 'all', sites: 'all', parties: [brandB] }] },
})
const asOffice = async (who: keyof typeof office, type: string, id: string) => {
  const response = await app.inject({ method: 'GET', url: `/records/${type}/${id}/summary`, headers: { 'x-test-session': who } })
  return { status: response.statusCode, body: response.json() as Json }
}
const asPortal = (browser: Browser, type: string, id: string) => browser.get(`/records/${type}/${id}/summary`)

/** A 404 in neutral words: never that the record exists, nor whose it is. */
function neutral404(answer: { status: number; body: Json }, ...names: string[]): void {
  expect(answer.status, JSON.stringify(answer.body)).toBe(404)
  const text = JSON.stringify(answer.body)
  expect(text).toMatch(/not found/i)
  for (const name of names) expect(text).not.toContain(name)
  expect(text).not.toMatch(/another (customer|brand|company)|altro cliente/i)
}

beforeAll(async () => {
  h = await startHarness('record_summary_th076')
  h.clock.set(new Date())
  freshGuard(h)
  world = await partnerWorld(h, NS)
  brandB = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-C2B'`, [world.tenantId])).id
  const buyerB = await one<{ id: string; email: string; displayName: string }>(`SELECT id, email, "displayName" FROM "User" WHERE "tenantId" = $1 AND "partyId" = $2 AND email LIKE 'buyer.second-brand.%' LIMIT 1`, [world.tenantId, brandB])
  await inTenant(h, world, (client) => client.portalSettings.updateMany({ where: { partyId: brandB }, data: { portalOn: true } }))
  ids.order = (await one<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0002' AND "partyId" = $2`, [world.tenantId, world.p1])).id
  ids.shipment = (await one<{ id: string }>(`SELECT id FROM "Shipment" WHERE "tenantId" = $1 AND number = 'SEED-SH-0001' AND "salesOrderId" = $2`, [world.tenantId, ids.order])).id
  ids.repair = (await one<{ id: string }>(`SELECT id FROM "RepairOrder" WHERE "tenantId" = $1 AND number = 'SEED-REP-0001'`, [world.tenantId])).id
  // fix-pg-1: SEED-REP-0001 is the repair of SEED-RMA-0002's line (seed/returns.ts); SEED-RMA-0001 is still waiting for its goods.
  ids.rma = (await one<{ id: string }>(`SELECT id FROM "ReturnAuthorisation" WHERE "tenantId" = $1 AND number = 'SEED-RMA-0002'`, [world.tenantId])).id
  ids.workOrder = (await one<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 ORDER BY number LIMIT 1`, [world.tenantId])).id
  for (const [key, id] of Object.entries(office)) await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, \'ACTIVE\', \'en\')', [id, world.tenantId, `th076-${key}@example.com`, `Made-up ${key}`])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => sessions()[String(request.headers['x-test-session'])] ?? null) },
  )
  alpha = await signIn(h, world, world.people.buyer)
  beta = await signIn(h, world, { id: buyerB.id, email: buyerB.email, name: buyerB.displayName } satisfies Person)
}, 600_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await app?.close()
  await h?.close()
})

describe('B-TH-076: every thread type has its summary reader and its words', () => {
  it('each record type of THREAD_RECORDS names its state and parent here and its type in words (never "a thread without a record")', () => {
    expect(Object.keys(THREAD_RECORDS).filter((type) => !SUMMARIZED_TYPES.has(type))).toEqual([])
    expect(Object.keys(THREAD_RECORDS).filter((type) => !Object.hasOwn(RECORD_TYPE_WORDS, type))).toEqual([])
    expect(stateWordsOf('PARTLY_SHIPPED')).toEqual({ it: 'Spedito in parte', en: 'Partly shipped' })
    // A state the words do not know yet is said as its code in plain letters, never left out.
    expect(stateWordsOf('SOME_NEW_STATE').en).toBe('Some new state')
  })
})

describe('B-TH-076: the office’s summary row', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('a delivery: its type in words, its number, its state in words and its order as the parent link', async () => {
    const answer = await asOffice('all', 'Shipment', ids.shipment)
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body.summary).toMatchObject({
      recordType: 'Shipment',
      recordId: ids.shipment,
      type: { it: 'Spedizione', en: 'Shipment' },
      label: 'SEED-SH-0001',
      theirRef: null,
      state: { code: 'SHIPPED', words: { it: 'Spedito', en: 'Shipped' } },
      parent: { recordType: 'SalesOrder', recordId: ids.order, type: { en: 'Sales order' }, label: 'SEED-SO-0002' },
    })
  })

  it('a repair from a return line names that return as its parent; an order with no quote, request or catalogue order has none', async () => {
    const repair = await asOffice('all', 'RepairOrder', ids.repair)
    expect(repair.status, JSON.stringify(repair.body)).toBe(200)
    expect(repair.body.summary.state.code).toBe('RECEIVED')
    expect(repair.body.summary.parent).toMatchObject({ recordType: 'ReturnAuthorisation', recordId: ids.rma, label: 'SEED-RMA-0002' })
  })

  it('a person limited to brand B gets 404 on brand A’s delivery — the words of a record that does not exist', async () => {
    neutral404(await asOffice('betaOnly', 'Shipment', ids.shipment), 'SEED-SH-0001', 'SEED-SO-0002')
    neutral404(await asOffice('all', 'Shipment', newId()))
    neutral404(await asOffice('all', 'NoSuchType', ids.shipment))
  })
})

describe('B-TH-076 / T09: the portal’s summary row, through the partner views only', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('brand A reads its own delivery: our number, the state, and its order opened through the order’s own partner view', async () => {
    const answer = await asPortal(alpha, 'Shipment', ids.shipment)
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body.summary).toMatchObject({ recordType: 'Shipment', recordId: ids.shipment, type: { en: 'Shipment' }, label: 'SEED-SH-0001', state: { code: 'SHIPPED' } })
    expect(answer.body.summary.parent).toMatchObject({ recordType: 'SalesOrder', recordId: ids.order })
  })

  it('brand B gets 404 in neutral words on brand A’s order and delivery; a work order has no partner view (404 for anyone outside)', async () => {
    neutral404(await asPortal(beta, 'Shipment', ids.shipment), 'SEED-SH-0001', 'SEED-SO-0002')
    neutral404(await asPortal(beta, 'SalesOrder', ids.order), 'SEED-SO-0002')
    neutral404(await asPortal(alpha, 'WorkOrder', ids.workOrder))
    neutral404(await asPortal(alpha, 'Shipment', newId()))
  })
})

// ---- follow-up (th9-web-b): the record's party in the OFFICE summary, so the docked thread offers "Reply to <party>" before the first
// message (the thread, and so its party, exists only after one). The portal answer never carries it (brand wall).
describe('follow-up (th9-web-b): the record’s party, office only', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const nameOf = async (partyId: string): Promise<string> => {
    const party = await one<{ legalName: string; tradeName: string | null }>('SELECT "legalName", "tradeName" FROM "Party" WHERE id = $1', [partyId])
    return party.tradeName ?? party.legalName
  }

  it('an order with no message yet names its customer (no thread to learn it from); a delivery names the same customer', async () => {
    const customer = { id: world.p1, name: await nameOf(world.p1) }
    const quiet = await admin<{ id: string }>(
      `SELECT so.id FROM "SalesOrder" so WHERE so."tenantId" = $1 AND so."partyId" = $2
          AND NOT EXISTS (SELECT 1 FROM "Thread" t WHERE t."tenantId" = so."tenantId" AND t."recordType" = 'SalesOrder' AND t."recordId" = so.id)
        ORDER BY so.number LIMIT 1`,
      [world.tenantId, world.p1],
    )
    expect(quiet.length, 'a seeded order of P1 without a thread').toBe(1)
    const before = await asOffice('all', 'SalesOrder', quiet[0]!.id)
    expect(before.status, JSON.stringify(before.body)).toBe(200)
    expect(before.body.summary.party).toEqual(customer)
    const delivery = await asOffice('all', 'Shipment', ids.shipment)
    expect(delivery.body.summary.party).toEqual(customer)
  })

  it('a record never shared (a work order: its customer is a wall party only) and a record with no party name none', async () => {
    const workOrder = await asOffice('all', 'WorkOrder', ids.workOrder)
    expect(workOrder.status, JSON.stringify(workOrder.body)).toBe(200)
    expect(workOrder.body.summary.party).toBeNull()
    const company = await asOffice('all', 'Company', world.companyA)
    expect(company.status, JSON.stringify(company.body)).toBe(200)
    expect(company.body.summary.party).toBeNull()
  })

  it('the portal’s summary never carries a party, of its own customer or another', async () => {
    const own = await asPortal(alpha, 'Shipment', ids.shipment)
    expect(own.status, JSON.stringify(own.body)).toBe(200)
    expect('party' in own.body.summary).toBe(false)
    const order = await asPortal(alpha, 'SalesOrder', ids.order)
    expect(order.status, JSON.stringify(order.body)).toBe(200)
    expect('party' in order.body.summary).toBe(false)
    expect(JSON.stringify(order.body)).not.toContain(world.p1)
  })
})
// ---- end follow-up
