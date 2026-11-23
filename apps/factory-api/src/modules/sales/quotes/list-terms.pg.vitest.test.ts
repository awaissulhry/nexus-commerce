import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { groupOfQuote, OPEN_QUOTES, QUOTE_GROUPS } from '@nexus/factory-domain/sales/before-order/groups'
import { addDays, type QuoteStatus } from '@nexus/factory-domain/sales/quotes/quotes'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedSalesIntake } from '../../../../../../packages/factory-db/seed/sales-intake'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { completeContext, testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { quotes as exportSource } from '../../../platform/exports/sources/quotes'

/**
 * B-CQ-010 … 013 (customer page › Quotes & incoming, settle L12; 13-backend §3): GET /sales/quotes gains `group` (a before-order group
 * of quotes, OPEN_QUOTES or LIVE: each group's rows are the domain rule's), `sort=urgent` ("Most urgent first", paged by the last
 * row's id), the row facts versionId, sentAt, reminderSentAt, customerSeq, language, customerHolds (no amount), and the file follows
 * both terms (screen = file). The set-up of ./quote-sources.pg (the core and sales-intake seeds), on these seed rows of customer P1:
 * SEED-Q-0001 ACCEPTED with its order SEED-SO-0001, SEED-Q-0002 a DRAFT made by hand. The hand-made set of one quote per urgency tier
 * (TEST-QT-U01 … U08, P1's, copied from SEED-Q-0002 with their states) and the states the seeds do not hold (a cancelled order, a
 * draft made from a version the customer still holds) are written past the guards by the admin: test data; the reads under test run
 * as the runtime login. Made-up data only. Run with `node scripts/factory/run-pg-tests.mjs quotes/list-terms`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = 'cq-list-terms'
const A = { tenant: seedUuid(ns, 'tenant'), companyA: seedUuid(ns, 'company:A'), P1: seedUuid(ns, 'party:P1') }
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

const salesTemplate = templateOf('sales')!
const SALES = [...salesTemplate.permissions, ...salesTemplate.grains.map((grain) => `money.${grain}`)] as Permission[]
const READS: Permission[] = ['quotes.view', 'orders.view']
const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const SESSIONS: Record<string, () => SessionContext> = {
  all: () => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(READS)] }),
  // The real Sales template (no grain: no amount).
  sales: () => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(SALES)] }),
  // The limited reader (SEED-R1 pattern): P1's quotes only; and one limited to a customer that holds none.
  onlyP1: () => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(READS, [A.P1])] }),
  otherCustomer: () => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(READS, [newId()])] }),
}
async function get(session: string, url: string): Promise<Json> {
  const response = await app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
  expect(response.statusCode, `${session} ${url}: ${response.body}`).toBe(200)
  return response.json() as Json
}
const status = async (session: string, url: string): Promise<number> => (await app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })).statusCode
/** Every row of a query, page after page (`limit` a page). */
async function allRows(session: string, query: string, limit = 2): Promise<Json[]> {
  const rows: Json[] = []
  let cursor: string | null = null
  for (let page = 0; page < 100; page++) {
    const answer: Json = await get(session, `/sales/quotes?${query}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`)
    expect(answer.quotes.length).toBeLessThanOrEqual(limit)
    rows.push(...answer.quotes)
    cursor = answer.nextCursor
    if (!cursor) return rows
  }
  throw new Error('more than 100 pages')
}
const numbers = (rows: readonly Json[]): string[] => rows.map((row) => row.number)
const sorted = (values: readonly string[]): string[] => [...values].sort()
const lit = (value: string | null | undefined): string => (value ? `'${value}'` : 'NULL')
const today = businessDate(new Date())
const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString()

/** A quote of P1 copied from SEED-Q-0002 (its first version only, no lines) in the given states (test data past the guards). */
async function copyQuote(number: string, quote: { status: QuoteStatus; updatedAt: string }, version: { status: string; validUntil?: string | null; sentAt?: string | null; closedAt?: string | null }): Promise<string> {
  const quoteId = newId()
  const versionId = newId()
  await force(`
    CREATE TEMP TABLE cq_q AS SELECT * FROM "Quote" WHERE id = '${S.draft}';
    CREATE TEMP TABLE cq_v AS SELECT * FROM "QuoteVersion" WHERE "quoteId" = '${S.draft}' AND revision = 1;
    UPDATE cq_q SET id = '${quoteId}', number = '${number}', "customerSeq" = NULL, status = '${quote.status}', "currentRevision" = 1, "updatedAt" = '${quote.updatedAt}', version = 1;
    UPDATE cq_v SET id = '${versionId}', "quoteId" = '${quoteId}', status = '${version.status}', "validUntil" = ${lit(version.validUntil)}, "sentAt" = ${lit(version.sentAt)}, "closedAt" = ${lit(version.closedAt)};
    INSERT INTO "Quote" SELECT * FROM cq_q;
    INSERT INTO "QuoteVersion" SELECT * FROM cq_v;
    DROP TABLE cq_q, cq_v;`)
  return quoteId
}

/** "Most urgent first" of P1's quotes (research §4): the tiers, then the inner order. */
const URGENT = ['TEST-QT-U01', 'TEST-QT-U02', 'TEST-QT-U03', 'TEST-QT-U04', 'SEED-Q-0002', 'TEST-QT-U08', 'TEST-QT-U05', 'TEST-QT-U06', 'SEED-Q-0001', 'TEST-QT-U07']

beforeAll(async () => {
  db = await migratedDatabase('cq_list_terms')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: ns })
  await seedSalesIntake({ db: database, namespace: ns })
  const id = async (table: string, number: string) => (await admin<{ id: string }>(`SELECT id FROM "${table}" WHERE "tenantId" = $1 AND number = $2`, [A.tenant, number]))[0]!.id
  S.accepted = await id('Quote', 'SEED-Q-0001')
  S.draft = await id('Quote', 'SEED-Q-0002')
  S.order = await id('SalesOrder', 'SEED-SO-0001')
  // One quote per tier (each named in URGENT's order).
  S.u01 = await copyQuote('TEST-QT-U01', { status: 'ACCEPTED', updatedAt: daysAgo(4) }, { status: 'ACCEPTED', sentAt: daysAgo(10), closedAt: daysAgo(5), validUntil: addDays(today, 20) })
  S.u02 = await copyQuote('TEST-QT-U02', { status: 'PENDING_APPROVAL', updatedAt: daysAgo(3) }, { status: 'PENDING_APPROVAL' })
  S.u03 = await copyQuote('TEST-QT-U03', { status: 'APPROVED', updatedAt: daysAgo(1) }, { status: 'APPROVED' })
  S.u04 = await copyQuote('TEST-QT-U04', { status: 'DRAFT', updatedAt: '2020-01-01T09:00:00.000Z' }, { status: 'DRAFT' })
  S.u05 = await copyQuote('TEST-QT-U05', { status: 'SENT', updatedAt: daysAgo(2) }, { status: 'SENT', sentAt: daysAgo(2), validUntil: addDays(today, 3) })
  S.u06 = await copyQuote('TEST-QT-U06', { status: 'SENT', updatedAt: daysAgo(20) }, { status: 'SENT', sentAt: daysAgo(20), validUntil: addDays(today, 30) })
  S.u07 = await copyQuote('TEST-QT-U07', { status: 'DECLINED', updatedAt: '2020-01-02T09:00:00.000Z' }, { status: 'DECLINED', sentAt: '2019-12-20T09:00:00.000Z', closedAt: '2020-01-02T09:00:00.000Z' })
  S.u08 = await copyQuote('TEST-QT-U08', { status: 'SENT', updatedAt: daysAgo(40) }, { status: 'SENT', sentAt: daysAgo(40), validUntil: addDays(today, -2) })
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

describe('B-CQ-010 the `group` term', () => {
  it('each group’s rows are the domain rule’s; OPEN_QUOTES the four open states; LIVE the open quotes and the accepted one whose order waits', async () => {
    const every = await allRows('all', `partyId=${A.P1}`, 200)
    expect(sorted(numbers(every))).toEqual(sorted(URGENT))
    const groupOf = (row: Json) => groupOfQuote(row.status as QuoteStatus, row.order?.state === 'MADE')
    for (const group of QUOTE_GROUPS) {
      const rows = await allRows('all', `partyId=${A.P1}&group=${group}`)
      expect(sorted(numbers(rows)), group).toEqual(sorted(numbers(every.filter((row) => groupOf(row) === group))))
    }
    expect(sorted(numbers(await allRows('all', `partyId=${A.P1}&group=PREPARING`)))).toEqual(sorted(['TEST-QT-U03', 'TEST-QT-U04', 'SEED-Q-0002']))
    expect(numbers(await allRows('all', `partyId=${A.P1}&group=APPROVAL`))).toEqual(['TEST-QT-U02'])
    expect(sorted(numbers(await allRows('all', `partyId=${A.P1}&group=WAITING_CUSTOMER`)))).toEqual(sorted(['TEST-QT-U05', 'TEST-QT-U06', 'TEST-QT-U08']))
    expect(numbers(await allRows('all', `partyId=${A.P1}&group=ORDER_WAITS`))).toEqual(['TEST-QT-U01'])
    expect(numbers(await allRows('all', `partyId=${A.P1}&group=WON`))).toEqual(['SEED-Q-0001'])
    expect(numbers(await allRows('all', `partyId=${A.P1}&group=LOST`))).toEqual(['TEST-QT-U07'])
    const open = every.filter((row) => (OPEN_QUOTES as readonly string[]).includes(row.status))
    expect(sorted(numbers(await allRows('all', `partyId=${A.P1}&group=OPEN_QUOTES`)))).toEqual(sorted(numbers(open)))
    expect(sorted(numbers(await allRows('all', `partyId=${A.P1}&group=LIVE`)))).toEqual(sorted([...numbers(open), 'TEST-QT-U01']))
    // ANDed with `status` when both are sent.
    expect(sorted(numbers(await allRows('all', `partyId=${A.P1}&group=PREPARING&status=DRAFT`)))).toEqual(sorted(['TEST-QT-U04', 'SEED-Q-0002']))
    expect(await allRows('all', `partyId=${A.P1}&group=PREPARING&status=SENT`)).toEqual([])
  })

  it('WON keeps an accepted quote whose order was cancelled later (an order exists on its version)', async () => {
    await force(`UPDATE "SalesOrder" SET status = 'CANCELLED' WHERE id = $1`, [S.order])
    try {
      expect(numbers(await allRows('all', `partyId=${A.P1}&group=WON`))).toEqual(['SEED-Q-0001'])
      expect(numbers(await allRows('all', `partyId=${A.P1}&group=ORDER_WAITS`))).toEqual(['TEST-QT-U01'])
    } finally {
      await force(`UPDATE "SalesOrder" SET status = 'CONFIRMED' WHERE id = $1`, [S.order])
    }
  })

  it('a door group no quote is in, an unknown group or sort: refused (400)', async () => {
    for (const query of ['group=TO_ANSWER', 'group=WRITING', 'group=MOVED', 'group=NOPE', 'sort=NOPE', 'sort=oldest']) expect(await status('all', `/sales/quotes?${query}`), query).toBe(400)
  })
})

describe('B-CQ-011 `sort=urgent`', () => {
  it('one per tier: order waits · approval · our move · ends soon (a past last day first) · sent · closed, newest change first', async () => {
    expect(numbers((await get('all', `/sales/quotes?partyId=${A.P1}&sort=urgent&limit=200`)).quotes)).toEqual(URGENT)
    // `sort=newest` is today's order (id desc), as without a sort.
    expect(numbers((await get('all', `/sales/quotes?partyId=${A.P1}&sort=newest&limit=200`)).quotes)).toEqual(numbers((await get('all', `/sales/quotes?partyId=${A.P1}&limit=200`)).quotes))
  })

  it('page by page (2 a page) is the one read; a cursor that left the list starts at the top; with a group, only its rows in that order', async () => {
    expect(numbers(await allRows('all', `partyId=${A.P1}&sort=urgent`, 2))).toEqual(URGENT)
    expect(numbers(await allRows('all', `partyId=${A.P1}&sort=urgent`, 3))).toEqual(URGENT)
    expect(numbers((await get('all', `/sales/quotes?partyId=${A.P1}&sort=urgent&limit=3&cursor=${newId()}`)).quotes)).toEqual(URGENT.slice(0, 3))
    const live = (await get('all', `/sales/quotes?partyId=${A.P1}&group=LIVE&sort=urgent&limit=200`)).quotes
    expect(numbers(live)).toEqual(URGENT.filter((number) => !['SEED-Q-0001', 'TEST-QT-U07'].includes(number)))
    expect((await get('all', `/sales/quotes?partyId=${A.P1}&sort=urgent&limit=200`)).nextCursor).toBeNull()
  })

  it('the limited reader: its own rows only, in every group and sort; a reader of another customer none', async () => {
    for (const query of ['', '&sort=urgent', '&group=LIVE', '&group=LIVE&sort=urgent', '&group=WON', '&group=OPEN_QUOTES&sort=urgent']) {
      expect(numbers(await allRows('onlyP1', `partyId=${A.P1}${query}`)), query).toEqual(numbers(await allRows('all', `partyId=${A.P1}${query}`)))
      expect(await allRows('otherCustomer', `partyId=${A.P1}${query}`), query).toEqual([])
      expect(await allRows('otherCustomer', query.replace(/^&/, '') || 'mine=false'), query).toEqual([])
    }
  })
})

describe('B-CQ-012 the row’s new facts, B-CQ-013 the file', () => {
  it('Sales reads every new fact and no amount', async () => {
    const rows = (await get('sales', `/sales/quotes?partyId=${A.P1}&sort=urgent&limit=200`)).quotes as Json[]
    expect(numbers(rows)).toEqual(URGENT)
    for (const row of rows) {
      for (const key of ['versionId', 'sentAt', 'reminderSentAt', 'customerSeq', 'language', 'customerHolds', 'fromPortalOrder']) expect(row, `${row.number} ${key}`).toHaveProperty(key)
      for (const key of ['netAmount', 'grossAmount', 'marginPct', 'marginFloorBreached', 'costAmount', 'marginAmount']) expect(row, `${row.number} ${key}`).not.toHaveProperty(key)
      expect(['it', 'en']).toContain(row.language)
    }
    const versionOf = async (quoteId: string) => (await admin<{ id: string }>(`SELECT v.id FROM "QuoteVersion" v JOIN "Quote" q ON q.id = v."quoteId" AND q."currentRevision" = v.revision WHERE q.id = $1`, [quoteId]))[0]!.id
    const sent = rows.find((row) => row.number === 'TEST-QT-U05')!
    expect(sent).toMatchObject({ status: 'SENT', versionId: await versionOf(S.u05!), customerSeq: null, customerHolds: null, fromPortalOrder: null })
    expect(Date.parse(sent.sentAt)).toBeGreaterThan(Date.now() - 3 * 86_400_000)
    const seeded = rows.find((row) => row.number === 'SEED-Q-0002')!
    expect(seeded.customerSeq).toEqual(expect.any(Number))
    expect(seeded.sentAt).toBeNull()
  })

  it('customerHolds: a draft made from a version still SENT names that revision; made from an EXPIRED one, null', async () => {
    const v2 = newId()
    await force(`
      CREATE TEMP TABLE cq_v AS SELECT * FROM "QuoteVersion" WHERE "quoteId" = '${S.draft}' AND revision = 1;
      UPDATE cq_v SET id = '${v2}', revision = 2, status = 'DRAFT', "sentAt" = NULL;
      INSERT INTO "QuoteVersion" SELECT * FROM cq_v;
      DROP TABLE cq_v;
      UPDATE "QuoteVersion" SET status = 'SENT', "sentAt" = now() WHERE "quoteId" = '${S.draft}' AND revision = 1;
      UPDATE "Quote" SET "currentRevision" = 2 WHERE id = '${S.draft}';`)
    try {
      const rowOf = async () => ((await get('all', `/sales/quotes?partyId=${A.P1}&limit=200`)).quotes as Json[]).find((row) => row.id === S.draft)!
      expect(await rowOf()).toMatchObject({ status: 'DRAFT', revision: 2, versionId: v2, customerHolds: { revision: 1 } })
      await force(`UPDATE "QuoteVersion" SET status = 'EXPIRED', "closedAt" = now() WHERE "quoteId" = $1 AND revision = 1`, [S.draft])
      expect(await rowOf()).toMatchObject({ revision: 2, customerHolds: null })
    } finally {
      await force(`
        UPDATE "Quote" SET "currentRevision" = 1 WHERE id = '${S.draft}';
        DELETE FROM "QuoteVersion" WHERE id = '${v2}';
        UPDATE "QuoteVersion" SET status = 'DRAFT', "sentAt" = NULL, "closedAt" = NULL WHERE "quoteId" = '${S.draft}' AND revision = 1;`)
    }
  })

  it('the file holds the screen’s rows for group=OPEN_QUOTES&sort=urgent, page after page; a wrong term is refused, never dropped', async () => {
    const caller = callerFor(database, completeContext(SESSIONS.onlyP1!(), 'cq-s1-file'))
    const query = exportSource.query(new URLSearchParams(`group=OPEN_QUOTES&sort=urgent&party=${A.P1}`))
    expect(query).toMatchObject({ group: 'OPEN_QUOTES', sort: 'urgent', partyId: A.P1 })
    const rows: Json[] = []
    let cursor: string | null = null
    do {
      const page = await exportSource.read(caller, query, cursor, 2)
      rows.push(...(page.rows as Json[]))
      cursor = page.next
    } while (cursor)
    const screen = (await get('onlyP1', `/sales/quotes?partyId=${A.P1}&group=OPEN_QUOTES&sort=urgent&limit=200`)).quotes as Json[]
    expect(numbers(rows)).toEqual(numbers(screen))
    expect(numbers(rows)).toEqual(URGENT.filter((number) => ['TEST-QT-U02', 'TEST-QT-U03', 'TEST-QT-U04', 'SEED-Q-0002', 'TEST-QT-U08', 'TEST-QT-U05', 'TEST-QT-U06'].includes(number)))
    for (const address of ['group=NOPE', 'group=TO_ANSWER', 'sort=oldest']) expect(() => exportSource.query(new URLSearchParams(address)), address).toThrow()
  })
})
