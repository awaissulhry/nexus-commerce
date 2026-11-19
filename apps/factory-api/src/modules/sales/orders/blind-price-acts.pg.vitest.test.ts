import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { BLIND_PRICE_WORDS } from '@nexus/factory-domain/sales/blind-price'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'

/**
 * Sales' four blind price acts are held (customer page lane B-CP-026; Owner answer A of 2026-11-19 to cp-2's MA1 open point 2; the
 * money wall, Owner O1) on the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations and
 * every factory-db seed (Brand Alpha = the seeds' customer SEED-C1: SEED-SO-0004 with its configured SEED-JKT-05 line, SEED-RMA-0001
 * waiting for its jacket). Test sessions hold the role templates' grants (B-CP-011: the Sales template holds no price grain).
 *
 *   1. a quote template's lines holding a unit price: "as Sales worker" the replace is refused 403 in words (it would wipe the
 *      price), nothing changes; a template without a typed price is replaced by Sales; the Owner replaces the priced one
 *   2. a line's product options whose surcharges move (the price moves, or is kept without them): an order line ("as Sales
 *      worker" 403 with or without keepPrice, nothing changes; the Owner keeps the price), a quote line priced again from its
 *      stored waterfall with a typed change kept (403; the Owner saves it), a quote line typed by hand (not priced again: 403; the
 *      Owner saves it); options that add the same are saved by Sales
 *   3. accepting a request whose agreed counter-offer carries a price (its fee): "as Sales worker" (the sales accept) and "as
 *      Production manager" (the production accept) 403, the request stays COUNTERED; the Owner passes the hold; a counter of a
 *      date only is not held
 *   4. deciding a return's credit: "as Sales worker" 403, nothing decided; the Owner decides it
 * The words are "It changes a price you cannot see: someone who sees prices does it." (refusal/BLIND_PRICE), and never an amount.
 * The web holds the same buttons in words later (B-CP-026 names the files). Every name, number and price is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs sales/orders/blind-price-acts`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'cp026-blind-price-acts'
const sid = (key: string) => seedUuid(NS, key)
const T = sid('tenant')
const companyA = sid('company:A')
const P1 = sid('party:P1')
const JKT01 = sid('product:style:JKT-01')
const JKT01_BLK = sid('product:colourway:JKT-01:BLK')

const PEOPLE = { owner: newId(), sales: newId(), production: newId() } as const
type Person = keyof typeof PEOPLE
const ROLE_OF: Record<Person, string> = { owner: 'owner', sales: 'sales', production: 'production_manager' }
const SESSIONS: Record<string, SessionContext> = {}
function grantsOf(role: string): Grant[] {
  const template = templateOf(role)!
  return [{ permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }]
}

let h: Harness
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let keys = 0
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
const call = (who: Person, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': who, ...(method !== 'GET' ? { 'idempotency-key': `cp026-${run}-${++keys}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(who: Person, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(who, method, url, payload)
  expect(response.statusCode, `${who} ${method} ${url}: ${response.body}`).toBe(status)
  return response.json() as Json
}
/** The hold: 403, refusal/BLIND_PRICE in words (and the field it rests on), never an amount. */
async function held(who: Person, method: Method, url: string, payload: unknown, at: string): Promise<void> {
  const response = await call(who, method, url, payload)
  expect(response.statusCode, `${who} ${method} ${url}: ${response.body}`).toBe(403)
  const error = (response.json() as Json).error
  expect(error.message).toBe(BLIND_PRICE_WORDS.en)
  expect(error.issues).toEqual([{ path: 'refusal/BLIND_PRICE', message: BLIND_PRICE_WORDS.en }, { path: at, message: BLIND_PRICE_WORDS.en }])
}
/** Not held: whatever the answer, it is not the blind-price refusal. */
async function notHeld(who: Person, method: Method, url: string, payload: unknown): Promise<Json> {
  const response = await call(who, method, url, payload)
  const body = response.json() as Json
  expect((body.error?.issues ?? []).map((issue: Json) => issue.path), `${who} ${method} ${url}: ${response.body}`).not.toContain('refusal/BLIND_PRICE')
  return { status: response.statusCode, ...body }
}
const optionValue = async (group: string, code: string) => (await one<{ id: string }>(`SELECT v.id FROM "OptionValue" v JOIN "OptionGroup" g ON g.id = v."groupId" WHERE g."tenantId" = $1 AND g.code = $2 AND v.code = $3`, [T, group, code])).id

beforeAll(async () => {
  h = await startHarness('blind_price_acts_cp026')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  const roleIds = new Map((await admin<{ id: string; key: string }>(`SELECT id, key FROM "Role" WHERE "tenantId" = $1`, [T])).map((row) => [row.key, row.id]))
  for (const [person, role] of Object.entries(ROLE_OF) as Array<[Person, string]>) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [PEOPLE[person], T, `cp026-${person}-${run}@example.com`, `Made-up ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '30 days')`, [newId(), T, PEOPLE[person], roleIds.get(role)])
    SESSIONS[person] = { audience: 'office', tenantId: T, actorId: PEOPLE[person], grants: grantsOf(role) }
  }
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('B-CP-026 1. a quote template’s lines that hold a price', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const linesOf = (templateId: string) => admin<Json>(`SELECT seq, "unitPrice"::text AS "unitPrice" FROM "QuoteTemplateLine" WHERE "templateId" = $1 ORDER BY seq`, [templateId])
  const plainLine = { seq: 10, section: 'Jackets', styleId: JKT01, colourwayId: JKT01_BLK, sizes: { '50': 2, '52': 1 } }

  it('as Sales worker: the replace would wipe the price — 403 in words, nothing changes; the Owner replaces it', async () => {
    const made = (await ok('owner', 'POST', '/sales/quote-templates', { companyId: companyA, name: 'Made-up priced kit', lines: [{ ...plainLine, unitPrice: '399' }] }, 201)).template
    expect(await linesOf(made.id)).toEqual([{ seq: 10, unitPrice: '399.000000' }])
    await held('sales', 'PUT', `/sales/quote-templates/${made.id}/lines`, { version: made.version, lines: [plainLine, { ...plainLine, seq: 20, sizes: { '54': 1 } }] }, 'body/lines')
    expect(await linesOf(made.id)).toEqual([{ seq: 10, unitPrice: '399.000000' }])
    expect((await ok('owner', 'GET', `/sales/quote-templates/${made.id}`)).template.version).toBe(made.version)
    const replaced = (await ok('owner', 'PUT', `/sales/quote-templates/${made.id}/lines`, { version: made.version, lines: [{ ...plainLine, unitPrice: '405' }, { ...plainLine, seq: 20, sizes: { '54': 1 } }] })).template
    expect(replaced.lines.map((line: Json) => line.seq)).toEqual([10, 20])
    expect(await linesOf(made.id)).toEqual([{ seq: 10, unitPrice: '405.000000' }, { seq: 20, unitPrice: null }])
  })

  it('a template without a typed price: Sales replaces its lines as before (the list prices them at use)', async () => {
    const made = (await ok('sales', 'POST', '/sales/quote-templates', { companyId: companyA, name: 'Made-up list kit', lines: [plainLine] }, 201)).template
    const replaced = (await ok('sales', 'PUT', `/sales/quote-templates/${made.id}/lines`, { version: made.version, lines: [{ ...plainLine, sizes: { '50': 4 } }] })).template
    expect(replaced.lines).toHaveLength(1)
    expect(await linesOf(made.id)).toEqual([{ seq: 10, unitPrice: null }])
  })
})

describe('B-CP-026 2. a line’s options whose surcharges move while its price is kept', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  let liner = ''
  let armour = ''
  let name = ''
  const optionsOf = (table: 'SalesOrderLineOption' | 'QuoteLineOption', lineId: string) => admin<{ valueId: string }>(`SELECT "valueId" FROM "${table}" WHERE "lineId" = $1 ORDER BY "valueId"`, [lineId])

  beforeAll(async () => {
    liner = await optionValue('SEED-OG-LINER', 'YES')
    armour = await optionValue('SEED-OG-ARMOUR', 'STD')
    name = await optionValue('SEED-OG-NAME', 'NAME')
  })

  it('an accepted order line (SEED-SO-0004): as Sales worker 403 with or without keepPrice, nothing changes; the Owner keeps the price', async () => {
    const { orderId, lineId } = await one<{ orderId: string; lineId: string }>(`SELECT o.id AS "orderId", l.id AS "lineId" FROM "SalesOrder" o JOIN "SalesOrderLine" l ON l."orderId" = o.id WHERE o."tenantId" = $1 AND o.number = 'SEED-SO-0004' ORDER BY l.seq LIMIT 1`, [T])
    const url = `/sales/orders/${orderId}/lines/${lineId}`
    const before = await optionsOf('SalesOrderLineOption', lineId)
    const same = [{ valueId: liner }, { valueId: armour }]
    // Options that add the same: Sales saves them (no price moves).
    let view = await ok('sales', 'GET', `${url}/configurator`)
    view = (await ok('sales', 'PUT', `${url}/options`, { version: view.document.version, picks: same })).line
    // The name on the chest adds to what the options add: a price decision.
    const more = [...same, { valueId: name, text: 'VERDI' }]
    await held('sales', 'PUT', `${url}/options`, { version: view.document.version, picks: more }, 'body/keepPrice')
    await held('sales', 'PUT', `${url}/options`, { version: view.document.version, picks: more, keepPrice: true }, 'body/keepPrice')
    expect(await optionsOf('SalesOrderLineOption', lineId)).toEqual(before)
    // The Owner: without keepPrice the amendment's words (409); with it, the accepted price is kept.
    expect((await call('owner', 'PUT', `${url}/options`, { version: view.document.version, picks: more })).statusCode).toBe(409)
    await ok('owner', 'PUT', `${url}/options`, { version: view.document.version, picks: more, keepPrice: true })
    expect((await optionsOf('SalesOrderLineOption', lineId)).map((row) => row.valueId)).toContain(name)
  })

  // B-CP-026 (lead, strict Owner answer A): every quote options save that moves money is held — also a line priced again from its
  // stored waterfall that keeps a typed change (SEED-Q-0003's grid line: … → MANUAL -0.25 → NET 470).
  it('a quote line priced again from its stored waterfall (a typed change kept): as Sales worker 403, nothing changes; the Owner saves it', async () => {
    const { quoteId, lineId } = await one<{ quoteId: string; lineId: string }>(
      `SELECT q.id AS "quoteId", l.id AS "lineId" FROM "Quote" q JOIN "QuoteVersion" v ON v."quoteId" = q.id JOIN "QuoteLine" l ON l."versionId" = v.id WHERE q."tenantId" = $1 AND q.number = 'SEED-Q-0003' AND l.kind::text = 'SIZE_GRID' ORDER BY v.revision DESC, l.seq LIMIT 1`,
      [T],
    )
    const url = `/sales/quotes/${quoteId}/lines/${lineId}`
    const before = await optionsOf('QuoteLineOption', lineId)
    const priceBefore = (await one<{ unitPrice: string }>(`SELECT "unitPrice"::text AS "unitPrice" FROM "QuoteLine" WHERE id = $1`, [lineId])).unitPrice
    expect((await ok('owner', 'GET', `${url}/configurator`)).pricing).toMatchObject({ held: null, manualKept: true })
    const version = (await ok('sales', 'GET', `/sales/quotes/${quoteId}`)).quote.version
    // The name on the chest taken off: what the options add moves (−15.00), so the price the waterfall gives moves.
    const without = before.filter((row) => row.valueId !== name).map((row) => ({ valueId: row.valueId }))
    await held('sales', 'PUT', `${url}/options`, { version, picks: without }, 'body/picks')
    expect(await optionsOf('QuoteLineOption', lineId)).toEqual(before)
    expect((await one<{ unitPrice: string }>(`SELECT "unitPrice"::text AS "unitPrice" FROM "QuoteLine" WHERE id = $1`, [lineId])).unitPrice).toBe(priceBefore)
    const saved = await notHeld('owner', 'PUT', `${url}/options`, { version, picks: without })
    expect(saved.status).toBe(200)
  })

  it('a quote line typed by hand (not priced again): as Sales worker 403, nothing changes; the Owner saves it and the price stays', async () => {
    const jkt05 = (await one<{ id: string }>(`SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-05'`, [T])).id
    const blk = (await one<{ id: string }>(`SELECT id FROM "Colourway" WHERE "styleId" = $1 AND code = 'BLK'`, [jkt05])).id
    let quote = (await ok('owner', 'POST', '/sales/quotes', { companyId: companyA, partyId: P1 }, 201)).quote
    quote = (await ok('owner', 'POST', `/sales/quotes/${quote.id}/lines`, { version: quote.version, styleId: jkt05, colourwayId: blk, unitPrice: '455', sizes: [{ size: '52', quantity: 2 }] }, 201)).quote
    const line = quote.lines[0]
    const url = `/sales/quotes/${quote.id}/lines/${line.id}`
    expect((await ok('owner', 'GET', `${url}/configurator`)).pricing).toMatchObject({ held: 'NO_START' })
    const before = await optionsOf('QuoteLineOption', line.id)
    await held('sales', 'PUT', `${url}/options`, { version: quote.version, picks: [{ valueId: liner }, { valueId: armour }] }, 'body/picks')
    expect(await optionsOf('QuoteLineOption', line.id)).toEqual(before)
    // Options that add nothing (the standard armour, the default): Sales saves them.
    quote = (await ok('sales', 'PUT', `${url}/options`, { version: quote.version, picks: [{ valueId: armour }] })).quote
    quote = (await ok('owner', 'PUT', `${url}/options`, { version: quote.version, picks: [{ valueId: liner }, { valueId: armour }] })).quote
    expect((await one<{ unitPrice: string }>(`SELECT "unitPrice"::text AS "unitPrice" FROM "QuoteLine" WHERE id = $1`, [line.id])).unitPrice).toBe('455.000000')
  })
})

describe('B-CP-026 3. accepting a request whose agreed counter-offer carries a price', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  /** A request of Brand Alpha's order, COUNTERED as planted (the counter flow's own tests are change-requests' and brand-requests'). */
  async function countered(kind: 'CHANGE' | 'RUSH', counter: { fee: number | null; date: string | null }): Promise<{ id: string; version: number }> {
    const order = await one<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND "companyId" = $2 AND "partyId" = $3 AND status::text = 'CONFIRMED' ORDER BY number LIMIT 1`, [T, companyA, P1])
    const id = newId()
    await force(
      `INSERT INTO "OrderChangeRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, status, "requestedDate", "counteredAt", "counterDate", "counterFee", "counterNote", version, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6::"OrderChangeRequestKind", 'COUNTERED', current_date + 30, now(), $7::date, $8, 'Made-up: the earlier date needs overtime.', 2, now(), now())`,
      [id, T, companyA, P1, order.id, kind, counter.date, counter.fee],
    )
    return { id, version: 2 }
  }
  const statusOf = async (id: string) => (await one<{ status: string }>(`SELECT status::text AS status FROM "OrderChangeRequest" WHERE id = $1`, [id])).status

  it('the sales accept: as Sales worker 403, the request stays COUNTERED; the Owner passes the hold', async () => {
    const request = await countered('CHANGE', { fee: 2500, date: null })
    await held('sales', 'POST', `/sales/change-requests/${request.id}/accept`, { version: request.version, answer: 'Made-up: done.' }, 'request/counterFee')
    expect(await statusOf(request.id)).toBe('COUNTERED')
    await notHeld('owner', 'POST', `/sales/change-requests/${request.id}/accept`, { version: request.version, answer: 'Made-up: done.' })
  })

  it('the production accept: as Production manager 403, the request stays COUNTERED; the Owner passes the hold', async () => {
    const request = await countered('RUSH', { fee: 1500, date: null })
    await held('production', 'POST', `/production/brand-requests/${request.id}/accept`, { version: request.version, answer: 'Made-up: agreed.' }, 'request/counterFee')
    expect(await statusOf(request.id)).toBe('COUNTERED')
    await notHeld('owner', 'POST', `/production/brand-requests/${request.id}/accept`, { version: request.version, answer: 'Made-up: agreed.' })
  })

  it('a counter of a date only carries no price: Sales is not held', async () => {
    const request = await countered('CHANGE', { fee: null, date: '2027-03-01' })
    await notHeld('sales', 'POST', `/sales/change-requests/${request.id}/accept`, { version: request.version, answer: 'Made-up: done.' })
  })
})

describe('B-CP-026 4. deciding a return’s credit', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('as Sales worker 403, nothing decided; the Owner decides the credit', async () => {
    const rma = await one<{ id: string }>(`SELECT id FROM "ReturnAuthorisation" WHERE "tenantId" = $1 AND number = 'SEED-RMA-0001'`, [T])
    let record = (await ok('sales', 'GET', `/sales/returns/${rma.id}`)).return
    const lineId = record.lines[0].id as string
    // The jacket arrives and is graded (the dock's and quality's steps, here by the Owner).
    record = (await ok('owner', 'POST', `/sales/returns/${rma.id}/receipts`, { version: record.version, parcels: 1, parcelCondition: 'INTACT', lines: [{ lineId, quantity: 1 }] }, 201)).return
    record = (await ok('owner', 'POST', `/sales/returns/${rma.id}/grades`, { version: record.version, lines: [{ lineId, grade: 'NEW', cause: 'NO_FAULT' }] })).return
    const decision = { version: record.version, lines: [{ lineId, disposition: 'CREDIT_ONLY', goodsOutcome: 'SCRAP' }] }
    await held('sales', 'POST', `/sales/returns/${rma.id}/decisions`, decision, 'body/lines/0/disposition')
    expect(await one(`SELECT disposition::text AS disposition, "creditAmount" FROM "ReturnLine" WHERE id = $1`, [lineId])).toEqual({ disposition: null, creditAmount: null })
    const decided = (await ok('owner', 'POST', `/sales/returns/${rma.id}/decisions`, decision)).return
    expect(decided.lines[0]).toMatchObject({ disposition: 'CREDIT_ONLY', followUp: 'CREDIT_NOTE' })
    expect((await one<{ credit: number }>(`SELECT "creditAmount" AS credit FROM "ReturnLine" WHERE id = $1`, [lineId])).credit).toBeGreaterThan(0)
  })
})
