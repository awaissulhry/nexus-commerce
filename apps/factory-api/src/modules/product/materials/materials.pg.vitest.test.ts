import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission, ScopeSet } from '@nexus/factory-domain/core/permissions'
import { SHEET_TYPES } from '@nexus/factory-domain/imports/job'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { callerFor, type CommandCaller } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { useImporters } from '../../../platform/imports/registry'
import { applyPlan, planImport } from '../../../platform/imports/worker'
import { systemContext } from '../../../platform/outbox/system'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { materialsImportAdapter } from './importer'

/**
 * The material library on the local stack (B-W1-09; features PRD-024, PRD-025, PRD-028, PRD-030, PRD-032, GAP-006,
 * PLT-176), with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login, so
 * row-level security and the product triggers are real), sessions from the test authenticator, and for the import the
 * gateway on the local Redis under this file's own prefix and the local file store in a temporary folder. Every
 * material, supplier and price here is made up. Run with `node scripts/factory/run-pg-tests.mjs materials`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string

const tenantA = newId()
const tenantB = newId()
const companyA1 = newId()
const companyA2 = newId()
const companyB = newId()
const supplier = newId()
const blocked = newId()
const customer = newId()
const blackLibrary = newId()

const VIEW = 'product.materials.view'
const MANAGE = 'product.materials.manage'
const COST = 'product.materials.cost'
const IMPORTS: Permission[] = ['imports.view', 'imports.run', 'imports.apply', 'files.upload', 'files.read']

/**
 * The people of the test: each is a User with one custom role assigned in the database (the dry run of an import reads
 * the live roles of the person who started it) and the same grants as their test session. Buyer: everything, the
 * cost grain included. Maker: a production manager, no money. Finance: sets costs only. Pricer: a manager who sees
 * costs but may not set them. CompanyOne: a manager of company 1 only.
 */
interface Person {
  readonly tenantId: string
  readonly permissions: readonly Permission[]
  readonly grains: readonly ('cost' | 'price')[]
  readonly companies: ScopeSet
}
const PEOPLE: Record<string, Person> = {
  buyer: { tenantId: tenantA, permissions: [VIEW, MANAGE, COST, 'audit.read', ...IMPORTS], grains: ['cost'], companies: 'all' },
  maker: { tenantId: tenantA, permissions: [VIEW, MANAGE, 'audit.read', ...IMPORTS], grains: [], companies: 'all' },
  finance: { tenantId: tenantA, permissions: [VIEW, COST, 'audit.read'], grains: ['cost'], companies: 'all' },
  pricer: { tenantId: tenantA, permissions: [VIEW, MANAGE, ...IMPORTS], grains: ['cost'], companies: 'all' },
  viewer: { tenantId: tenantA, permissions: [VIEW, 'imports.view'], grains: [], companies: 'all' },
  companyOne: { tenantId: tenantA, permissions: [VIEW, MANAGE, ...IMPORTS], grains: [], companies: [companyA1] },
  otherTenant: { tenantId: tenantB, permissions: [VIEW, MANAGE, COST], grains: ['cost'], companies: 'all' },
}
const IDS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions, ...person.grains.map((grain) => `money.${grain}` as Permission)], companies: person.companies, sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: person.tenantId, actorId: IDS[key]!, grants: [grant] }]
  }),
)

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) })
const system = (tenantId = tenantA): CommandCaller => callerFor(database, systemContext(tenantId, newId()))

async function create(session: string, body: Json): Promise<Json> {
  const response = await call(session, 'POST', '/product/materials', body)
  expect(response.statusCode, response.body).toBe(201)
  return response.json().material
}
async function read(session: string, id: string): Promise<Json> {
  const response = await call(session, 'GET', `/product/materials/${id}`)
  expect(response.statusCode, response.body).toBe(200)
  return response.json().material
}
async function patch(session: string, id: string, body: Json, status = 200): Promise<Json> {
  const response = await call(session, 'PATCH', `/product/materials/${id}`, body)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const historyOf = async (session: string, recordType: string, id: string): Promise<any[]> => {
  const response = await call(session, 'GET', `/audit/${recordType}/${id}`)
  expect(response.statusCode, response.body).toBe(200)
  return response.json().entries
}
const eventsOf = async (subject: string) => admin<{ type: string; payload: Json }>('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])

/** A made-up chrome-tanned bovine nappa: stocked in ft², bought by the hide (52.5 ft² average), cut in dm². */
const LEATHER = {
  code: 'pl-nap-12',
  name: 'Nappa bovina 1,2',
  nameI18n: { it: 'Nappa bovina 1,2', en: 'Bovine nappa 1.2' },
  kind: 'LEATHER',
  baseUom: 'FT2',
  purchaseUom: 'HIDE',
  purchaseFactor: '52.5',
  consumptionUom: 'DM2',
  defaultSupplierId: supplier,
  supplierArticleCode: 'TAN-77',
  animalSpecies: 'bovine',
  tannage: 'CHROME',
  grade: 'A',
  finish: 'full grain',
  thicknessMinMm: '1.1',
  thicknessMaxMm: '1.3',
  requiresCrViTest: true,
  crViLimitMgKg: '3',
  standardCost: '2.40',
  colours: [{ code: 'ner', name: 'Nero', supplierColourCode: 'T-01', colourId: blackLibrary }, { code: 'MAR', name: 'Marrone' }],
}

let leatherId: string

beforeAll(async () => {
  db = await migratedDatabase('materials')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-materials-test-'))
  for (const [tenantId, slug, companies] of [
    [tenantA, 'materials-a', [companyA1, companyA2]],
    [tenantB, 'materials-b', [companyB]],
  ] as const) {
    await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
    for (const [index, companyId] of companies.entries()) {
      await admin('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $3)', [companyId, tenantId, `${slug}-${index + 1}`])
    }
    await admin(
      `INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`,
      [newId(), tenantId],
    )
  }
  await admin(
    `INSERT INTO "Party" (id, "tenantId", code, kind, "legalName", roles, status) VALUES
       ($1, $4, 'TAN-ROSSI', 'ORGANISATION', 'Conceria Esempio S.r.l.', '{SUPPLIER}', 'ACTIVE'),
       ($2, $4, 'TAN-OLD', 'ORGANISATION', 'Conceria Chiusa S.r.l.', '{SUPPLIER}', 'BLOCKED'),
       ($3, $4, 'CUST-1', 'ORGANISATION', 'Cliente Esempio S.p.A.', '{CUSTOMER}', 'ACTIVE')`,
    [supplier, blocked, customer, tenantA],
  )
  await admin(`INSERT INTO "Colour" (id, "tenantId", code, name) VALUES ($1, $2, 'BLK', 'Black')`, [blackLibrary, tenantA])
  for (const [key, person] of Object.entries(PEOPLE)) {
    const roleId = newId()
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [IDS[key], person.tenantId, `${key}@example.com`, key])
    await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, grains) VALUES ($1, $2, $3, $4, $5, $6)`, [roleId, person.tenantId, `custom.${key.toLowerCase()}`, key, person.permissions, person.grains])
    await admin(
      `INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, $5, $6, now() - interval '1 day')`,
      [newId(), person.tenantId, IDS[key], roleId, person.companies === 'all', person.companies === 'all' ? [] : person.companies],
    )
  }
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  useImporters([materialsImportAdapter])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 60_000)

afterAll(async () => {
  useImporters(undefined)
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

describe('materials through the API (PRD-028, PRD-030, PRD-032, GAP-006)', () => {
  it('creates a leather article bought by the hide and cut in dm², with its colours and standard purchase price', async () => {
    const material = await create('buyer', LEATHER)
    leatherId = material.id
    expect(material).toMatchObject({
      code: 'PL-NAP-12',
      companyId: null,
      kind: 'LEATHER',
      sourcing: 'BUY',
      tracking: 'HIDE',
      animalOrigin: true,
      units: { base: { uom: 'FT2', factor: '1', fixed: true }, purchase: { uom: 'HIDE', factor: '52.5', fixed: false }, consumption: { uom: 'DM2', factor: '0.1076391', fixed: true } },
      standardCost: '2.4',
      currency: 'EUR',
      // 2.40 €/ft²: 126 € per hide of 52.5 ft², 0.258334 € per dm² (exactly 0.0929…/0.0929… ft²).
      standardCostPerPurchaseUnit: '126',
      standardCostPerConsumptionUnit: '0.258334',
      defaultSupplier: { id: supplier, code: 'TAN-ROSSI', name: 'Conceria Esempio S.r.l.' },
      colourCount: 2,
      warnings: [],
      version: 1,
    })
    expect(material.colours.map((colour: Json) => [colour.code, colour.supplierColourCode, colour.colourId])).toEqual([
      ['MAR', null, null],
      ['NER', 'T-01', blackLibrary],
    ])
    expect((await eventsOf(material.id)).map((event) => event.type)).toEqual(['material.created'])
    const [row] = await admin('SELECT "standardCost"::text AS cost, "purchaseFactor"::text AS factor, "createdById" FROM "Item" WHERE id = $1', [material.id])
    expect(row).toEqual({ cost: '2.400000', factor: '52.50000000', createdById: IDS.buyer })
  })

  it('refuses the Cr VI rule with a clear error, never the database trigger (REACH Annex XVII entry 47)', async () => {
    const above = await call('buyer', 'POST', '/product/materials', { ...LEATHER, code: 'PL-CR6-1', colours: [], crViLimitMgKg: '3.5' })
    expect(above.statusCode).toBe(400)
    expect(above.json().error).toMatchObject({
      code: 'validation_failed',
      issues: [{ path: 'body/crViLimitMgKg', message: 'The Cr VI limit is above 0 and at most 3 mg/kg (REACH Annex XVII entry 47), with at most 3 decimals.' }],
    })
    const noLimit = await call('buyer', 'POST', '/product/materials', { ...LEATHER, code: 'PL-CR6-2', colours: [], crViLimitMgKg: null })
    expect(noLimit.json().error.issues).toEqual([
      { path: 'body/crViLimitMgKg', message: "A material whose lots need a Cr VI test has its limit: at most 3 mg/kg (REACH Annex XVII entry 47), or a brand's lower one." },
    ])
    const noTest = await call('buyer', 'POST', '/product/materials', { ...LEATHER, code: 'PL-CR6-3', colours: [], requiresCrViTest: false })
    expect(noTest.json().error.issues).toEqual([{ path: 'body/crViLimitMgKg', message: 'A Cr VI limit is set only when the lots need a Cr VI test.' }])
    const { version } = await read('buyer', leatherId)
    expect((await patch('buyer', leatherId, { version, crViLimitMgKg: '4' }, 400)).error.code).toBe('validation_failed')
    // A factor of 0 would reach the trigger as a bare P2003: the domain refuses it first.
    expect((await patch('buyer', leatherId, { version, purchaseFactor: '0' }, 400)).error.issues).toEqual([{ path: 'body/purchaseFactor', message: 'The factor is above 0.' }])
    expect(await admin('SELECT code FROM "Item" WHERE code LIKE $1', ['PL-CR6-%'])).toEqual([])
  })

  it('keeps the standard cost from a person without the cost grain: in answers, requests and the audit history', async () => {
    const seen = await read('maker', leatherId)
    for (const field of ['standardCost', 'standardCostPerPurchaseUnit', 'standardCostPerConsumptionUnit']) expect(seen).not.toHaveProperty(field)
    expect(seen.code).toBe('PL-NAP-12')
    const listed = (await call('maker', 'GET', '/product/materials?q=nap')).json().materials
    expect(listed[0]).not.toHaveProperty('standardCost')
    expect((await call('buyer', 'GET', '/product/materials?q=nap')).json().materials[0]).toHaveProperty('standardCost', '2.4')

    const sent = await call('maker', 'POST', '/product/materials', { code: 'TR-ZIP-1', name: 'Zip', kind: 'TRIM', baseUom: 'PCS', standardCost: '0.5' })
    expect(sent.statusCode).toBe(403)
    expect(sent.json().error.issues).toEqual([{ path: 'standardCost', message: 'Needs the cost grain.' }])
    expect((await call('maker', 'PUT', `/product/materials/${leatherId}/standard-cost`, { version: seen.version })).statusCode).toBe(403)

    const set = await call('finance', 'PUT', `/product/materials/${leatherId}/standard-cost`, { version: seen.version, standardCost: '2.55', reason: 'Price list 2027 (made up)' })
    expect(set.statusCode, set.body).toBe(200)
    expect(set.json().material).toMatchObject({ standardCost: '2.55', standardCostPerPurchaseUnit: '133.875', version: seen.version + 1 })
    const events = await eventsOf(leatherId)
    expect(events.at(-1)).toEqual({ type: 'material.standard_cost_changed', payload: { itemId: leatherId, code: 'PL-NAP-12' } })

    const forFinance = await historyOf('finance', 'Item', leatherId)
    const [costRow] = forFinance.filter((entry) => entry.action === 'product.materials.setStandardCost')
    expect(costRow).toMatchObject({ before: { standardCost: '2.4', currency: 'EUR' }, after: { standardCost: '2.55', currency: 'EUR' }, reason: 'Price list 2027 (made up)' })
    const forMaker = await historyOf('maker', 'Item', leatherId)
    const [hidden] = forMaker.filter((entry) => entry.action === 'product.materials.setStandardCost')
    expect(hidden.before).toEqual({ currency: 'EUR' })
    expect(hidden.after).toEqual({ currency: 'EUR' })
    const [created] = forMaker.filter((entry) => entry.action === 'product.materials.create')
    expect(created.after).toMatchObject({ code: 'PL-NAP-12', currency: 'EUR' })
    expect(created.after).not.toHaveProperty('standardCost')
  })

  it('moves the base unit with its hide factor and standard cost, and never while a BOM line uses the material', async () => {
    const before = await read('buyer', leatherId)
    const moved = (await patch('buyer', leatherId, { version: before.version, baseUom: 'M2' })).material
    // A hide of 52.5 ft² is 4.8774096 m²; 2.55 €/ft² is 27.447972 €/m².
    expect(moved).toMatchObject({
      units: { base: { uom: 'M2' }, purchase: { uom: 'HIDE', factor: '4.8774096' }, consumption: { uom: 'DM2', factor: '0.01' } },
      standardCost: '27.447972',
      standardCostPerPurchaseUnit: '133.875002',
    })
    // A person without the grain may move it back: the cost follows, and its audit row hides it from them.
    const back = (await patch('maker', leatherId, { version: moved.version, baseUom: 'FT2' })).material
    expect(back.units.purchase.factor).toBe('52.5')
    expect((await read('buyer', leatherId)).standardCost).toBe('2.55')
    const [moveBack] = (await historyOf('maker', 'Item', leatherId)).filter((entry) => entry.action === 'product.materials.update')
    expect(moveBack.after).toEqual({ baseUom: 'FT2', purchaseFactor: '52.5', consumptionFactor: '0.1076391' })

    // On a BOM line (in DM2 and in HIDE), the base unit stays and the units the lines use stay convertible.
    const scale = newId()
    const style = newId()
    const revision = newId()
    await admin(`INSERT INTO "SizeScale" (id, "tenantId", code, name) VALUES ($1, $2, 'EU', 'EU 46-58')`, [scale, tenantA])
    await admin(`INSERT INTO "Style" (id, "tenantId", code, name, "productType", "sizeScaleId", "ppeCategory") VALUES ($1, $2, 'ST-1', 'Jacket', 'JACKET', $3, 'CATEGORY_II')`, [style, tenantA, scale])
    await admin(`INSERT INTO "StyleRevision" (id, "tenantId", "styleId", revision) VALUES ($1, $2, $3, 1)`, [revision, tenantA, style])
    await admin(
      `INSERT INTO "BomLine" (id, "tenantId", "styleId", "revisionId", seq, "itemId", qty, uom) VALUES ($1, $3, $4, $5, 1, $6, 180, 'DM2'), ($2, $3, $4, $5, 2, $6, 0.5, 'HIDE')`,
      [newId(), newId(), tenantA, style, revision, leatherId],
    )
    const onBom = await patch('buyer', leatherId, { version: back.version, baseUom: 'M2' }, 409)
    expect(onBom.error.message).toBe('This material is on BOM lines, so its base unit stays FT2.')
    const lost = await patch('buyer', leatherId, { version: back.version, purchaseUom: 'SIDE', purchaseFactor: '26' }, 409)
    expect(lost.error.message).toBe('BOM lines use this material in HIDE, which it would no longer convert.')
    expect((await patch('buyer', leatherId, { version: back.version, consumptionUom: 'FT2' })).material.units.consumption).toEqual({ uom: 'FT2', factor: '1', fixed: true })

    // A cost per m² says nothing per metre: that move waits until the cost is removed or changed.
    const lining = await create('buyer', { code: 'LN-MESH-1', name: 'Fodera rete', kind: 'LINING', baseUom: 'M2', standardCost: '4.2', composition: [{ fibre: 'polyester', percent: '100' }] })
    const crossing = await patch('buyer', lining.id, { version: lining.version, baseUom: 'M', purchaseFactor: '1.5', consumptionFactor: '1.5' }, 409)
    expect(crossing.error.message).toMatch(/^The standard cost is per M2; it cannot follow the base unit to M\./)
  })

  it('lists with a search, filters and pages (SCR-047)', async () => {
    await create('maker', { code: 'PR-BACK-1', name: 'Paraschiena livello 2', kind: 'PROTECTOR', baseUom: 'PCS' })
    await create('maker', { code: 'TH-40', name: 'Filo poliestere 40', kind: 'THREAD', baseUom: 'M', purchaseUom: 'CONE', purchaseFactor: '5000' })
    const page = (query: string) => call('viewer', 'GET', `/product/materials${query}`).then((response) => {
      expect(response.statusCode, response.body).toBe(200)
      return response.json()
    })
    expect((await page('?q=PARASCH')).materials.map((row: Json) => row.code)).toEqual(['PR-BACK-1'])
    expect((await page('?q=tan-77')).materials.map((row: Json) => row.code)).toEqual(['PL-NAP-12'])
    expect((await page('?kind=protector,thread')).materials.map((row: Json) => row.code)).toEqual(['PR-BACK-1', 'TH-40'])
    expect((await page(`?supplierId=${supplier}`)).materials.map((row: Json) => row.code)).toEqual(['PL-NAP-12'])
    expect((await page('?requiresCrViTest=true')).materials.map((row: Json) => row.code)).toEqual(['PL-NAP-12'])
    const first = await page('?limit=2')
    expect(first.count).toBe(4)
    expect(first.materials.map((row: Json) => row.code)).toEqual(['LN-MESH-1', 'PL-NAP-12'])
    const second = await page(`?limit=2&cursor=${first.nextCursor}`)
    expect(second.materials.map((row: Json) => row.code)).toEqual(['PR-BACK-1', 'TH-40'])
    expect(second.nextCursor).toBeNull()
    expect((await call('viewer', 'GET', '/product/materials?cursor=nonsense')).statusCode).toBe(400)
    expect((await call('viewer', 'GET', '/product/materials?kind=SHOES')).statusCode).toBe(400)
  })

  it('clears what a change sends as null, the JSON fields included', async () => {
    const lining = (await call('buyer', 'GET', '/product/materials?q=LN-MESH-1')).json().materials[0]
    const filled = (await patch('buyer', lining.id, { version: lining.version, nameI18n: { it: 'Fodera rete', en: 'Mesh lining' }, attributes: { weave: 'mesh' }, finish: 'brushed' })).material
    expect(filled).toMatchObject({ nameI18n: { it: 'Fodera rete', en: 'Mesh lining' }, attributes: { weave: 'mesh' }, finish: 'brushed', composition: [{ fibre: 'polyester', percent: '100' }] })
    const cleared = (await patch('buyer', lining.id, { version: filled.version, nameI18n: null, attributes: null, composition: null, finish: null })).material
    expect(cleared).toMatchObject({ nameI18n: null, attributes: null, composition: null, finish: null, version: filled.version + 1 })
    expect(await admin('SELECT "nameI18n", attributes, composition, finish FROM "Item" WHERE id = $1', [lining.id])).toEqual([{ nameI18n: null, attributes: null, composition: null, finish: null }])
    const [entry] = (await historyOf('buyer', 'Item', lining.id)).filter((row) => row.action === 'product.materials.update')
    expect(entry.before).toMatchObject({ nameI18n: { it: 'Fodera rete', en: 'Mesh lining' }, composition: [{ fibre: 'polyester', percent: '100' }] })
    expect(entry.after).toEqual({ nameI18n: null, attributes: null, composition: null, finish: null })
  })

  it('keeps make or buy (PRD-024), tracking (PRD-025) and the default supplier straight', async () => {
    const refusal = async (body: Json) => {
      const response = await call('buyer', 'POST', '/product/materials', body)
      expect(response.statusCode, response.body).toBe(400)
      return response.json().error.issues
    }
    expect(await refusal({ code: 'CMP-1', name: 'Carré', kind: 'COMPONENT', baseUom: 'PCS', sourcing: 'BUY' })).toEqual([{ path: 'body/sourcing', message: 'A component is a part we make: MAKE, or MAKE_OR_BUY.' }])
    expect(await refusal({ code: 'LB-1', name: 'Label', kind: 'LABEL', baseUom: 'PCS', sourcing: 'MAKE', defaultSupplierId: supplier })).toEqual([{ path: 'body/defaultSupplierId', message: 'A material we only make has no supplier.' }])
    expect(await refusal({ code: 'LB-2', name: 'Label', kind: 'LABEL', baseUom: 'PCS', defaultSupplierId: customer })).toEqual([{ path: 'body/defaultSupplierId', message: 'This party is not a supplier.' }])
    expect(await refusal({ code: 'LB-3', name: 'Label', kind: 'LABEL', baseUom: 'PCS', defaultSupplierId: blocked })).toEqual([{ path: 'body/defaultSupplierId', message: 'This supplier is blocked.' }])
    expect(await refusal({ code: 'PR-2', name: 'Elbow protector', kind: 'PROTECTOR', baseUom: 'PCS', tracking: 'NONE' })).toEqual([
      { path: 'body/tracking', message: 'A PPE component is traced by lot or serial, so the garments that hold one lot can be found (Reg. (EU) 2016/425 art. 8(5)).' },
    ])
    const made = await create('buyer', { code: 'CMP-2', name: 'Pre-sewn yoke', kind: 'COMPONENT', baseUom: 'PCS' })
    expect(made).toMatchObject({ sourcing: 'MAKE', warnings: [] })
    const bought = await create('buyer', { code: 'TR-SNAP-1', name: 'Snap', kind: 'TRIM', baseUom: 'PCS', purchaseUom: 'BOX', purchaseFactor: '500' })
    expect(bought.warnings.map((warning: Json) => warning.code)).toEqual(['NO_DEFAULT_SUPPLIER'])
    expect((await patch('buyer', bought.id, { version: bought.version, defaultSupplierId: supplier })).material.warnings).toEqual([])
  })

  it('keeps a material\'s colours: add, change, remove and restore, each on its own version (PRD-032)', async () => {
    const material = await read('buyer', leatherId)
    const added = await call('maker', 'POST', `/product/materials/${leatherId}/colours`, { code: 'blu', name: 'Blu' })
    expect(added.statusCode, added.body).toBe(201)
    const blue = added.json().material.colours.find((colour: Json) => colour.code === 'BLU')
    expect(added.json().material.version).toBe(material.version)
    expect((await call('maker', 'POST', `/product/materials/${leatherId}/colours`, { code: 'BLU', name: 'Blu' })).statusCode).toBe(409)
    const removed = await call('maker', 'PATCH', `/product/materials/${leatherId}/colours/${blue.id}`, { version: blue.version, status: 'ARCHIVED' })
    expect(removed.statusCode, removed.body).toBe(200)
    expect(removed.json().material.colourCount).toBe(2)
    const again = await call('maker', 'POST', `/product/materials/${leatherId}/colours`, { code: 'BLU', name: 'Blu' })
    expect(again.json().error.message).toBe('The material had colour BLU; restore it instead.')
    const stale = await call('maker', 'PATCH', `/product/materials/${leatherId}/colours/${blue.id}`, { version: blue.version, status: 'ACTIVE' })
    expect(stale.statusCode).toBe(409)
    const restored = await call('maker', 'PATCH', `/product/materials/${leatherId}/colours/${blue.id}`, { version: blue.version + 1, status: 'ACTIVE', name: 'Blu notte', supplierColourCode: 'T-33' })
    expect(restored.json().material.colours.find((colour: Json) => colour.id === blue.id)).toMatchObject({ status: 'ACTIVE', name: 'Blu notte', supplierColourCode: 'T-33', version: blue.version + 2 })
    expect((await historyOf('maker', 'ItemColour', blue.id)).map((entry) => entry.action)).toEqual(['product.materials.updateColour', 'product.materials.updateColour', 'product.materials.addColour'])
    expect((await eventsOf(leatherId)).filter((event) => event.type === 'material.colours_changed')).toHaveLength(3)
    expect((await call('maker', 'PATCH', `/product/materials/${leatherId}/colours/${newId()}`, { version: 1, name: 'x' })).statusCode).toBe(404)
  })

  it('archives a material out of new use, read only until it is reactivated (PRD-022)', async () => {
    const thread = (await call('buyer', 'GET', '/product/materials?q=TH-40')).json().materials[0]
    const archived = await call('maker', 'POST', `/product/materials/${thread.id}/archive`, { version: thread.version, reason: 'Replaced by a made-up thread' })
    expect(archived.statusCode, archived.body).toBe(200)
    expect(archived.json().material.status).toBe('ARCHIVED')
    expect((await call('viewer', 'GET', '/product/materials?q=TH-40')).json().materials).toEqual([])
    expect((await call('viewer', 'GET', '/product/materials?q=TH-40&status=ALL')).json().materials).toHaveLength(1)
    const version = archived.json().material.version
    expect((await patch('maker', thread.id, { version, name: 'x' }, 409)).error.code).toBe('invalid_state')
    expect((await call('maker', 'POST', `/product/materials/${thread.id}/colours`, { code: 'BIA', name: 'Bianco' })).json().error.code).toBe('invalid_state')
    expect((await call('maker', 'POST', `/product/materials/${thread.id}/archive`, { version })).json().error.code).toBe('invalid_state')
    const back = await call('maker', 'POST', `/product/materials/${thread.id}/reactivate`, { version })
    expect(back.json().material).toMatchObject({ status: 'ACTIVE', version: version + 1 })
    const [entry] = (await historyOf('maker', 'Item', thread.id)).filter((row) => row.action === 'product.materials.archive')
    expect(entry).toMatchObject({ before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED' }, reason: 'Replaced by a made-up thread' })
    expect((await eventsOf(thread.id)).map((event) => event.type)).toEqual(['material.created', 'material.status_changed', 'material.status_changed'])
  })

  it('refuses a stale version and a taken code, and answers a repeated request from its receipt', async () => {
    const material = await read('buyer', leatherId)
    expect((await patch('buyer', leatherId, { version: material.version - 1, name: 'x' }, 409)).error.issues).toEqual([{ path: 'version', message: `The current version is ${material.version}.` }])
    expect((await patch('buyer', leatherId, { version: material.version, code: 'pr-back-1' }, 409)).error.message).toBe('The material code PR-BACK-1 is taken.')
    expect((await call('buyer', 'POST', '/product/materials', { code: 'PL-NAP-12', name: 'x', kind: 'TRIM', baseUom: 'PCS' })).statusCode).toBe(409)
    const body = { code: 'PK-BOX-1', name: 'Scatola giacca', kind: 'PACKAGING', baseUom: 'PCS' }
    const key = { 'idempotency-key': `materials-${newId()}` }
    const first = await call('buyer', 'POST', '/product/materials', body, key)
    const second = await call('buyer', 'POST', '/product/materials', body, key)
    expect(first.statusCode, first.body).toBe(201)
    expect(second.json().material.id).toBe(first.json().material.id)
    expect(await admin('SELECT id FROM "Item" WHERE code = $1', ['PK-BOX-1'])).toHaveLength(1)
  })

  it('keeps companies and tenants apart', async () => {
    // A person whose grant reaches company 1 only: its own materials and the tenant-wide ones, nothing of company 2.
    expect((await call('companyOne', 'POST', '/product/materials', { code: 'C0-1', name: 'x', kind: 'TRIM', baseUom: 'PCS' })).statusCode).toBe(403)
    expect((await call('companyOne', 'POST', '/product/materials', { code: 'C2-1', name: 'x', kind: 'TRIM', baseUom: 'PCS', companyId: companyA2 })).statusCode).toBe(403)
    const own = await create('companyOne', { code: 'C1-1', name: 'Bottone', kind: 'TRIM', baseUom: 'PCS', companyId: companyA1 })
    const other = await create('buyer', { code: 'C2-2', name: 'Bottone', kind: 'TRIM', baseUom: 'PCS', companyId: companyA2 })
    expect((await call('companyOne', 'GET', `/product/materials/${other.id}`)).statusCode).toBe(404)
    expect((await call('companyOne', 'PATCH', `/product/materials/${other.id}`, { version: 1, name: 'y' })).statusCode).toBe(404)
    expect((await patch('companyOne', leatherId, { version: (await read('buyer', leatherId)).version, name: 'y' }, 403)).error.message).toBe('A material for every company is changed only by a role over every company.')
    const codes = (await call('companyOne', 'GET', '/product/materials?limit=200&q=C')).json().materials.map((row: Json) => row.code)
    expect(codes).toContain('C1-1')
    expect(codes).not.toContain('C2-2')
    expect(own.companyId).toBe(companyA1)

    // Another tenant sees none of it; the same code is free there.
    expect((await call('otherTenant', 'GET', `/product/materials/${leatherId}`)).statusCode).toBe(404)
    expect((await call('otherTenant', 'PATCH', `/product/materials/${leatherId}`, { version: 1, name: 'z' })).statusCode).toBe(404)
    expect((await call('otherTenant', 'PUT', `/product/materials/${leatherId}/standard-cost`, { version: 1, standardCost: '1' })).statusCode).toBe(404)
    expect((await call('otherTenant', 'GET', '/product/materials')).json()).toMatchObject({ materials: [], count: 0 })
    const theirs = await create('otherTenant', { ...LEATHER, defaultSupplierId: null, supplierArticleCode: null, colours: [] })
    expect(theirs.code).toBe('PL-NAP-12')
    expect((await call('otherTenant', 'POST', `/product/materials/${theirs.id}/colours`, { code: 'X', name: 'x', colourId: blackLibrary })).json().error.issues).toEqual([
      { path: 'body/colourId', message: 'No such library colour.' },
    ])
    void companyB
  })
})

describe('the material import (PLT-176, PRD-040)', () => {
  const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
  const csv = (lines: string[]): Buffer => Buffer.from(lines.join('\r\n'), 'utf8')
  const SHEET = [
    'Codice;Descrizione;Tipo;UM;UM acquisto;Fattore acquisto;UM consumo;Specie;Concia;Scelta;Spessore da;Spessore a;Test cromo VI;Limite Cr6;Colori;Costo standard',
    'pl-imp-1;Vitello importato;pelle;ft²;pelle;48,5;dmq;calf;cromo;A;0,9;1,1;sì;2,5;"NER=Nero|T-9; MAR=Marrone";3,10',
    'LN-IMP-1;Fodera rete;fodera;mq;;;;;;;;;;;;0,85',
    'PL-NAP-12;;;;;;;;;B;;;;;"BLU=Blu notte; VER=Verde";',
    'PL-IMP-2;Pelle;pelle;ft²;pelle;;dmq;bovine;cromo;A;1;1,2;sì;3,5;;',
  ]

  const start = (session: string, body: Buffer, fields: Json = {}) =>
    call(session, 'POST', '/imports', {
      importerKey: 'product.materials',
      file: { originalName: 'materiali.csv', contentType: SHEET_TYPES.csv, sizeBytes: body.length, sha256: sha256(body) },
      ...fields,
    })
  async function upload(session: string, body: Buffer, fields: Json = {}): Promise<Json> {
    const started = await start(session, body, fields)
    expect(started.statusCode, started.body).toBe(201)
    const { job, upload: presigned } = started.json() as { job: Json; upload: { url: string; headers: Record<string, string> } }
    const sent = await app.inject({ method: 'PUT', url: presigned.url, headers: presigned.headers, payload: body })
    expect(sent.statusCode, sent.body).toBe(200)
    expect((await call(session, 'POST', `/files/${job.fileId}/complete`)).statusCode).toBe(200)
    await planImport(system(), job.id, { lastAttempt: true })
    return (await call(session, 'GET', `/imports/${job.id}`)).json().job
  }
  const rowsOf = async (session: string, jobId: string): Promise<Json[]> => (await call(session, 'GET', `/imports/${jobId}/rows`)).json().rows
  const byCode = async (code: string): Promise<Json> => (await call('buyer', 'GET', `/product/materials?q=${code}&status=ALL`)).json().materials.find((row: Json) => row.code === code)

  it('plans every row without writing a material, then applies exactly the plan', async () => {
    const before = await admin('SELECT code, version FROM "Item" WHERE "tenantId" = $1 ORDER BY code', [tenantA])
    const job = await upload('buyer', csv(SHEET))
    expect(job).toMatchObject({ status: 'PLANNED', rowCount: 4, createCount: 2, updateCount: 1, errorCount: 1 })
    expect(await admin('SELECT code, version FROM "Item" WHERE "tenantId" = $1 ORDER BY code', [tenantA])).toEqual(before)

    const rows = await rowsOf('buyer', job.id)
    expect(rows.map((row) => [row.rowNumber, row.action])).toEqual([[2, 'CREATE'], [3, 'CREATE'], [4, 'UPDATE'], [5, 'ERROR']])
    expect(rows[0]!.after).toMatchObject({ code: 'PL-IMP-1', kind: 'LEATHER', baseUom: 'FT2', purchaseFactor: '48.5', crViLimitMgKg: '2.5', standardCost: '3.1' })
    expect(rows[2]).toMatchObject({ before: { grade: 'A', colours: 'BLU=Blu notte|T-33; MAR=Marrone; NER=Nero|T-01' }, after: { grade: 'B', colours: 'BLU=Blu notte|T-33; MAR=Marrone; NER=Nero|T-01; VER=Verde' } })
    expect(rows[3]!.errors).toEqual([
      { column: 'purchaseFactor', message: 'Say how many ft² one pelle holds (its average area).' },
      { column: 'crViLimitMgKg', message: 'The Cr VI limit is above 0 and at most 3 mg/kg (REACH Annex XVII entry 47), with at most 3 decimals.' },
    ])
    // The review hides the cost column from a person without the grain.
    const forViewer = await rowsOf('viewer', job.id)
    expect(forViewer[0]!.after).not.toHaveProperty('standardCost')
    expect(forViewer[1]!.after).toEqual({ code: 'LN-IMP-1', name: 'Fodera rete', kind: 'LINING', baseUom: 'M2' })

    const apply = await call('buyer', 'POST', `/imports/${job.id}/apply`, { version: job.version })
    expect(apply.statusCode, apply.body).toBe(200)
    await applyPlan(system(), job.id, { lastAttempt: true })
    expect((await call('buyer', 'GET', `/imports/${job.id}`)).json().job).toMatchObject({ status: 'APPLIED', appliedCount: 3, skippedCount: 0 })

    const calf = await read('buyer', (await byCode('PL-IMP-1')).id)
    expect(calf).toMatchObject({
      companyId: null,
      tracking: 'HIDE',
      units: { purchase: { uom: 'HIDE', factor: '48.5' }, consumption: { uom: 'DM2', factor: '0.1076391' } },
      standardCost: '3.1',
      requiresCrViTest: true,
      crViLimitMgKg: '2.5',
      createdById: null,
    })
    expect(calf.colours.map((colour: Json) => colour.code)).toEqual(['MAR', 'NER'])
    const nappa = await read('buyer', leatherId)
    expect(nappa.grade).toBe('B')
    expect(nappa.colours.map((colour: Json) => colour.code)).toEqual(['BLU', 'MAR', 'NER', 'VER'])
    const [imported] = (await historyOf('maker', 'Item', calf.id)).filter((entry) => entry.action === 'product.materials.import')
    expect(imported.after).toMatchObject({ code: 'PL-IMP-1', baseUom: 'FT2' })
    expect(imported.after).not.toHaveProperty('standardCost')
    const [forCost] = (await historyOf('buyer', 'Item', calf.id)).filter((entry) => entry.action === 'product.materials.import')
    expect(forCost.after.standardCost).toBe('3.1')
  })

  const COST_REFUSED = { path: 'column/standardCost', message: 'Importing the standard cost needs product.materials.cost over every company.' }

  it('refuses a sheet with the cost column to a person without the cost grain or the cost permission, in the dry run', async () => {
    const job = await upload('maker', csv(SHEET.slice(0, 2)))
    expect(job.status).toBe('FAILED')
    expect(job.issues).toEqual([
      { path: 'column/standardCost', message: 'The column "Costo standard" holds cost values (the cost money grain), which may not be imported without that grain.' },
      COST_REFUSED,
    ])
    const without = await upload('maker', csv([SHEET[0]!.replace(';Costo standard', ''), 'TR-IMP-1;Zip;accessorio;pz;scatola;100;;;;;;;;;;']))
    expect(without).toMatchObject({ status: 'PLANNED', createCount: 1 })
  })

  it('lets only product.materials.cost and the cost grain import the standard cost: the dry run says why, the apply refuses', async () => {
    // A manager who sees costs but may not set them: refused in the dry run, with the reason.
    const sheet = csv([SHEET[0]!, 'TR-IMP-2;Bottone;accessorio;pz;;;;;;;;;;;;0,12'])
    const own = await upload('pricer', sheet)
    expect(own).toMatchObject({ status: 'FAILED', issues: [COST_REFUSED] })
    // …and at the start when the mapping names the column.
    const named = await start('pricer', sheet, { mapping: { 'Costo standard': 'standardCost' } })
    expect(named.statusCode).toBe(403)
    expect(named.json().error.issues).toEqual([COST_REFUSED])
    // A plan made by a buyer is applied by a buyer only.
    const planned = await upload('buyer', sheet)
    expect(planned).toMatchObject({ status: 'PLANNED', createCount: 1 })
    const refused = await call('pricer', 'POST', `/imports/${planned.id}/apply`, { version: planned.version })
    expect(refused.statusCode).toBe(403)
    expect(refused.json().error).toMatchObject({ code: 'forbidden', issues: [COST_REFUSED] })
    expect(await admin('SELECT code FROM "Item" WHERE code = $1', ['TR-IMP-2'])).toEqual([])
    const applied = await call('buyer', 'POST', `/imports/${planned.id}/apply`, { version: planned.version })
    expect(applied.statusCode, applied.body).toBe(200)
    await applyPlan(system(), planned.id, { lastAttempt: true })
    expect(await byCode('TR-IMP-2')).toMatchObject({ standardCost: '0.12' })
  })

  it('lets a manager of one company import for that company only, never for every company', async () => {
    const sheet = (code: string) => csv([SHEET[0]!.replace(';Costo standard', ''), `${code};Fibbia;minuteria;pz;;;;;;;;;;;`])
    const COMPANY_REFUSED = { path: 'companyId', message: 'A materials import for every company needs product.materials.manage over every company; import for one company instead.' }
    // Every company: refused at the start.
    const everyCompany = await start('companyOne', sheet('HW-1'))
    expect(everyCompany.statusCode).toBe(403)
    expect(everyCompany.json().error.issues).toEqual([COMPANY_REFUSED])
    // A plan for every company made by a buyer: not applied by them.
    const tenantWide = await upload('buyer', sheet('HW-2'))
    expect(tenantWide.status).toBe('PLANNED')
    const refused = await call('companyOne', 'POST', `/imports/${tenantWide.id}/apply`, { version: tenantWide.version })
    expect(refused.statusCode).toBe(403)
    expect(refused.json().error.issues).toEqual([COMPANY_REFUSED])
    // Their own company: started, planned and applied; the material is that company's.
    const theirs = await upload('companyOne', sheet('HW-3'), { companyId: companyA1 })
    expect(theirs).toMatchObject({ status: 'PLANNED', createCount: 1 })
    expect((await call('companyOne', 'POST', `/imports/${theirs.id}/apply`, { version: theirs.version })).statusCode).toBe(200)
    await applyPlan(system(), theirs.id, { lastAttempt: true })
    expect(await admin('SELECT code, "companyId" FROM "Item" WHERE code IN ($1, $2) ORDER BY code', ['HW-2', 'HW-3'])).toEqual([{ code: 'HW-3', companyId: companyA1 }])
  })

  it('checks the live roles of the person who started the import in its dry run', async () => {
    // The pricer gets product.materials.cost after starting: the dry run reads the role as it is then.
    const sheet = csv([SHEET[0]!, 'TR-IMP-3;Gancio;accessorio;pz;;;;;;;;;;;;0,3'])
    const started = await start('pricer', sheet)
    expect(started.statusCode, started.body).toBe(201)
    const { job, upload: presigned } = started.json() as { job: Json; upload: { url: string; headers: Record<string, string> } }
    expect((await app.inject({ method: 'PUT', url: presigned.url, headers: presigned.headers, payload: sheet })).statusCode).toBe(200)
    expect((await call('pricer', 'POST', `/files/${job.fileId}/complete`)).statusCode).toBe(200)
    await admin(`UPDATE "Role" SET permissions = array_append(permissions, $1) WHERE key = 'custom.pricer'`, [COST])
    try {
      await planImport(system(), job.id, { lastAttempt: true })
      expect((await call('pricer', 'GET', `/imports/${job.id}`)).json().job).toMatchObject({ status: 'PLANNED', createCount: 1, issues: null })
    } finally {
      await admin(`UPDATE "Role" SET permissions = array_remove(permissions, $1) WHERE key = 'custom.pricer'`, [COST])
    }
  })
})
