import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCostSheets, type CostSheetsSeed } from '../../../../../../packages/factory-db/seed/cost-sheets'
import { seed as seedPacking } from '../../../../../../packages/factory-db/seed/packing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * The cost sheet's components on the local stack (B-W2b-418; FIN-003, FIN-006, FIN-008, FIN-009, FIN-011, FIN-020) with the
 * app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the
 * …_cost_sheets_w2b_guards are real), the product seed's jacket (every company's; revision 1 a DRAFT: leather 43 / 45 / 47.5
 * ft² net in sizes 50 / 52 / 54 at 4.20, a lining 1.8 m with 5 % waste at 3.10, two protectors at 6.50; cut 14, sew 96.5,
 * inspect 8, pack 3.5 minutes), the costing seed's tenant-wide rates (cut 0.50, sew 0.40 at 80 %, pack 0.30), the cost sheets
 * seed (the jacket's own leather basis 82.5 % with A 70 / B 30 — the article's grade rules A 88 % and B 74 % usable: 83.8 % —
 * company A's leather uplift 3 % freight and 0.5 % insurance, the workshop P2's transport 0.80 out and 0.80 back, company A's
 * overhead 25 % of labour and 0.05 per sewing minute, every company's 2.75 per garment; version 3 of company A's FW27 sheet a
 * DRAFT with a typed packaging line) and the packing seed (company A's polybag 0.05 and carton 1.20 for the jacket). The
 * final inspection is given to the workshop P2 at 1.50 a piece below. Every figure is made up and worked out by hand.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/costing/sheet-components`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seeded: CostSheetsSeed

const NS = 'sheet-components'
const id = (key: string) => seedUuid(NS, key)
const tenant = id('tenant')
const companyA = id('company:A')
const companyB = id('company:B')
const siteA1 = id('site:A1')
const jacket = id('product:style:JKT-01')
const revision1 = id('product:revision:JKT-01:1')
const leather = id('product:item:leather')
const protector = id('product:item:protector')
const inspectStep = id('product:routing:JKT-01:1:SEED-FIN-QC')
const workshop = id('party:P2')
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `t-${run}-${++keys}`

const grant = (permissions: readonly string[], companies: Grant['companies'] = 'all'): Grant => ({ permissions: permissions as Permission[], companies, sites: 'all', parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants })
const fromTemplate = (name: string): SessionContext => {
  const role = templateOf(name)!
  return office([grant([...role.permissions, ...role.grains.map((g) => `money.${g}`)])])
}
const SESSIONS: Record<string, SessionContext> = {
  finance: fromTemplate('finance'),
  // Sales holds costing.view, not the cost grain: it sees the structure, quantities and words without a figure.
  sales: fromTemplate('sales'),
  viewerA: office([grant(['costing.view', 'money.cost'], [companyA])]),
  keeperB: office([grant(['costing.view', 'costing.sheets.manage', 'money.cost'], [companyB])]),
  floor: { audience: 'floor', tenantId: tenant, actorId: newId(), siteId: siteA1, deviceId: newId(), grants: [grant(['costing.view', 'costing.sheets.manage', 'money.cost'], [companyA])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function failed(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
async function refusal(session: string, method: Method, url: string, payload: unknown, code: string): Promise<Json> {
  const error = await failed(session, method, url, payload, 409)
  expect(error.issues?.[0]?.path).toBe(`refusal/${code}`)
  return error
}
const eventsOf = async (subject: string) => (await admin<{ type: string; payload: Json }>('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])).map((event) => [event.type, event.payload])
const componentsUrl = (query: string) => `/costing/styles/${jacket}/revisions/${revision1}/components?${query}`
const brief = (lines: Json[]) => lines.map((line) => [line.category, line.source, line.size, line.quantity, line.uom, line.unitCost, line.cost, line.pct])
const today = businessDate(new Date())

beforeAll(async () => {
  db = await migratedDatabase('sheet_components')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 16 } })
  await seedCore({ db: database, namespace: NS })
  seeded = await seedCostSheets({ db: database, namespace: NS })
  await seedPacking({ db: database, namespace: NS })
  // The final inspection goes out to the workshop P2 (the revision is a DRAFT: its routing still changes).
  await admin('UPDATE "RoutingOperation" SET "supplierId" = $2, "pricePerPiece" = 1.5 WHERE id = $1', [inspectStep, workshop])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe("a revision's components (FIN-003, FIN-008, FIN-009, FIN-011)", () => {
  it('cost the jacket for company A: bought leather, labour, the workshop with its transport, freight, packaging and overhead', async () => {
    const view = await ok('finance', 'GET', componentsUrl(`companyId=${companyA}&piecesPerCarton=12`))
    expect(view).toMatchObject({ companyId: companyA, currency: 'EUR', sizes: ['50', '52', '54'], complete: true, missing: [], piecesPerCarton: 12, pieceRate: { on: false, siteId: null } })
    expect(brief(view.lines)).toEqual([
      // 43 / 45 / 47.5 ft² ÷ (82.5 % × 83.8 %) = 62.1972 / 65.09 / 68.7062 ft² at 4.20 (the yield replaces the 12 % wastage).
      ['LEATHER', 'BOM_LINE', '50', '62.1972', 'FT2', '4.2', '261.22824', null],
      ['LEATHER', 'BOM_LINE', '52', '65.09', 'FT2', '4.2', '273.378', null],
      ['LEATHER', 'BOM_LINE', '54', '68.7062', 'FT2', '4.2', '288.56604', null],
      // 1.8 × 1.05 = 1.89 m at 3.10; two protectors at 6.50.
      ['MATERIAL', 'BOM_LINE', null, '1.89', 'M', '3.1', '5.859', null],
      ['MATERIAL', 'BOM_LINE', null, '2', 'PCS', '6.5', '13', null],
      // Cut 14 × 0.50; sew 96.5 × 0.40 ÷ 80 %; pack 3.5 × 0.30 (the inspection is the workshop's now).
      ['LABOUR', 'ROUTING', null, '14', null, '0.5', '7', null],
      ['LABOUR', 'ROUTING', null, '96.5', null, '0.5', '48.25', null],
      ['LABOUR', 'ROUTING', null, '3.5', null, '0.3', '1.05', null],
      ['SUBCONTRACT', 'ROUTING', null, '1', null, '1.5', '1.5', null],
      ['SUBCONTRACT', 'UPLIFT', null, '1', null, '0.8', '0.8', null],
      ['SUBCONTRACT', 'UPLIFT', null, '1', null, '0.8', '0.8', null],
      // 3 % freight and 0.5 % insurance on each size's leather (company A's own uplift of the article, before its kind's).
      ['FREIGHT', 'UPLIFT', '50', '1', null, '7.836847', '7.836847', '3'],
      ['FREIGHT', 'UPLIFT', '52', '1', null, '8.20134', '8.20134', '3'],
      ['FREIGHT', 'UPLIFT', '54', '1', null, '8.656981', '8.656981', '3'],
      ['FREIGHT', 'UPLIFT', '50', '1', null, '1.306141', '1.306141', '0.5'],
      ['FREIGHT', 'UPLIFT', '52', '1', null, '1.36689', '1.36689', '0.5'],
      ['FREIGHT', 'UPLIFT', '54', '1', null, '1.44283', '1.44283', '0.5'],
      ['PACKAGING', 'PACKAGING', null, '1', null, '0.05', '0.05', null],
      ['PACKAGING', 'PACKAGING', null, '1', null, '0.1', '0.1', null],
      // 25 % of 7, of 48.25 (and 96.5 × 0.05 per sewing minute) and of 1.05; 2.75 a garment.
      ['OVERHEAD', 'OVERHEAD_RULE', null, '1', null, '1.75', '1.75', '25'],
      ['OVERHEAD', 'OVERHEAD_RULE', null, '1', null, '12.0625', '12.0625', '25'],
      ['OVERHEAD', 'OVERHEAD_RULE', null, '96.5', null, '0.05', '4.825', null],
      ['OVERHEAD', 'OVERHEAD_RULE', null, '1', null, '0.2625', '0.2625', '25'],
      ['OVERHEAD', 'OVERHEAD_RULE', null, '1', null, '2.75', '2.75', null],
    ])
    // Size 50: 261.22824 + 18.859 + 56.30 + 3.10 + 9.142988 + 0.15 + 21.65.
    expect(view.split[0]).toMatchObject({ size: '50', total: '370.430228', complete: true })
    expect(view.warnings.map((warning: Json) => warning.code)).toEqual(['NO_WRITTEN_TERMS'])
    expect(view.ledger).toContainEqual({ category: 'PACKAGING', source: 'PACKAGING', ledgerGroup: 'NONE', marginPart: null })
  })

  it('name what is missing in words, ask the company for an every-company style, and show no figure without the cost grain', async () => {
    const missing = await ok('finance', 'GET', componentsUrl(`companyId=${companyA}`))
    expect(missing).toMatchObject({ complete: false, missing: [{ code: 'CARTON_PIECES', recordType: 'PackagingType' }] })
    expect(missing.split.every((size: Json) => size.total === null)).toBe(true)
    expect((await failed('finance', 'GET', componentsUrl(''), undefined, 400)).issues[0].path).toBe('querystring/companyId')
    const blind = await ok('sales', 'GET', componentsUrl(`companyId=${companyA}&piecesPerCarton=12`))
    expect(blind.lines[0]).toMatchObject({ category: 'LEATHER', quantity: '62.1972', uom: 'FT2' })
    expect(blind.lines[0].unitCost).toBeUndefined()
    expect(blind.lines[0].cost).toBeUndefined()
    expect(blind.split[0].total).toBeUndefined()
    await failed('floor', 'GET', componentsUrl(`companyId=${companyA}`), undefined, 403)
  })
})

describe("a draft cost sheet's lines (FIN-020: the split kept from the sheet)", () => {
  it('write a draft from its components, keep its typed line, refuse an incomplete write and an approved sheet', async () => {
    const draft = seeded.sheetIds.draftA
    const { version } = (await admin<{ version: number }>('SELECT version FROM "CostSheet" WHERE id = $1', [draft]))[0]!
    const incomplete = await refusal('finance', 'POST', `/costing/cost-sheets/${draft}/components`, { version }, 'INCOMPLETE')
    expect(incomplete.issues[1]).toMatchObject({ path: 'missing/CARTON_PIECES' })
    await failed('keeperB', 'POST', `/costing/cost-sheets/${draft}/components`, { version, piecesPerCarton: 12 }, 404)
    await failed('viewerA', 'POST', `/costing/cost-sheets/${draft}/components`, { version, piecesPerCarton: 12 }, 403)
    const written = await ok('finance', 'POST', `/costing/cost-sheets/${draft}/components`, { version, piecesPerCarton: 12 })
    expect(written).toMatchObject({ sheet: { id: draft, state: 'DRAFT', version: version + 1 }, keptTyped: 1, missing: [] })
    expect(written.lines).toHaveLength(24)
    // The typed line keeps its place 80: the written lines step over it.
    expect(written.lines.map((line: Json) => line.seq)).not.toContain(80)
    expect(written.lines.at(-1).seq).toBe(250)
    const split = await ok('viewerA', 'GET', `/costing/cost-sheets/${draft}/split`)
    expect(split.lines).toHaveLength(25)
    expect(split.lines.find((line: Json) => line.source === 'TYPED')).toMatchObject({ seq: 80, category: 'PACKAGING', cost: '1.35' })
    // 370.430228 + the typed 1.35.
    expect(split.split[0]).toMatchObject({ size: '50', total: '371.780228', complete: true })
    expect(split.leftOut).toEqual([])
    expect(await eventsOf(draft)).toContainEqual(['cost_sheet.components_written', { sheetId: draft, styleId: jacket, revisionId: revision1, lines: 24, leftOut: 0 }])
    const { inputs } = (await admin<{ inputs: Json }>('SELECT inputs FROM "CostSheet" WHERE id = $1', [draft]))[0]!
    expect(inputs.components).toMatchObject({ piecesPerCarton: 12, leftOut: [], warnings: ['NO_WRITTEN_TERMS'] })
    // Written leaving out what is missing: the sheet keeps the list and its split has no total.
    const left = await ok('finance', 'POST', `/costing/cost-sheets/${draft}/components`, { version: version + 1, leaveOutMissing: true })
    expect(left.missing.map((entry: Json) => entry.code)).toEqual(['CARTON_PIECES'])
    expect((await ok('finance', 'GET', `/costing/cost-sheets/${draft}/split`)).split[0].total).toBeNull()
    await refusal('finance', 'POST', `/costing/cost-sheets/${seeded.sheetIds.approvedA}/components`, { version: 1, piecesPerCarton: 12 }, 'NOT_DRAFT')
  })
})

describe('the inputs: leather bases, uplifts, piece-rate labour', () => {
  it('keep a leather basis: the most specific one costs the sheet, a refused mix, a taken day, nothing to change, archived', async () => {
    const listed = await ok('finance', 'GET', `/costing/leather-bases?companyId=${companyA}`)
    expect(listed.bases.map((basis: Json) => basis.id).sort()).toEqual([seeded.basisIds[0], seeded.basisIds[1]].sort())
    const bad = await failed('finance', 'POST', '/costing/leather-bases', { companyId: companyA, itemId: leather, styleId: jacket, areaUnit: 'DM2', expectedYieldPct: '80', gradeMix: { A: '60', B: '30' }, validFrom: today }, 400)
    expect(bad.issues.map((issue: Json) => issue.path)).toEqual(['body/gradeMix'])
    const { basis } = await ok('finance', 'POST', '/costing/leather-bases', { companyId: companyA, itemId: leather, styleId: jacket, areaUnit: 'DM2', expectedYieldPct: '80', gradeMix: { a: '60', b: '40' }, validFrom: today }, 201)
    expect(basis).toMatchObject({ key: `leather:${leather}:${jacket}:${companyA}`, areaUnit: 'DM2', gradeMix: { A: '60.0000', B: '40.0000' }, inForce: true, version: 1 })
    await refusal('finance', 'POST', '/costing/leather-bases', { companyId: companyA, itemId: leather, styleId: jacket, areaUnit: 'FT2', expectedYieldPct: '81', gradeMix: { A: '100' }, validFrom: today }, 'START_TAKEN')
    const view = await ok('finance', 'GET', componentsUrl(`companyId=${companyA}&piecesPerCarton=12`))
    expect(view.lines[0]).toMatchObject({ category: 'LEATHER', uom: 'DM2', size: '50' })
    expect(view.lines[0].note).toMatch(/80 % yield × 82\.4 % usable by the grade mix A 60 \/ B 40/)
    await refusal('finance', 'PATCH', `/costing/leather-bases/${basis.id}`, { version: 1, areaUnit: 'DM2' }, 'NOTHING_CHANGES')
    const patched = await ok('finance', 'PATCH', `/costing/leather-bases/${basis.id}`, { version: 1, expectedYieldPct: '78.5' })
    expect(patched.basis).toMatchObject({ expectedYieldPct: '78.5', version: 2 })
    const archived = await ok('finance', 'POST', `/costing/leather-bases/${basis.id}/archive`, { version: 2 })
    expect(archived.basis).toMatchObject({ status: 'ARCHIVED', inForce: false })
    await refusal('finance', 'PATCH', `/costing/leather-bases/${basis.id}`, { version: 3, expectedYieldPct: '79' }, 'ARCHIVED')
    expect((await eventsOf(basis.id)).map(([type, payload]) => [type, (payload as Json).change])).toEqual([
      ['leather_cost_basis.changed', 'created'],
      ['leather_cost_basis.changed', 'updated'],
      ['leather_cost_basis.changed', 'archived'],
    ])
    await failed('keeperB', 'POST', '/costing/leather-bases', { companyId: companyA, itemId: leather, areaUnit: 'FT2', expectedYieldPct: '81', gradeMix: { A: '100' }, validFrom: today }, 403)
  })

  it('keep an uplift: duty on the protectors costs the sheet, a workshop takes no percent, landed cost needs receipts', async () => {
    const { uplift } = await ok('finance', 'POST', '/costing/uplifts', { companyId: companyA, target: 'MATERIAL', itemId: protector, dutyPct: '4', validFrom: today }, 201)
    expect(uplift).toMatchObject({ key: `uplift:${companyA}:item:${protector}`, source: 'TYPED', dutyPct: '4', freightPct: null, inForce: true })
    const view = await ok('finance', 'GET', componentsUrl(`companyId=${companyA}&piecesPerCarton=12`))
    // 4 % of the two protectors' 13.00.
    expect(brief(view.lines.filter((line: Json) => line.category === 'DUTY'))).toEqual([['DUTY', 'UPLIFT', null, '1', null, '0.52', '0.52', '4']])
    const bad = await failed('finance', 'POST', '/costing/uplifts', { companyId: companyA, target: 'WORKSHOP', partyId: workshop, freightPct: '3', validFrom: today }, 400)
    expect(bad.issues.map((issue: Json) => issue.path)).toEqual(['body/freightPct', 'body/transportOutPerPiece', 'body/currency'])
    const landed = await ok('finance', 'GET', `/costing/uplifts/landed?companyId=${companyA}&itemKind=LEATHER&from=2026-07-01&to=2026-09-30`)
    expect(landed).toMatchObject({ lots: 0, receivedAmount: 0, landedAmount: 0, pct: null })
    await refusal('finance', 'POST', '/costing/uplifts', { companyId: companyA, target: 'CATEGORY', itemKind: 'LEATHER', source: 'LANDED_COST', landedFrom: '2026-07-01', landedTo: '2026-09-30', validFrom: today }, 'NO_RECEIPTS')
    const patched = await ok('finance', 'PATCH', `/costing/uplifts/${uplift.id}`, { version: 1, dutyPct: '4.5', freightPct: '1' })
    expect(patched.uplift).toMatchObject({ dutyPct: '4.5', freightPct: '1', version: 2 })
    await ok('finance', 'POST', `/costing/uplifts/${uplift.id}/archive`, { version: 2 })
    expect((await eventsOf(uplift.id)).map(([type, payload]) => [type, (payload as Json).change])).toEqual([
      ['cost_uplift.changed', 'created'],
      ['cost_uplift.changed', 'updated'],
      ['cost_uplift.changed', 'archived'],
    ])
    const blind = await ok('sales', 'GET', `/costing/uplifts?companyId=${companyA}&target=WORKSHOP`)
    expect(blind.uplifts[0]).toMatchObject({ id: seeded.upliftIds.workshop, currency: 'EUR' })
    expect(blind.uplifts[0].transportOutPerPiece).toBeUndefined()
  })

  it('switch piece-rate labour only while a site of the company pays piece rates (GATE-PIECE-PAY)', async () => {
    const view = await ok('finance', 'GET', `/costing/piece-rate-labour?companyId=${companyA}`)
    expect(view).toMatchObject({ companyId: companyA, on: false, payingSites: [], settingsVersion: null, can: { manage: true, switchOn: false } })
    await refusal('finance', 'PUT', '/costing/piece-rate-labour', { companyId: companyA, on: true }, 'PIECE_PAY_OFF')
    await refusal('finance', 'PUT', '/costing/piece-rate-labour', { companyId: companyA, on: false }, 'NOTHING_CHANGES')
    await failed('viewerA', 'PUT', '/costing/piece-rate-labour', { companyId: companyA, on: true }, 403)
    expect(await admin('SELECT id FROM "CostingSettings" WHERE id = $1', [companyA])).toEqual([])
  })
})
