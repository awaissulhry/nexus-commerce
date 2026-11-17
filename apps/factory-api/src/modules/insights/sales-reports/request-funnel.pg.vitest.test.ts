import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
// This file fixes its clock on a day of the seeds' story, so it runs the seeds as written (seed-calendar, B-W2b-F53).
await vi.hoisted(async () => (await import('@nexus/factory-db/testing')).seedsAsWritten())

/**
 * B-TH-052 (threads plan L2-G10, X-SAL-REPORTS.drill; wall W27/W30, test T30): the request-to-order figure on Sales › Reports,
 * GET /sales/reports/requests, through the app's real routes on a throwaway PostgreSQL 17 database (the runtime login: row-level
 * security is real), tenant A from EVERY seed. The test's world is company B (the seeds ask nothing there): requests, quotes and
 * orders copied from seed rows with made-up numbers and dates. The clock is 30 November 2026; the default period is November.
 *
 *   I1  customer A (SEED-C1), 2 Nov, QUOTED with Q1 — an order was made from Q1's version (O1): quoted and ordered
 *   I2  customer A, 10 Nov, QUOTED with Q2 (no order)
 *   I3  customer A, 12 Nov, ORDERED (Make order: O2)
 *   I4  customer B (SEED-C2), 18 Nov, DECLINED (price) · I5 customer B, 20 Nov, NEW · I6 customer B, 21 Nov, "Not an order"
 *   I7  customer B, 25 Nov, QUOTED with Q3 whose order (O3) was cancelled: quoted, not ordered
 *   I8  a prospect (a made-up company), 24 Nov, NEED_INFO
 *   I9  customer A, 15 Oct: outside the default period
 *   I10 customer B, 27 Nov, WITHDRAWN by B from its portal before we decided (B-TH-095): its own part, in the rates' whole
 * Every name and number is made up.
 */

type Json = Record<string, any>

const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'request-funnel-th052'
const sid = (key: string) => seedUuid(NS, key)
const T = sid('tenant')
const COMPANY_B = sid('company:B')
const NOW = new Date('2026-11-30T15:00:00.000Z')
const PROSPECT = { company: 'Made-up Prospect Srl', name: 'Made-up Person', email: 'prospect@example.com' }

let h: Harness
let app: FastifyInstance
let A: { id: string; code: string; legalName: string; tradeName: string | null }
let B: { id: string; code: string; legalName: string; tradeName: string | null }
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!

/** A copy of a seed row with some columns changed (test data past the guards: replica mode, one connection). */
async function copy(table: string, sourceId: string, changes: Record<string, unknown>): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(`CREATE TEMP TABLE _copy AS SELECT * FROM "${table}" WHERE id = $1`, [sourceId])
    const keys = Object.keys(changes)
    await admin(`UPDATE _copy SET ${keys.map((key, index) => `"${key}" = $${index + 1}`).join(', ')}`, Object.values(changes))
    await admin(`INSERT INTO "${table}" SELECT * FROM _copy`)
  } finally {
    await admin('DROP TABLE IF EXISTS _copy')
    await admin('SET session_replication_role = DEFAULT')
  }
}

function grantsOf(role: string, options: { without?: string[]; parties?: string[] } = {}): Grant[] {
  const template = templateOf(role)!
  const permissions = [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)].filter((name) => !(options.without ?? []).includes(name)) as Permission[]
  return [{ permissions, companies: 'all', sites: 'all', parties: options.parties ?? 'all' }]
}
const SESSIONS: Record<string, () => SessionContext> = {}
const session = (grants: Grant[]) => (): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), companyId: COMPANY_B, grants }) as SessionContext

const call = (who: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-session': who } })
async function ok(who: string, url: string): Promise<Json> {
  const response = await call(who, url)
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as Json
}
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : []
const group = (answer: Json, key: string) => answer.groups.find((row: Json) => row.key === key)

beforeAll(async () => {
  h = await startHarness('request_funnel_th052')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  const party = (code: string) => one<{ id: string; code: string; legalName: string; tradeName: string | null }>(`SELECT id, code, "legalName", "tradeName" FROM "Party" WHERE "tenantId" = $1 AND code = $2`, [T, code])
  A = await party('SEED-C1')
  B = await party('SEED-C2')
  const id = async (sql: string, values: unknown[] = []) => (await one<{ id: string }>(sql, [T, ...values])).id
  const srcOrder = await id(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0001'`)
  const srcQuote = await id(`SELECT id FROM "Quote" WHERE "tenantId" = $1 AND number = 'SEED-Q-0001'`)
  const srcVersion = await id(`SELECT id FROM "QuoteVersion" WHERE "tenantId" = $1 AND "quoteId" = $2 ORDER BY revision LIMIT 1`, [srcQuote])
  const srcInquiry = await id(`SELECT id FROM "Inquiry" WHERE "tenantId" = $1 ORDER BY number LIMIT 1`)

  const quote = async (number: string, partyId: string): Promise<{ quoteId: string; versionId: string }> => {
    const quoteId = newId()
    const versionId = newId()
    await copy('Quote', srcQuote, { id: quoteId, number, companyId: COMPANY_B, partyId, customerSeq: null, status: 'ACCEPTED', templateId: null, contactId: null })
    await copy('QuoteVersion', srcVersion, { id: versionId, quoteId, partyId, revision: 1, status: 'ACCEPTED', seasonId: null, priceListVersionId: null, taxIdentityId: null, billToAddressId: null, shipToAddressId: null, paymentTermsId: null })
    return { quoteId, versionId }
  }
  const order = async (number: string, partyId: string, status: string, quoteVersionId: string | null): Promise<string> => {
    const orderId = newId()
    await copy('SalesOrder', srcOrder, { id: orderId, number, companyId: COMPANY_B, partyId, customerSeq: null, status, orderDate: '2026-11-15', promiseDate: null, originalPromiseDate: null, seasonId: null, quoteVersionId, backlogRank: null, closedAt: null })
    return orderId
  }
  const request = (number: string, partyId: string | null, receivedAt: string, status: string, extra: Record<string, unknown> = {}) =>
    copy('Inquiry', srcInquiry, {
      id: newId(),
      number,
      companyId: COMPANY_B,
      partyId,
      contactId: null,
      customerSeq: null,
      receivedAt: new Date(receivedAt),
      status,
      quoteId: null,
      salesOrderId: null,
      declineReason: null,
      closedAt: null,
      sourceEmailId: null,
      assigneeId: null,
      assignedAt: null,
      shipToAddressId: null,
      techPackFileIds: [],
      styleIds: [],
      prospectName: null,
      prospectCompany: null,
      prospectEmail: null,
      prospectPhone: null,
      prospectLawfulBasis: null,
      ...extra,
    })

  const q1 = await quote('T052-Q-1', A.id)
  const q2 = await quote('T052-Q-2', A.id)
  const q3 = await quote('T052-Q-3', B.id)
  await order('T052-SO-1', A.id, 'CONFIRMED', q1.versionId)
  const o2 = await order('T052-SO-2', A.id, 'CONFIRMED', null)
  await order('T052-SO-3', B.id, 'CANCELLED', q3.versionId)
  await request('T052-INQ-1', A.id, '2026-11-02T08:00:00Z', 'QUOTED', { quoteId: q1.quoteId, closedAt: new Date('2026-11-03T08:00:00Z') })
  await request('T052-INQ-2', A.id, '2026-11-10T08:00:00Z', 'QUOTED', { quoteId: q2.quoteId, closedAt: new Date('2026-11-11T08:00:00Z') })
  await request('T052-INQ-3', A.id, '2026-11-12T08:00:00Z', 'ORDERED', { salesOrderId: o2, closedAt: new Date('2026-11-13T08:00:00Z') })
  await request('T052-INQ-4', B.id, '2026-11-18T08:00:00Z', 'DECLINED', { declineReason: 'PRICE', closedAt: new Date('2026-11-19T08:00:00Z') })
  await request('T052-INQ-5', B.id, '2026-11-20T08:00:00Z', 'NEW')
  await request('T052-INQ-6', B.id, '2026-11-21T08:00:00Z', 'DECLINED', { declineReason: 'NOT_AN_ORDER', closedAt: new Date('2026-11-21T09:00:00Z') })
  await request('T052-INQ-7', B.id, '2026-11-25T08:00:00Z', 'QUOTED', { quoteId: q3.quoteId, closedAt: new Date('2026-11-26T08:00:00Z') })
  await request('T052-INQ-8', null, '2026-11-24T08:00:00Z', 'NEED_INFO', { prospectCompany: PROSPECT.company, prospectName: PROSPECT.name, prospectEmail: PROSPECT.email, prospectLawfulBasis: 'CONTRACT' })
  await request('T052-INQ-9', A.id, '2026-10-15T08:00:00Z', 'NEW')
  // B-TH-095: withdrawn by the customer (test data past the guards: the portal's route itself is withdraw.pg's).
  await request('T052-INQ-10', B.id, '2026-11-27T08:00:00Z', 'WITHDRAWN', { closedAt: new Date('2026-11-27T09:00:00Z') })

  SESSIONS.sales = session(grantsOf('sales'))
  // T30: a person limited to customer A on every grant (RoleAssignment.partyIds as the session holds it).
  SESSIONS.limitedA = session(grantsOf('sales', { parties: [A.id] }))
  SESSIONS.manager = session(grantsOf('production_manager'))
  SESSIONS.noOrders = session(grantsOf('sales', { without: ['orders.view', 'orders.manage'] }))
  SESSIONS.noRequests = session(grantsOf('sales', { without: ['sales.inquiries.view', 'sales.inquiries.manage'] }))
  SESSIONS.noReports = session(grantsOf('sales', { without: ['sales.reports.view'] }))
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
}, 600_000)

afterAll(async () => {
  vi.useRealTimers()
  await app?.close()
  await h?.close()
}, 60_000)

describe('B-TH-052 the request-to-order figure (GET /sales/reports/requests)', () => {
  it('counts the requests received in November and what each became: quoted, ordered (straight or from its quote), declined, withdrawn, open; "Not an order" apart', async () => {
    const answer = await ok('sales', '/sales/reports/requests')
    expect(answer).toMatchObject({ from: '2026-11-01', to: '2026-11-30', by: 'week', sight: { requests: true, orders: true }, more: 0, complete: true })
    // B-TH-095: the withdrawn request (I10) is a part of its own and stays in the rates' whole (9 − 1 "Not an order" = 8).
    expect(answer.all).toEqual({ received: 9, open: 2, quoted: 3, ordered: 2, declined: 1, lost: 0, withdrawn: 1, notAnOrder: 1, quotedPct: '37.5', orderedPct: '25.0' })
    expect(answer.buckets.reduce((sum: number, bucket: Json) => sum + bucket.figures.received, 0)).toBe(9)
    expect(answer.buckets.every((bucket: Json) => bucket.from >= '2026-11-01' && bucket.to <= '2026-11-30')).toBe(true)
    // By customer, the most requests first; each names its customer so the page opens Incoming for it.
    expect(answer.groups.map((row: Json) => [row.key, row.partyId, row.code, row.figures.received])).toEqual([
      [B.id, B.id, B.code, 5],
      [A.id, A.id, A.code, 3],
      ['prospects', null, null, 1],
    ])
    expect(group(answer, A.id)).toMatchObject({ name: A.tradeName ?? A.legalName, figures: { quoted: 2, ordered: 2, orderedPct: '66.7' } })
    expect(group(answer, B.id).figures).toMatchObject({ received: 5, quoted: 1, ordered: 0, declined: 1, withdrawn: 1, notAnOrder: 1, open: 1, quotedPct: '25.0' })
    expect(group(answer, A.id).buckets.reduce((sum: number, bucket: Json) => sum + bucket.figures.received, 0)).toBe(3)
  })

  it('the prospects are one group with no name: never a prospect’s company, name or e-mail; no money, no person', async () => {
    const answer = await ok('sales', '/sales/reports/requests')
    expect(group(answer, 'prospects')).toMatchObject({ partyId: null, code: null, name: null, figures: { received: 1, open: 1 } })
    const text = JSON.stringify(answer)
    for (const word of Object.values(PROSPECT)) expect(text).not.toContain(word)
    const keys = keysOf(answer)
    for (const name of ['value', 'netAmount', 'targetUnitPrice', 'assigneeId', 'createdById', 'email', 'number']) expect(keys, name).not.toContain(name)
  })

  it('by month over a period the reader names; October counts in its own month', async () => {
    const answer = await ok('sales', '/sales/reports/requests?from=2026-10-01&to=2026-11-30&by=month')
    expect(answer.buckets.map((bucket: Json) => [bucket.key, bucket.figures.received])).toEqual([
      ['2026-10', 1],
      ['2026-11', 9],
    ])
    expect(answer.all.received).toBe(10)
  })

  it('T30: a person limited to customer A gets A’s figures only — no row, id, code, name or count of customer B anywhere', async () => {
    const answer = await ok('limitedA', '/sales/reports/requests')
    expect(answer.groups.map((row: Json) => row.key)).toEqual([A.id, 'prospects'])
    expect(answer.all).toMatchObject({ received: 4, quoted: 2, ordered: 2, declined: 0, notAnOrder: 0, open: 1 })
    const text = JSON.stringify(answer)
    expect(answer.all.withdrawn).toBe(0)
    for (const word of [B.id, B.code, B.legalName, ...(B.tradeName ? [B.tradeName] : []), 'T052-INQ-4', 'T052-INQ-10', 'T052-SO-3']) expect(text, word).not.toContain(word)
    expect(answer.buckets.reduce((sum: number, bucket: Json) => sum + bucket.figures.received, 0)).toBe(4)
  })

  it('each figure only within the reader’s own rights: no orders.view — an order made from a quote is not counted; no requests — null, never 0', async () => {
    const noOrders = await ok('noOrders', '/sales/reports/requests')
    expect(noOrders.sight).toMatchObject({ orders: false, requests: true })
    expect(noOrders.all).toMatchObject({ received: 9, quoted: 3, ordered: 1 })
    const noRequests = await ok('noRequests', '/sales/reports/requests')
    expect(noRequests).toMatchObject({ sight: { requests: false }, all: null, buckets: [], groups: [], more: 0 })
    // The production manager reads requests (B-TH-014) and the reports: the same counts, no amount anywhere.
    const manager = await ok('manager', '/sales/reports/requests')
    expect(manager.all.received).toBe(9)
  })

  it('refuses in words: no sales reports in the role (403), a period after today (400), an unknown key (400)', async () => {
    const forbidden = await call('noReports', '/sales/reports/requests')
    expect(forbidden.statusCode).toBe(403)
    expect((forbidden.json() as Json).error.message).toBeTruthy()
    const later = await call('sales', '/sales/reports/requests?to=2026-12-01')
    expect(later.statusCode).toBe(400)
    expect((later.json() as Json).error.message).toMatch(/after today/)
    expect((await call('sales', '/sales/reports/requests?split=customer')).statusCode).toBe(400)
  })
})

// ---- B-TH-235 (web: Sales › Reports' request figure, every figure a door to Sales › Incoming; Owner rule "every total opens its
// rows"): each figure's door — the list's tile, `outcome` (what a request became), the company and the days — lists exactly the
// requests the figure counts, on the list the page reads today (GET /sales/inquiries) and on Incoming's one read (GET
// /sales/incoming, the export's), for every customer group, the prospects and a week; a limited reader's doors stay inside A.
// The doors are the web's (apps/factory-web areas/sales/reports/model.ts requestsDoor): change both together.
const DOORS: Record<string, { tile: string; outcome?: string }> = {
  received: { tile: 'ALL' },
  open: { tile: 'OPEN' },
  quoted: { tile: 'QUOTED' },
  ordered: { tile: 'ALL', outcome: 'ORDERED' },
  declined: { tile: 'ALL', outcome: 'DECLINED' },
  lost: { tile: 'LOST' },
  // B-TH-095: the customer's withdrawals open on their own outcome (the LOST tile keeps the office's "went away").
  withdrawn: { tile: 'ALL', outcome: 'WITHDRAWN' },
  notAnOrder: { tile: 'ALL', outcome: 'NOT_AN_ORDER' },
}
const doorQuery = (figure: string, scope: { from: string; to: string; partyId?: string | null; prospect?: boolean }) => {
  const door = DOORS[figure]!
  // The company the figure counts (the screen's): the list reaches every company of the person's grant.
  const terms = new URLSearchParams({ tile: door.tile, companyId: COMPANY_B, receivedFrom: scope.from, receivedTo: scope.to })
  if (door.outcome) terms.set('outcome', door.outcome)
  if (scope.prospect) terms.set('prospect', 'true')
  else if (scope.partyId) terms.set('partyId', scope.partyId)
  return terms.toString()
}
async function doorCount(who: string, figure: string, scope: Parameters<typeof doorQuery>[1]): Promise<{ inquiries: number; incoming: number }> {
  const query = doorQuery(figure, scope)
  const inquiries = await ok(who, `/sales/inquiries?${query}`)
  // Incoming's one read lists every kind: the door names requests (the figure counts requests only).
  const incoming = await ok(who, `/sales/incoming?${query}&kind=REQUEST`)
  return { inquiries: inquiries.counts[DOORS[figure]!.tile], incoming: incoming.counts[DOORS[figure]!.tile] }
}

describe('B-TH-235 every figure of the request figure opens exactly its rows in Sales › Incoming', () => {
  it('the period, each customer, the prospects and one week: the door lists as many requests as the figure says (both reads)', async () => {
    const answer = await ok('sales', '/sales/reports/requests')
    const period = { from: answer.from as string, to: answer.to as string }
    for (const figure of Object.keys(DOORS)) {
      expect(await doorCount('sales', figure, period), `all ${figure}`).toEqual({ inquiries: answer.all[figure], incoming: answer.all[figure] })
      for (const row of answer.groups as Json[]) {
        const scope = { ...period, partyId: row.partyId as string | null, prospect: row.key === 'prospects' }
        expect(await doorCount('sales', figure, scope), `${row.key} ${figure}`).toEqual({ inquiries: row.figures[figure], incoming: row.figures[figure] })
      }
    }
    const week = (answer.buckets as Json[]).find((bucket) => bucket.figures.received > 0 && bucket.figures.ordered > 0)!
    for (const figure of Object.keys(DOORS)) expect(await doorCount('sales', figure, { from: week.from, to: week.to }), `${week.key} ${figure}`).toEqual({ inquiries: week.figures[figure], incoming: week.figures[figure] })
  })

  it('an order made from a quote counts as ordered only for a reader who may see orders — the door says the same', async () => {
    const answer = await ok('noOrders', '/sales/reports/requests')
    const period = { from: answer.from as string, to: answer.to as string }
    expect(answer.all.ordered).toBe(1)
    expect((await ok('noOrders', `/sales/inquiries?${doorQuery('ordered', period)}`)).counts.ALL).toBe(1)
  })

  it('T30: a person limited to customer A opens A’s rows only; the door names no row of customer B', async () => {
    const answer = await ok('limitedA', '/sales/reports/requests')
    const period = { from: answer.from as string, to: answer.to as string }
    for (const figure of Object.keys(DOORS)) expect(await doorCount('limitedA', figure, period), figure).toEqual({ inquiries: answer.all[figure], incoming: answer.all[figure] })
    const listed = await ok('limitedA', `/sales/inquiries?${doorQuery('received', period)}`)
    expect(listed.rows.map((row: Json) => row.party?.id ?? null).filter((party: string | null) => party === B.id)).toEqual([])
    expect(JSON.stringify(listed)).not.toContain(B.code)
  })

  it('the doors refuse a word that is not a request outcome (400), and the export reads the same address terms', async () => {
    expect((await call('sales', '/sales/inquiries?outcome=SHIPPED')).statusCode).toBe(400)
    expect((await call('sales', '/sales/incoming?outcome=QUOTED')).statusCode).toBe(400)
    const { inquiries } = await import('../../sales/inquiries/export-source')
    const query = inquiries.query(new URLSearchParams('tile=ALL&from=2026-11-09&to=2026-11-15&outcome=ORDERED&party=' + A.id))
    expect(query).toMatchObject({ tile: 'ALL', receivedFrom: '2026-11-09', receivedTo: '2026-11-15', outcome: 'ORDERED', partyId: A.id })
    expect(inquiries.query(new URLSearchParams('from=11/2026&outcome=SHIPPED'))).not.toHaveProperty('outcome')
  })
})
// ---- end B-TH-235
