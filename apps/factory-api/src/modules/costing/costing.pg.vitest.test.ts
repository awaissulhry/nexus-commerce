import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission, ScopeSet } from '@nexus/factory-domain/core/permissions'
import type { LabourRate, OverheadRule } from '@nexus/factory-domain/costing/inputs'
import { MONEY_NAME } from '@nexus/factory-domain/money/marked'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedProduct } from '../../../../../packages/factory-db/seed/product'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { useCostingInputs } from './inputs'

/**
 * The style cost sheet on the local stack (B-W1-16; FIN-001, FIN-002, FIN-004, GAP-006, PLT-034), with the app's real
 * routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login, so row-level security is real),
 * the product seed's jacket (leather 43 / 45 / 47.5 ft² in sizes 50 / 52 / 54 with 12 % waste at 4.20/ft², a lining
 * 1.8 m with 5 % waste at 3.10/m, two protectors at 6.50; cut 14, sew 96.5, inspect 8, pack 3.5 minutes), made-up
 * rates per kind of work centre and 10 % overhead. Every figure is made up and worked out by hand below. Run with
 * `node scripts/factory/run-pg-tests.mjs costing`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'costing-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const companyB = seedId('company:B')
const siteA = seedId('site:A1')
const jacket = seedId('product:style:JKT-01')
const revision1 = seedId('product:revision:JKT-01:1')
const BLK = seedId('product:colourway:JKT-01:BLK')
const RED = seedId('product:colourway:JKT-01:RED')
const leather = seedId('product:item:leather')
const lining = seedId('product:item:lining')
const leatherLine = seedId('product:bom:JKT-01:1:10')
const otherTenant = newId()

const VIEW: Permission = 'costing.view'
const PRODUCT: Permission[] = ['product.styles.view', 'product.bom.view', 'product.bom.manage', 'product.bom.release', 'product.routing.view', 'product.materials.view', 'product.materials.cost']
const grainsOf = (grains: readonly string[]): Permission[] => grains.map((grain) => `money.${grain}` as Permission)

interface Person {
  readonly tenantId: string
  readonly permissions: readonly Permission[]
  readonly companies: ScopeSet
}
const fromTemplate = (key: string): Person => {
  const role = templateOf(key)!
  return { tenantId: tenant, permissions: [...role.permissions, ...grainsOf(role.grains)], companies: 'all' }
}
const PEOPLE: Record<string, Person> = {
  // The finance and sales templates as they are: finance sees costs, sales holds costing.view but not the cost grain.
  finance: fromTemplate('finance'),
  sales: fromTemplate('sales'),
  engineer: { tenantId: tenant, permissions: [VIEW, ...PRODUCT, 'money.cost'], companies: 'all' },
  companyB: { tenantId: tenant, permissions: [VIEW, 'money.cost'], companies: [companyB] },
  noView: { tenantId: tenant, permissions: ['product.bom.view', 'money.cost'], companies: 'all' },
  otherTenant: { tenantId: otherTenant, permissions: [VIEW, 'money.cost'], companies: 'all' },
}
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions], companies: person.companies, sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: person.tenantId, actorId: newId(), grants: [grant] }]
  }),
)
// A floor device and a portal session holding even the cost permission and grain: costing is the office's only.
SESSIONS.floor = { audience: 'floor', tenantId: tenant, actorId: newId(), siteId: siteA, deviceId: newId(), grants: [{ permissions: [VIEW, 'floor.work', 'money.wages'], companies: [companyA], sites: [siteA], parties: 'all' }] }
SESSIONS.partner = { audience: 'partner', tenantId: tenant, actorId: newId(), partyId: seedId('party:P1'), grants: [{ permissions: [VIEW, 'money.price'], companies: 'all', sites: 'all', parties: [seedId('party:P1')] }] }

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const sheetUrl = (revisionId: string, query = '') => `/costing/styles/${jacket}/revisions/${revisionId}/cost-sheet${query}`
const getSheet = async (session = 'finance', revisionId = revision1, query = ''): Promise<Json> => (await ok(session, 'GET', sheetUrl(revisionId, query))).sheet
const cellOf = (sheet: Json, colourwayId: string, size: string): Json => sheet.cells.find((cell: Json) => cell.colourwayId === colourwayId && cell.size === size)
const totals = (sheet: Json) => sheet.cells.map((cell: Json) => [cell.colourwayId === BLK ? 'BLK' : 'RED', cell.size, cell.total])

/** Every key of a JSON value, at any depth. */
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []

// ---- the labour rates and overhead (made up) ----------------------------------------------------------------------------

let rateSeq = 0
const rate = (over: Partial<LabourRate> & Pick<LabourRate, 'workCentreKind' | 'costPerMinute'>): LabourRate => ({
  id: newId(),
  companyId: null,
  currency: 'EUR',
  plannedEfficiencyPct: '100',
  validFrom: `2026-01-${String(++rateSeq).padStart(2, '0')}`,
  status: 'ACTIVE',
  ...over,
})
const RATES: LabourRate[] = [
  rate({ workCentreKind: 'CUTTING', costPerMinute: '0.5' }),
  rate({ workCentreKind: 'SEWING', costPerMinute: '0.4', plannedEfficiencyPct: '80' }),
  rate({ workCentreKind: 'INSPECTION', costPerMinute: '0.45' }),
  rate({ workCentreKind: 'PACKING', costPerMinute: '0.3' }),
]
const OVERHEAD: OverheadRule = { id: newId(), companyId: null, overheadPct: '10', updatedAt: '2026-10-01T08:00:00.000Z' }

/** The rates and overhead rules the sheet reads (filtered by company as the reader does). */
function setInputs(rates: readonly LabourRate[], overheads: readonly OverheadRule[]): void {
  useCostingInputs({
    labourRates: async (_client, companyId) => rates.filter((entry) => entry.companyId === null || entry.companyId === companyId),
    overheadRules: async (_client, companyId) => overheads.filter((entry) => entry.companyId === null || entry.companyId === companyId),
  })
}

beforeAll(async () => {
  db = await migratedDatabase('costing')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 16 } })
  await seedCore({ db: database, namespace: NS })
  await seedProduct({ db: database, namespace: NS })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [otherTenant, 'costing-other'])
  setInputs(RATES, [OVERHEAD])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 60_000)

afterAll(async () => {
  useCostingInputs(undefined)
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe("the seed jacket's cost per size (FIN-001, FIN-002, FIN-004)", () => {
  // Labour, every size: cut 14 × 0.50 = 7; sew 96.5 × 0.40 ÷ 0.80 = 48.25; inspect 8 × 0.45 = 3.60; pack 3.5 × 0.30 = 1.05:
  // 59.90. Size 52: leather 45 × 1.12 = 50.4 ft² × 4.20 = 211.68; lining 1.8 × 1.05 = 1.89 m × 3.10 = 5.859; protectors
  // 2 × 6.50 = 13; material 230.539; + 59.90 = 290.439; + 10 % = 319.4829. Size 50: leather 48.16 ft² = 202.272;
  // material 221.131; 281.031 × 1.1 = 309.1341. Size 54: leather 53.2 ft² = 223.44; material 242.299; × → 332.4189.
  it('costs every colourway × size from the BOM and the routing, with the waterfall and the inputs used', async () => {
    const sheet = await getSheet()
    expect(sheet).toMatchObject({
      style: { id: jacket, code: 'SEED-JKT-01', companyId: null, baseSize: '52' },
      revision: { id: revision1, revision: 1, status: 'DRAFT' },
      estimate: true,
      currency: 'EUR',
      companyId: null,
      sizes: ['50', '52', '54'],
      colourways: [
        { id: BLK, code: 'BLK' },
        { id: RED, code: 'RED' },
      ],
      complete: true,
      missing: [],
    })
    expect(totals(sheet)).toEqual([
      ['BLK', '50', '309.1341'],
      ['BLK', '52', '319.4829'],
      ['BLK', '54', '332.4189'],
      ['RED', '50', '309.1341'],
      ['RED', '52', '319.4829'],
      ['RED', '54', '332.4189'],
    ])
    const base = cellOf(sheet, BLK, '52')
    expect(base).toMatchObject({ complete: true, minutes: '122', knownTotal: '319.4829', overhead: { overheadPct: '10', base: '290.439', amount: '29.0439' } })
    expect(base.material.lines.map((line: Json) => [line.code, line.qty, line.uom, line.wastagePct, line.baseQuantity, line.unitCost, line.amount])).toEqual([
      ['SEED-LEA-100', '45', 'FT2', '12', '50.4', '4.2', '211.68'],
      ['SEED-LIN-200', '1.8', 'M', '5', '1.89', '3.1', '5.859'],
      ['SEED-PRO-300', '2', 'PCS', '0', '2', '6.5', '13'],
    ])
    expect(base.labour.lines.map((line: Json) => [line.workCentreKind, line.minutes, line.amount])).toEqual([
      ['CUTTING', '14', '7'],
      ['SEWING', '96.5', '48.25'],
      ['INSPECTION', '8', '3.6'],
      ['PACKING', '3.5', '1.05'],
    ])
    expect(base.waterfall.map((step: Json) => [step.step, step.category ?? step.workCentreKind, step.runningTotal])).toEqual([
      ['MATERIAL', 'LEATHER', '211.68'],
      ['MATERIAL', 'MATERIALS', '230.539'],
      ['LABOUR', 'CUTTING', '237.539'],
      ['LABOUR', 'SEWING', '285.789'],
      ['LABOUR', 'INSPECTION', '289.389'],
      ['LABOUR', 'PACKING', '290.439'],
      ['OVERHEAD', null, '319.4829'],
    ])
    // The leather is bought by the 52.5 ft² hide: 4.20 × 52.5 = 220.50 a hide. The seed writes no audit row, so the price
    // is as of the material's last change.
    expect(sheet.inputs.materials[0]).toMatchObject({ itemId: leather, source: 'STANDARD', baseUom: 'FT2', standardCost: '4.2', currency: 'EUR', purchaseUom: 'HIDE', standardCostPerPurchaseUnit: '220.5', asOf: '2026-10-28T08:00:00.000Z' })
    expect(sheet.inputs.labour.map((entry: Json) => [entry.workCentreKind, entry.source, entry.costPerMinute, entry.plannedEfficiencyPct])).toEqual([
      ['CUTTING', 'LABOUR_RATE', '0.5', '100'],
      ['SEWING', 'LABOUR_RATE', '0.4', '80'],
      ['INSPECTION', 'LABOUR_RATE', '0.45', '100'],
      ['PACKING', 'LABOUR_RATE', '0.3', '100'],
    ])
    expect(sheet.inputs.overhead).toMatchObject({ source: 'OVERHEAD_RULE', overheadPct: '10' })
  })

  it("costs a quote's cells: the unit cost per garment and the amount for a quantity, rounded once", async () => {
    const batch = (
      await ok('finance', 'POST', '/costing/cells', {
        styleId: jacket,
        revisionId: revision1,
        cells: [
          { colourwayId: BLK, size: '52', quantity: 7 },
          { colourwayId: RED, size: '54' },
        ],
      })
    ).batch
    // 319.4829 × 7 = 2236.3803 → 223638 cents; 122 × 7 = 854 minutes.
    expect(batch).toMatchObject({ revision: { id: revision1 }, estimate: true, currency: 'EUR', complete: true, missing: [] })
    expect(batch.cells).toEqual([
      { colourwayId: BLK, size: '52', quantity: 7, complete: true, missing: [], minutes: '122', materialCost: '230.539', labourCost: '59.9', overheadCost: '29.0439', knownUnitCost: '319.4829', unitCost: '319.4829', quantityMinutes: '854', amount: 223638 },
      { colourwayId: RED, size: '54', quantity: null, complete: true, missing: [], minutes: '122', materialCost: '242.299', labourCost: '59.9', overheadCost: '30.2199', knownUnitCost: '332.4189', unitCost: '332.4189', quantityMinutes: null, amount: null },
    ])
    const refusal = await refused('finance', 'POST', '/costing/cells', { styleId: jacket, revisionId: revision1, cells: [{ colourwayId: BLK, size: '56' }, { colourwayId: newId(), size: '52' }] }, 400)
    expect(refusal.issues).toEqual([
      { path: 'body/cells/0/size', message: "Not a size of this style's range (50, 52, 54)." },
      { path: 'body/cells/1/colourwayId', message: 'Not an active colourway of this style.' },
    ])
  })
})

describe('a missing input is listed and the cost is not complete, never a silent 0', () => {
  it('a material without a standard price: the cells that use it, until a price is set (with its date)', async () => {
    const version = async () => (await admin<{ version: number }>('SELECT version FROM "Item" WHERE id = $1', [lining]))[0]!.version
    await ok('engineer', 'PUT', `/product/materials/${lining}/standard-cost`, { version: await version(), standardCost: null, reason: 'Waiting for the new price list (made up).' })
    const sheet = await getSheet()
    expect(sheet.complete).toBe(false)
    expect(sheet.missing).toEqual([
      { key: `MATERIAL_PRICE:${lining}`, code: 'MATERIAL_PRICE', itemId: lining, lineId: null, size: null, workCentreKind: null, message: 'SEED-LIN-200 Seed mesh lining has no standard purchase price.' },
    ])
    // Size 52 without the lining: 224.68 + 59.90 = 284.58, + 10 % = 313.038 known.
    expect(cellOf(sheet, BLK, '52')).toMatchObject({ complete: false, missing: [`MATERIAL_PRICE:${lining}`], total: null, knownTotal: '313.038', material: { complete: false, amount: '224.68' } })
    expect(cellOf(sheet, BLK, '52').material.lines[1]).toMatchObject({ code: 'SEED-LIN-200', unitCost: null, amount: null })
    expect(sheet.cells.every((cell: Json) => cell.total === null)).toBe(true)
    const batch = (await ok('finance', 'POST', '/costing/cells', { styleId: jacket, revisionId: revision1, cells: [{ colourwayId: BLK, size: '52', quantity: 3 }] })).batch
    expect(batch).toMatchObject({ complete: false, missing: [{ code: 'MATERIAL_PRICE', itemId: lining }] })
    expect(batch.cells[0]).toMatchObject({ complete: false, unitCost: null, amount: null, knownUnitCost: '313.038', quantityMinutes: '366' })

    await ok('engineer', 'PUT', `/product/materials/${lining}/standard-cost`, { version: await version(), standardCost: '3.1', reason: 'New price list (made up).' })
    const again = await getSheet()
    expect(again.complete).toBe(true)
    const [{ at }] = await admin<{ at: Date }>(`SELECT at FROM "AuditLog" WHERE "recordType" = 'Item' AND "recordId" = $1 ORDER BY at DESC LIMIT 1`, [lining])
    expect(again.inputs.materials.find((entry: Json) => entry.itemId === lining)).toMatchObject({ standardCost: '3.1', asOf: at!.toISOString() })
  })

  it('a kind of work centre without a cost per minute: every cell, and the labour says which', async () => {
    setInputs(
      RATES.filter((entry) => entry.workCentreKind !== 'SEWING'),
      [OVERHEAD],
    )
    try {
      const sheet = await getSheet()
      expect(sheet.complete).toBe(false)
      expect(sheet.missing).toEqual([
        { key: 'LABOUR_RATE:SEWING', code: 'LABOUR_RATE', itemId: null, lineId: null, size: null, workCentreKind: 'SEWING', message: expect.stringMatching(/^No cost per minute for SEWING work centres is in force on \d{4}-\d{2}-\d{2}\.$/) },
      ])
      // Size 52: labour without sewing 11.65; 230.539 + 11.65 = 242.189, + 10 % = 266.4079 known.
      expect(cellOf(sheet, BLK, '52')).toMatchObject({ complete: false, total: null, knownTotal: '266.4079', labour: { complete: false, amount: '11.65' } })
      expect(sheet.inputs.labour[1]).toMatchObject({ workCentreKind: 'SEWING', source: 'NONE', rateId: null, costPerMinute: null })
      expect(sheet.cells.every((cell: Json) => !cell.complete && cell.missing.includes('LABOUR_RATE:SEWING'))).toBe(true)
    } finally {
      setInputs(RATES, [OVERHEAD])
    }
  })
})

describe('who sees what (A1 §2.6; PLT-034, PLT-035)', () => {
  it('a sales person (costing.view, not the cost grain) sees the structure and what is missing, never a cost figure', async () => {
    const sheet = await getSheet('sales')
    expect(sheet).toMatchObject({ complete: true, currency: 'EUR', sizes: ['50', '52', '54'] })
    const cell = cellOf(sheet, BLK, '52')
    expect(cell).toMatchObject({ complete: true, minutes: '122' })
    expect(cell.material.lines[0]).toMatchObject({ code: 'SEED-LEA-100', qty: '45', baseQuantity: '50.4' })
    expect(cell.waterfall.map((step: Json) => step.step)).toEqual(['MATERIAL', 'MATERIAL', 'LABOUR', 'LABOUR', 'LABOUR', 'LABOUR', 'OVERHEAD'])
    expect(cell.overhead).toEqual({ overheadPct: '10' })
    // Not one money-looking key, nor an overhead base, anywhere in the answer (computedAt is a time).
    const costKeys = (value: unknown) => keysOf(value).filter((key) => (MONEY_NAME.test(key) && key !== 'computedAt') || key === 'base')
    expect(costKeys(sheet)).toEqual([])
    expect(sheet.inputs.materials[0]).not.toHaveProperty('standardCost')
    expect(sheet.inputs.labour[0]).not.toHaveProperty('costPerMinute')

    const batch = (await ok('sales', 'POST', '/costing/cells', { styleId: jacket, revisionId: revision1, cells: [{ colourwayId: BLK, size: '52', quantity: 7 }] })).batch
    expect(batch.cells[0]).toEqual({ colourwayId: BLK, size: '52', quantity: 7, complete: true, missing: [], minutes: '122', quantityMinutes: '854' })
    expect(costKeys(batch)).toEqual([])
    // The finance template sees them.
    expect(cellOf(await getSheet('finance'), BLK, '52').total).toBe('319.4829')
  })

  it('refuses the floor and portal sessions, and a person without costing.view', async () => {
    for (const session of ['floor', 'partner', 'noView']) {
      expect((await refused(session, 'GET', sheetUrl(revision1), undefined, 403)).code).toBe('forbidden')
      expect((await refused(session, 'POST', '/costing/cells', { styleId: jacket, revisionId: revision1, cells: [{ colourwayId: BLK, size: '52' }] }, 403)).code).toBe('forbidden')
      expect((await refused(session, 'GET', `/costing/styles/${jacket}/cost-sheet/compare?from=${revision1}&to=${revision1}`, undefined, 403)).code).toBe('forbidden')
    }
  })

  it('keeps the tenant and company walls: another tenant finds nothing; a company outside the grants is not found', async () => {
    expect((await refused('otherTenant', 'GET', sheetUrl(revision1), undefined, 404)).message).toBe('Style not found.')
    expect((await refused('otherTenant', 'POST', '/costing/cells', { styleId: jacket, revisionId: revision1, cells: [{ colourwayId: BLK, size: '52' }] }, 404)).message).toBe('Style not found.')
    // The jacket is tenant-wide: company B's person costs it for company B, never for company A.
    expect((await getSheet('companyB', revision1, `?companyId=${companyB}`)).companyId).toBe(companyB)
    expect((await refused('companyB', 'GET', sheetUrl(revision1, `?companyId=${companyA}`), undefined, 404)).message).toBe('Company not found.')
    expect((await refused('finance', 'GET', sheetUrl(revision1, `?companyId=${newId()}`), undefined, 404)).message).toBe('Company not found.')
    // A style of company A: company B's person does not find it, and nobody costs it for another company.
    await admin('UPDATE "Style" SET "companyId" = $1 WHERE id = $2', [companyA, jacket])
    try {
      expect((await refused('companyB', 'GET', sheetUrl(revision1), undefined, 404)).message).toBe('Style not found.')
      expect((await getSheet('finance')).companyId).toBe(companyA)
      expect((await refused('finance', 'GET', sheetUrl(revision1, `?companyId=${companyB}`), undefined, 400)).issues).toEqual([
        { path: 'querystring/companyId', message: "This style belongs to one company: its cost is that company's." },
      ])
    } finally {
      await admin('UPDATE "Style" SET "companyId" = NULL WHERE id = $1', [jacket])
    }
    // Another style's revision is not found.
    expect((await refused('finance', 'GET', `/costing/styles/${jacket}/revisions/${newId()}/cost-sheet`, undefined, 404)).message).toBe('Revision not found.')
  })
})

describe('two revisions compared', () => {
  it('releases revision 1, copies it, makes size 54 bigger, and shows what that costs', async () => {
    const bomUrl = (revisionId: string) => `/product/styles/${jacket}/revisions/${revisionId}`
    const bom = (await ok('engineer', 'GET', `${bomUrl(revision1)}/bom`)).bom
    await ok('engineer', 'POST', `${bomUrl(revision1)}/release`, { version: bom.revision.version })
    let copy = (await ok('engineer', 'POST', `${bomUrl(revision1)}/copy`, { changeNote: 'A bigger 54 (made up).' }, 201)).bom
    const revision2 = copy.revision.id as string
    const line = copy.lines.find((entry: Json) => entry.item.id === leather)
    copy = (await ok('engineer', 'PUT', `${bomUrl(revision2)}/bom/lines/${line.id}/sizes`, { version: copy.revision.version, sizes: [{ size: '54', qty: '48' }] })).bom

    const released = await getSheet('finance', revision1)
    expect(released).toMatchObject({ revision: { status: 'RELEASED' }, estimate: false, complete: true })
    const diff = (await ok('finance', 'GET', `/costing/styles/${jacket}/cost-sheet/compare?from=${revision1}&to=${revision2}`)).diff
    expect(diff).toMatchObject({ from: { id: revision1, status: 'RELEASED', complete: true, missing: [] }, to: { id: revision2, revision: 2, status: 'DRAFT', complete: true }, currency: 'EUR', unchanged: 4 })
    // Size 54: +0.5 ft² × 1.12 × 4.20 = +2.352 material, +0.2352 overhead, +2.5872 in all.
    expect(diff.cells.map((cell: Json) => [cell.colourwayId === BLK ? 'BLK' : 'RED', cell.size, cell.materialCostChange, cell.labourCostChange, cell.overheadCostChange, cell.totalChange])).toEqual([
      ['BLK', '54', '2.352', '0', '0.2352', '2.5872'],
      ['RED', '54', '2.352', '0', '0.2352', '2.5872'],
    ])
    expect(diff.cells[0].materials).toEqual([{ itemId: leather, code: 'SEED-LEA-100', from: { baseQuantity: '53.2', materialCost: '223.44' }, to: { baseQuantity: '53.76', materialCost: '225.792' } }])
    expect(diff.cells[0].from).toMatchObject({ total: '332.4189' })
    expect(diff.cells[0].to).toMatchObject({ total: '335.0061' })

    // Without the grain, the same answer has the structure and no figure.
    const blind = (await ok('sales', 'GET', `/costing/styles/${jacket}/cost-sheet/compare?from=${revision1}&to=${revision2}`)).diff
    expect(blind.cells[0]).toEqual({ colourwayId: BLK, size: '54', from: { complete: true }, to: { complete: true }, materials: [{ itemId: leather, code: 'SEED-LEA-100', from: { baseQuantity: '53.2' }, to: { baseQuantity: '53.76' } }], labour: [] })

    // A draft size without a quantity is missing in that size alone.
    copy = (await ok('engineer', 'PUT', `${bomUrl(revision2)}/bom/lines/${line.id}/sizes`, { version: copy.revision.version, sizes: [{ size: '50', qty: null }] })).bom
    const draft = await getSheet('finance', revision2)
    expect(draft.missing).toEqual([{ key: `BOM_QUANTITY:${line.id}:50`, code: 'BOM_QUANTITY', itemId: null, lineId: line.id, size: '50', workCentreKind: null, message: 'BOM line 10 (SEED-LEA-100) has no quantity for size 50.' }])
    expect(draft.cells.filter((cell: Json) => !cell.complete).map((cell: Json) => cell.size)).toEqual(['50', '50'])
    expect(leatherLine).not.toBe(line.id)
  })
})
