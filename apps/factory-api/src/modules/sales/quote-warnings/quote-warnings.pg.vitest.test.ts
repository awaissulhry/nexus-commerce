import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedSalesPricing } from '../../../../../../packages/factory-db/seed/sales-pricing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { overdueWarning } from './overdue'

/**
 * The customer and product warnings (B-W2b-294; SAL-147; follow-ups QT1:01, QT1:02) through the app's real routes on a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login), on the seeds up to the sales pricing: the brand P1 = SEED-C1
 * whose private-label jackets are SEED-JKT-01 (a draft revision) and SEED-JKT-02 (released, its BOM with the lining SEED-LIN-200),
 * the German customer P3 = SEED-C2 (delivery in DE), P1's invoice FT-2026-00001 partly paid and due 2026-11-27. The facts a
 * warning reads (a phase-out, the markets of a style, a blocked material, a released scope) are set by the database's admin
 * login, each as its own step would write it. Every word and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/quote-warnings`.
 */

vi.setConfig({ testTimeout: 90_000 })

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'

const NS = 'w2b294-warnings'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const P1 = idOf('party:P1')
const P3 = idOf('party:P3')
const JKT01 = idOf('product:style:JKT-01')
const JKT01_BLK = idOf('product:colourway:JKT-01:BLK')
const JKT02 = idOf('production:style:JKT-02')
const JKT02_BLK = idOf('production:colourway:JKT-02:BLK')
const GRID = [{ size: '50', quantity: 1 }, { size: '52', quantity: 2 }, { size: '54', quantity: 1 }]

const roleOf = (key: string): Permission[] => {
  const template = templateOf(key)!
  return [...template.permissions, ...template.grains.map((grain) => `money.${grain}`)] as Permission[]
}
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [grant(permissions)] })
const SESSIONS: Record<string, SessionContext> = { sales: office(roleOf('sales')), noPrice: office(roleOf('sales').filter((name) => name !== 'money.price')) }

let h: Harness
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let serial = 0
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const one = async (sql: string, values: unknown[] = []): Promise<Json> => (await admin(sql, values))[0]!
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `w-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}

let user = ''

async function quoteFor(partyId: string, styleId: string, colourwayId: string): Promise<Json> {
  let { quote } = await ok('sales', 'POST', '/sales/quotes', { companyId: companyA, partyId, customerRef: `PO-${run}-${++serial}` }, 201)
  ;({ quote } = await ok('sales', 'POST', `/sales/quotes/${quote.id}/lines`, { version: quote.version, styleId, colourwayId, sizes: GRID, unitPrice: '450' }, 201))
  return quote
}
const warningsOf = async (quoteId: string, session = 'sales') => ok(session, 'GET', `/sales/quotes/${quoteId}/warnings`)
const codes = (answer: Json) => (answer.warnings as Json[]).map((entry) => [entry.code, entry.severity])

beforeAll(async () => {
  h = await startHarness('quote_warnings')
  await seedCore({ db: h.database, namespace: NS })
  await seedSalesPricing({ db: h.database, namespace: NS })
  user = (await one(`SELECT id FROM "User" WHERE "tenantId" = $1 ORDER BY "createdAt", id LIMIT 1`, [T])).id
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe("another customer's private-label style (QT1:02)", () => {
  it('BLOCKS the quote of P3 in words, with the style that settles it; the send check says so; the brand P1 is not warned', async () => {
    const forP3 = await quoteFor(P3, JKT01, JKT01_BLK)
    const answer = await warningsOf(forP3.id)
    const blocks = (answer.warnings as Json[]).filter((entry) => entry.code === 'PRIVATE_LABEL')
    expect(blocks).toEqual([
      expect.objectContaining({ severity: 'BLOCKS', source: 'LINE_RULE', check: 'private-label', seqs: [10], lineIds: [forP3.lines[0].id], open: { recordType: 'Style', recordId: JKT01, tab: 'private-label' }, message: "Line 10 (SEED-JKT-01 BLK): SEED-JKT-01 is another customer's private-label style; it is made and sold for that brand only." }),
    ])
    expect(answer.counts.blocks).toBeGreaterThanOrEqual(1)
    expect(answer.warnings[0].severity).toBe('BLOCKS')
    const check = await ok('sales', 'GET', `/sales/quotes/${forP3.id}/send-check`)
    expect(check.ready).toBe(false)
    expect(check.checks).toContainEqual(expect.objectContaining({ code: 'PRIVATE_LABEL', severity: 'BLOCKS', lineId: forP3.lines[0].id }))
    const forP1 = await quoteFor(P1, JKT01, JKT01_BLK)
    expect(codes(await warningsOf(forP1.id))).not.toContainEqual(['PRIVATE_LABEL', 'BLOCKS'])
  })

  it("refuses an office order of P3 for P1's jacket, in the rule's words", async () => {
    const preview = await ok('sales', 'POST', '/sales/orders/manual/preview', { companyId: companyA, partyId: P3, customerRef: `PO-${run}`, lines: [{ styleId: JKT02, colourwayId: JKT02_BLK, sizes: [{ size: '52', quantity: 1 }], unitPrice: '450' }] })
    expect(preview.ok).toBe(false)
    expect(preview.problems).toContainEqual({ path: 'body/lines', message: "Line 10 (SEED-JKT-02 BLK): SEED-JKT-02 is another customer's private-label style; it is made and sold for that brand only." })
  })
})

describe('a colourway or size its revision is not released for (QT1:01)', () => {
  it('BLOCKS the line that names a size outside the released scope; a released size passes', async () => {
    const quote = await quoteFor(P1, JKT01, JKT01_BLK)
    // SEED-JKT-01's revision released for sizes 50 and 52 only (B-W2b-231: 54 waits for a later release).
    await admin(`UPDATE "StyleRevision" SET "releasedSizes" = ARRAY['50', '52'] WHERE "styleId" = $1 AND status = 'DRAFT'`, [JKT01])
    await admin(`UPDATE "StyleRevision" SET status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2 WHERE "styleId" = $1 AND status = 'DRAFT'`, [JKT01, user])
    const answer = await warningsOf(quote.id)
    expect((answer.warnings as Json[]).find((entry) => entry.code === 'OUTSIDE_RELEASED_SCOPE')).toMatchObject({
      severity: 'BLOCKS',
      check: 'released-scope',
      open: { recordType: 'Style', recordId: JKT01, tab: 'release' },
      message: "Line 10 (SEED-JKT-01 BLK): SEED-JKT-01 revision 1 is not released for size 54 yet. Release it for them first (the style's release), or quote what is released.",
    })
    const inside = await ok('sales', 'POST', '/sales/quotes', { companyId: companyA, partyId: P1, customerRef: `PO-${run}-in` }, 201)
    const lined = (await ok('sales', 'POST', `/sales/quotes/${inside.quote.id}/lines`, { version: inside.quote.version, styleId: JKT01, colourwayId: JKT01_BLK, sizes: [{ size: '50', quantity: 1 }, { size: '52', quantity: 1 }], unitPrice: '450' }, 201)).quote
    expect(codes(await warningsOf(lined.id)).map(([code]) => code)).not.toContain('OUTSIDE_RELEASED_SCOPE')
  })
})

describe('product warnings: phase-out, markets, a blocked material (SAL-147)', () => {
  it('warns of a style being phased out with what replaces it, of a market it is not sold in, of a blocked lining; nothing stops', async () => {
    await admin(`UPDATE "Style" SET lifecycle = 'PHASE_OUT', "lifecycleChangedAt" = now(), "lifecycleChangedById" = $2, "replacedById" = $3 WHERE id = $1`, [JKT02, user, JKT01])
    // The tenant's markets (Compliance › Rules & markets; the compliance seed is not in this chain): Italy and Germany.
    for (const [code, name] of [['IT', 'Italy'], ['DE', 'Germany']]) await admin(`INSERT INTO "MarketProfile" (id, "tenantId", code, name) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [newId(), T, code, name])
    await admin(`UPDATE "Style" SET "marketCodes" = ARRAY['IT'] WHERE id = $1`, [JKT02])
    await admin(`UPDATE "Item" SET approval = 'BLOCKED', "approvalNote" = 'Made-up: failed the colour fastness test.', "approvedAt" = now(), "approvedById" = $2 WHERE "tenantId" = $1 AND code = 'SEED-LIN-200'`, [T, user])
    const forP1 = await quoteFor(P1, JKT02, JKT02_BLK)
    const answer = await warningsOf(forP1.id)
    const byCode = new Map((answer.warnings as Json[]).map((entry) => [entry.code, entry]))
    expect(byCode.get('STYLE_PHASE_OUT')).toMatchObject({ severity: 'WARNING', message: 'Line 10 (SEED-JKT-02 BLK): SEED-JKT-02 is being phased out: made and sold while stock and orders last; SEED-JKT-01 replaces it.' })
    expect(byCode.get('BLOCKED_MATERIAL')).toMatchObject({ severity: 'WARNING', open: { recordType: 'Item' }, message: 'Line 10 (SEED-JKT-02 BLK): material SEED-LIN-200 is blocked (Made-up: failed the colour fastness test.): it may not be used until it is approved again or replaced.' })
    // P1's goods go to Italy, where the jacket is sold.
    expect(byCode.has('NOT_SOLD_IN_MARKET')).toBe(false)
    expect((answer.warnings as Json[]).filter((entry) => entry.severity === 'BLOCKS')).toEqual([])
    const forP3 = await quoteFor(P3, JKT02, JKT02_BLK)
    expect((await warningsOf(forP3.id)).warnings).toContainEqual(expect.objectContaining({ code: 'NOT_SOLD_IN_MARKET', severity: 'WARNING', open: { recordType: 'Style', recordId: JKT02, tab: 'markets' }, message: expect.stringContaining('SEED-JKT-02 is not sold in Germany (DE), where the goods go (it is sold in IT)') }))
    const check = await ok('sales', 'GET', `/sales/quotes/${forP1.id}/send-check`)
    expect(check.checks).toContainEqual(expect.objectContaining({ code: 'STYLE_PHASE_OUT', severity: 'WARNING' }))
  })
})

describe('the customer: an overdue account (SAL-147)', () => {
  it("warns of P1's invoice past its due day, the amount only in the details (price grain)", async () => {
    const read = (today: string) => h.database.withScope({ audience: 'office', tenantId: T, actorId: user }, (client) => overdueWarning(client, { companyId: companyA, partyId: P1 }, today))
    expect(await read('2026-11-27')).toBeNull()
    const warning = await read('2027-01-15')
    expect(warning!.finding).toMatchObject({ code: 'ACCOUNT_OVERDUE', severity: 'WARNING', open: { recordType: 'Party', recordId: P1, tab: 'receivables' }, message: 'Seed Customer One S.r.l. has an invoice past due with this company, the oldest by 49 days: ask about the payment before the deal grows.' })
    expect(warning!.details).toMatchObject({ invoices: 1, oldestDueDate: '2026-11-27', daysLate: 49, overdue: [{ currency: 'EUR', amount: { $money: 'price', value: 41_000 } }] })
  })
})
