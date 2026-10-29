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
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * The BOM of a style revision on the local stack (B-W1-13; features PRD-043, PRD-076, PRD-079, PRD-082, PRD-100), with
 * the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login, so row-level
 * security and the …_product_guards triggers are real), the product seed's jacket (leather in ft² per size with hide
 * wastage, lining in metres, protectors per piece) and sessions from the test authenticator. Every code and name is
 * made up. Run with `node scripts/factory/run-pg-tests.mjs bom`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'bom-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const companyB = seedId('company:B')
const jacket = seedId('product:style:JKT-01')
const revision1 = seedId('product:revision:JKT-01:1')
const scale = seedId('product:size-scale:EU-JKT')
const leather = seedId('product:item:leather')
const lining = seedId('product:item:lining')
const protector = seedId('product:item:protector')
const leatherBLK = seedId('product:item-colour:leather:BLK')
const leatherRED = seedId('product:item-colour:leather:RED')
const liningGRY = seedId('product:item-colour:lining:GRY')
const BLK = seedId('product:colourway:JKT-01:BLK')
const RED = seedId('product:colourway:JKT-01:RED')
const brandP1 = seedId('party:P1')
const supplierP2 = seedId('party:P2')
const line10 = seedId('product:bom:JKT-01:1:10')
const line30 = seedId('product:bom:JKT-01:1:30')
const otherTenant = newId()
const archivedMaterial = newId()
const companyBMaterial = newId()

const VIEW = 'product.bom.view'
const MANAGE = 'product.bom.manage'
const RELEASE = 'product.bom.release'
const STYLES: Permission[] = ['product.styles.view', 'product.styles.manage']
const ROUTING: Permission[] = ['product.routing.view', 'product.routing.manage']
const CUT = seedId('product:operation:CUT')
const QC = seedId('product:operation:QC')

interface Person {
  readonly tenantId: string
  readonly permissions: readonly Permission[]
  readonly companies: ScopeSet
}
const PEOPLE: Record<string, Person> = {
  maker: { tenantId: tenant, permissions: [VIEW, MANAGE, RELEASE, ...STYLES, 'product.materials.view', 'product.materials.manage', 'audit.read'], companies: 'all' },
  developer: { tenantId: tenant, permissions: [VIEW, MANAGE], companies: 'all' },
  viewer: { tenantId: tenant, permissions: [VIEW], companies: 'all' },
  companyA: { tenantId: tenant, permissions: [VIEW, MANAGE, RELEASE, ...STYLES, ...ROUTING], companies: [companyA] },
  companyB: { tenantId: tenant, permissions: [VIEW, MANAGE, RELEASE], companies: [companyB] },
  stylesOnly: { tenantId: tenant, permissions: STYLES, companies: 'all' },
  otherTenant: { tenantId: otherTenant, permissions: [VIEW, MANAGE, RELEASE], companies: 'all' },
}
const ACTORS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions], companies: person.companies, sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: person.tenantId, actorId: ACTORS[key]!, grants: [grant] }]
  }),
)

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
const eventsOf = async (subject: string) => admin<{ type: string; payload: Json }>('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])
const historyOf = async (recordType: string, id: string): Promise<any[]> => (await ok('maker', 'GET', `/audit/${recordType}/${id}`)).entries
const bomUrl = (styleId: string, revisionId: string) => `/product/styles/${styleId}/revisions/${revisionId}`
const getBom = async (styleId: string, revisionId: string, session = 'maker'): Promise<Json> => (await ok(session, 'GET', `${bomUrl(styleId, revisionId)}/bom`)).bom
const lineOf = (bom: Json, itemId: string): Json => bom.lines.find((line: Json) => line.item.id === itemId)
const needOf = (bom: Json, colourwayId: string, itemId: string): Json => bom.requirements.find((entry: Json) => entry.colourwayId === colourwayId).materials.find((entry: Json) => entry.itemId === itemId)

/** The seed jacket's figures per garment: leather 43/45/47.5 ft² + 12 %, lining 1.8 m + 5 %, two protectors. */
const LEATHER_BY_SIZE = [
  { size: '50', qty: '43', gross: '48.16', base: '48.16' },
  { size: '52', qty: '45', gross: '50.4', base: '50.4' },
  { size: '54', qty: '47.5', gross: '53.2', base: '53.2' },
]

beforeAll(async () => {
  db = await migratedDatabase('bom')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 16 } })
  await seedCore({ db: database, namespace: NS })
  await seedProduct({ db: database, namespace: NS })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [otherTenant, 'bom-other'])
  await admin(
    `INSERT INTO "Item" (id, "tenantId", "companyId", code, name, kind, "baseUom", "purchaseUom", "consumptionUom", status) VALUES
       ($1, $3, NULL, 'OLD-TRIM-1', 'Old snap (made up)', 'TRIM', 'PCS', 'PCS', 'PCS', 'ARCHIVED'),
       ($2, $3, $4, 'B-ZIP-1', 'Company B zip (made up)', 'TRIM', 'PCS', 'PCS', 'PCS', 'ACTIVE')`,
    [archivedMaterial, companyBMaterial, tenant, companyB],
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

describe("the seed jacket's BOM (PRD-076, PRD-079, PRD-082, PRD-043)", () => {
  it('shows leather in ft² per size with 12 % hide wastage, lining in metres, protectors per piece, and what each size needs', async () => {
    const bom = await getBom(jacket, revision1)
    expect(bom.revision).toMatchObject({ id: revision1, revision: 1, status: 'DRAFT', plannedHideYieldPct: '75', version: 1 })
    expect(bom.style).toMatchObject({ code: 'SEED-JKT-01', companyId: null, status: 'DRAFT', baseSize: '52' })
    expect(bom.sizes.map((size: Json) => size.code)).toEqual(['50', '52', '54'])
    expect(bom.colourways.map((colourway: Json) => colourway.code)).toEqual(['BLK', 'RED'])
    expect(bom.lines.map((line: Json) => [line.seq, line.item.code, line.uom, line.qty, line.wastagePct])).toEqual([
      [10, 'SEED-LEA-100', 'FT2', '45', '12'],
      [20, 'SEED-LIN-200', 'M', '1.8', '5'],
      [30, 'SEED-PRO-300', 'PCS', '2', '0'],
    ])
    const leatherLine = lineOf(bom, leather)
    expect(leatherLine).toMatchObject({ sizeDependent: true, colourDependent: true, placement: 'Outer shell', item: { kind: 'LEATHER', baseUom: 'FT2', status: 'ACTIVE' } })
    expect(leatherLine.sizes).toEqual([
      { size: '50', qty: '43' },
      { size: '52', qty: '45' },
      { size: '54', qty: '47.5' },
    ])
    expect(leatherLine.colours.map((cell: Json) => [cell.colourwayId, cell.itemColour.code])).toEqual([
      [BLK, 'BLK'],
      [RED, 'RED'],
    ])
    expect(leatherLine.bySize).toEqual(LEATHER_BY_SIZE)
    expect(lineOf(bom, lining)).toMatchObject({ itemColour: { id: liningGRY, code: 'GRY', status: 'ACTIVE' }, bySize: ['50', '52', '54'].map((size) => ({ size, qty: '1.8', gross: '1.89', base: '1.89' })) })
    expect(lineOf(bom, protector).bySize[0]).toEqual({ size: '50', qty: '2', gross: '2', base: '2' })

    // Per colourway: the leather in its colour, the grey lining and two protectors, in each material's stock unit.
    expect(needOf(bom, BLK, leather)).toEqual({ itemId: leather, code: 'SEED-LEA-100', itemColourId: leatherBLK, itemColourCode: 'BLK', uom: 'FT2', bySize: LEATHER_BY_SIZE.map(({ size, base }) => ({ size, qty: base })) })
    expect(needOf(bom, RED, leather)).toMatchObject({ itemColourId: leatherRED, itemColourCode: 'RED' })
    expect(needOf(bom, RED, lining)).toMatchObject({ itemColourId: liningGRY, uom: 'M', bySize: [{ size: '50', qty: '1.89' }, { size: '52', qty: '1.89' }, { size: '54', qty: '1.89' }] })
    expect(needOf(bom, BLK, protector)).toMatchObject({ itemColourId: null, uom: 'PCS', bySize: [{ size: '50', qty: '2' }, { size: '52', qty: '2' }, { size: '54', qty: '2' }] })
    expect(bom).toMatchObject({ issues: [], warnings: [], releasable: true })
  })
})

let jacket2: string
let draft2: string

describe('a BOM built through the API (PRD-076, PRD-100)', () => {
  it('adds leather per size and colourway, lining and protectors to a new style revision, each change versioned and audited', async () => {
    const style = (
      await ok(
        'companyA',
        'POST',
        '/product/styles',
        { companyId: companyA, code: 'BOM-JKT-02', name: 'Jacket two (made up)', productType: 'JACKET', sizeScaleId: scale, sizes: ['50', '52', '54'], baseSize: '52', colourways: [{ code: 'BLK', name: 'Black' }, { code: 'RED', name: 'Red' }] },
        201,
      )
    ).style
    jacket2 = style.id
    const [black, red] = style.colourways.map((colourway: Json) => colourway.id)
    draft2 = (await ok('companyA', 'POST', `/product/styles/${jacket2}/revisions`, { changeNote: 'First cut (made up).' }, 201)).revision.id
    const url = `${bomUrl(jacket2, draft2)}/bom/lines`

    let bom = (
      await ok(
        'companyA',
        'POST',
        url,
        {
          version: 1,
          itemId: leather,
          placement: 'Outer shell',
          uom: 'FT2',
          wastagePct: '12',
          sizeDependent: true,
          sizes: [{ size: '54', qty: '47.5' }, { size: '50', qty: '43' }, { size: '52', qty: '45.0' }],
          colourDependent: true,
          colours: [{ colourwayId: black, itemColourId: leatherBLK }, { colourwayId: red, itemColourId: leatherRED }],
        },
        201,
      )
    ).bom
    expect(bom.revision.version).toBe(2)
    expect(bom.lines[0]).toMatchObject({ seq: 10, qty: '45', sizes: [{ size: '50', qty: '43' }, { size: '52', qty: '45' }, { size: '54', qty: '47.5' }], bySize: LEATHER_BY_SIZE })
    bom = (await ok('companyA', 'POST', url, { version: 2, itemId: lining, placement: 'Body lining', qty: '1.8', wastagePct: '5', itemColourId: liningGRY }, 201)).bom
    // The lining's consumption unit (metres) is taken when no unit is sent.
    expect(lineOf(bom, lining)).toMatchObject({ seq: 20, uom: 'M', qty: '1.8' })
    bom = (await ok('companyA', 'POST', url, { version: 3, itemId: protector, placement: 'Shoulder pockets', qty: '2', supplierId: supplierP2 }, 201)).bom
    expect(lineOf(bom, protector)).toMatchObject({ seq: 30, uom: 'PCS', supplier: { id: supplierP2 } })
    expect(needOf(bom, red, leather).bySize).toEqual(LEATHER_BY_SIZE.map(({ size, base }) => ({ size, qty: base })))
    // Hide wastage without a planned yield is pointed out, never refused.
    // The BOM is complete; the revision is not releasable until its routing has a step (below).
    expect(bom).toMatchObject({ issues: [{ code: 'NO_STEPS' }], releasable: false, warnings: [{ code: 'NO_PLANNED_HIDE_YIELD', lineId: null }] })
    bom = (await ok('companyA', 'PATCH', bomUrl(jacket2, draft2), { version: 4, plannedHideYieldPct: '75.5' })).bom
    expect(bom).toMatchObject({ revision: { plannedHideYieldPct: '75.5', version: 5 }, warnings: [] })

    const leatherLine = lineOf(bom, leather).id
    expect((await historyOf('BomLine', leatherLine))[0]).toMatchObject({ action: 'product.bom.addLine', after: { itemId: leather, wastagePct: '12', sizes: { '50': '43', '52': '45', '54': '47.5' } } })
    expect((await historyOf('StyleRevision', draft2)).map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['product.bom.addLine', 'product.bom.updateRevision', 'product.styles.createRevision']),
    )
    const events = (await eventsOf(jacket2)).filter((event) => event.type === 'style.bom_changed')
    expect(events).toHaveLength(4)
    expect(events[0]!.payload).toEqual({ styleId: jacket2, code: 'BOM-JKT-02', revisionId: draft2, revision: 1, lineIds: [leatherLine] })
  })

  it('refuses at once a material, unit, wastage, size, colour or supplier that does not fit, and a stale version', async () => {
    const url = `${bomUrl(jacket2, draft2)}/bom/lines`
    const version = (await getBom(jacket2, draft2)).revision.version
    const issues = async (body: Json) => (await refused('companyA', 'POST', url, { version, ...body }, 400)).issues
    expect(await issues({ itemId: archivedMaterial, qty: '1' })).toEqual([{ path: 'body/itemId', message: 'OLD-TRIM-1 is archived: choose an active material.' }])
    expect(await issues({ itemId: companyBMaterial, qty: '1' })).toEqual([{ path: 'body/itemId', message: "This material belongs to another company than the style's." }])
    expect(await issues({ itemId: newId(), qty: '1' })).toEqual([{ path: 'body/itemId', message: 'No such material.' }])
    expect(await issues({ itemId: lining, uom: 'FT2', qty: '1', wastagePct: '61', itemColourId: liningGRY })).toEqual([
      { path: 'body/uom', message: 'SEED-LIN-200 does not convert ft² to its base unit m: use M, CM, MM, ROLL.' },
      { path: 'body/wastagePct', message: 'Wastage is 0 to 60 %.' },
    ])
    expect(await issues({ itemId: leather, sizeDependent: true, sizes: [{ size: '56', qty: '50' }], colourDependent: true })).toEqual([{ path: 'body/sizes/56', message: "Size 56 is not in the style's range (50, 52, 54)." }])
    expect(await issues({ itemId: lining, qty: '1', itemColourId: leatherBLK })).toEqual([{ path: 'body/itemColourId', message: 'Not a colour of SEED-LIN-200.' }])
    expect(await issues({ itemId: protector, qty: '1', supplierId: brandP1 })).toEqual([{ path: 'body/supplierId', message: 'This party is not a supplier.' }])
    expect((await refused('companyA', 'POST', url, { version, itemId: protector, qty: '1', seq: 10 }, 409)).message).toBe('Place 10 is taken by another line of this BOM: choose another.')
    const stale = await refused('companyA', 'POST', url, { version: version - 1, itemId: protector, qty: '1' }, 409)
    expect(stale).toMatchObject({ code: 'conflict', issues: [{ path: 'version', message: `The current version is ${version}.` }] })
    expect((await refused('companyA', 'PATCH', `${url}/${newId()}`, { version, qty: '1' }, 404)).message).toBe('BOM line not found.')
    // A line of another revision is not found here.
    expect((await refused('companyA', 'PATCH', `${url}/${line10}`, { version, qty: '1' }, 404)).message).toBe('BOM line not found.')
    expect((await getBom(jacket2, draft2)).revision.version).toBe(version)
  })
})

describe('the release check of the BOM view (B-W1-14)', () => {
  it('is the release\'s own: a complete BOM without a routing is not releasable, and the view lists the routing\'s issue the release refuses', async () => {
    const bom = await getBom(jacket2, draft2)
    expect(bom.lines.map((line: Json) => line.item.id)).toEqual([leather, lining, protector])
    expect(bom.issues).toEqual([{ code: 'NO_STEPS', lineId: null, size: null, colourwayId: null, stepId: null, message: 'The routing has no operation yet.' }])
    expect(bom.releasable).toBe(false)
    const refusal = await refused('companyA', 'POST', `${bomUrl(jacket2, draft2)}/release`, { version: bom.revision.version }, 409)
    expect(refusal).toMatchObject({ code: 'invalid_state', message: 'The routing is not ready to release: 1 problem(s) to fix first.', issues: [{ path: 'routing/NO_STEPS', message: bom.issues[0].message }] })
  })
})

describe('the colour grid and the quantity per size before a release (PRD-043, PRD-079)', () => {
  it('blocks the release until every active colourway has a colour and every size a quantity', async () => {
    const green = (await ok('companyA', 'POST', `/product/styles/${jacket2}/colourways`, { code: 'GRN', name: 'Green' }, 201)).style.colourways.find((colourway: Json) => colourway.code === 'GRN').id
    let bom = await getBom(jacket2, draft2)
    const leatherLine = lineOf(bom, leather).id
    expect(bom.releasable).toBe(false)
    expect(bom.issues).toEqual([{ code: 'COLOUR_MISSING', lineId: leatherLine, size: null, colourwayId: green, stepId: null, message: 'Line 10 (SEED-LEA-100): no SEED-LEA-100 colour for colourway GRN.' }, { code: 'NO_STEPS', lineId: null, size: null, colourwayId: null, stepId: null, message: 'The routing has no operation yet.' }])
    expect(bom.requirements.find((entry: Json) => entry.colourwayId === green).materials.map((entry: Json) => entry.code)).toEqual(['SEED-LIN-200', 'SEED-PRO-300'])
    const refusal = await refused('companyA', 'POST', `${bomUrl(jacket2, draft2)}/release`, { version: bom.revision.version }, 409)
    // Every blocker at once: the BOM's and the routing's (it has no step yet).
    expect(refusal).toMatchObject({
      code: 'invalid_state',
      message: 'The BOM and the routing are not ready to release: 2 problem(s) to fix first.',
      issues: [{ path: `lines/${leatherLine}/colours/${green}` }, { path: 'routing/NO_STEPS', message: 'The routing has no operation yet.' }],
    })

    const lineUrl = `${bomUrl(jacket2, draft2)}/bom/lines/${leatherLine}`
    bom = (await ok('companyA', 'PUT', `${lineUrl}/colours`, { version: bom.revision.version, colours: [{ colourwayId: green, itemColourId: leatherRED }] })).bom
    expect(lineOf(bom, leather).colours.map((cell: Json) => cell.itemColour.code)).toEqual(['BLK', 'RED', 'RED'])
    // A size cleared is missing; 0 says the size does not use the line.
    bom = (await ok('companyA', 'PUT', `${lineUrl}/sizes`, { version: bom.revision.version, sizes: [{ size: '54', qty: null }] })).bom
    expect(bom.issues.map((issue: Json) => [issue.code, issue.size])).toEqual([['SIZE_QUANTITY_MISSING', '54'], ['NO_STEPS', null]])
    expect(lineOf(bom, leather).bySize[2]).toEqual({ size: '54', qty: null, gross: null, base: null })
    bom = (await ok('companyA', 'PUT', `${lineUrl}/sizes`, { version: bom.revision.version, sizes: [{ size: '54', qty: '47.5' }] })).bom
    expect(bom).toMatchObject({ issues: [{ code: 'NO_STEPS' }], releasable: false })
    expect(await admin('SELECT count(*)::int AS n FROM "BomLineColour" WHERE "bomLineId" = $1', [leatherLine])).toEqual([{ n: 3 }])
  })

  it('removes a line, and a line that stops depending on size or colour keeps only its one quantity and colour', async () => {
    let bom = await getBom(jacket2, draft2)
    const leatherLine = lineOf(bom, leather).id
    const lineUrl = `${bomUrl(jacket2, draft2)}/bom/lines/${leatherLine}`
    bom = (await ok('companyA', 'PATCH', lineUrl, { version: bom.revision.version, sizeDependent: false, colourDependent: false, itemColourId: leatherBLK })).bom
    expect(lineOf(bom, leather)).toMatchObject({ sizeDependent: false, colourDependent: false, qty: '45', itemColour: { code: 'BLK' }, sizes: [], colours: [] })
    expect(await admin('SELECT (SELECT count(*)::int FROM "BomLineSize" WHERE "bomLineId" = $1) AS sizes, (SELECT count(*)::int FROM "BomLineColour" WHERE "bomLineId" = $1) AS cells', [leatherLine])).toEqual([{ sizes: 0, cells: 0 }])
    // And back: every size gets the one quantity, every active colourway the one colour, to be edited.
    bom = (await ok('companyA', 'PATCH', lineUrl, { version: bom.revision.version, sizeDependent: true, colourDependent: true })).bom
    expect(lineOf(bom, leather).sizes).toEqual([{ size: '50', qty: '45' }, { size: '52', qty: '45' }, { size: '54', qty: '45' }])
    expect(lineOf(bom, leather).colours.map((cell: Json) => cell.itemColour.code)).toEqual(['BLK', 'BLK', 'BLK'])
    bom = (await ok('companyA', 'PUT', `${lineUrl}/sizes`, { version: bom.revision.version, sizes: [{ size: '50', qty: '43' }, { size: '54', qty: '47.5' }] })).bom

    const zip = (await ok('companyA', 'POST', `${bomUrl(jacket2, draft2)}/bom/lines`, { version: bom.revision.version, itemId: protector, qty: '1', placement: 'Spare (made up)' }, 201)).bom
    const spare = zip.lines.find((line: Json) => line.placement === 'Spare (made up)').id
    bom = (await ok('companyA', 'DELETE', `${bomUrl(jacket2, draft2)}/bom/lines/${spare}?version=${zip.revision.version}`)).bom
    expect(bom.lines.map((line: Json) => line.placement)).toEqual(['Outer shell', 'Body lining', 'Shoulder pockets'])
    expect((await historyOf('BomLine', spare))[0]).toMatchObject({ action: 'product.bom.removeLine', before: { placement: 'Spare (made up)' }, after: { removed: true } })
  })
})

describe('release (A1 §2.5; the PPE technical file a work order is made from, Reg. (EU) 2016/425 art. 8(3))', () => {
  it('releases the draft, makes the style active, and the database refuses any change to its BOM for every login', async () => {
    let bom = await getBom(jacket2, draft2)
    // A complete BOM is not enough: a work order is released with one operation per routing step (B-W1-14).
    expect(bom).toMatchObject({ issues: [{ code: 'NO_STEPS', stepId: null }], releasable: false })
    expect(await refused('companyA', 'POST', `${bomUrl(jacket2, draft2)}/release`, { version: bom.revision.version }, 409)).toMatchObject({
      code: 'invalid_state',
      message: 'The routing is not ready to release: 1 problem(s) to fix first.',
      issues: [{ path: 'routing/NO_STEPS', message: 'The routing has no operation yet.' }],
    })
    await ok('companyA', 'POST', `${bomUrl(jacket2, draft2)}/routing/steps`, { version: bom.revision.version, operations: [{ operationId: CUT }, { operationId: QC }] }, 201)
    bom = await getBom(jacket2, draft2)
    expect(bom).toMatchObject({ issues: [], releasable: true })
    expect((await refused('developer', 'POST', `${bomUrl(jacket2, draft2)}/release`, { version: bom.revision.version }, 403)).code).toBe('forbidden')
    bom = (await ok('companyA', 'POST', `${bomUrl(jacket2, draft2)}/release`, { version: bom.revision.version, changeNote: 'Ready for the sample (made up).' })).bom
    expect(bom.revision).toMatchObject({ status: 'RELEASED', changeNote: 'Ready for the sample (made up).', releasedById: ACTORS.companyA! })
    expect(bom).toMatchObject({ style: { status: 'ACTIVE' }, issues: [], warnings: [], releasable: false })
    expect((await eventsOf(jacket2)).map((event) => event.type).slice(-2)).toEqual(['style.status_changed', 'style.revision_released'])

    // The API answers first, with what to do instead.
    const version = bom.revision.version
    const leatherLine = lineOf(bom, leather).id
    const frozen = 'Revision 1 is released: its BOM is frozen. Copy it into a new draft to change it.'
    expect(await refused('companyA', 'POST', `${bomUrl(jacket2, draft2)}/bom/lines`, { version, itemId: protector, qty: '1' }, 409)).toMatchObject({ code: 'invalid_state', message: frozen })
    expect((await refused('companyA', 'PUT', `${bomUrl(jacket2, draft2)}/bom/lines/${leatherLine}/sizes`, { version, sizes: [{ size: '50', qty: '40' }] }, 409)).message).toBe(frozen)
    expect((await refused('companyA', 'DELETE', `${bomUrl(jacket2, draft2)}/bom/lines/${leatherLine}?version=${version}`, undefined, 409)).message).toBe(frozen)
    expect((await refused('companyA', 'PATCH', bomUrl(jacket2, draft2), { version, plannedHideYieldPct: '80' }, 409)).message).toBe(frozen)
    expect((await refused('companyA', 'POST', `${bomUrl(jacket2, draft2)}/release`, { version }, 409)).message).toBe('Revision 1 is released: only a draft is released.')

    // The database: the runtime login and the owner alike.
    const runtime = (sql: string) =>
      database.withScope({ audience: 'office', tenantId: tenant, actorId: ACTORS.companyA! }, (client) => client.$executeRawUnsafe(sql, draft2))
    await expect(runtime('UPDATE "BomLineSize" SET qty = qty + 1 WHERE "revisionId" = $1::uuid')).rejects.toThrow(/never change, a change is a new revision/)
    await expect(runtime('DELETE FROM "BomLineColour" WHERE "revisionId" = $1::uuid')).rejects.toThrow(/never change, a change is a new revision/)
    await expect(admin('UPDATE "BomLine" SET "wastagePct" = 0 WHERE "revisionId" = $1', [draft2])).rejects.toThrow(/never change, a change is a new revision/)
    await expect(admin('UPDATE "StyleRevision" SET "plannedHideYieldPct" = 90 WHERE id = $1', [draft2])).rejects.toThrow(/it never changes, a change is a new revision/)
    expect((await getBom(jacket2, draft2)).lines[0].bySize).toEqual(LEATHER_BY_SIZE)
  })

  it("gives the office runtime role DELETE on a draft's parts only (the trigger refuses a released one's) and the floor none", async () => {
    // The grants as the policy migration gives them (ownership/product.json).
    const PARTS = ['BomLine', 'BomLineSize', 'BomLineColour', 'RoutingOperation']
    expect(
      await admin(
        `SELECT t AS "table", has_table_privilege('factory_runtime', format('public.%I', t), 'DELETE') AS office, has_table_privilege('factory_floor_runtime', format('public.%I', t), 'DELETE') AS floor
           FROM unnest($1::text[]) AS t`,
        [PARTS],
      ),
    ).toEqual(PARTS.map((table) => ({ table, office: true, floor: false })))

    const released = await getBom(jacket2, draft2)
    const draft = (await ok('companyA', 'POST', `${bomUrl(jacket2, draft2)}/copy`, {}, 201)).bom
    const office = (sql: string, id: string) => database.withScope({ audience: 'office', tenantId: tenant, actorId: ACTORS.companyA! }, (client) => client.$executeRawUnsafe(sql, id))
    const floor = (sql: string, id: string) =>
      database.withScope({ audience: 'floor', tenantId: tenant, actorId: newId(), siteId: seedId('site:A1') }, (client) => client.$executeRawUnsafe(sql, id))
    const frozen = /rows never change, a change is a new revision/

    await expect(floor('DELETE FROM "BomLine" WHERE id = $1::uuid', lineOf(draft, protector).id)).rejects.toThrow(/permission denied for table BomLine/)
    await expect(office('DELETE FROM "BomLine" WHERE id = $1::uuid', lineOf(released, protector).id)).rejects.toThrow(frozen)
    await expect(office('DELETE FROM "BomLineSize" WHERE "bomLineId" = $1::uuid', lineOf(released, leather).id)).rejects.toThrow(frozen)
    await expect(office('DELETE FROM "BomLineColour" WHERE "bomLineId" = $1::uuid', lineOf(released, leather).id)).rejects.toThrow(frozen)
    expect(await office('DELETE FROM "BomLineColour" WHERE "bomLineId" = $1::uuid', lineOf(draft, leather).id)).toBe(3)
    expect(await office('DELETE FROM "BomLine" WHERE id = $1::uuid', lineOf(draft, protector).id)).toBe(1)
    expect((await getBom(jacket2, draft.revision.id)).lines.map((line: Json) => line.item.id)).toEqual([leather, lining])
    expect((await getBom(jacket2, draft2)).lines).toHaveLength(3)
    // The draft is abandoned: the style keeps one open draft at most.
    await ok('companyA', 'POST', `${bomUrl(jacket2, draft.revision.id)}/obsolete`, { version: draft.revision.version })
  })

  it('copies the released revision into a new draft, compares them, and releasing the new one makes the old one obsolete', async () => {
    const base = (await ok('maker', 'POST', `${bomUrl(jacket, revision1)}/release`, { version: (await getBom(jacket, revision1)).revision.version })).bom
    expect(base.revision.status).toBe('RELEASED')
    expect((await refused('maker', 'POST', `${bomUrl(jacket, revision1)}/obsolete`, { version: base.revision.version }, 409)).message).toBe(
      "Revision 1 is the active style's current specification: release the revision that replaces it, or archive the style first.",
    )

    let copy = (await ok('developer', 'POST', `${bomUrl(jacket, revision1)}/copy`, { changeNote: 'More wastage, a bigger 52 (made up).' }, 201)).bom
    const revision2 = copy.revision.id
    expect(copy.revision).toMatchObject({ revision: 2, status: 'DRAFT', plannedHideYieldPct: '75', changeNote: 'More wastage, a bigger 52 (made up).', version: 1 })
    expect(copy.lines.map((line: Json) => [line.seq, line.item.code, line.qty])).toEqual(base.lines.map((line: Json) => [line.seq, line.item.code, line.qty]))
    expect(copy.lines.map((line: Json) => line.id)).not.toContain(line10)
    expect(lineOf(copy, leather).bySize).toEqual(LEATHER_BY_SIZE)
    expect(copy).toMatchObject({ issues: [], releasable: true })
    // The routing travels with the revision.
    expect(await admin('SELECT code, seq, "standardMinutes"::text AS minutes FROM "RoutingOperation" WHERE "revisionId" = $1 ORDER BY seq', [revision2])).toEqual(
      await admin('SELECT code, seq, "standardMinutes"::text AS minutes FROM "RoutingOperation" WHERE "revisionId" = $1 ORDER BY seq', [revision1]),
    )
    expect((await refused('developer', 'POST', `${bomUrl(jacket, revision1)}/copy`, {}, 409)).message).toBe('Revision 2 is still a draft: change it, or release or abandon it, before starting another.')
    expect((await refused('developer', 'POST', `${bomUrl(jacket, revision2)}/copy`, {}, 409)).message).toBe('Revision 2 is a draft: change it in place; only a frozen revision is copied.')

    const leatherLine = lineOf(copy, leather).id
    const lineUrl = `${bomUrl(jacket, revision2)}/bom/lines`
    copy = (await ok('developer', 'PATCH', `${lineUrl}/${leatherLine}`, { version: copy.revision.version, wastagePct: '15', sizes: [{ size: '52', qty: '46' }] })).bom
    copy = (await ok('developer', 'DELETE', `${lineUrl}/${lineOf(copy, protector).id}?version=${copy.revision.version}`)).bom
    const diff = (await ok('viewer', 'GET', `/product/styles/${jacket}/bom/compare?from=${revision1}&to=${revision2}`)).diff
    expect(diff).toMatchObject({
      from: { id: revision1, revision: 1, status: 'RELEASED' },
      to: { id: revision2, revision: 2, status: 'DRAFT' },
      revision: [],
      added: [],
      removed: [{ lineId: line30, code: 'SEED-PRO-300', placement: 'Shoulder pockets' }],
      changed: [{ from: { lineId: line10 }, to: { lineId: leatherLine }, fields: [{ field: 'wastagePct', from: '12', to: '15' }], sizes: [{ size: '52', from: '45', to: '46' }], colours: [] }],
      unchanged: 1,
    })
    expect(lineOf(copy, leather).bySize[1]).toEqual({ size: '52', qty: '46', gross: '52.9', base: '52.9' })

    const released = (await ok('maker', 'POST', `${bomUrl(jacket, revision2)}/release`, { version: copy.revision.version })).bom
    expect(released.revision).toMatchObject({ revision: 2, status: 'RELEASED' })
    expect(await admin('SELECT revision, status FROM "StyleRevision" WHERE "styleId" = $1 ORDER BY revision', [jacket])).toEqual([
      { revision: 1, status: 'OBSOLETE' },
      { revision: 2, status: 'RELEASED' },
    ])
    expect((await eventsOf(jacket)).filter((event) => event.type === 'style.revision_released').map((event) => event.payload.obsoletedRevisionId)).toEqual([null, revision1])
    // A frozen BOM shows no issues: it is not checked again.
    expect((await getBom(jacket, revision1)).revision.status).toBe('OBSOLETE')

    // A draft is abandoned at any time.
    const abandoned = (await ok('developer', 'POST', `${bomUrl(jacket, revision2)}/copy`, {}, 201)).bom
    const gone = (await ok('developer', 'POST', `${bomUrl(jacket, abandoned.revision.id)}/obsolete`, { version: abandoned.revision.version, reason: 'Not needed (made up).' })).bom
    expect(gone.revision).toMatchObject({ revision: 3, status: 'OBSOLETE' })
    expect((await historyOf('StyleRevision', abandoned.revision.id))[0]).toMatchObject({ action: 'product.bom.obsolete', reason: 'Not needed (made up).', after: { status: 'OBSOLETE' } })
  })
  it('withdraws the released revision only while the style is not active, and only with the release permission', async () => {
    const [current] = await admin<{ id: string; version: number }>(`SELECT id, version FROM "StyleRevision" WHERE "styleId" = $1 AND status = 'RELEASED'`, [jacket])
    const style = (await ok('maker', 'GET', `/product/styles/${jacket}`)).style
    expect(style.status).toBe('ACTIVE')
    await ok('maker', 'POST', `/product/styles/${jacket}/archive`, { version: style.version, reason: 'Season over (made up).' })
    expect((await refused('developer', 'POST', `${bomUrl(jacket, current!.id)}/obsolete`, { version: current!.version }, 403)).code).toBe('forbidden')
    const withdrawn = (await ok('maker', 'POST', `${bomUrl(jacket, current!.id)}/obsolete`, { version: current!.version, reason: 'Withdrawn (made up).' })).bom
    expect(withdrawn).toMatchObject({ revision: { status: 'OBSOLETE' }, style: { status: 'ARCHIVED' }, issues: [], releasable: false })
    expect((await eventsOf(jacket)).at(-1)).toMatchObject({ type: 'style.revision_obsoleted', payload: { revisionId: current!.id, from: 'RELEASED' } })
    // Without a released revision the style comes back as a draft.
    const archived = (await ok('maker', 'GET', `/product/styles/${jacket}`)).style
    expect((await ok('maker', 'POST', `/product/styles/${jacket}/reactivate`, { version: archived.version })).style.status).toBe('DRAFT')
  })
})

describe('the tenant and company walls', () => {
  it('shows a BOM only inside the tenant and the companies a grant reaches; a style for every company is changed only by a grant over every company', async () => {
    expect((await refused('otherTenant', 'POST', `${bomUrl(jacket2, draft2)}/release`, { version: 1 }, 404)).message).toBe('Style not found.')
    expect((await call('otherTenant', 'GET', `${bomUrl(jacket, revision1)}/bom`)).statusCode).toBe(404)
    expect((await call('companyB', 'GET', `${bomUrl(jacket2, draft2)}/bom`)).statusCode).toBe(404)
    expect((await call('companyB', 'GET', `${bomUrl(jacket, revision1)}/bom`)).statusCode).toBe(200)
    const copy = await call('companyA', 'POST', `${bomUrl(jacket, revision1)}/copy`, {})
    expect(copy.statusCode, copy.body).toBe(403)
    expect(copy.json().error.message).toBe('The BOM of a style for every company is changed only by a role over every company.')
    // Without the BOM permission, the styles routes' revisions are no way into it.
    expect((await call('stylesOnly', 'GET', `${bomUrl(jacket, revision1)}/bom`)).statusCode).toBe(403)
    expect((await call('viewer', 'POST', `${bomUrl(jacket2, draft2)}/copy`, {})).statusCode).toBe(403)
    // A revision of another style is not found under this one.
    expect((await call('maker', 'GET', `${bomUrl(jacket2, revision1)}/bom`)).statusCode).toBe(404)
  })
})

describe('concurrent edits of one revision', () => {
  /** Sends a write built from what it reads now, again after each 409, until it lands (at most 30 tries). */
  async function retrying(write: () => Promise<{ statusCode: number; body: string }>): Promise<number> {
    for (let attempt = 1; attempt <= 30; attempt++) {
      const response = await write()
      if (response.statusCode !== 409) {
        expect(response.statusCode, response.body).toBeLessThan(300)
        return attempt
      }
    }
    throw new Error('never landed')
  }

  it('serialise on the style row: one write of a version wins, the others get the current version, never a deadlock', async () => {
    const draft = (await ok('companyA', 'POST', `${bomUrl(jacket2, draft2)}/copy`, {}, 201)).bom
    const revisionId = draft.revision.id
    const lineUrl = `${bomUrl(jacket2, revisionId)}/bom/lines`
    const leatherLine = lineOf(draft, leather).id

    // Eight edits of one version at once: one lands, seven are told the version moved.
    const answers = await Promise.all(Array.from({ length: 8 }, (_, index) => call('companyA', 'PATCH', `${lineUrl}/${leatherLine}`, { version: draft.revision.version, wastagePct: String(10 + index) })))
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 409, 409, 409, 409, 409, 409, 409])
    for (const answer of answers.filter((entry) => entry.statusCode === 409)) expect(answer.json().error).toMatchObject({ code: 'conflict', issues: [{ path: 'version', message: `The current version is ${draft.revision.version + 1}.` }] })

    // Six writers that read again after a 409 all land, one after another, each at its own place.
    const start = (await getBom(jacket2, revisionId)).revision.version
    const adds = Array.from({ length: 6 }, (_, index) => () =>
      retrying(async () => call('companyA', 'POST', lineUrl, { version: (await getBom(jacket2, revisionId)).revision.version, itemId: protector, qty: '1', placement: `Pocket ${index} (made up)` })),
    )
    // Meanwhile the style's colourways and the leather itself change (styles and materials lock their own rows).
    const style = (await ok('maker', 'GET', `/product/styles/${jacket2}`)).style
    const green = style.colourways.find((colourway: Json) => colourway.code === 'GRN')
    const others = [
      () => retrying(async () => call('companyA', 'PATCH', `/product/styles/${jacket2}/colourways/${green.id}`, { version: (await ok('maker', 'GET', `/product/styles/${jacket2}`)).style.colourways.find((entry: Json) => entry.id === green.id).version, name: 'Green (renamed)' })),
      () => retrying(async () => call('maker', 'PATCH', `/product/materials/${leather}`, { version: (await ok('maker', 'GET', `/product/materials/${leather}`)).material.version, name: 'Seed cowhide 1.2 mm (renamed)' })),
    ]
    await Promise.all([...adds, ...others].map((run) => run()))
    const after = await getBom(jacket2, revisionId)
    expect(after.revision.version).toBe(start + 6)
    expect(after.lines.filter((line: Json) => line.placement?.startsWith('Pocket'))).toHaveLength(6)
    expect(new Set(after.lines.map((line: Json) => line.seq)).size).toBe(after.lines.length)

    // A release racing an edit of the same version: exactly one of them lands.
    const raced = await Promise.all([
      call('companyA', 'POST', `${bomUrl(jacket2, revisionId)}/release`, { version: after.revision.version }),
      call('companyA', 'PATCH', `${lineUrl}/${leatherLine}`, { version: after.revision.version, wastagePct: '20' }),
    ])
    expect(raced.map((answer) => answer.statusCode).sort()).toEqual([200, 409])
    const final = await getBom(jacket2, revisionId)
    expect(final.revision.status === 'RELEASED').toBe(raced[0]!.statusCode === 200)
    expect(lineOf(final, leather).wastagePct === '20').toBe(raced[1]!.statusCode === 200)
  })
})
