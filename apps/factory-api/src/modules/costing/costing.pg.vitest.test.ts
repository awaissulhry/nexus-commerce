import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission, ScopeSet } from '@nexus/factory-domain/core/permissions'
import { MONEY_NAME } from '@nexus/factory-domain/money/marked'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedCosting } from '../../../../../packages/factory-db/seed/costing'
import { seed as seedProduct } from '../../../../../packages/factory-db/seed/product'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { TABLE_COSTING_INPUTS, useCostingInputs } from './inputs'

/**
 * The style cost sheet on the local stack (B-W1-16; FIN-001, FIN-002, FIN-004, GAP-006, PLT-034), with the app's real
 * routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login, so row-level security is real),
 * the product seed's jacket (leather 43 / 45 / 47.5 ft² in sizes 50 / 52 / 54 with 12 % waste at 4.20/ft², a lining
 * 1.8 m with 5 % waste at 3.10/m, two protectors at 6.50; cut 14, sew 96.5, inspect 8, pack 3.5 minutes), the costing
 * seed's tenant-wide rates (cut 0.50, sew 0.40 at 80 %, inspect 0.45, pack 0.30 a minute) and its overhead, set to 10 %
 * through the API first. Every figure is made up and worked out by hand below. Run with
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
  managerB: { tenantId: tenant, permissions: [VIEW, 'costing.rates.manage', 'money.cost'], companies: [companyB] },
  blindManager: { tenantId: tenant, permissions: [VIEW, 'costing.rates.manage', 'audit.read'], companies: 'all' },
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

const eventsOf = async (subject: string) => (await admin<{ type: string; payload: Json }>('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])).map((event) => [event.type, event.payload])
const settingsOf = async (session = 'finance', query = ''): Promise<Json> => (await ok(session, 'GET', `/costing/settings${query}`)).settings

beforeAll(async () => {
  db = await migratedDatabase('costing')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 16 } })
  await seedCore({ db: database, namespace: NS })
  await seedProduct({ db: database, namespace: NS })
  await seedCosting({ db: database, namespace: NS })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [otherTenant, 'costing-other'])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
  // The seed's tenant-wide overhead is 0 %: 10 % for the figures below.
  const seeded = await settingsOf()
  expect(seeded).toMatchObject({ tenant: { id: tenant, companyId: null, overheadPct: '0', version: 1 }, company: null, inForce: tenant })
  await ok('finance', 'PUT', '/costing/settings', { overheadPct: '10', version: 1 })
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
    expect(sheet.inputs.labour.map((entry: Json) => [entry.rateId, entry.companyId, entry.validFrom])).toEqual(
      ['CUTTING', 'SEWING', 'INSPECTION', 'PACKING'].map((kind) => [seedId(`costing:rate:${kind}`), null, '2026-01-01']),
    )
    expect(sheet.inputs.overhead).toMatchObject({ source: 'OVERHEAD_RULE', ruleId: tenant, companyId: null, overheadPct: '10' })
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
    const [audit] = await admin<{ at: Date }>(`SELECT at FROM "AuditLog" WHERE "recordType" = 'Item' AND "recordId" = $1 ORDER BY at DESC LIMIT 1`, [lining])
    expect(again.inputs.materials.find((entry: Json) => entry.itemId === lining)).toMatchObject({ standardCost: '3.1', asOf: audit!.at.toISOString() })
  })

  it('a kind of work centre without a cost per minute: every cell, and the labour says which', async () => {
    // The table's rates without the sewing ones (as if none had been typed).
    useCostingInputs({
      labourRates: async (client, companyId) => (await TABLE_COSTING_INPUTS.labourRates(client, companyId)).filter((entry) => entry.workCentreKind !== 'SEWING'),
      overheadRules: TABLE_COSTING_INPUTS.overheadRules,
    })
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
      useCostingInputs(undefined)
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

describe('labour rates and the overhead setting (FIN-004, FIN-005)', () => {
  const sewing = seedId('costing:rate:SEWING')
  const base52 = async (query = '') => cellOf(await getSheet('finance', revision1, query), BLK, '52')

  it("lists the seed's tenant-wide rates, each in force; a person without the cost grain sees them without the figure", async () => {
    const { rates } = await ok('finance', 'GET', '/costing/rates')
    expect(rates.map((rate: Json) => [rate.workCentreKind, rate.companyId, rate.costPerMinute, rate.plannedEfficiencyPct, rate.validFrom, rate.inForce])).toEqual([
      ['CUTTING', null, '0.5', '100', '2026-01-01', true],
      ['SEWING', null, '0.4', '80', '2026-01-01', true],
      ['ASSEMBLY', null, '0.42', '100', '2026-01-01', true],
      ['FINISHING', null, '0.38', '100', '2026-01-01', true],
      ['INSPECTION', null, '0.45', '100', '2026-01-01', true],
      ['PACKING', null, '0.3', '100', '2026-01-01', true],
      ['SUBCONTRACT', null, '0.55', '100', '2026-01-01', true],
    ])
    const blind = (await ok('sales', 'GET', '/costing/rates?kind=SEWING')).rates
    expect(blind).toEqual([expect.objectContaining({ id: sewing, workCentreKind: 'SEWING', currency: 'EUR', plannedEfficiencyPct: '80', inForce: true })])
    expect(blind[0]).not.toHaveProperty('costPerMinute')
  })

  it("a company's own rate wins over the tenant-wide one for that company, from its first day; a later one waits for its day", async () => {
    // Company A sews at 0.60 a minute at 100 %: 96.5 × 0.60 = 57.90; labour 7 + 57.90 + 3.60 + 1.05 = 69.55;
    // size 52: 230.539 + 69.55 = 300.089, + 10 % = 330.0979. Company B keeps the tenant-wide 0.40 at 80 %: 319.4829.
    const created = await ok('finance', 'POST', '/costing/rates', { companyId: companyA, workCentreKind: 'SEWING', costPerMinute: '0.6', validFrom: '2026-03-01', note: 'Payroll March (made up).' }, 201)
    const own = created.rate
    expect(own).toMatchObject({ companyId: companyA, workCentreKind: 'SEWING', costPerMinute: '0.6', currency: 'EUR', plannedEfficiencyPct: '100', validFrom: '2026-03-01', status: 'ACTIVE', inForce: true, version: 1 })
    const later = (await ok('finance', 'POST', '/costing/rates', { companyId: companyA, workCentreKind: 'SEWING', costPerMinute: '0.9', validFrom: '2099-01-01' }, 201)).rate
    expect(later.inForce).toBe(false)

    expect((await base52(`?companyId=${companyA}`)).total).toBe('330.0979')
    expect((await getSheet('finance', revision1, `?companyId=${companyA}`)).inputs.labour[1]).toMatchObject({ rateId: own.id, companyId: companyA, costPerMinute: '0.6', validFrom: '2026-03-01' })
    expect((await base52(`?companyId=${companyB}`)).total).toBe('319.4829')
    expect((await base52()).total).toBe('319.4829')
    const listed = (await ok('finance', 'GET', `/costing/rates?companyId=${companyA}&kind=SEWING`)).rates
    expect(listed.map((rate: Json) => [rate.companyId, rate.validFrom, rate.inForce])).toEqual([
      [null, '2026-01-01', true],
      [companyA, '2099-01-01', false],
      [companyA, '2026-03-01', true],
    ])

    // The same kind, company and day again: refused.
    expect((await refused('finance', 'POST', '/costing/rates', { companyId: companyA, workCentreKind: 'SEWING', costPerMinute: '0.7', validFrom: '2026-03-01' }, 409)).message).toBe(
      'A SEWING rate from 2026-03-01 exists already for this company (or tenant-wide): correct it, or choose another first day.',
    )
    expect((await refused('finance', 'POST', '/costing/rates', { workCentreKind: 'SEWING', costPerMinute: '0.7', validFrom: '2026-01-01' }, 409)).code).toBe('conflict')

    // A correction is audited with the cost marked, and the sheet follows.
    const corrected = (await ok('finance', 'PATCH', `/costing/rates/${own.id}`, { version: 1, costPerMinute: '0.65', plannedEfficiencyPct: '130' })).rate
    expect(corrected).toMatchObject({ costPerMinute: '0.65', plannedEfficiencyPct: '130', version: 2 })
    // Sew 96.5 × 0.65 ÷ 1.30 = 48.25: the same labour as the tenant's, 319.4829.
    expect((await base52(`?companyId=${companyA}`)).total).toBe('319.4829')
    const [audit] = await admin<{ before: Json; after: Json }>(`SELECT before, after FROM "AuditLog" WHERE "recordType" = 'LabourRate' AND "recordId" = $1 ORDER BY at DESC LIMIT 1`, [own.id])
    expect(audit).toEqual({ before: { costPerMinute: { $money: 'cost', value: '0.6' }, plannedEfficiencyPct: '100' }, after: { costPerMinute: { $money: 'cost', value: '0.65' }, plannedEfficiencyPct: '130' } })
    expect((await refused('finance', 'PATCH', `/costing/rates/${own.id}`, { version: 1, costPerMinute: '0.7' }, 409)).code).toBe('conflict')

    // Archived: the company is back on the tenant-wide rate; an archived rate is never changed again.
    expect((await ok('finance', 'POST', `/costing/rates/${own.id}/archive`, { version: 2, reason: 'Typed in the wrong company (made up).' })).rate).toMatchObject({ status: 'ARCHIVED', inForce: false })
    expect((await getSheet('finance', revision1, `?companyId=${companyA}`)).inputs.labour[1]).toMatchObject({ rateId: sewing, companyId: null })
    expect((await refused('finance', 'PATCH', `/costing/rates/${own.id}`, { version: 3, costPerMinute: '0.7' }, 409)).message).toBe('This rate is archived: add a new rate instead.')
    expect((await ok('finance', 'GET', `/costing/rates?companyId=${companyA}&kind=SEWING&status=ALL`)).rates.map((rate: Json) => rate.status)).toEqual(['ACTIVE', 'ACTIVE', 'ARCHIVED'])
    expect(await eventsOf(own.id)).toEqual([
      ['labour_rate.created', { rateId: own.id, workCentreKind: 'SEWING', validFrom: '2026-03-01' }],
      ['labour_rate.updated', { rateId: own.id, workCentreKind: 'SEWING', fields: ['costPerMinute', 'plannedEfficiencyPct'] }],
      ['labour_rate.status_changed', { rateId: own.id, workCentreKind: 'SEWING', status: 'ARCHIVED' }],
    ])
  })

  it('keeps the cost grain, the company and the limits: who may send a rate, for which company, and what figures', async () => {
    // Without the cost grain the figure cannot be sent at all.
    expect((await refused('blindManager', 'POST', '/costing/rates', { workCentreKind: 'FINISHING', costPerMinute: '0.4', validFrom: '2026-05-01' }, 403)).issues).toEqual([{ path: 'costPerMinute', message: 'Needs the cost grain.' }])
    // A manager of company B: B's own rates only, never a tenant-wide one or company A's.
    expect((await ok('managerB', 'POST', '/costing/rates', { companyId: companyB, workCentreKind: 'FINISHING', costPerMinute: '0.4', validFrom: '2026-05-01' }, 201)).rate.companyId).toBe(companyB)
    expect((await refused('managerB', 'POST', '/costing/rates', { workCentreKind: 'FINISHING', costPerMinute: '0.4', validFrom: '2026-05-02' }, 403)).message).toBe('A tenant-wide rate or setting is changed only by a role over every company.')
    expect((await refused('managerB', 'POST', '/costing/rates', { companyId: companyA, workCentreKind: 'FINISHING', costPerMinute: '0.4', validFrom: '2026-05-02' }, 403)).code).toBe('forbidden')
    expect((await refused('managerB', 'PATCH', `/costing/rates/${sewing}`, { version: 1, costPerMinute: '0.1' }, 403)).code).toBe('forbidden')
    // Company B's person sees B's and the tenant's rates, never company A's.
    expect((await ok('companyB', 'GET', '/costing/rates?status=ALL')).rates.every((rate: Json) => rate.companyId === null || rate.companyId === companyB)).toBe(true)
    expect((await refused('companyB', 'GET', `/costing/rates?companyId=${companyA}`, undefined, 404)).message).toBe('Company not found.')
    // The limits, in the API and in the database (for every login).
    for (const [body, path] of [
      [{ plannedEfficiencyPct: '0' }, 'body/plannedEfficiencyPct'],
      [{ plannedEfficiencyPct: '250' }, 'body/plannedEfficiencyPct'],
      [{ costPerMinute: '-0.1' }, 'body/costPerMinute'],
    ] as const) {
      expect((await refused('finance', 'POST', '/costing/rates', { workCentreKind: 'ASSEMBLY', costPerMinute: '0.4', validFrom: '2026-06-01', ...body }, 400)).issues).toEqual([{ path, message: expect.any(String) }])
    }
    await expect(admin(`UPDATE "LabourRate" SET "plannedEfficiencyPct" = 0 WHERE id = $1`, [sewing])).rejects.toThrow('the planned efficiency of the labour rate')
    await expect(admin(`UPDATE "LabourRate" SET "costPerMinute" = -1 WHERE id = $1`, [sewing])).rejects.toThrow('the cost per minute of the labour rate')
    await expect(admin(`UPDATE "LabourRate" SET "workCentreKind" = 'CUTTING' WHERE id = $1`, [sewing])).rejects.toThrow('never change')
    await expect(admin(`DELETE FROM "LabourRate" WHERE id = $1`, [sewing])).rejects.toThrow('archived, never deleted')
    await expect(
      admin(`INSERT INTO "LabourRate" (id, "tenantId", "workCentreKind", "costPerMinute", "validFrom") VALUES ($1, $2, 'SEWING', 0.1, '2026-01-01')`, [newId(), tenant]),
    ).rejects.toThrow('LabourRate_one_tenant_rate_per_kind_and_day')
  })

  it("the overhead: the tenant-wide setting, a company's own winning for its sheets, in range, by version", async () => {
    expect(await settingsOf('finance', `?companyId=${companyA}`)).toMatchObject({ tenant: { id: tenant, overheadPct: '10', version: 2 }, company: null, inForce: tenant })
    // Company A at 12 %: size 52 for A = 290.439 × 1.12 = 325.29168; the others keep 10 %.
    const saved = (await ok('finance', 'PUT', '/costing/settings', { companyId: companyA, overheadPct: '12' })).settings
    expect(saved).toMatchObject({ id: companyA, companyId: companyA, overheadPct: '12', version: 1 })
    expect(await settingsOf('finance', `?companyId=${companyA}`)).toMatchObject({ company: { id: companyA, overheadPct: '12' }, inForce: companyA })
    expect((await base52(`?companyId=${companyA}`)).total).toBe('325.29168')
    expect((await getSheet('finance', revision1, `?companyId=${companyA}`)).inputs.overhead).toMatchObject({ source: 'OVERHEAD_RULE', ruleId: companyA, companyId: companyA, overheadPct: '12' })
    expect((await base52(`?companyId=${companyB}`)).total).toBe('319.4829')

    expect((await refused('finance', 'PUT', '/costing/settings', { companyId: companyA, overheadPct: '13' }, 409)).message).toBe('These costing settings exist: send their version to change them.')
    expect((await refused('finance', 'PUT', '/costing/settings', { companyId: companyA, overheadPct: '13', version: 5 }, 409)).code).toBe('conflict')
    expect((await refused('finance', 'PUT', '/costing/settings', { companyId: companyA, overheadPct: '101', version: 1 }, 400)).issues).toEqual([{ path: 'body/overheadPct', message: 'Expected a percentage from 0 to 100, with at most 4 decimals.' }])
    expect((await refused('managerB', 'PUT', '/costing/settings', { overheadPct: '5', version: 2 }, 403)).code).toBe('forbidden')
    expect((await refused('sales', 'PUT', '/costing/settings', { overheadPct: '5', version: 2 }, 403)).code).toBe('forbidden')
    await expect(admin(`UPDATE "CostingSettings" SET "overheadPct" = 150 WHERE id = $1`, [companyA])).rejects.toThrow('the overhead of the costing settings')
    await expect(admin(`DELETE FROM "CostingSettings" WHERE id = $1`, [companyA])).rejects.toThrow('changed, never deleted')
    expect(await eventsOf(companyA)).toEqual([['costing_settings.changed', { settingsId: companyA, fields: ['overheadPct'] }]])
  })

  it('refuses the rate and settings routes to the floor and portal sessions', async () => {
    for (const session of ['floor', 'partner']) {
      expect((await refused(session, 'GET', '/costing/rates', undefined, 403)).code).toBe('forbidden')
      expect((await refused(session, 'GET', '/costing/settings', undefined, 403)).code).toBe('forbidden')
      expect((await refused(session, 'POST', '/costing/rates', { workCentreKind: 'CUTTING', costPerMinute: '0.1', validFrom: '2026-07-01' }, 403)).code).toBe('forbidden')
    }
    expect((await ok('otherTenant', 'GET', '/costing/rates')).rates).toEqual([])
  })
})
