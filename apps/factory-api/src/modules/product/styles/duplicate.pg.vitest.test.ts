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
 * B-W2a-09 on the local stack, with the app's real routes: a style's customs and origin data (PRD-018), a subcontracted
 * routing step (PRD-120: workshop, fee per piece by the cost grain, transit days; frozen with its revision, carried by
 * a copied revision) and a copy of a style with the parts picked (PRD-011). A throwaway PostgreSQL 17 database from the
 * migrations (the runtime login: row-level security and the product triggers are real), the product seed's jacket and
 * sessions from the test authenticator. Every code, name and fee is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs duplicate`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'duplicate-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const jacket = seedId('product:style:JKT-01')
const revision1 = seedId('product:revision:JKT-01:1')
const SEW = seedId('product:routing:JKT-01:1:SEED-SEW-ASM')
const template = seedId('product:measurement-template:JACKET')
const otherTenant = newId()
const workshop = newId()
const blockedWorkshop = newId()
const supplierOnly = newId()

const STYLES: Permission[] = ['product.styles.view', 'product.styles.manage']
const BOM: Permission[] = ['product.bom.view', 'product.bom.manage', 'product.bom.release']
const ROUTING: Permission[] = ['product.routing.view', 'product.routing.manage']

interface Person {
  readonly tenantId: string
  readonly permissions: readonly Permission[]
  readonly companies: ScopeSet
}
const PEOPLE: Record<string, Person> = {
  // Product engineering with the cost grain: sets a workshop's fee.
  engineer: { tenantId: tenant, permissions: [...STYLES, ...BOM, ...ROUTING, 'compliance.labels.manage', 'audit.read', 'money.cost'], companies: 'all' },
  // A product developer without money.
  developer: { tenantId: tenant, permissions: [...STYLES, ...BOM, ...ROUTING], companies: 'all' },
  stylesOnly: { tenantId: tenant, permissions: STYLES, companies: 'all' },
  viewer: { tenantId: tenant, permissions: ['product.styles.view', 'product.bom.view', 'product.routing.view'], companies: 'all' },
  companyA: { tenantId: tenant, permissions: [...STYLES, ...BOM, ...ROUTING], companies: [companyA] },
  otherTenant: { tenantId: otherTenant, permissions: [...STYLES, ...BOM, ...ROUTING], companies: 'all' },
}
const ACTORS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions], companies: person.companies, sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: person.tenantId, actorId: ACTORS[key]!, grants: [grant] }]
  }),
)
// A floor device holding the routing's permissions: the routes are the office's only.
SESSIONS.floor = { audience: 'floor', tenantId: tenant, actorId: newId(), siteId: seedId('site:A1'), deviceId: newId(), grants: [{ permissions: [...ROUTING, 'floor.work'], companies: [companyA], sites: [seedId('site:A1')], parties: 'all' }] }

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, headers: Record<string, string> = {}): Promise<Json> {
  const response = await call(session, method, url, payload, headers)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const eventsOf = async (subject: string) => admin<{ type: string; payload: Json }>('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])
const historyOf = async (session: string, recordType: string, id: string): Promise<any[]> => (await ok(session, 'GET', `/audit/${recordType}/${id}`)).entries
const routingUrl = (styleId: string, revisionId: string) => `/product/styles/${styleId}/revisions/${revisionId}/routing`
const getRouting = async (styleId: string, revisionId: string, session = 'engineer'): Promise<Json> => (await ok(session, 'GET', routingUrl(styleId, revisionId))).routing
const stepOf = (routing: Json, code: string): Json => routing.steps.find((step: Json) => step.code === code)

beforeAll(async () => {
  db = await migratedDatabase('duplicate')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 16 } })
  await seedCore({ db: database, namespace: NS })
  await seedProduct({ db: database, namespace: NS })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [otherTenant, 'duplicate-other'])
  await admin(
    `INSERT INTO "Party" (id, "tenantId", code, kind, "legalName", "tradeName", roles, status) VALUES
       ($1, $4, 'TERZ-CUCI', 'ORGANISATION', 'Laboratorio Esempio S.n.c.', 'Lab Esempio', '{SUBCONTRACTOR}', 'ACTIVE'),
       ($2, $4, 'TERZ-OLD', 'ORGANISATION', 'Laboratorio Chiuso S.n.c.', NULL, '{SUBCONTRACTOR}', 'BLOCKED'),
       ($3, $4, 'FORN-ONLY', 'ORGANISATION', 'Fornitore Esempio S.r.l.', NULL, '{SUPPLIER}', 'ACTIVE')`,
    [workshop, blockedWorkshop, supplierOnly, tenant],
  )
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 120_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('customs and origin data on a style (PRD-018)', () => {
  it('keeps the commodity code as digits, the origin in capitals and the net mass, with an audit row and style.updated', async () => {
    const before = (await ok('viewer', 'GET', `/product/styles/${jacket}`)).style
    expect(before).toMatchObject({ hsCode: null, originCountry: null, netMassKg: null })
    const style = (await ok('engineer', 'PATCH', `/product/styles/${jacket}`, { version: before.version, hsCode: '4203.10 00', originCountry: 'it', netMassKg: '1.850' })).style
    expect(style).toMatchObject({ hsCode: '42031000', originCountry: 'IT', netMassKg: '1.85', version: before.version + 1 })
    expect((await ok('viewer', 'GET', '/product/styles?status=ALL')).styles.find((row: Json) => row.id === jacket)).toMatchObject({ hsCode: '42031000', originCountry: 'IT', netMassKg: '1.85' })
    const update = (await eventsOf(jacket)).filter((event) => event.type === 'style.updated').at(-1)
    expect(update?.payload).toEqual({ styleId: jacket, code: 'SEED-JKT-01', fields: ['hsCode', 'originCountry', 'netMassKg'] })
    const entry = (await historyOf('engineer', 'Style', jacket)).find((row) => row.after?.hsCode === '42031000')
    expect(entry).toMatchObject({ before: { hsCode: null, originCountry: null, netMassKg: null }, after: { hsCode: '42031000', originCountry: 'IT', netMassKg: '1.85' } })
  })

  it('refuses a code of the wrong length or chapter, the EU as an origin and a mass of 0, in words, before the database', async () => {
    const { version } = (await ok('viewer', 'GET', `/product/styles/${jacket}`)).style
    const refusal = await refused('engineer', 'PATCH', `/product/styles/${jacket}`, { version, hsCode: '42031', originCountry: 'EU', netMassKg: '0' }, 400)
    expect(refusal.issues).toEqual([
      { path: 'body/hsCode', message: 'Expected the commodity code of 6 (HS), 8 (CN) or 10 (TARIC) digits.' },
      { path: 'body/originCountry', message: 'Name the country of origin (ISO 3166-1, like IT), not the EU.' },
      { path: 'body/netMassKg', message: 'The net mass of one garment is above 0 kg.' },
    ])
    // The database holds the same formats for every login (Style_customs_guard).
    await expect(admin(`UPDATE "Style" SET "originCountry" = 'it' WHERE id = $1`, [jacket])).rejects.toThrow(/commodity code of 6, 8 or 10 digits/)
  })
})

describe('a subcontracted routing step (PRD-120)', () => {
  it('names the workshop, its fee per piece and the transit days; the fee is the cost grain', async () => {
    let routing = await getRouting(jacket, revision1)
    expect(stepOf(routing, 'SEED-SEW-ASM').subcontract).toBeNull()
    expect(routing.minutes.subcontracted).toBe(0)
    routing = (await ok('engineer', 'PATCH', `${routingUrl(jacket, revision1)}/steps/${SEW}`, { version: routing.revision.version, subcontract: { supplierId: workshop, pricePerPiece: '4.50', transitDays: 6 } })).routing
    expect(stepOf(routing, 'SEED-SEW-ASM').subcontract).toEqual({ supplier: { id: workshop, code: 'TERZ-CUCI', name: 'Lab Esempio' }, pricePerPiece: '4.5', transitDays: 6 })
    expect(routing.minutes.subcontracted).toBe(1)
    // Without the cost grain the workshop and the days show, the fee does not.
    expect(stepOf(await getRouting(jacket, revision1, 'viewer'), 'SEED-SEW-ASM').subcontract).toEqual({ supplier: { id: workshop, code: 'TERZ-CUCI', name: 'Lab Esempio' }, transitDays: 6 })
    const events = (await eventsOf(jacket)).filter((event) => event.type === 'style.routing_changed')
    expect(events.at(-1)?.payload).toMatchObject({ stepIds: [SEW] })
    const entry = (await historyOf('engineer', 'RoutingOperation', SEW)).find((row) => row.action === 'product.routing.updateStep')
    expect(entry).toMatchObject({ before: { subcontract: null }, after: { subcontract: { supplierId: workshop, pricePerPiece: '4.5', transitDays: 6 } } })
  })

  it('refuses a fee from a person without the cost grain; their change of the days keeps the fee', async () => {
    let { version } = (await getRouting(jacket, revision1)).revision
    const refusal = await refused('developer', 'PATCH', `${routingUrl(jacket, revision1)}/steps/${SEW}`, { version, subcontract: { pricePerPiece: '5' } }, 403)
    expect(refusal.code).toBe('forbidden')
    const routing = (await ok('developer', 'PATCH', `${routingUrl(jacket, revision1)}/steps/${SEW}`, { version, subcontract: { transitDays: 8 } })).routing
    expect(stepOf(routing, 'SEED-SEW-ASM').subcontract).toEqual({ supplier: { id: workshop, code: 'TERZ-CUCI', name: 'Lab Esempio' }, transitDays: 8 })
    expect(stepOf(await getRouting(jacket, revision1), 'SEED-SEW-ASM').subcontract).toMatchObject({ pricePerPiece: '4.5', transitDays: 8 })
    version = routing.revision.version
    // A workshop must be one: a party with the SUBCONTRACTOR role, not blocked; a fee or days need a workshop.
    const notWorkshop = await refused('engineer', 'PATCH', `${routingUrl(jacket, revision1)}/steps/${SEW}`, { version, subcontract: { supplierId: supplierOnly } }, 400)
    expect(notWorkshop.issues).toEqual([{ path: 'body/subcontract/supplierId', message: 'FORN-ONLY is not a workshop: give the party the SUBCONTRACTOR role first.' }])
    const blocked = await refused('engineer', 'PATCH', `${routingUrl(jacket, revision1)}/steps/${SEW}`, { version, subcontract: { supplierId: blockedWorkshop } }, 400)
    expect(blocked.issues).toEqual([{ path: 'body/subcontract/supplierId', message: 'Workshop TERZ-OLD is blocked.' }])
    const cut = stepOf(await getRouting(jacket, revision1), 'SEED-CUT-LEA')
    const orphan = await refused('engineer', 'PATCH', `${routingUrl(jacket, revision1)}/steps/${cut.id}`, { version, subcontract: { transitDays: 3 } }, 400)
    expect(orphan.issues).toEqual([{ path: 'body/subcontract/supplierId', message: 'Name the workshop that does the step before its fee or transit days.' }])
    // The floor reads no routing route at all.
    expect((await call('floor', 'GET', routingUrl(jacket, revision1))).statusCode).toBe(403)
  })

  it('a released revision keeps its subcontracted step frozen; a copied revision carries it', async () => {
    const bom = (await ok('engineer', 'GET', `/product/styles/${jacket}/revisions/${revision1}/bom`)).bom
    await ok('engineer', 'POST', `/product/styles/${jacket}/revisions/${revision1}/release`, { version: bom.revision.version })
    const frozen = await refused('engineer', 'PATCH', `${routingUrl(jacket, revision1)}/steps/${SEW}`, { version: bom.revision.version + 1, subcontract: null }, 409)
    expect(frozen.message).toBe('Revision 1 is released: its routing is frozen. Copy it into a new draft to change it.')
    const copy = (await ok('engineer', 'POST', `/product/styles/${jacket}/revisions/${revision1}/copy`, { changeNote: 'Spring changes (made up).' }, 201)).bom
    const routing = await getRouting(jacket, copy.revision.id)
    expect(stepOf(routing, 'SEED-SEW-ASM').subcontract).toEqual({ supplier: { id: workshop, code: 'TERZ-CUCI', name: 'Lab Esempio' }, pricePerPiece: '4.5', transitDays: 8 })
    // Back in-house in the draft; the released revision keeps its workshop.
    const cleared = (await ok('engineer', 'PATCH', `${routingUrl(jacket, copy.revision.id)}/steps/${stepOf(routing, 'SEED-SEW-ASM').id}`, { version: routing.revision.version, subcontract: null })).routing
    expect(stepOf(cleared, 'SEED-SEW-ASM').subcontract).toBeNull()
    expect(stepOf(await getRouting(jacket, revision1), 'SEED-SEW-ASM').subcontract).toMatchObject({ transitDays: 8 })
    // Abandon the draft again: the copy tests below take their parts from the released revision.
    await ok('engineer', 'POST', `/product/styles/${jacket}/revisions/${copy.revision.id}/obsolete`, { version: cleared.revision.version })
  })
})

describe('copying a style (PRD-011)', () => {
  it('offers each part with what it holds, and says why one cannot be picked', async () => {
    const offer = (await ok('engineer', 'GET', `/product/styles/${jacket}/duplicate`)).offer
    expect(offer).toMatchObject({ source: { id: jacket, code: 'SEED-JKT-01', status: 'ACTIVE' }, revision: { id: revision1, revision: 1, status: 'RELEASED' }, colourways: 2, droppedSizes: [] })
    // W2b (B-W2b-25): each reason also as a code with its facts.
    const facts = (more: Json = {}) => ({ style: 'SEED-JKT-01', revision: null, label: null, labelRevision: null, permission: null, everyCompany: false, ...more })
    const can = { reasonCode: null, reasonFacts: null }
    expect(offer.parts).toEqual([
      { part: 'BOM', available: true, count: 3, reason: null, ...can },
      { part: 'ROUTING', available: true, count: 4, reason: null, ...can },
      { part: 'MEASUREMENTS', available: true, count: null, reason: null, ...can },
      { part: 'LABELS', available: false, count: null, reason: 'Revision 1 has no garment label.', reasonCode: 'NO_LABEL', reasonFacts: facts({ revision: 1 }) },
      { part: 'PICTURES', available: false, count: null, reason: "The style's sketches and pictures are copied once the gallery arrives (W2b).", reasonCode: 'NOT_YET', reasonFacts: facts() },
      { part: 'OPTIONS', available: false, count: null, reason: 'Style options are copied once option groups arrive (W2b).', reasonCode: 'NOT_YET', reasonFacts: facts() },
    ])
    const limited = (await ok('stylesOnly', 'GET', `/product/styles/${jacket}/duplicate`)).offer.parts
    expect(limited[0]).toEqual({
      part: 'BOM',
      available: false,
      count: null,
      reason: 'Copying the BOM needs product.bom.manage over every company.',
      reasonCode: 'NEEDS_PERMISSION',
      reasonFacts: facts({ permission: 'product.bom.manage', everyCompany: true }),
    })
  })

  it('makes a new draft style with its own code, the colourways, SKUs and the BOM and routing in a new draft revision', async () => {
    const answer = await ok(
      'engineer',
      'POST',
      `/product/styles/${jacket}/duplicate`,
      { code: 'seed-jkt-02', name: 'Seed jacket, summer copy', season: 'SS28', parts: ['BOM', 'ROUTING', 'MEASUREMENTS'], generateSkus: true },
      201,
      { 'idempotency-key': 'duplicate-jkt-02' },
    )
    const copy = answer.style
    expect(copy).toMatchObject({
      code: 'SEED-JKT-02',
      name: 'Seed jacket, summer copy',
      nameI18n: null,
      season: 'SS28',
      companyId: null,
      status: 'DRAFT',
      sizes: ['50', '52', '54'],
      baseSize: '52',
      ppeCategory: 'CATEGORY_II',
      mtmAllowed: true,
      measurementTemplate: { id: template },
      hsCode: '42031000',
      originCountry: 'IT',
      netMassKg: '1.85',
      skuCount: 6,
      revisionState: 'DRAFT',
      draftRevision: 1,
    })
    expect(copy.colourways.map((colourway: Json) => colourway.code)).toEqual(['BLK', 'RED'])
    expect(copy.skus.map((sku: Json) => sku.sku)).toContain('SEED-JKT-02-BLK-52')
    expect(answer.revision).toMatchObject({ revision: 1, status: 'DRAFT', changeNote: 'Copied from SEED-JKT-01 revision 1.' })
    expect(answer.copied).toEqual({ from: { styleId: jacket, code: 'SEED-JKT-01', revisionId: revision1, revision: 1 }, parts: ['BOM', 'ROUTING', 'MEASUREMENTS'], colourways: 2, bomLines: 3, routingSteps: 4, label: false, skus: 6 })
    expect(answer.notes).toEqual([])
    expect(answer.noteCodes).toEqual([])
    // W2b (B-W2b-25): the copy names its source and the revision its parts came from, on the record too; the source names none.
    expect(copy.copiedFrom).toEqual({ styleId: jacket, code: 'SEED-JKT-01', name: expect.any(String), revisionId: revision1, revision: 1 })
    expect((await ok('viewer', 'GET', `/product/styles/${copy.id}`)).style.copiedFrom).toEqual(copy.copiedFrom)
    expect((await ok('viewer', 'GET', `/product/styles/${jacket}`)).style.copiedFrom).toBeNull()
    expect(await admin(`SELECT "copiedFromStyleId"::text AS "styleId", "copiedFromRevisionId"::text AS "revisionId" FROM "Style" WHERE id = $1`, [copy.id])).toEqual([{ styleId: jacket, revisionId: revision1 }])

    // The BOM onto the copy's colourways, its size quantities; the routing with its subcontracted step.
    const bom = (await ok('viewer', 'GET', `/product/styles/${copy.id}/revisions/${answer.revision.id}/bom`)).bom
    expect(bom.lines.map((line: Json) => [line.seq, line.item.code])).toEqual([[10, 'SEED-LEA-100'], [20, 'SEED-LIN-200'], [30, 'SEED-PRO-300']])
    expect(bom.lines[0].colours.map((cell: Json) => cell.colourwayId)).toEqual(copy.colourways.map((colourway: Json) => colourway.id))
    expect(bom.lines[0].sizes).toEqual([{ size: '50', qty: '43' }, { size: '52', qty: '45' }, { size: '54', qty: '47.5' }])
    expect(bom.revision.plannedHideYieldPct).toBe('75')
    const routing = await getRouting(copy.id, answer.revision.id)
    expect(routing.steps.map((step: Json) => step.code)).toEqual(['SEED-CUT-LEA', 'SEED-SEW-ASM', 'SEED-FIN-QC', 'SEED-PACK'])
    expect(stepOf(routing, 'SEED-SEW-ASM').subcontract).toEqual({ supplier: { id: workshop, code: 'TERZ-CUCI', name: 'Lab Esempio' }, pricePerPiece: '4.5', transitDays: 8 })
    // The copy is released by its own check, like any draft.
    expect(bom.releasable).toBe(true)

    expect((await eventsOf(copy.id)).map((event) => event.type).sort()).toEqual(['style.created', 'style.duplicated', 'style.revision_created', 'style.skus_changed'])
    const duplicated = (await eventsOf(copy.id)).find((event) => event.type === 'style.duplicated')
    expect(duplicated?.payload).toEqual({ styleId: copy.id, code: 'SEED-JKT-02', sourceStyleId: jacket, sourceCode: 'SEED-JKT-01', sourceRevisionId: revision1, parts: ['BOM', 'ROUTING', 'MEASUREMENTS'] })
    expect((await historyOf('engineer', 'Style', jacket)).find((entry) => entry.action === 'product.styles.duplicate')).toMatchObject({ after: { copiedTo: { styleId: copy.id, code: 'SEED-JKT-02' } } })

    // The same request again answers the same copy.
    const again = await ok('engineer', 'POST', `/product/styles/${jacket}/duplicate`, { code: 'seed-jkt-02', name: 'Seed jacket, summer copy', season: 'SS28', parts: ['BOM', 'ROUTING', 'MEASUREMENTS'], generateSkus: true }, 201, { 'idempotency-key': 'duplicate-jkt-02' })
    expect(again.style.id).toBe(copy.id)
  })

  it('copies only the identity and colourways when no part is picked; leaves out an archived size and colourway, and says so', async () => {
    const red = (await ok('viewer', 'GET', `/product/styles/${jacket}`)).style.colourways.find((colourway: Json) => colourway.code === 'RED')
    await admin(`UPDATE "Colourway" SET status = 'ARCHIVED' WHERE id = $1`, [red.id])
    await admin(`UPDATE "Size" SET status = 'ARCHIVED' WHERE "scaleId" = $1 AND code = '54'`, [seedId('product:size-scale:EU-JKT')])
    try {
      expect((await ok('engineer', 'GET', `/product/styles/${jacket}/duplicate`)).offer.droppedSizes).toEqual(['54'])
      const answer = await ok('engineer', 'POST', `/product/styles/${jacket}/duplicate`, { code: 'SEED-JKT-03', name: 'Seed jacket, plain copy', parts: ['BOM'] }, 201)
      expect(answer.style).toMatchObject({ sizes: ['50', '52'], mtmAllowed: false, measurementTemplate: null, skuCount: 0 })
      expect(answer.style.colourways.map((colourway: Json) => colourway.code)).toEqual(['BLK'])
      expect(answer.notes).toEqual(["Size(s) 54 are archived in the scale: the copy's range leaves them out.", '1 archived colourway(s) are not copied.'])
      expect(answer.noteCodes).toEqual([
        { code: 'SIZES_ARCHIVED', sizes: ['54'], count: null, colourway: null },
        { code: 'COLOURWAYS_ARCHIVED', sizes: [], count: 1, colourway: null },
      ])
      expect(answer.style.copiedFrom).toMatchObject({ styleId: jacket, revisionId: revision1, revision: 1 })
      const bom = (await ok('viewer', 'GET', `/product/styles/${answer.style.id}/revisions/${answer.revision.id}/bom`)).bom
      expect(bom.lines[0].sizes).toEqual([{ size: '50', qty: '43' }, { size: '52', qty: '45' }])
      expect(bom.lines[0].colours.map((cell: Json) => cell.colourwayId)).toEqual([answer.style.colourways[0].id])
      expect((await getRouting(answer.style.id, answer.revision.id)).steps).toEqual([])
    } finally {
      await admin(`UPDATE "Colourway" SET status = 'ACTIVE' WHERE id = $1`, [red.id])
      await admin(`UPDATE "Size" SET status = 'ACTIVE' WHERE "scaleId" = $1 AND code = '54'`, [seedId('product:size-scale:EU-JKT')])
    }
  })

  it('refuses a taken code, a part the person may not copy or the source lacks, an unknown revision, another tenant', async () => {
    expect((await refused('engineer', 'POST', `/product/styles/${jacket}/duplicate`, { code: 'SEED-JKT-01', name: 'Clash' }, 409)).message).toBe('The style code SEED-JKT-01 is taken.')
    expect((await refused('stylesOnly', 'POST', `/product/styles/${jacket}/duplicate`, { code: 'SEED-JKT-09', name: 'X', parts: ['ROUTING'] }, 403)).message).toBe('Copying the routing needs product.routing.manage over every company.')
    const label = await refused('engineer', 'POST', `/product/styles/${jacket}/duplicate`, { code: 'SEED-JKT-09', name: 'X', parts: ['LABELS'] }, 409)
    expect(label).toMatchObject({ code: 'invalid_state', issues: [{ path: 'body/parts/0', message: 'Revision 1 has no garment label.' }] })
    expect((await refused('engineer', 'POST', `/product/styles/${jacket}/duplicate`, { code: 'SEED-JKT-09', name: 'X', parts: ['PICTURES'] }, 400)).code).toBe('validation_failed')
    expect((await refused('engineer', 'POST', `/product/styles/${jacket}/duplicate`, { code: 'SEED-JKT-09', name: 'X', fromRevisionId: newId() }, 404)).message).toBe('Revision not found.')
    // A tenant-wide style is copied only by a role over every company; another tenant does not see it.
    expect((await refused('companyA', 'POST', `/product/styles/${jacket}/duplicate`, { code: 'SEED-JKT-09', name: 'X' }, 403)).code).toBe('forbidden')
    expect((await refused('otherTenant', 'POST', `/product/styles/${jacket}/duplicate`, { code: 'SEED-JKT-09', name: 'X' }, 404)).message).toBe('Style not found.')
    expect((await admin(`SELECT count(*)::int AS n FROM "Style" WHERE code = 'SEED-JKT-09'`))[0]!.n).toBe(0)
  })
})
