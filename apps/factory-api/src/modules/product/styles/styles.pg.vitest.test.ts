import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission, ScopeSet } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedProduct } from '../../../../../../packages/factory-db/seed/product'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * Styles, colourways, size scales and the colour x size SKU matrix on the local stack (B-W1-11; features PRD-001,
 * PRD-002, PRD-004, PRD-005, PRD-022, PRD-047, PRD-048, PRD-270), with the app's real routes: a throwaway PostgreSQL 17
 * database from the migrations (the runtime login, so row-level security and the product triggers are real) and
 * sessions from the test authenticator. Every style, brand, colour and barcode here is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs styles`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const tenantA = newId()
const tenantB = newId()
const companyA1 = newId()
const companyA2 = newId()
const brand = newId()
const customer = newId()
const blackLibrary = newId()
const redLibrary = newId()
const jacketTemplate = newId()
const glovesTemplate = newId()

const VIEW = 'product.styles.view'
const MANAGE = 'product.styles.manage'
const READS: Permission[] = ['audit.read', 'threads.read', 'threads.post']

interface Person {
  readonly tenantId: string
  readonly permissions: readonly Permission[]
  readonly companies: ScopeSet
}
const PEOPLE: Record<string, Person> = {
  maker: { tenantId: tenantA, permissions: [VIEW, MANAGE, ...READS], companies: 'all' },
  viewer: { tenantId: tenantA, permissions: [VIEW, 'audit.read'], companies: 'all' },
  companyOne: { tenantId: tenantA, permissions: [VIEW, MANAGE], companies: [companyA1] },
  materialsOnly: { tenantId: tenantA, permissions: ['product.materials.view', 'product.materials.manage'], companies: 'all' },
  otherTenant: { tenantId: tenantB, permissions: [VIEW, MANAGE], companies: 'all' },
}
const IDS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions], companies: person.companies, sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: person.tenantId, actorId: IDS[key]!, grants: [grant] }]
  }),
)

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: 'POST' | 'PUT' | 'PATCH', url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const historyOf = async (recordType: string, id: string): Promise<any[]> => (await ok('maker', 'GET', `/audit/${recordType}/${id}`)).entries
const eventsOf = async (subject: string) => admin<{ type: string; payload: Json }>('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])

/** A made-up EU jacket scale with body measures, and a letter scale. */
const EU = {
  code: 'eu-46-58',
  name: 'EU 46-58 (made up)',
  sizes: ['46', '48', '50', '52', '54', '56', '58'].map((code, index) => ({
    code,
    label: index === 3 ? '52 (L)' : undefined,
    bodyMeasures: { chest: { min: String(92 + index * 4), max: String(95 + index * 4), unit: 'cm' } },
  })),
}

let euScale: Json
let jacket: Json

beforeAll(async () => {
  db = await migratedDatabase('styles')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  for (const [tenantId, slug, companies] of [
    [tenantA, 'styles-a', [companyA1, companyA2]],
    [tenantB, 'styles-b', []],
  ] as const) {
    await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
    for (const [index, companyId] of companies.entries()) {
      await admin('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $3)', [companyId, tenantId, `${slug}-${index + 1}`])
    }
  }
  await admin(
    `INSERT INTO "Party" (id, "tenantId", code, kind, "legalName", roles, status) VALUES
       ($1, $3, 'BRAND-1', 'ORGANISATION', 'Marchio Esempio S.r.l.', '{CUSTOMER,BRAND}', 'ACTIVE'),
       ($2, $3, 'CUST-1', 'ORGANISATION', 'Cliente Esempio S.p.A.', '{CUSTOMER}', 'ACTIVE')`,
    [brand, customer, tenantA],
  )
  await admin(`INSERT INTO "Colour" (id, "tenantId", code, name, hex) VALUES ($1, $3, 'BLK', 'Black', '#111111'), ($2, $3, 'RED', 'Red', '#B00020')`, [blackLibrary, redLibrary, tenantA])
  await admin(
    `INSERT INTO "MeasurementTemplate" (id, "tenantId", code, name, "productType") VALUES ($1, $3, 'JACKET', 'Jacket measures', 'JACKET'), ($2, $3, 'GLOVES', 'Glove measures', 'GLOVES')`,
    [jacketTemplate, glovesTemplate, tenantA],
  )
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
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the size scale library (PRD-047)', () => {
  it('creates a scale with its ordered sizes and body measures', async () => {
    euScale = (await ok('maker', 'POST', '/product/size-scales', EU, 201)).scale
    expect(euScale).toMatchObject({ code: 'EU-46-58', companyId: null, codes: ['46', '48', '50', '52', '54', '56', '58'], styleCount: 0, status: 'ACTIVE', version: 1, measureUnits: { chest: 'cm' } })
    expect(euScale.sizes[3]).toMatchObject({ code: '52', label: '52 (L)', seq: 4, bodyMeasures: { chest: { min: '104', max: '107', unit: 'cm' } }, inUse: false })
    expect((await eventsOf(euScale.id)).map((event) => event.type)).toEqual(['size_scale.created'])
  })

  it('refuses a size code twice, the SKU separator in a code, and two units for one point', async () => {
    const twice = await refused('maker', 'POST', '/product/size-scales', { code: 'X1', name: 'x', sizes: [{ code: 'S' }, { code: 's' }] }, 400)
    expect(twice.issues).toEqual([{ path: 'body/sizes/1/code', message: 'The scale has size S already.' }])
    expect((await refused('maker', 'POST', '/product/size-scales', { code: 'X2', name: 'x', sizes: [{ code: 'S-M' }] }, 400)).code).toBe('validation_failed')
    const units = await refused('maker', 'POST', '/product/size-scales', { code: 'X3', name: 'x', sizes: [{ code: 'S', bodyMeasures: { chest: { min: '90', max: null, unit: 'cm' } } }, { code: 'M', bodyMeasures: { chest: { min: '38', max: null, unit: 'in' } } }] }, 400)
    expect(units.issues).toEqual([{ path: 'body/sizes/1/bodyMeasures/chest/unit', message: 'The scale measures chest in cm: use cm in every size.' }])
    expect((await refused('maker', 'POST', '/product/size-scales', { ...EU, name: 'Again' }, 409)).message).toBe('The size scale code EU-46-58 is taken.')
  })

  it('edits an unused scale freely: code, order, size codes', async () => {
    const letters = (await ok('maker', 'POST', '/product/size-scales', { code: 'LT', name: 'Letters', sizes: [{ code: 'M' }, { code: 'S' }, { code: 'L' }] }, 201)).scale
    const renamed = (await ok('maker', 'PATCH', `/product/size-scales/${letters.id}`, { version: 1, code: 'LETTERS', name: 'Letters S-L' })).scale
    expect(renamed).toMatchObject({ code: 'LETTERS', name: 'Letters S-L', version: 2 })
    const ordered = (await ok('maker', 'PUT', `/product/size-scales/${letters.id}/order`, { version: 2, codes: ['S', 'M', 'L'] })).scale
    expect(ordered.codes).toEqual(['S', 'M', 'L'])
    expect((await refused('maker', 'PUT', `/product/size-scales/${letters.id}/order`, { version: 3, codes: ['S', 'M'] }, 400)).issues).toEqual([{ path: 'body/codes', message: 'List every size of the scale once; missing: L.' }])
    const large = ordered.sizes.find((size: Json) => size.code === 'L')
    const xl = (await ok('maker', 'PATCH', `/product/size-scales/${letters.id}/sizes/${large.id}`, { version: large.version, code: 'xl', label: 'Extra large' })).scale
    expect(xl.codes).toEqual(['S', 'M', 'XL'])
    expect((await historyOf('Size', large.id)).map((entry) => entry.action)).toEqual(['product.styles.updateSize', 'product.styles.createScale'])
  })
})

describe('a style with 2 colourways x 3 sizes (PRD-001, PRD-004, PRD-005, PRD-048)', () => {
  it('creates the style with its colourways and range, then generates 6 SKUs, each unique', async () => {
    jacket = (
      await ok(
        'maker',
        'POST',
        '/product/styles',
        {
          code: 'gt-jkt-01',
          name: 'Giacca touring (made up)',
          nameI18n: { it: 'Giacca touring', en: 'Touring jacket' },
          productType: 'JACKET',
          season: 'FW27',
          brandPartyId: brand,
          sizeScaleId: euScale.id,
          sizes: ['54', '50', '52'],
          baseSize: '52',
          ppeCategory: 'CATEGORY_II',
          ppeStandard: 'en 17092-4:2020',
          colourways: [
            { code: 'blk', name: 'Black', colourId: blackLibrary, description: 'Black leather, grey lining.' },
            { code: 'RED', name: 'Red', colourId: redLibrary },
          ],
        },
        201,
      )
    ).style
    expect(jacket).toMatchObject({
      code: 'GT-JKT-01',
      status: 'DRAFT',
      sizes: ['50', '52', '54'],
      baseSize: '52',
      ppeStandard: 'EN 17092-4:2020',
      ppeClass: 'A',
      tracking: 'LOT',
      brand: { id: brand, code: 'BRAND-1', name: 'Marchio Esempio S.r.l.' },
      sizeScale: { id: euScale.id, code: 'EU-46-58' },
      colourwayCount: 2,
      skuCount: 0,
      revisionState: 'NONE',
      matrix: { generated: false, missing: 6 },
    })
    expect(jacket.range.map((size: Json) => [size.code, size.label])).toEqual([['50', null], ['52', '52 (L)'], ['54', null]])
    expect(jacket.colourways.map((colourway: Json) => [colourway.code, colourway.colour?.hex])).toEqual([['BLK', '#111111'], ['RED', '#B00020']])
    expect(jacket.warnings.map((warning: Json) => warning.code)).toEqual(['SKUS_MISSING'])

    const preview = await ok('maker', 'POST', `/product/styles/${jacket.id}/skus/generate`, { dryRun: true })
    expect(preview.skus).toHaveLength(6)
    expect(await admin('SELECT id FROM "Variant" WHERE "styleId" = $1', [jacket.id])).toEqual([])

    const generated = await ok('maker', 'POST', `/product/styles/${jacket.id}/skus/generate`, {})
    expect(generated.skus.map((entry: Json) => entry.sku)).toEqual(['GT-JKT-01-BLK-50', 'GT-JKT-01-BLK-52', 'GT-JKT-01-BLK-54', 'GT-JKT-01-RED-50', 'GT-JKT-01-RED-52', 'GT-JKT-01-RED-54'])
    jacket = generated.style
    expect(jacket).toMatchObject({ skuCount: 6, matrix: { generated: true, missing: 0 }, warnings: [] })
    expect(jacket.matrix.rows[1].cells.map((cell: Json) => cell.sku.sku)).toEqual(['GT-JKT-01-RED-50', 'GT-JKT-01-RED-52', 'GT-JKT-01-RED-54'])
    expect(jacket.colourways.map((colourway: Json) => [colourway.offeredSizes, colourway.inUse])).toEqual([[['50', '52', '54'], true], [['50', '52', '54'], true]])
    const rows = await admin<{ sku: string }>('SELECT sku FROM "Variant" WHERE "styleId" = $1', [jacket.id])
    expect(new Set(rows.map((row) => row.sku)).size).toBe(6)
    // Generating again makes nothing.
    expect((await ok('maker', 'POST', `/product/styles/${jacket.id}/skus/generate`, {})).skus).toEqual([])
    expect((await eventsOf(jacket.id)).map((event) => event.type)).toEqual(['style.created', 'style.skus_changed'])
    expect((await eventsOf(jacket.id))[1]!.payload).toEqual({ styleId: jacket.id, code: 'GT-JKT-01', created: 6, archived: 0, restored: 0, updated: 0 })
    expect((await historyOf('Variant', jacket.skus[0].id))[0]).toMatchObject({ action: 'product.styles.generateSkus', after: { sku: 'GT-JKT-01-BLK-50', size: '50', status: 'ACTIVE' } })
    // The scale is in use now.
    expect((await ok('viewer', 'GET', `/product/size-scales/${euScale.id}`)).scale).toMatchObject({ styleCount: 1 })
  })

  it('creates a style with its SKUs at once when asked', async () => {
    const trousers = (
      await ok('maker', 'POST', '/product/styles', { code: 'GT-TRS-01', name: 'Pantaloni (made up)', productType: 'TROUSERS', sizeScaleId: euScale.id, sizes: ['50', '52'], colourways: [{ code: 'BLK', name: 'Black' }], generateSkus: true }, 201)
    ).style
    expect(trousers.skus.map((entry: Json) => entry.sku)).toEqual(['GT-TRS-01-BLK-50', 'GT-TRS-01-BLK-52'])
    expect(trousers).toMatchObject({ ppeCategory: 'NOT_PPE', tracking: 'NONE' })
  })

  it('refuses sizes outside the scale, a base size outside the range, a wrong PPE class, a non-brand and a template of another type', async () => {
    const base = { code: 'GT-BAD-1', name: 'x', productType: 'JACKET', sizeScaleId: euScale.id }
    expect((await refused('maker', 'POST', '/product/styles', { ...base, sizes: ['50', '60'] }, 400)).issues).toEqual([{ path: 'body/sizes/1', message: "The style's size scale has no size 60." }])
    expect((await refused('maker', 'POST', '/product/styles', { ...base, sizes: ['50'], baseSize: '52' }, 400)).issues).toEqual([{ path: 'body/baseSize', message: 'The base size is one of the range: 50.' }])
    expect((await refused('maker', 'POST', '/product/styles', { ...base, ppeCategory: 'CATEGORY_II', ppeStandard: 'EN 17092-3:2020', ppeClass: 'A' }, 400)).issues).toEqual([{ path: 'body/ppeClass', message: 'EN 17092-3:2020 is class AA.' }])
    expect((await refused('maker', 'POST', '/product/styles', { ...base, brandPartyId: customer }, 400)).issues).toEqual([{ path: 'body/brandPartyId', message: 'This party is not a brand (give it the BRAND role first).' }])
    expect((await refused('maker', 'POST', '/product/styles', { ...base, mtmAllowed: true, measurementTemplateId: glovesTemplate }, 400)).issues).toEqual([
      { path: 'body/measurementTemplateId', message: 'This measurement template is for gloves, not jacket.' },
    ])
    expect((await refused('maker', 'POST', '/product/styles', { ...base, colourways: [{ code: 'BLK-1', name: 'x' }] }, 400)).code).toBe('validation_failed')
    expect((await refused('maker', 'POST', '/product/styles', { ...base, code: 'gt-jkt-01' }, 409)).message).toBe('The style code GT-JKT-01 is taken.')
    expect(await admin('SELECT code FROM "Style" WHERE code = $1', ['GT-BAD-1'])).toEqual([])
  })

  it('moves the SKUs with the range: a new size gets them, a size taken out has them archived, never deleted', async () => {
    const wider = (await ok('maker', 'PATCH', `/product/styles/${jacket.id}`, { version: jacket.version, sizes: ['50', '52', '54', '56'] })).style
    expect(wider.skus.filter((entry: Json) => entry.size === '56').map((entry: Json) => entry.sku)).toEqual(['GT-JKT-01-BLK-56', 'GT-JKT-01-RED-56'])
    expect(wider.skuCount).toBe(8)
    const narrower = (await ok('maker', 'PATCH', `/product/styles/${jacket.id}`, { version: wider.version, sizes: ['50', '52', '56'] })).style
    expect(narrower.skuCount).toBe(6)
    expect(narrower.skus.filter((entry: Json) => entry.size === '54').map((entry: Json) => [entry.status, entry.offered])).toEqual([['ARCHIVED', false], ['ARCHIVED', false]])
    expect(await admin('SELECT count(*)::int AS n FROM "Variant" WHERE "styleId" = $1', [jacket.id])).toEqual([{ n: 8 }])
    const back = (await ok('maker', 'PATCH', `/product/styles/${jacket.id}`, { version: narrower.version, sizes: ['50', '52', '54', '56'] })).style
    expect(back.skus.filter((entry: Json) => entry.size === '54').map((entry: Json) => entry.status)).toEqual(['ACTIVE', 'ACTIVE'])
    expect(back.skuCount).toBe(8)
    const [entry] = (await historyOf('Style', jacket.id)).filter((row) => row.action === 'product.styles.update' && row.after.skus)
    expect(entry.after.skus).toEqual({ created: [], archived: [], restored: ['GT-JKT-01-BLK-54', 'GT-JKT-01-RED-54'] })
    // The base size cannot leave the range while it is the base size.
    expect((await refused('maker', 'PATCH', `/product/styles/${jacket.id}`, { version: back.version, sizes: ['50', '54'] }, 400)).issues[0].path).toBe('body/baseSize')
    jacket = back
  })

  it('keeps the code and the scale of a style with SKUs', async () => {
    expect((await refused('maker', 'PATCH', `/product/styles/${jacket.id}`, { version: jacket.version, code: 'GT-JKT-99' }, 409)).message).toBe('The style has SKUs, which start with its code: its code stays GT-JKT-01.')
    const letters = (await ok('viewer', 'GET', '/product/size-scales?q=LETTERS')).scales[0]
    expect((await refused('maker', 'PATCH', `/product/styles/${jacket.id}`, { version: jacket.version, sizeScaleId: letters.id, sizes: ['S'], baseSize: 'S' }, 409)).message).toBe(
      'The style has SKUs in sizes of its scale: its size scale stays.',
    )
  })
})

describe('colourways (PRD-004) and SKU cells (PRD-005)', () => {
  it('adds a colourway with its SKUs in the range, archives it (its SKUs off) and restores it', async () => {
    const added = (await ok('maker', 'POST', `/product/styles/${jacket.id}/colourways`, { code: 'wht', name: 'White' }, 201)).style
    const white = added.colourways.find((colourway: Json) => colourway.code === 'WHT')
    expect(added.skus.filter((entry: Json) => entry.colourwayId === white.id).map((entry: Json) => entry.sku)).toEqual(['GT-JKT-01-WHT-50', 'GT-JKT-01-WHT-52', 'GT-JKT-01-WHT-54', 'GT-JKT-01-WHT-56'])
    expect(added.version).toBe(jacket.version)
    expect((await refused('maker', 'POST', `/product/styles/${jacket.id}/colourways`, { code: 'WHT', name: 'White' }, 409)).message).toBe('The style has colourway WHT already.')

    const archived = (await ok('maker', 'PATCH', `/product/styles/${jacket.id}/colourways/${white.id}`, { version: white.version, status: 'ARCHIVED' })).style
    expect(archived.skus.filter((entry: Json) => entry.colourwayId === white.id).map((entry: Json) => entry.status)).toEqual(['ARCHIVED', 'ARCHIVED', 'ARCHIVED', 'ARCHIVED'])
    expect(archived.matrix.rows.find((row: Json) => row.code === 'WHT').cells.every((cell: Json) => !cell.offered)).toBe(true)
    expect((await refused('maker', 'POST', `/product/styles/${jacket.id}/colourways`, { code: 'WHT', name: 'White' }, 409)).message).toBe('The style had colourway WHT; restore it instead.')
    const restored = (await ok('maker', 'PATCH', `/product/styles/${jacket.id}/colourways/${white.id}`, { version: white.version + 1, status: 'ACTIVE', name: 'Bianco' })).style
    expect(restored.skus.filter((entry: Json) => entry.colourwayId === white.id).every((entry: Json) => entry.status === 'ACTIVE')).toBe(true)
    expect(restored.colourways.find((colourway: Json) => colourway.id === white.id)).toMatchObject({ name: 'Bianco', status: 'ACTIVE', version: white.version + 2 })
    expect((await historyOf('Colourway', white.id)).map((entry) => entry.action)).toEqual(['product.styles.updateColourway', 'product.styles.updateColourway', 'product.styles.addColourway'])
    // Stale version.
    expect((await refused('maker', 'PATCH', `/product/styles/${jacket.id}/colourways/${white.id}`, { version: white.version, name: 'x' }, 409)).issues).toEqual([{ path: 'version', message: `The current version is ${white.version + 2}.` }])
    jacket = restored
  })

  it('never changes the code of a used colourway, but does of an unused one', async () => {
    const black = jacket.colourways.find((colourway: Json) => colourway.code === 'BLK')
    expect((await refused('maker', 'PATCH', `/product/styles/${jacket.id}/colourways/${black.id}`, { version: black.version, code: 'NERO' }, 409)).message).toMatch(/^Colourway BLK is in use/)
    const draft = (await ok('maker', 'POST', '/product/styles', { code: 'GT-VST-01', name: 'Gilet (made up)', productType: 'VEST', sizeScaleId: euScale.id, colourways: [{ code: 'GRY', name: 'Grey' }] }, 201)).style
    const grey = draft.colourways[0]
    const renamed = (await ok('maker', 'PATCH', `/product/styles/${draft.id}/colourways/${grey.id}`, { version: grey.version, code: 'ANT', name: 'Anthracite' })).style
    expect(renamed.colourways[0]).toMatchObject({ code: 'ANT', name: 'Anthracite', inUse: false })
  })

  it('switches one cell off and on, only a cell the style offers', async () => {
    const cell = jacket.skus.find((entry: Json) => entry.sku === 'GT-JKT-01-RED-56')
    const off = (await ok('maker', 'PATCH', `/product/styles/${jacket.id}/skus/${cell.id}`, { version: cell.version, status: 'ARCHIVED' })).style
    expect(off.skus.find((entry: Json) => entry.id === cell.id)).toMatchObject({ status: 'ARCHIVED', offered: true })
    expect(off.colourways.find((colourway: Json) => colourway.code === 'RED').offeredSizes).toEqual(['50', '52', '54'])
    // A cell switched off stays off when the SKUs are generated again.
    expect((await ok('maker', 'POST', `/product/styles/${jacket.id}/skus/generate`, {})).skus).toEqual([])
    const on = (await ok('maker', 'PATCH', `/product/styles/${jacket.id}/skus/${cell.id}`, { version: cell.version + 1, status: 'ACTIVE' })).style
    expect(on.skus.find((entry: Json) => entry.id === cell.id).status).toBe('ACTIVE')
    // A size out of the range: its SKU stays off.
    const narrowed = (await ok('maker', 'PATCH', `/product/styles/${jacket.id}`, { version: on.version, sizes: ['50', '52', '54'] })).style
    const outside = narrowed.skus.find((entry: Json) => entry.sku === 'GT-JKT-01-BLK-56')
    expect((await refused('maker', 'PATCH', `/product/styles/${jacket.id}/skus/${outside.id}`, { version: outside.version, status: 'ACTIVE' }, 409)).code).toBe('invalid_state')
    jacket = narrowed
  })

  it('sets a GTIN with its check digit, in one canonical form, once in the tenant', async () => {
    const [first, second] = jacket.skus.filter((entry: Json) => entry.status === 'ACTIVE')
    const wrong = await refused('maker', 'PATCH', `/product/styles/${jacket.id}/skus/${first.id}`, { version: first.version, gtin: '2001234567891' }, 400)
    expect(wrong.issues).toEqual([{ path: 'body/gtin', message: 'The last digit of the GTIN is not its check digit: it was mistyped.' }])
    const set = (await ok('maker', 'PATCH', `/product/styles/${jacket.id}/skus/${first.id}`, { version: first.version, gtin: '02001234567893' })).style
    expect(set.skus.find((entry: Json) => entry.id === first.id).gtin).toBe('2001234567893')
    expect((await refused('maker', 'PATCH', `/product/styles/${jacket.id}/skus/${second.id}`, { version: second.version, gtin: '2001 2345 6789 3' }, 409)).message).toBe(
      `GTIN 2001234567893 is on SKU ${first.sku} already.`,
    )
    const cleared = (await ok('maker', 'PATCH', `/product/styles/${jacket.id}/skus/${first.id}`, { version: first.version + 1, gtin: null })).style
    expect(cleared.skus.find((entry: Json) => entry.id === first.id).gtin).toBeNull()
    const [entry] = await historyOf('Variant', first.id)
    expect(entry).toMatchObject({ action: 'product.styles.updateSku', before: { gtin: '2001234567893' }, after: { gtin: null } })
    jacket = (await ok('maker', 'GET', `/product/styles/${jacket.id}`)).style
  })
})

describe('size codes in use (PRD-047)', () => {
  it('never changes the code of a size a style names, and keeps a used scale in its order; sizes are still added', async () => {
    const scale = (await ok('maker', 'GET', `/product/size-scales/${euScale.id}`)).scale
    const fifty = scale.sizes.find((size: Json) => size.code === '50')
    const fortySix = scale.sizes.find((size: Json) => size.code === '46')
    expect(fifty.inUse).toBe(true)
    expect(fortySix.inUse).toBe(false)
    expect((await refused('maker', 'PATCH', `/product/size-scales/${euScale.id}/sizes/${fifty.id}`, { version: fifty.version, code: '50R' }, 409)).message).toMatch(/^Size 50 is in use/)
    expect((await refused('maker', 'PATCH', `/product/size-scales/${euScale.id}`, { version: scale.version, code: 'EU-NEW' }, 409)).message).toMatch(/use this scale: its code stays EU-46-58\.$/)
    expect((await refused('maker', 'PUT', `/product/size-scales/${euScale.id}/order`, { version: scale.version, codes: [...scale.codes].reverse() }, 409)).message).toMatch(/its order stays/)
    // An unused size of a used scale: its code may change, and its label and measures always.
    const renamed = (await ok('maker', 'PATCH', `/product/size-scales/${euScale.id}/sizes/${fortySix.id}`, { version: fortySix.version, code: '46S', label: 'Slim 46', bodyMeasures: null })).scale
    expect(renamed.sizes[0]).toMatchObject({ code: '46S', label: 'Slim 46', bodyMeasures: null })
    const added = (await ok('maker', 'POST', `/product/size-scales/${euScale.id}/sizes`, { version: renamed.version, before: '46S', sizes: [{ code: '44' }] }, 201)).scale
    expect(added.codes).toEqual(['44', '46S', '48', '50', '52', '54', '56', '58'])
    expect((await refused('maker', 'POST', `/product/size-scales/${euScale.id}/sizes`, { version: added.version, sizes: [{ code: '60', bodyMeasures: { chest: { min: '40', max: null, unit: 'in' } } }] }, 400)).issues).toEqual([
      { path: 'body/sizes/0/bodyMeasures/chest/unit', message: 'The scale measures chest in cm: use cm in every size.' },
    ])
    // An archived size stays in the styles that have it, but is not added to a range.
    const fiftyEight = added.sizes.find((size: Json) => size.code === '58')
    await ok('maker', 'PATCH', `/product/size-scales/${euScale.id}/sizes/${fiftyEight.id}`, { version: fiftyEight.version, status: 'ARCHIVED' })
    expect((await refused('maker', 'PATCH', `/product/styles/${jacket.id}`, { version: jacket.version, sizes: [...jacket.sizes, '58'] }, 400)).issues).toEqual([
      { path: 'body/sizes/3', message: 'Size 58 is archived in the scale: it is no longer added to a range.' },
    ])
    expect((await refused('maker', 'POST', `/product/size-scales/${euScale.id}/sizes`, { version: added.version, sizes: [{ code: '58' }] }, 409)).message).toBe('The scale had size 58; restore it instead.')
  })
})

describe('revisions (A1 §2.5)', () => {
  it('starts a DRAFT revision shell, one at a time', async () => {
    const created = (await ok('maker', 'POST', `/product/styles/${jacket.id}/revisions`, { changeNote: 'First specification' }, 201)).revision
    expect(created).toMatchObject({ revision: 1, status: 'DRAFT', changeNote: 'First specification', releasedAt: null, version: 1, createdById: IDS.maker })
    expect((await refused('maker', 'POST', `/product/styles/${jacket.id}/revisions`, {}, 409)).message).toBe('Revision 1 is still a draft: change it, or release or abandon it, before starting another.')
    expect((await ok('viewer', 'GET', `/product/styles/${jacket.id}/revisions`)).revisions.map((entry: Json) => [entry.revision, entry.status])).toEqual([[1, 'DRAFT']])
    const style = (await ok('viewer', 'GET', `/product/styles/${jacket.id}`)).style
    expect(style).toMatchObject({ revisionState: 'DRAFT', completeness: { colourways: true, sizeRange: true, baseSize: true, skus: true, releasedRevision: false } })
    expect((await eventsOf(jacket.id)).at(-1)).toEqual({ type: 'style.revision_created', payload: { styleId: jacket.id, code: 'GT-JKT-01', revisionId: created.id, revision: 1 } })
    // A style is ACTIVE only with a released revision (the release is the BOM step's).
    await admin(`UPDATE "StyleRevision" SET status = 'OBSOLETE' WHERE id = $1`, [created.id])
    const second = (await ok('maker', 'POST', `/product/styles/${jacket.id}/revisions`, {}, 201)).revision
    expect(second.revision).toBe(2)
  })
})

describe('lists, archive, idempotency and the walls', () => {
  it('lists with a search and filters, and pages', async () => {
    const page = async (query: string) => (await ok('viewer', 'GET', `/product/styles${query}`)) as Json
    expect((await page('?q=touring')).styles.map((row: Json) => row.code)).toEqual(['GT-JKT-01'])
    expect((await page('?productType=jacket,vest')).styles.map((row: Json) => row.code)).toEqual(['GT-JKT-01', 'GT-VST-01'])
    expect((await page('?ppeCategory=CATEGORY_II')).styles.map((row: Json) => row.code)).toEqual(['GT-JKT-01'])
    expect((await page(`?brandPartyId=${brand}`)).styles.map((row: Json) => row.code)).toEqual(['GT-JKT-01'])
    expect((await page('?season=fw27')).styles[0]).toMatchObject({ code: 'GT-JKT-01', colourwayCount: 3, skuCount: 9, revisionState: 'DRAFT' })
    const first = await page('?limit=2')
    expect(first.count).toBe(3)
    const second = await page(`?limit=2&cursor=${first.nextCursor}`)
    expect([...first.styles, ...second.styles].map((row: Json) => row.code)).toEqual(['GT-JKT-01', 'GT-TRS-01', 'GT-VST-01'])
    expect(second.nextCursor).toBeNull()
    expect((await call('viewer', 'GET', '/product/styles?productType=SHOES')).statusCode).toBe(400)
    expect((await ok('viewer', 'GET', '/product/size-scales')).scales.map((row: Json) => row.code)).toEqual(['EU-46-58', 'LETTERS'])
  })

  it('lists the styles whose draft revision waits for its release, with the revision numbers on each row (SCR-040)', async () => {
    const page = async (query: string) => (await ok('viewer', 'GET', `/product/styles${query}`)) as Json
    const waiting = await page('?draftRevision=true')
    expect(waiting.styles.map((row: Json) => row.code)).toEqual(['GT-JKT-01'])
    expect(waiting.count).toBe(1)
    // Revision 1 was made obsolete above; revision 2 is the open draft.
    expect(waiting.styles[0]).toMatchObject({ revisionState: 'DRAFT', releasedRevision: null, draftRevision: 2 })
    expect((await page('?draftRevision=false')).styles.map((row: Json) => row.code)).toEqual(['GT-TRS-01', 'GT-VST-01'])
    expect((await page('?draftRevision=false')).styles[0]).toMatchObject({ releasedRevision: null, draftRevision: null })
    expect((await ok('viewer', 'GET', `/product/styles/${jacket.id}`)).style).toMatchObject({ releasedRevision: null, draftRevision: 2 })
    expect((await call('viewer', 'GET', '/product/styles?draftRevision=maybe')).statusCode).toBe(400)
  })

  it('lists the colour library a colourway picks from: active by code, searched, scoped to the tenant', async () => {
    expect((await ok('viewer', 'GET', '/product/colours')).colours).toEqual([
      { id: blackLibrary, companyId: null, code: 'BLK', name: 'Black', hex: '#111111', status: 'ACTIVE' },
      { id: redLibrary, companyId: null, code: 'RED', name: 'Red', hex: '#B00020', status: 'ACTIVE' },
    ])
    expect((await ok('viewer', 'GET', '/product/colours?q=re')).colours.map((row: Json) => row.code)).toEqual(['RED'])
    expect((await ok('otherTenant', 'GET', '/product/colours')).colours).toEqual([])
    expect((await call('materialsOnly', 'GET', '/product/colours')).statusCode).toBe(403)
  })

  it('archives a style out of new use, read only until it is reactivated (PRD-022)', async () => {
    const vest = (await ok('viewer', 'GET', '/product/styles?q=GT-VST-01')).styles[0]
    const archived = (await ok('maker', 'POST', `/product/styles/${vest.id}/archive`, { version: vest.version, reason: 'Dropped from the collection (made up)' })).style
    expect(archived.status).toBe('ARCHIVED')
    expect((await ok('viewer', 'GET', '/product/styles?q=GT-VST-01')).styles).toEqual([])
    expect((await ok('viewer', 'GET', '/product/styles?q=GT-VST-01&status=ALL')).styles).toHaveLength(1)
    expect((await refused('maker', 'PATCH', `/product/styles/${vest.id}`, { version: archived.version, name: 'x' }, 409)).code).toBe('invalid_state')
    expect((await refused('maker', 'POST', `/product/styles/${vest.id}/colourways`, { code: 'X', name: 'x' }, 409)).code).toBe('invalid_state')
    expect((await refused('maker', 'POST', `/product/styles/${vest.id}/revisions`, {}, 409)).message).toBe('This style is archived: reactivate it before starting a revision.')
    const back = (await ok('maker', 'POST', `/product/styles/${vest.id}/reactivate`, { version: archived.version })).style
    expect(back).toMatchObject({ status: 'DRAFT', version: archived.version + 1 })
    expect((await refused('maker', 'POST', `/product/styles/${vest.id}/reactivate`, { version: back.version }, 409)).code).toBe('invalid_state')
    const [entry] = (await historyOf('Style', vest.id)).filter((row) => row.action === 'product.styles.archive')
    expect(entry).toMatchObject({ before: { status: 'DRAFT' }, after: { status: 'ARCHIVED' }, reason: 'Dropped from the collection (made up)' })
    // Nothing deletes a style, a colourway or a SKU: the runtime login has no DELETE grant.
    await expect(database.withScope({ audience: 'office', tenantId: tenantA, actorId: IDS.maker! }, (client) => client.variant.deleteMany({ where: { styleId: jacket.id } }))).rejects.toThrow(/permission denied/i)
    expect(await admin('SELECT count(*)::int AS n FROM "Variant" WHERE "styleId" = $1', [jacket.id])).toEqual([{ n: 12 }])
  })

  it('answers a repeated request from its receipt', async () => {
    const body = { code: 'GT-GLV-01', name: 'Guanti (made up)', productType: 'GLOVES', sizeScaleId: euScale.id, ppeCategory: 'CATEGORY_II', ppeStandard: 'EN 13594:2015', ppeClass: '1kp' }
    const key = { 'idempotency-key': `styles-${newId()}` }
    const first = await call('maker', 'POST', '/product/styles', body, key)
    const second = await call('maker', 'POST', '/product/styles', body, key)
    expect(first.statusCode, first.body).toBe(201)
    expect(second.json().style.id).toBe(first.json().style.id)
    expect(first.json().style).toMatchObject({ ppeClass: '1KP', ppeStandard: 'EN 13594:2015' })
    expect(await admin('SELECT id FROM "Style" WHERE code = $1', ['GT-GLV-01'])).toHaveLength(1)
  })

  it('keeps companies and tenants apart, and needs product.styles.*', async () => {
    // A person whose grant reaches company 1 only: its own styles and the tenant-wide ones, nothing of company 2.
    expect((await refused('companyOne', 'POST', '/product/styles', { code: 'C0-1', name: 'x', productType: 'OTHER', sizeScaleId: euScale.id }, 403)).message).toBe('A style for every company is changed only by a role over every company.')
    const own = (await ok('companyOne', 'POST', '/product/styles', { code: 'C1-1', name: 'x', productType: 'OTHER', sizeScaleId: euScale.id, companyId: companyA1 }, 201)).style
    const other = (await ok('maker', 'POST', '/product/styles', { code: 'C2-1', name: 'x', productType: 'OTHER', sizeScaleId: euScale.id, companyId: companyA2 }, 201)).style
    expect(own.companyId).toBe(companyA1)
    expect((await call('companyOne', 'GET', `/product/styles/${other.id}`)).statusCode).toBe(404)
    expect((await call('companyOne', 'PATCH', `/product/styles/${other.id}`, { version: 1, name: 'y' })).statusCode).toBe(404)
    expect((await refused('companyOne', 'PATCH', `/product/styles/${jacket.id}`, { version: jacket.version, name: 'y' }, 403)).message).toBe('A style for every company is changed only by a role over every company.')
    const codes = (await ok('companyOne', 'GET', '/product/styles?limit=200&status=ALL')).styles.map((row: Json) => row.code)
    expect(codes).toContain('C1-1')
    expect(codes).toContain('GT-JKT-01')
    expect(codes).not.toContain('C2-1')
    // A company-2 scale is not for a company-1 style.
    const scale2 = (await ok('maker', 'POST', '/product/size-scales', { code: 'C2-SC', name: 'x', companyId: companyA2, sizes: [{ code: 'U' }] }, 201)).scale
    expect((await refused('maker', 'POST', '/product/styles', { code: 'C1-2', name: 'x', productType: 'OTHER', sizeScaleId: scale2.id, sizes: ['U'], companyId: companyA1 }, 400)).issues).toEqual([
      { path: 'body/sizeScaleId', message: "This size scale belongs to another company than the style's." },
    ])
    expect((await call('companyOne', 'GET', `/product/size-scales/${scale2.id}`)).statusCode).toBe(404)

    // Another tenant sees none of it; the same codes are free there.
    expect((await call('otherTenant', 'GET', `/product/styles/${jacket.id}`)).statusCode).toBe(404)
    expect((await call('otherTenant', 'GET', `/product/size-scales/${euScale.id}`)).statusCode).toBe(404)
    expect((await call('otherTenant', 'PATCH', `/product/styles/${jacket.id}/skus/${jacket.skus[0].id}`, { version: 1, gtin: null })).statusCode).toBe(404)
    expect(await ok('otherTenant', 'GET', '/product/styles')).toMatchObject({ styles: [], count: 0 })
    const theirScale = (await ok('otherTenant', 'POST', '/product/size-scales', EU, 201)).scale
    expect((await refused('otherTenant', 'POST', '/product/styles', { code: 'GT-JKT-01', name: 'x', productType: 'JACKET', sizeScaleId: euScale.id }, 400)).issues).toEqual([{ path: 'body/sizeScaleId', message: 'No such size scale.' }])
    const theirs = (await ok('otherTenant', 'POST', '/product/styles', { code: 'GT-JKT-01', name: 'x', productType: 'JACKET', sizeScaleId: theirScale.id, sizes: ['50'], colourways: [{ code: 'BLK', name: 'Black' }], generateSkus: true }, 201)).style
    expect(theirs.skus.map((entry: Json) => entry.sku)).toEqual(['GT-JKT-01-BLK-50'])

    // Without product.styles.* nothing is reached.
    expect((await call('materialsOnly', 'GET', '/product/styles')).statusCode).toBe(403)
    expect((await call('materialsOnly', 'POST', '/product/size-scales', EU)).statusCode).toBe(403)
    expect((await call('viewer', 'POST', '/product/styles', { code: 'V-1', name: 'x', productType: 'OTHER', sizeScaleId: euScale.id })).statusCode).toBe(403)
  })

  it('gives a style its record thread (COL-001): its company, and its brand as the party', async () => {
    const posted = await call('maker', 'POST', `/threads/Style/${jacket.id}/notes`, { body: 'Check the knee armour pocket on the sample (made up).' })
    expect(posted.statusCode, posted.body).toBe(201)
    expect(await admin('SELECT "recordType", "companyId", "partyId" FROM "Thread" WHERE "recordId" = $1', [jacket.id])).toEqual([{ recordType: 'Style', companyId: null, partyId: brand }])
    const timeline = await call('maker', 'GET', `/threads/Style/${jacket.id}/timeline`)
    expect(timeline.statusCode, timeline.body).toBe(200)
    // The thread is shared with the brand: the style keeps its brand.
    const current = (await ok('maker', 'GET', `/product/styles/${jacket.id}`)).style
    expect((await refused('maker', 'PATCH', `/product/styles/${jacket.id}`, { version: current.version, brandPartyId: null }, 409)).message).toMatch(/^The style's thread is shared with its brand/)
  })
})

describe('the seed style (packages/factory-db seed/product.ts)', () => {
  it('passes the style rules: a PATCH of it is accepted (EN 17092-3 is class AA), and the seed stays idempotent', async () => {
    const core = await seedCore({ db: database, namespace: 'styles-seed' })
    const seeded = await seedProduct({ db: database, namespace: 'styles-seed' })
    await seedProduct({ db: database, namespace: 'styles-seed' })
    SESSIONS.seeded = { audience: 'office', tenantId: core.tenantId, actorId: core.actorId, grants: [{ permissions: [VIEW, MANAGE], companies: 'all', sites: 'all', parties: 'all' }] }
    const style = (await ok('seeded', 'GET', `/product/styles/${seeded.styleId}`)).style
    expect(style).toMatchObject({ code: 'SEED-JKT-01', ppeStandard: 'EN 17092-3:2020', ppeClass: 'AA', matrix: { generated: true, missing: 0 } })
    const patched = (await ok('seeded', 'PATCH', `/product/styles/${seeded.styleId}`, { version: style.version, name: 'Seed leather jacket (edited)' })).style
    expect(patched).toMatchObject({ name: 'Seed leather jacket (edited)', ppeClass: 'AA', version: style.version + 1 })
  })
})
