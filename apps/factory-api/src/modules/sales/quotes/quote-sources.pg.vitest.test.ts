import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedSalesIntake } from '../../../../../../packages/factory-db/seed/sales-intake'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * B-TH-078 (threads plan TH-6, ORD-G03): the quote reads its request and its order — on the record (GET /sales/quotes/:id)
 * and on the list (GET /sales/quotes): "Made from INQ-…", the order made from the accepted quote (a cancelled one says so),
 * and "Order waits" with why when an accepted quote has no order (no order numbering for the company, or not made yet).
 *
 * On a throwaway database from the migrations with the core and sales-intake seeds (SEED-Q-0001 ACCEPTED, made from
 * SEED-INQ-0004, its order SEED-SO-0001; SEED-Q-0002 a DRAFT made by hand). The states the seeds do not hold (SEED-Q-0002
 * accepted without its order, a closed series, a cancelled order) are written by the admin past the guards: they are test
 * data; the reads under test run as the runtime login. Run with `node scripts/factory/run-pg-tests.mjs quotes/quote-sources`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = 'thq-a'
const A = { tenant: seedUuid(ns, 'tenant'), companyA: seedUuid(ns, 'company:A') }
const S: Record<string, string> = {}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
/** Writes test data past its own guards (the admin's session only), then back. */
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}

const VIEW: Permission[] = ['quotes.view']
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, () => SessionContext> = {
  sales: () => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(VIEW)] }),
}
async function get(url: string): Promise<Json> {
  const response = await app.inject({ method: 'GET', url, headers: { 'x-test-session': 'sales' } })
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as Json
}
const record = async (quoteId: string) => (await get(`/sales/quotes/${quoteId}`)).quote
const row = async (quoteId: string) => ((await get('/sales/quotes?limit=200')).quotes as Json[]).find((quote) => quote.id === quoteId)!

beforeAll(async () => {
  db = await migratedDatabase('quote_sources')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: ns })
  await seedSalesIntake({ db: database, namespace: ns })
  const id = async (table: string, number: string) => (await admin<{ id: string }>(`SELECT id FROM "${table}" WHERE "tenantId" = $1 AND number = $2`, [A.tenant, number]))[0]!.id
  S.accepted = await id('Quote', 'SEED-Q-0001')
  S.draft = await id('Quote', 'SEED-Q-0002')
  S.inquiry = await id('Inquiry', 'SEED-INQ-0004')
  S.order = await id('SalesOrder', 'SEED-SO-0001')
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null), logger: false },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('B-TH-078: the quote reads its request and its order', () => {
  it('an accepted quote made from a request: "Made from SEED-INQ-0004" and its order, on the record and on the list', async () => {
    const quote = await record(S.accepted!)
    expect(quote.madeFrom).toEqual({ inquiryId: S.inquiry, number: 'SEED-INQ-0004' })
    expect(quote.order).toEqual({ state: 'MADE', id: S.order, number: 'SEED-SO-0001', status: 'CONFIRMED', reason: null, words: null })
    const listed = await row(S.accepted!)
    expect(listed.madeFrom).toEqual(quote.madeFrom)
    expect(listed.order).toEqual(quote.order)
  })

  it('a draft made by hand has neither', async () => {
    const quote = await record(S.draft!)
    expect(quote).toMatchObject({ madeFrom: null, order: null })
    expect(await row(S.draft!)).toMatchObject({ madeFrom: null, order: null })
  })

  it('accepted without an order: "Order waits" with why — not made yet, then no order numbering for the company', async () => {
    await force(`UPDATE "Quote" SET status = 'ACCEPTED' WHERE id = $1`, [S.draft])
    const notMade = await record(S.draft!)
    expect(notMade.order).toMatchObject({ state: 'WAITS', id: null, number: null, reason: expect.stringMatching(/^(NOT_MADE|PO_NUMBER_REQUIRED|ACCOUNT_ON_HOLD)$/), words: expect.stringMatching(/^Order waits: /) })
    const series = await admin<{ id: string }>(`SELECT id FROM "NumberSeries" WHERE "companyId" = $1 AND kind = 'SALES_ORDER' AND status = 'ACTIVE'`, [A.companyA])
    expect(series.length).toBeGreaterThan(0)
    await force(`UPDATE "NumberSeries" SET status = 'CLOSED' WHERE id = ANY($1::uuid[])`, [series.map((entry) => entry.id)])
    try {
      const company = (await admin<{ legalName: string }>('SELECT "legalName" FROM "Company" WHERE id = $1', [A.companyA]))[0]!.legalName
      const waits = await record(S.draft!)
      expect(waits.order).toEqual({ state: 'WAITS', id: null, number: null, status: null, reason: 'NO_SALES_ORDER_SERIES', words: `Order waits: no order numbering for ${company}. Set up the series, then make the order.` })
      expect((await row(S.draft!)).order).toEqual(waits.order)
    } finally {
      await force(`UPDATE "NumberSeries" SET status = 'ACTIVE' WHERE id = ANY($1::uuid[])`, [series.map((entry) => entry.id)])
      await force(`UPDATE "Quote" SET status = 'DRAFT' WHERE id = $1`, [S.draft])
    }
    // Not accepted again: no order, no wait.
    expect((await record(S.draft!)).order).toBeNull()
  })

  it('an order cancelled later still points back, saying it is cancelled', async () => {
    await force(`UPDATE "SalesOrder" SET status = 'CANCELLED' WHERE id = $1`, [S.order])
    expect((await record(S.accepted!)).order).toMatchObject({ state: 'MADE', number: 'SEED-SO-0001', status: 'CANCELLED' })
    expect((await row(S.accepted!)).order).toMatchObject({ state: 'MADE', status: 'CANCELLED' })
  })
})
