import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { suggestedPriceOf } from '@nexus/factory-domain/sales/price-waterfall/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedCosting } from '../../../../../../packages/factory-db/seed/costing'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedSalesPricing, type SalesPricingSeed } from '../../../../../../packages/factory-db/seed/sales-pricing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * B-W2b-302 on the local stack, with the app's real routes (a throwaway PostgreSQL 17 database from the migrations, the
 * runtime login: row-level security and B-W2b-280's guards — the waterfall that must add up — are real): target price goal-seek
 * (SAL-150) shown first and written through B-W2b-330's line price writer, a price under cost held, a target margin only with
 * the cost grain; and two versions of a quote compared (SAL-158) in VersionCompare's shape, the prices only with the price
 * grain. The seeds' P1 list prices SEED-JKT-01 at 420.00; SEED-Q-0004 is SENT (JKT-01 RED 52 × 3, LIST 430 → MANUAL −10
 * VOLUME → NET 420, DAP). Made-up data; prices worked out by hand.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/quote-goalseek/`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seeded: SalesPricingSeed

const NS = 'goalseek-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const P1 = seedId('party:P1')
const jkt01 = seedId('product:style:JKT-01')
const BLK = seedId('product:colourway:JKT-01:BLK')

const grainsOf = (grains: readonly string[]): Permission[] => grains.map((grain) => `money.${grain}` as Permission)
const PEOPLE: Record<string, { readonly template: string; readonly role: string | null; readonly dropGrains?: readonly string[] }> = {
  seller: { template: 'sales', role: 'sales' },
  owner: { template: 'owner', role: 'owner' },
  // The sales role without the price and margin grains (a custom role may be).
  blind: { template: 'sales', role: null, dropGrains: ['price', 'margin'] },
}
const IDS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const role = templateOf(person.template)!
    const grains = role.grains.filter((grain) => !(person.dropGrains ?? []).includes(grain))
    const grant: Grant = { permissions: [...role.permissions, ...grainsOf(grains)], companies: 'all', sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: tenant, actorId: IDS[key]!, grants: [grant] }]
  }),
)

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) => app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const q = (id: string) => `/sales/quotes/${id}`
const lineOf = (quote: Json) => quote.lines.find((line: Json) => line.kind === 'SIZE_GRID')
/** The line's unit cost as priced (read as the database keeps it). */
const unitCostOf = async (lineId: string): Promise<string> => (await admin<{ cost: string }>(`SELECT trim(trailing '.' from trim(trailing '0' from "unitCost"::text)) AS cost FROM "QuoteLine" WHERE id = $1`, [lineId]))[0]!.cost
const kinds = (steps: Json[]) => steps.map((step) => [step.kind, step.delta ?? null, step.unitPrice ?? null, step.reasonCode ?? null])

let quote: Json

beforeAll(async () => {
  db = await migratedDatabase('quote_goalseek')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  await seedCore({ db: database, namespace: NS })
  await seedCompliance({ db: database, namespace: NS })
  await seedCosting({ db: database, namespace: NS })
  await seedNumbering({ db: database, namespace: NS })
  seeded = await seedSalesPricing({ db: database, namespace: NS })
  // The PRICE_ADJUSTMENT reasons (TARGET_PRICE among them).
  await seedReasons({ db: database, namespace: NS })
  for (const [key, person] of Object.entries(PEOPLE)) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [IDS[key], tenant, `${key}.goalseek@example.com`, `Goal-seek ${key}`])
    if (person.role === null) continue
    const [role] = await admin<{ id: string }>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = $2`, [tenant, person.role])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}', now() - interval '1 day')`, [newId(), tenant, IDS[key], role!.id])
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  quote = (await ok('seller', 'POST', '/sales/quotes', { companyId: companyA, partyId: P1 }, 201)).quote
  quote = (await ok('seller', 'POST', `${q(quote.id)}/lines`, { version: quote.version, styleId: jkt01, colourwayId: BLK, sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 4 }, { size: '54', quantity: 2 }] }, 201)).quote
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('target price goal-seek (SAL-150)', () => {
  it('shows the waterfall a target unit price gives, the discount needed and the totals, and writes nothing', async () => {
    expect(lineOf(quote)).toMatchObject({ listUnitPrice: '420', unitPrice: '420' })
    const preview = await ok('seller', 'POST', `${q(quote.id)}/goal-seek`, { version: quote.version, target: { kind: 'UNIT_PRICE', unitPrice: '395' }, preview: true })
    const [line] = preview.lines
    expect(line).toMatchObject({ start: { kind: 'LIST', unitPrice: '420' }, from: { unitPrice: '420' }, to: { unitPrice: '395' }, discountPct: '5.9524', pieces: 8 })
    expect(kinds(line.steps)).toEqual([
      ['LIST', null, '420', null],
      ['MANUAL', '-25', '395', 'TARGET_PRICE'],
      ['NET', null, '395', null],
    ])
    expect(preview.totals).toMatchObject({ before: { netAmount: 336000 }, after: { netAmount: 316000 } })
    // The seller holds the margin grain, not the cost grain: a margin %, never a margin amount.
    expect(line.to).toHaveProperty('marginPct')
    expect(line.to).not.toHaveProperty('marginAmount')
    expect(preview).toMatchObject({ preview: true, held: [], words: expect.stringMatching(/^Target unit price: 1 line\(s\) would take the target/) })
    expect(lineOf((await ok('seller', 'GET', q(quote.id))).quote).unitPrice).toBe('420')
    // Without the price and margin grains the figures are left out, and a priced target is refused.
    await refused('blind', 'POST', `${q(quote.id)}/goal-seek`, { version: quote.version, target: { kind: 'UNIT_PRICE', unitPrice: '395' }, preview: true }, 403)
  })

  it('writes the same through the line price writer: the waterfall with its TARGET_PRICE reason', async () => {
    const done = await ok('seller', 'POST', `${q(quote.id)}/goal-seek`, { version: quote.version, target: { kind: 'UNIT_PRICE', unitPrice: '395' } })
    quote = done.quote
    expect(done.preview).toBe(false)
    expect(lineOf(quote)).toMatchObject({ unitPrice: '395', listUnitPrice: '420' })
    const pricing = await ok('seller', 'GET', `${q(quote.id)}/pricing`)
    expect(pricing.lines[0]).toMatchObject({ adjustmentReason: 'TARGET_PRICE', stepsProblem: null })
    expect(kinds(pricing.lines[0].steps)).toEqual([
      ['LIST', null, '420', null],
      ['MANUAL', '-25', '395', 'TARGET_PRICE'],
      ['NET', null, '395', null],
    ])
    const audits = await admin<{ action: string }>(`SELECT action FROM "AuditLog" WHERE "recordId" = $1 AND action IN ('quotes.goalSeek', 'quotes.priceLine') ORDER BY action`, [quote.id])
    expect(audits.map((row) => row.action)).toEqual(['quotes.goalSeek', 'quotes.priceLine'])
  })

  it('a discount off the start, and a total reached by one factor', async () => {
    const discount = await ok('seller', 'POST', `${q(quote.id)}/goal-seek`, { version: quote.version, target: { kind: 'DISCOUNT', pct: '10' }, preview: true })
    expect(kinds(discount.lines[0].steps)).toEqual([
      ['LIST', null, '420', null],
      ['DISCOUNT', '-42', '378', 'TARGET_PRICE'],
      ['NET', null, '378', null],
    ])
    const total = await ok('seller', 'POST', `${q(quote.id)}/goal-seek`, { version: quote.version, target: { kind: 'TOTAL', amount: '3000' }, preview: true })
    expect(total.lines[0].to.unitPrice).toBe('375')
    expect(total.totals).toMatchObject({ after: { netAmount: 300000 }, target: 300000, gap: 0 })
  })

  it('holds a price under cost (an approver must allow it) and asks the cost grain for a target margin', async () => {
    const line = lineOf(quote)
    const held = await ok('seller', 'POST', `${q(quote.id)}/goal-seek`, { version: quote.version, lineIds: [line.id], target: { kind: 'UNIT_PRICE', unitPrice: '1' }, preview: true })
    expect(held.held).toEqual([{ lineId: line.id, seq: 10, code: 'BELOW_COST', words: expect.stringContaining('would sell below its cost: an approver must allow it') }])
    expect(held.lines[0].belowCost).toBe(true)
    expect((await refused('seller', 'POST', `${q(quote.id)}/goal-seek`, { version: quote.version, target: { kind: 'UNIT_PRICE', unitPrice: '1' } }, 409)).message).toContain('price the line by hand')
    expect((await refused('seller', 'POST', `${q(quote.id)}/goal-seek`, { version: quote.version, target: { kind: 'MARGIN', marginPct: '30' }, preview: true }, 403)).message).toContain('worked out from the cost')
    // The owner holds the cost grain: cost ÷ 0.70, up to the cent.
    const margin = await ok('owner', 'POST', `${q(quote.id)}/goal-seek`, { version: quote.version, target: { kind: 'MARGIN', marginPct: '30' }, preview: true })
    const expected = suggestedPriceOf({ unitCost: await unitCostOf(line.id), marginPct: '30', currency: 'EUR' })
    expect(margin.lines[0].to.unitPrice).toBe('unitPrice' in expected ? expected.unitPrice : null)
    expect(margin.lines[0].to).toHaveProperty('marginAmount')
    // A stale review is refused; a fee is priced on its own.
    await refused('seller', 'POST', `${q(quote.id)}/goal-seek`, { version: quote.version - 1, target: { kind: 'UNIT_PRICE', unitPrice: '390' }, preview: true }, 409)
    const withFee = (await ok('seller', 'POST', `${q(quote.id)}/fees`, { version: quote.version, feeKind: 'SAMPLE', styleId: jkt01, unitPrice: '150' }, 201)).quote
    const fee = withFee.lines.find((entry: Json) => entry.kind === 'FEE')
    expect((await refused('seller', 'POST', `${q(quote.id)}/goal-seek`, { version: withFee.version, lineIds: [fee.id], target: { kind: 'UNIT_PRICE', unitPrice: '100' }, preview: true }, 400)).message).toContain('a fee is priced on its own')
  })
})

describe('two versions of a quote compared (SAL-158)', () => {
  it('says the lines, sizes, prices and terms that changed, in VersionCompare shape, and a change note', async () => {
    const sentId = seeded.sentQuote.quoteId
    let sent = (await ok('seller', 'GET', q(sentId))).quote
    sent = (await ok('seller', 'POST', `${q(sentId)}/revise`, { version: sent.version, changeNote: 'Made-up: the customer asked for more.' })).quote
    const line = lineOf(sent)
    sent = (await ok('seller', 'POST', `${q(sentId)}/goal-seek`, { version: sent.version, lineIds: [line.id], target: { kind: 'UNIT_PRICE', unitPrice: '400' } })).quote
    sent = (await ok('seller', 'POST', `${q(sentId)}/lines/sizes`, { version: sent.version, sizes: ['52'], change: { kind: 'DELTA', pieces: 1 } })).quote
    await ok('seller', 'PUT', `${q(sentId)}/terms`, { version: sent.version, incoterm: 'EXW', incotermPlace: 'Seedville' })

    const compare = await ok('seller', 'GET', `${q(sentId)}/versions/compare`)
    expect([compare.before.label, compare.after.label]).toEqual(['Version 1', 'Version 2'])
    const [terms, lines] = compare.sections
    expect(terms.lines[0].after.fields.incoterm).toBe('EXW Seedville')
    expect(terms.summary.changed).toBe(1)
    expect(lines.lines[0]).toMatchObject({ before: { sizes: { '52': '3' } }, after: { sizes: { '52': '4' } } })
    expect(compare.prices.lines[0].before.fields).toMatchObject({ unitPrice: '420', adjustmentReason: null })
    expect(compare.prices.lines[0].after.fields).toMatchObject({ unitPrice: '400', adjustmentReason: 'TARGET_PRICE' })
    expect(compare.words).toMatch(/^Terms & delivery: 1 changed · Lines: 1 changed · Prices: 1 changed/)
    expect(compare.changeNote).toContain('52 3 → 4')
    expect(compare.changeNote).toContain('unit price 420 → 400')
    // Without the price and margin grains: no prices, no margins, and a change note without them.
    const blind = await ok('blind', 'GET', `${q(sentId)}/versions/compare?from=1&to=2`)
    expect(blind).not.toHaveProperty('prices')
    expect(blind).not.toHaveProperty('margin')
    expect(blind.changeNote).not.toContain('400')
    expect(blind.words).toBe('Terms & delivery: 1 changed · Lines: 1 changed')
    expect(blind.differs.map((entry: Json) => entry.section)).toEqual(['terms', 'lines'])
    expect((await refused('seller', 'GET', `${q(sentId)}/versions/compare?from=2&to=2`, undefined, 400)).message).toBe('Pick two different versions to compare.')
    await refused('seller', 'GET', `${q(sentId)}/versions/compare?from=1&to=5`, undefined, 404)
  })
})
