import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { BEFORE_ORDER_GROUPS } from '@nexus/factory-domain/sales/before-order/groups'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedMoney } from '../../../../../../packages/factory-db/seed/money'
import { seed as seedOptions } from '../../../../../../packages/factory-db/seed/options'
import { seed as seedPortalSales } from '../../../../../../packages/factory-db/seed/portal-sales'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedSalesIntake } from '../../../../../../packages/factory-db/seed/sales-intake'
import { seed as seedSamples } from '../../../../../../packages/factory-db/seed/samples'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { actorOf, completeContext, testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { beforeOrderCountsByParty } from './counts'

/**
 * B-CQ-002 / B-CQ-003 (customer page › Quotes & incoming, settle L11, C20; 13-backend ★, §1, §10 cases 1–6): GET
 * /sales/before-order/counts and the per-party helper beforeOrderCountsByParty — every group's number is the rows its door opens
 * (the quotes list with `group`, Incoming with its tile and `kinds=REQUEST,CATALOGUE_ORDER`, the drafts read), for every reader;
 * the helper gives each customer exactly the route's numbers; a person limited to one customer gets "Customer not found." for
 * another and 0s from the helper, never another customer's number; each kind follows its own right (null, never 0); counts only.
 * Through the app's real routes on a throwaway PostgreSQL 17 database from the migrations, the set-up of
 * modules/sales/incoming/incoming.pg (its seeds, + the samples seed), standing on these seed rows of customer P1 (Seed Customer
 * One): SEED-Q-0001 ACCEPTED with its order SEED-SO-0001 (WON), SEED-Q-0002 a DRAFT (PREPARING); SEED-INQ-0004 QUOTED (MOVED);
 * SEED-RQ-0001 SENT (TO_ANSWER), SEED-RQ-0002 ACCEPTED as SEED-SO-0002 (WON), SEED-RQ-0003 REFUSED (LOST), the DRAFT PO-SEED-7004
 * (WRITING); SEED-SR-0001 / -0003 sample rounds in progress. And of P3: SEED-INQ-0002 ASSIGNED (TO_ANSWER), SEED-INQ-0005 DECLINED
 * (LOST). States the seeds do not hold are written past the guards by the admin (test data), then put back. Made-up data only.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/before-order`.
 */

vi.setConfig({ testTimeout: 120_000 })

type Json = Record<string, any>

const NS = 'cq-before-order'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const P1 = idOf('party:P1')
const P3 = idOf('party:P3')
const companyA = idOf('company:A')
const rightsOf = (key: string): Permission[] => {
  const template = templateOf(key)!
  return [...template.permissions, ...template.grains.map((grain) => `money.${grain}`)] as Permission[]
}
const OWNER = rightsOf('owner')
const SALES = rightsOf('sales')
const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const office = (permissions: Permission[], parties: Grant['parties'] = 'all'): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [grant(permissions, parties)] })
const SESSIONS: Record<string, SessionContext> = {
  owner: office(OWNER),
  // The real Sales template: no grain (sees no money).
  sales: office(SALES),
  // The limited person (wall T30 / SEED-R1 pattern): every right, customer P1 only.
  onlyP1: office(OWNER, [P1]),
  salesP1: office(SALES, [P1]),
  // The real role templates: each kind follows the template's own rights.
  finance: office(rightsOf('finance')),
  production: office(rightsOf('production_manager')),
  readOnly: office(rightsOf('read_only')),
  // Hand-made right sets (13-backend §10 case 4): Finance-like (quotes and drafts, no requests right), Production-manager-like
  // (requests only), no orders right, no parties right (the route's own).
  quotesAndDrafts: office(['parties.view', 'quotes.view', 'orders.view'] as Permission[]),
  requestsOnly: office(['parties.view', 'sales.inquiries.view'] as Permission[]),
  noOrders: office(['parties.view', 'quotes.view', 'sales.inquiries.view'] as Permission[]),
  noParties: office(['quotes.view', 'sales.inquiries.view', 'orders.view'] as Permission[]),
  // B-CQ-030: the portal orders' pictures — orders.view without files.read (the style, never its file), and limited to one customer.
  pictures: office(['orders.view'] as Permission[]),
  picturesP1: office(['orders.view'] as Permission[], [P1]),
  picturesP3: office(['orders.view'] as Permission[], [P3]),
}

let h: Harness
let app: FastifyInstance
let portal: Awaited<ReturnType<typeof seedPortalSales>>
const run = randomBytes(4).toString('hex')
const call = (session: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-session': session, 'x-run': run } })
async function get(session: string, url: string): Promise<Json> {
  const response = await call(session, url)
  expect(response.statusCode, `${session} ${url}: ${response.body}`).toBe(200)
  return response.json()
}
const counts = (session: string, partyId: string, extra = ''): Promise<Json> => get(session, `/sales/before-order/counts?partyId=${partyId}${extra}`)
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
/** Writes test data past its own guards (the admin's session only), then back. */
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}

/** Every row of the quotes list for a query, page after page (2 a page). */
async function allQuotes(session: string, query: string): Promise<Json[]> {
  const rows: Json[] = []
  let cursor: string | null = null
  for (let page = 0; page < 200; page++) {
    const answer: Json = await get(session, `/sales/quotes?${query}&limit=2${cursor ? `&cursor=${cursor}` : ''}`)
    rows.push(...answer.quotes)
    cursor = answer.nextCursor
    if (!cursor) return rows
  }
  throw new Error('more than 200 pages')
}
/** Every row of Incoming for a query, page after page (2 a page). */
async function allIncoming(session: string, query: string): Promise<Json[]> {
  const rows: Json[] = []
  let cursor: string | null = null
  for (let page = 0; page < 200; page++) {
    const answer: Json = await get(session, `/sales/incoming?${query}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    rows.push(...answer.rows)
    cursor = answer.next
    if (!cursor) return rows
  }
  throw new Error('more than 200 pages')
}
const numbersOf = (rows: readonly Json[]): string[] => rows.map((row) => row.number)
/** Every key of an answer, at any depth. */
const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : [])
/** Every leaf value of an answer with its path. */
const leavesOf = (value: unknown, path = ''): [string, unknown][] => (value && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => leavesOf(item, path ? `${path}.${name}` : name)) : [[path, value]])

beforeAll(async () => {
  h = await startHarness('cq_before_order')
  // In the CLI's name order (each seed runs the ones it builds on itself).
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedMoney({ db: h.database, namespace: NS })
  await seedOptions({ db: h.database, namespace: NS })
  portal = await seedPortalSales({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
  await seedSamples({ db: h.database, namespace: NS })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('B-CQ-002 GET /sales/before-order/counts and the per-party helper', () => {
  it('case 1 — count = rows: every group, each kind and the open quotes are the rows their doors open (the Owner, on P1 and P3)', async () => {
    for (const party of [P1, P3]) {
      const answer = await counts('owner', party)
      expect(answer.partyId).toBe(party)
      expect(Date.parse(answer.asOf)).not.toBeNaN()
      const quotesIn = async (group: string): Promise<number> => (await allQuotes('owner', `partyId=${party}&group=${group}`)).length
      const incomingIn = async (tile: string): Promise<number> => (await allIncoming('owner', `partyId=${party}&kinds=REQUEST,CATALOGUE_ORDER&tile=${tile}`)).length
      const drafts = ((await get('owner', `/sales/order-requests?status=DRAFT&partyId=${party}`)).requests as Json[]).length
      expect(answer.groups.WRITING, 'WRITING').toBe(drafts)
      expect(answer.groups.TO_ANSWER, 'TO_ANSWER').toBe(await incomingIn('TO_ANSWER'))
      expect(answer.groups.PREPARING, 'PREPARING').toBe(await quotesIn('PREPARING'))
      expect(answer.groups.APPROVAL, 'APPROVAL').toBe(await quotesIn('APPROVAL'))
      expect(answer.groups.WAITING_CUSTOMER, 'WAITING_CUSTOMER').toBe((await quotesIn('WAITING_CUSTOMER')) + (await incomingIn('WAITING_CUSTOMER')))
      expect(answer.groups.ORDER_WAITS, 'ORDER_WAITS').toBe(await quotesIn('ORDER_WAITS'))
      expect(answer.groups.WON, 'WON').toBe((await quotesIn('WON')) + (await incomingIn('ORDERED')))
      expect(answer.groups.MOVED, 'MOVED').toBe(await incomingIn('QUOTED'))
      expect(answer.groups.LOST, 'LOST').toBe((await quotesIn('LOST')) + (await incomingIn('ENDED')))
      expect(answer.openQuotes, 'OPEN_QUOTES').toBe(await quotesIn('OPEN_QUOTES'))
      expect(answer.waitsOnUs).toBe(answer.groups.TO_ANSWER + answer.groups.ORDER_WAITS)
      // Each kind: the quotes' groups are their doors; the requests' and portal orders' split of the Incoming tiles by kind.
      for (const group of ['PREPARING', 'APPROVAL', 'WAITING_CUSTOMER', 'ORDER_WAITS', 'WON', 'LOST']) expect(answer.byKind.quotes[group], `quotes ${group}`).toBe(await quotesIn(group))
      const kindIn = async (tile: string, kind: string): Promise<number> => (await allIncoming('owner', `partyId=${party}&kinds=${kind}&tile=${tile}`)).length
      for (const [group, tile] of [['TO_ANSWER', 'TO_ANSWER'], ['WAITING_CUSTOMER', 'WAITING_CUSTOMER'], ['WON', 'ORDERED'], ['MOVED', 'QUOTED'], ['LOST', 'ENDED']] as const) expect(answer.byKind.requests[group], `requests ${group}`).toBe(await kindIn(tile, 'REQUEST'))
      for (const [group, tile] of [['TO_ANSWER', 'TO_ANSWER'], ['WON', 'ORDERED'], ['MOVED', 'QUOTED'], ['LOST', 'ENDED']] as const) expect(answer.byKind.portalOrders[group], `portal ${group}`).toBe(await kindIn(tile, 'CATALOGUE_ORDER'))
      expect(answer.byKind.drafts).toBe(answer.groups.WRITING)
    }
  })

  it('case 1 — the seed rows each sit behind their group’s door', async () => {
    const answer = await counts('owner', P1)
    const quotes = async (group: string) => numbersOf(await allQuotes('owner', `partyId=${P1}&group=${group}`))
    const incoming = async (tile: string) => numbersOf(await allIncoming('owner', `partyId=${P1}&kinds=REQUEST,CATALOGUE_ORDER&tile=${tile}`))
    expect(await quotes('WON')).toContain('SEED-Q-0001')
    expect(await quotes('PREPARING')).toContain('SEED-Q-0002')
    expect(await quotes('LIVE')).toContain('SEED-Q-0002')
    expect(await quotes('LIVE')).not.toContain('SEED-Q-0001')
    expect(await incoming('TO_ANSWER')).toContain('SEED-RQ-0001')
    expect(await incoming('ORDERED')).toContain('SEED-RQ-0002')
    expect(await incoming('ENDED')).toContain('SEED-RQ-0003')
    expect(await incoming('QUOTED')).toContain('SEED-INQ-0004')
    // P1's portal orders: one sent, one accepted as an order, one refused, one draft (the draft is no Incoming row).
    expect(answer.byKind.portalOrders).toEqual({ TO_ANSWER: 1, WON: 1, MOVED: 0, LOST: 1 })
    expect(answer.byKind.drafts).toBe(1)
    const drafts = ((await get('owner', `/sales/order-requests?status=DRAFT&partyId=${P1}`)).requests as Json[]).map((row) => row.id)
    expect(drafts).toEqual([portal.requests.draft])
    // P3's requests wait on us (the wall of case 3 hides real numbers, not empty ones).
    expect((await counts('owner', P3)).groups.TO_ANSWER).toBeGreaterThan(0)
  })

  it('B-CQ-003: the sample rounds in progress are Overview’s number (one rule); without a company, of every company', async () => {
    const withCompany = await counts('owner', P1, `&companyId=${companyA}`)
    const glance = await get('owner', `/sales/customer-360/${P1}?companyId=${companyA}`)
    expect(withCompany.sampleRounds).toBe(glance.samples.count)
    expect(withCompany.sampleRounds).toBeGreaterThan(0)
    const everyCompany = await counts('owner', P1)
    expect(everyCompany.sampleRounds).toBeGreaterThanOrEqual(withCompany.sampleRounds)
    // Without sales.samples.view: left out (null), never 0.
    expect((await counts('quotesAndDrafts', P1)).sampleRounds).toBeNull()
  })

  it('case 2 — the helper gives each customer exactly the route’s numbers, for the Owner, Sales and the limited person', async () => {
    for (const session of ['owner', 'sales', 'onlyP1', 'salesP1']) {
      const context = completeContext(SESSIONS[session]!, `cq-s1-${session}`)
      const many = await callerFor(h.database, context).withClient((client) => beforeOrderCountsByParty(client, actorOf(context), [P1, P3]))
      expect([...many.keys()]).toEqual([P1, P3])
      for (const party of [P1, P3]) {
        const response = await call(session, `/sales/before-order/counts?partyId=${party}`)
        if (response.statusCode === 404) continue // the limited person on P3: case 3
        expect(response.statusCode, `${session} ${response.body}`).toBe(200)
        const { partyId: _partyId, sampleRounds: _sampleRounds, asOf: _asOf, ...single } = response.json() as Json
        expect(many.get(party), `${session} ${party}`).toEqual(single)
      }
    }
  })

  it('case 3 — the person limited to P1: P3 is "Customer not found." as an unknown id; the helper gives P3 only 0s', async () => {
    for (const session of ['onlyP1', 'salesP1']) {
      const refused = await call(session, `/sales/before-order/counts?partyId=${P3}`)
      const unknown = await call(session, `/sales/before-order/counts?partyId=${newId()}`)
      expect([refused.statusCode, unknown.statusCode]).toEqual([404, 404])
      expect(refused.json().error.message).toBe('Customer not found.')
      expect(unknown.json().error.message).toBe(refused.json().error.message)
      expect(refused.body).not.toContain(P3)
      const context = completeContext(SESSIONS[session]!, `cq-s1-wall-${session}`)
      const many = await callerFor(h.database, context).withClient((client) => beforeOrderCountsByParty(client, actorOf(context), [P1, P3, newId()]))
      for (const [path, value] of leavesOf(many.get(P3))) expect(value === 0 || value === null, `${session} P3 ${path}`).toBe(true)
      // Its own customer: the Owner's numbers (every right, P1's rows only).
      const own = await counts(session, P1)
      expect(JSON.stringify(own)).not.toContain(P3)
    }
    const limited = await counts('onlyP1', P1)
    const owner = await counts('owner', P1)
    const { asOf: _a, ...limitedRest } = limited
    const { asOf: _b, ...ownerRest } = owner
    expect(limitedRest).toEqual(ownerRest)
    // The helper refuses more than 50 customers in words; a malformed or missing customer is refused by the route.
    const context = completeContext(SESSIONS.owner!, 'cq-s1-max')
    await expect(callerFor(h.database, context).withClient((client) => beforeOrderCountsByParty(client, actorOf(context), Array.from({ length: 51 }, () => newId())))).rejects.toThrow('At most 50 customers at once.')
    for (const url of ['/sales/before-order/counts', '/sales/before-order/counts?partyId=not-an-id', `/sales/before-order/counts?partyId=${P1}&companyId=nope`]) {
      const bad = await call('owner', url)
      expect(bad.statusCode, url).toBe(400)
    }
    const missing = await call('owner', '/sales/before-order/counts')
    expect(JSON.stringify(missing.json().error.issues)).toContain('querystring/partyId')
    expect(JSON.stringify(missing.json().error.issues)).toContain('Name the customer.')
  })

  it('case 4 — each kind follows its own right: null (left out), never 0', async () => {
    const owner = await counts('owner', P1)
    // Finance-like: quotes and drafts, no requests right — no request, no sent portal order (C20, C35).
    const finance = await counts('quotesAndDrafts', P1)
    expect(finance.byKind).toMatchObject({ requests: null, portalOrders: null, drafts: owner.byKind.drafts })
    expect(finance.groups).toMatchObject({ TO_ANSWER: null, MOVED: null, WRITING: owner.groups.WRITING, WON: owner.byKind.quotes.WON, LOST: owner.byKind.quotes.LOST, WAITING_CUSTOMER: owner.byKind.quotes.WAITING_CUSTOMER })
    expect(finance.waitsOnUs).toBe(owner.groups.ORDER_WAITS)
    // Production-manager-like: requests only.
    const production = await counts('requestsOnly', P1)
    expect(production.byKind).toMatchObject({ quotes: null, portalOrders: null, drafts: null, requests: owner.byKind.requests })
    expect(production.groups).toMatchObject({ WRITING: null, PREPARING: null, APPROVAL: null, ORDER_WAITS: null, TO_ANSWER: owner.byKind.requests.TO_ANSWER })
    expect(production.openQuotes).toBeNull()
    // No orders right: no draft, no portal order.
    const noOrders = await counts('noOrders', P1)
    expect(noOrders.byKind).toMatchObject({ drafts: null, portalOrders: null })
    expect(noOrders.groups.WRITING).toBeNull()
    // The route's own right.
    expect((await call('noParties', `/sales/before-order/counts?partyId=${P1}`)).statusCode).toBe(403)
    // The real templates, each by its own rights.
    for (const session of ['finance', 'production', 'readOnly', 'sales']) {
      const rights = new Set(SESSIONS[session]!.grants[0]!.permissions)
      const response = await call(session, `/sales/before-order/counts?partyId=${P1}`)
      if (!rights.has('parties.view' as Permission)) {
        expect(response.statusCode, session).toBe(403)
        continue
      }
      expect(response.statusCode, `${session} ${response.body}`).toBe(200)
      const answer = response.json() as Json
      const has = (permission: string) => rights.has(permission as Permission)
      expect(answer.byKind.quotes === null, `${session} quotes`).toBe(!has('quotes.view'))
      expect(answer.byKind.requests === null, `${session} requests`).toBe(!has('sales.inquiries.view'))
      expect(answer.byKind.portalOrders === null, `${session} portal`).toBe(!(has('orders.view') && has('sales.inquiries.view')))
      expect(answer.byKind.drafts === null, `${session} drafts`).toBe(!has('orders.view'))
      if (answer.byKind.quotes) expect(answer.byKind.quotes, session).toEqual(owner.byKind.quotes)
    }
    // Read-only reads every kind: numbers everywhere.
    const readOnly = await counts('readOnly', P1)
    for (const group of BEFORE_ORDER_GROUPS) expect(typeof readOnly.groups[group], `readOnly ${group}`).toBe('number')
  })

  it('case 5 — the money wall: Sales’ answer holds counts only (no amount, no person: a deep key walk)', async () => {
    const answer = await counts('sales', P1, `&companyId=${companyA}`)
    const allowed = new Set(['partyId', 'groups', 'openQuotes', 'waitsOnUs', 'byKind', 'quotes', 'requests', 'portalOrders', 'drafts', 'sampleRounds', 'asOf', ...BEFORE_ORDER_GROUPS])
    for (const key of keysOf(answer)) expect(allowed.has(key), key).toBe(true)
    for (const [path, value] of leavesOf(answer)) {
      if (path === 'partyId' || path === 'asOf') continue
      expect(value === null || (Number.isInteger(value) && (value as number) >= 0), `${path}: ${String(value)}`).toBe(true)
    }
  })

  it('case 6 — a draft counts in WRITING only; an accepted quote whose order was cancelled stays WON; an expired quote is LOST and, made a draft again, PREPARING', async () => {
    const before = await counts('owner', P1)
    // SEED-RQ-0001 back to a draft (test data): WRITING one more, TO_ANSWER one less, no other group moves.
    await force(`UPDATE "PortalOrderRequest" SET status = 'DRAFT' WHERE id = $1`, [portal.requests.sent])
    try {
      const drafted = await counts('owner', P1)
      expect(drafted.groups.WRITING).toBe(before.groups.WRITING + 1)
      expect(drafted.groups.TO_ANSWER).toBe(before.groups.TO_ANSWER - 1)
      expect(drafted.waitsOnUs).toBe(before.waitsOnUs - 1)
      for (const group of ['PREPARING', 'APPROVAL', 'WAITING_CUSTOMER', 'ORDER_WAITS', 'WON', 'MOVED', 'LOST']) expect(drafted.groups[group], group).toBe(before.groups[group])
    } finally {
      await force(`UPDATE "PortalOrderRequest" SET status = 'SENT' WHERE id = $1`, [portal.requests.sent])
    }
    // SEED-SO-0001 cancelled: SEED-Q-0001 keeps its order (an order exists on its version) — still WON, no order waits.
    const order = (await admin<{ id: string; status: string }>(`SELECT id, status::text AS status FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0001'`, [T]))[0]!
    await force(`UPDATE "SalesOrder" SET status = 'CANCELLED' WHERE id = $1`, [order.id])
    try {
      const cancelled = await counts('owner', P1)
      expect(cancelled.byKind.quotes.WON).toBe(before.byKind.quotes.WON)
      expect(cancelled.groups.ORDER_WAITS).toBe(before.groups.ORDER_WAITS)
      expect(numbersOf(await allQuotes('owner', `partyId=${P1}&group=WON`))).toContain('SEED-Q-0001')
    } finally {
      await force(`UPDATE "SalesOrder" SET status = $2::"SalesOrderStatus" WHERE id = $1`, [order.id, order.status])
    }
    // SEED-Q-0002 expired (test data): LOST one more, PREPARING one less; a revision makes it a draft again: PREPARING.
    const draft = (await admin<{ id: string }>(`SELECT id FROM "Quote" WHERE "tenantId" = $1 AND number = 'SEED-Q-0002'`, [T]))[0]!.id
    await force(`UPDATE "Quote" SET status = 'EXPIRED' WHERE id = $1`, [draft])
    try {
      const expired = await counts('owner', P1)
      expect(expired.groups.LOST).toBe(before.groups.LOST + 1)
      expect(expired.groups.PREPARING).toBe(before.groups.PREPARING - 1)
      expect(expired.openQuotes).toBe(before.openQuotes - 1)
    } finally {
      await force(`UPDATE "Quote" SET status = 'DRAFT' WHERE id = $1`, [draft])
    }
    const revised = await counts('owner', P1)
    expect(revised.groups.PREPARING).toBe(before.groups.PREPARING)
    expect(revised.groups.LOST).toBe(before.groups.LOST)
  })
})

// ---- B-CQ-030 (customer page › Quotes & incoming, L12, Q3; 13-backend §5): the portal orders' small pictures, drafts too -----------
describe('B-CQ-030 POST /sales/order-requests/pictures', () => {
  let serial = 0
  const post = (session: string, requestIds: readonly string[]) =>
    app.inject({ method: 'POST', url: '/sales/order-requests/pictures', payload: { requestIds }, headers: { 'x-test-session': session, 'x-run': run, 'idempotency-key': `cq-s1-pictures-${run}-${++serial}` } })
  /** Each request's first line that names a style, and how many styles its lines name (the seeds' lines). */
  const stylesOf = async (requestIds: readonly string[]): Promise<Map<string, { first: string; count: number }>> => {
    const rows = await admin<{ requestId: string; styleId: string }>(`SELECT "requestId"::text AS "requestId", "styleId"::text AS "styleId" FROM "PortalOrderRequestLine" WHERE "requestId" = ANY($1::uuid[]) AND "styleId" IS NOT NULL ORDER BY "requestId", seq`, [requestIds])
    const out = new Map<string, { first: string; count: number }>()
    for (const id of requestIds) {
      const own = rows.filter((row) => row.requestId === id).map((row) => row.styleId)
      if (own.length > 0) out.set(id, { first: own[0]!, count: new Set(own).size })
    }
    return out
  }

  it('P1’s sent, accepted and refused orders and its draft: each its first style, in the asked order; no files.read: no file', async () => {
    const asked = [portal.requests.draft, portal.requests.sent, portal.requests.accepted, portal.requests.refused]
    const response = await post('pictures', asked)
    expect(response.statusCode, response.body).toBe(200)
    const answer = response.json() as Json
    expect(Date.parse(answer.asOf)).not.toBeNaN()
    const styles = await stylesOf(asked)
    expect((answer.pictures as Json[]).map((picture) => picture.id)).toEqual(asked.filter((id) => styles.has(id)))
    for (const picture of answer.pictures as Json[]) {
      expect(picture.styleId, picture.id).toBe(styles.get(picture.id)!.first)
      expect(picture.styleCount, picture.id).toBe(styles.get(picture.id)!.count)
      expect(picture).toMatchObject({ fileId: null, contentType: null, small: null, styleCode: expect.any(String), styleName: expect.any(String) })
    }
    // The draft names two styles (the seeds' spring restock).
    expect((answer.pictures as Json[]).find((picture) => picture.id === portal.requests.draft)?.styleCount).toBe(2)
  })

  it('the wall: a person limited to P3 asking for P1’s orders gets nothing (as unknown ids); limited to P1, the same as everyone', async () => {
    const asked = [portal.requests.draft, portal.requests.sent]
    const other = await post('picturesP3', asked)
    expect(other.statusCode, other.body).toBe(200)
    expect((other.json() as Json).pictures).toEqual([])
    const unknown = await post('picturesP3', [newId(), newId()])
    expect((unknown.json() as Json).pictures).toEqual([])
    const own = (await post('picturesP1', asked)).json() as Json
    const everyone = (await post('pictures', asked)).json() as Json
    expect(own.pictures).toEqual(everyone.pictures)
  })

  it('the route asks orders.view; each id once; 1–200 ids', async () => {
    expect((await post('noOrders', [portal.requests.sent])).statusCode).toBe(403)
    expect((await post('pictures', [portal.requests.sent, portal.requests.sent])).statusCode).toBe(400)
    expect((await post('pictures', [])).statusCode).toBe(400)
  })
})
// ---- end B-CQ-030
