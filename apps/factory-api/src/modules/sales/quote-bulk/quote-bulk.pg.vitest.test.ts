import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedCosting } from '../../../../../../packages/factory-db/seed/costing'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedSalesPricing, type SalesPricingSeed } from '../../../../../../packages/factory-db/seed/sales-pricing'
import { seed as seedSizesDepth, type SizesDepthSeed } from '../../../../../../packages/factory-db/seed/sizes-depth'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * B-W2b-302 on the local stack, with the app's real routes (a throwaway PostgreSQL 17 database from the migrations, the
 * runtime login: row-level security, the grants and B-W2b-280's guards on size curves and delivery schedules are real): size
 * curves kept in Sales settings, lines pasted from a sheet, a size run changed in bulk, lines filled by a curve and by a
 * prepack — each shown first and written the same way — and the refusals in words (a delivery schedule a change would break,
 * a pack of sizes the line does not take, an archived curve or pack, a stale review). SEED-JKT-01 is made in 50, 52, 54
 * (base 52), black and red; "Seed EU jacket curve" shares 48 5 %, 50 20 %, 52 40 %, 54 25 %, 56 10 %; SEED-PP-JKT-COL holds
 * 52 × 2 black and 52 × 1 red; SEED-PP-EU-9 is the scale's 1-2-3-2-1 over 48-56. Made-up data only.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/quote-bulk/`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let pricing: SalesPricingSeed
let sizes: SizesDepthSeed

const NS = 'quote-bulk-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const P1 = seedId('party:P1')
const jkt01 = seedId('product:style:JKT-01')
const BLK = seedId('product:colourway:JKT-01:BLK')
const RED = seedId('product:colourway:JKT-01:RED')
const scale = seedId('product:size-scale:EU-JKT')

const grainsOf = (grains: readonly string[]): Permission[] => grains.map((grain) => `money.${grain}` as Permission)
const roleOf = (key: string): Permission[] => {
  const role = templateOf(key)!
  return [...role.permissions, ...grainsOf(role.grains)]
}
// The seller (the sales role), the planner (no quotes) and someone who only reads quotes.
const PEOPLE: Record<string, Permission[]> = { seller: roleOf('sales'), planner: roleOf('planner'), viewer: ['quotes.view'] as Permission[] }
const IDS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, permissions]) => {
    const grant: Grant = { permissions, companies: 'all', sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: tenant, actorId: IDS[key]!, grants: [grant] }]
  }),
)

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'
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
const lineOf = (quote: Json, colourwayId: string) => quote.lines.find((line: Json) => line.kind === 'SIZE_GRID' && line.colourwayId === colourwayId)
const grid = (line: Json) => Object.fromEntries(line.sizes.map((row: Json) => [row.size, row.quantity]))

let quote: Json

beforeAll(async () => {
  db = await migratedDatabase('quote_bulk')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  await seedCore({ db: database, namespace: NS })
  await seedCompliance({ db: database, namespace: NS })
  await seedCosting({ db: database, namespace: NS })
  await seedNumbering({ db: database, namespace: NS })
  pricing = await seedSalesPricing({ db: database, namespace: NS })
  sizes = await seedSizesDepth({ db: database, namespace: NS })
  for (const key of Object.keys(PEOPLE)) await db.admin.query(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [IDS[key], tenant, `${key}.bulk@example.com`, `Bulk ${key}`])
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

describe('size curves (SAL-269, Sales settings › Size curves)', () => {
  it('lists the seed curves, makes one of company A, and refuses shares that do not total 100 in words', async () => {
    const { curves } = await ok('viewer', 'GET', `/sales/size-curves?sizeScaleId=${scale}`)
    expect(curves.map((curve: Json) => curve.name)).toEqual(['Seed EU jacket curve', 'Seed small run'])
    expect(curves[0]).toMatchObject({ companyId: companyA, words: '48 5 % · 50 20 % · 52 40 % · 54 25 % · 56 10 %', status: 'ACTIVE' })
    const made = (await ok('seller', 'POST', '/sales/size-curves', { companyId: companyA, sizeScaleId: scale, name: 'Made-up dealer curve', shares: { '52': '50', '50': '25', '54': '25' } }, 201)).curve
    expect(made.shares).toEqual({ '50': '25.0000', '52': '50.0000', '54': '25.0000' })
    const bad = await refused('seller', 'POST', '/sales/size-curves', { companyId: companyA, sizeScaleId: scale, name: 'Made-up wrong', shares: { '50': '30', '52': '60' } }, 400)
    expect(bad.message).toBe('The shares total 90 %: a curve totals exactly 100 %.')
    expect((await refused('seller', 'POST', '/sales/size-curves', { companyId: companyA, sizeScaleId: scale, name: 'Made-up dealer curve', shares: { '52': '100' } }, 409)).message).toContain('already exists')
    // Kept with the quote templates' permission: the planner reads no quotes and keeps nothing.
    await refused('planner', 'POST', '/sales/size-curves', { companyId: companyA, sizeScaleId: scale, name: 'X', shares: { '52': '100' } }, 403)
    const renamed = (await ok('seller', 'PATCH', `/sales/size-curves/${made.id}`, { version: made.version, name: 'Made-up dealer curve 2' })).curve
    const archived = (await ok('seller', 'POST', '/sales/size-curves/status', { curves: [{ id: renamed.id, version: renamed.version }], status: 'ARCHIVED' })).curves[0]
    expect(archived.status).toBe('ARCHIVED')
    // An archived curve fills nothing.
    const line = lineOf(quote, BLK)
    expect((await refused('seller', 'POST', `${q(quote.id)}/lines/fill`, { version: quote.version, curveId: archived.id, lines: [{ lineId: line.id, pieces: 10 }], preview: true }, 409)).message).toContain('archived')
    const events = await db.admin.query(`SELECT payload->>'change' AS change FROM "OutboxEvent" WHERE type = 'size_curve.changed' AND payload->>'sizeCurveId' = $1 ORDER BY "occurredAt", id`, [made.id])
    expect(events.rows.map((row: Json) => row.change)).toEqual(['CREATED', 'UPDATED', 'ARCHIVED'])
  })
})

describe('lines pasted from a sheet (SAL-160)', () => {
  it('shows what lands and what cannot, cell by cell, then writes the same', async () => {
    const text = ['Style\tColourway\t50\t52\t54\t56\tPrice', 'SEED-JKT-01\tBLK\t\t6\t\t\t', 'SEED-JKT-01\tRed\t1\tx\t3\t2\t401.50', 'SEED-NOPE\tBLK\t1\t\t\t\t'].join('\n')
    const preview = await ok('seller', 'POST', `${q(quote.id)}/lines/paste`, { version: quote.version, text, preview: true })
    expect(preview.counts).toEqual({ rows: 3, added: 1, changed: 1, skipped: 1, cellsLanded: 3, cellsLeftOut: 2 })
    expect(preview.rows.map((row: Json) => [row.row, row.action, row.priceFrom])).toEqual([
      [2, 'CHANGE', 'KEPT'],
      [3, 'ADD', 'TYPED'],
      [4, 'SKIP', null],
    ])
    expect(preview.rows[0]).toMatchObject({ before: { '50': 2, '52': 4, '54': 2 }, after: { '50': 2, '52': 6, '54': 2 } })
    expect(preview.rows[1].leftOut.map((entry: Json) => entry.message)).toEqual(['Row 3, size 52: "x" is not whole pieces.', 'Row 3: 56 is not a size of SEED-JKT-01 (50, 52, 54).'])
    expect(preview.rows[2].words).toBe('Row 4: SEED-NOPE is not a style this company sells.')
    // Nothing written by the review.
    expect(grid(lineOf((await ok('seller', 'GET', q(quote.id))).quote, BLK))).toEqual({ '50': 2, '52': 4, '54': 2 })
    const done = await ok('seller', 'POST', `${q(quote.id)}/lines/paste`, { version: quote.version, text })
    quote = done.quote
    expect(grid(lineOf(quote, BLK))).toEqual({ '50': 2, '52': 6, '54': 2 })
    expect(lineOf(quote, RED)).toMatchObject({ unitPrice: '401.5', quantity: 4 })
    expect(grid(lineOf(quote, RED))).toEqual({ '50': 1, '54': 3 })
    // A stale review is refused.
    await refused('seller', 'POST', `${q(quote.id)}/lines/paste`, { version: quote.version - 1, text, preview: true }, 409)
  })
})

describe('a size run changed in bulk (SAL-160)', () => {
  it('shows each line before → after, writes it in one command, and keeps a delivery schedule whole', async () => {
    const preview = await ok('seller', 'POST', `${q(quote.id)}/lines/sizes`, { version: quote.version, change: { kind: 'PERCENT', pct: '50' }, preview: true })
    expect(preview.lines.map((line: Json) => [line.label, line.after])).toEqual([
      ['10 · SEED-JKT-01 BLK', { '50': 3, '52': 9, '54': 3 }],
      ['20 · SEED-JKT-01 RED', { '50': 2, '54': 5 }],
    ])
    expect(preview.counts).toEqual({ lines: 2, changing: 2, unchanged: 0, problems: 0 })
    const black = lineOf(quote, BLK)
    quote = (await ok('seller', 'POST', `${q(quote.id)}/lines/sizes`, { version: quote.version, lineIds: [black.id], sizes: ['52'], change: { kind: 'DELTA', pieces: -2 } })).quote
    expect(grid(lineOf(quote, BLK))).toEqual({ '50': 2, '52': 4, '54': 2 })
    // B-W2b-294's schedule: 52 × 4 promised on one day; taking 52 down to 1 would break it.
    const today = businessDate(new Date())
    await ok('seller', 'PUT', `${q(quote.id)}/lines/${black.id}/deliveries`, { version: quote.version, deliveries: [{ deliveryDate: addDays(today, 30), sizes: { '52': 4 } }] })
    quote = (await ok('seller', 'GET', q(quote.id))).quote
    const held = await ok('seller', 'POST', `${q(quote.id)}/lines/sizes`, { version: quote.version, lineIds: [black.id], change: { kind: 'SET', pieces: 1 }, preview: true })
    expect(held.lines[0].problems).toEqual([expect.objectContaining({ code: 'SCHEDULE', message: expect.stringContaining('its delivery schedule brings 4 pieces of size 52') })])
    const error = await refused('seller', 'POST', `${q(quote.id)}/lines/sizes`, { version: quote.version, lineIds: [black.id], change: { kind: 'SET', pieces: 1 } }, 409)
    expect(error.message).toContain('Change the schedule first')
    // Filling the empty sizes the colourway offers.
    const red = lineOf(quote, RED)
    quote = (await ok('seller', 'POST', `${q(quote.id)}/lines/sizes`, { version: quote.version, lineIds: [red.id], change: { kind: 'FILL_EMPTY', pieces: 2 } })).quote
    expect(grid(lineOf(quote, RED))).toEqual({ '50': 1, '52': 2, '54': 3 })
  })
})

describe('lines filled by a curve or a prepack (SAL-269, QT2:01)', () => {
  it("fills by the curve in whole pieces, the rest on the base size; the curve's sizes the line lacks left out", async () => {
    const red = lineOf(quote, RED)
    const preview = await ok('seller', 'POST', `${q(quote.id)}/lines/fill`, { version: quote.version, curveId: pricing.curveIds[0], lines: [{ lineId: red.id, pieces: 100 }], preview: true })
    // 50-54 share 20 + 40 + 25 = 85: 23.5 → 23, 47.1 → 47, 29.4 → 29 (99): 1 more on 52, the base size.
    expect(preview.lines[0].after).toEqual({ '50': 23, '52': 48, '54': 29 })
    expect(preview.lines[0].fill).toMatchObject({ leftOut: ['48', '56'], remainder: { size: '52', pieces: 1 } })
    quote = (await ok('seller', 'POST', `${q(quote.id)}/lines/fill`, { version: quote.version, curveId: pricing.curveIds[0], lines: [{ lineId: red.id, pieces: 100 }] })).quote
    expect(lineOf(quote, RED).quantity).toBe(100)
  })

  it('fills from a usable prepack × packs, each colourway its own; refuses a pack of sizes the line lacks and an archived one', async () => {
    const red = lineOf(quote, RED)
    const black = lineOf(quote, BLK)
    const preview = await ok('seller', 'POST', `${q(quote.id)}/lines/fill`, { version: quote.version, prepackId: sizes.prepackIds.colours, lines: [{ lineId: red.id, packs: 3 }, { lineId: black.id, packs: 2 }], preview: true })
    expect(preview.lines.map((line: Json) => line.after)).toEqual([{ '52': 3 }, { '52': 4 }])
    expect(preview.source).toMatchObject({ kind: 'PREPACK', name: expect.stringContaining('SEED-PP-JKT-COL') })
    quote = (await ok('seller', 'POST', `${q(quote.id)}/lines/fill`, { version: quote.version, prepackId: sizes.prepackIds.colours, lines: [{ lineId: red.id, packs: 3 }] })).quote
    expect(grid(lineOf(quote, RED))).toEqual({ '52': 3 })
    const scalePack = await ok('seller', 'POST', `${q(quote.id)}/lines/fill`, { version: quote.version, prepackId: sizes.prepackIds.scale, lines: [{ lineId: red.id, packs: 1 }], preview: true })
    expect(scalePack.lines[0].problems[0].message).toContain('sizes this line does not take (48, 56)')
    await refused('seller', 'POST', `${q(quote.id)}/lines/fill`, { version: quote.version, prepackId: sizes.prepackIds.archived, lines: [{ lineId: red.id, packs: 1 }], preview: true }, 409)
    expect((await refused('seller', 'POST', `${q(quote.id)}/lines/fill`, { version: quote.version, lines: [{ lineId: red.id, packs: 1 }] }, 400)).message).toBe('Fill from one size curve or one prepack.')
  })
})
