import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedSizesDepth, type SizesDepthSeed } from '../../../../../../packages/factory-db/seed/sizes-depth'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * owb-pd4s s.1 and s.2 (S4 products; web A's list and Sizes tab) through the app's real routes, on a throwaway PostgreSQL 17
 * database from the migrations and the core and sizes seeds: SEED-JKT-01 (P1's own label: made for a customer; DRAFT revision 1 with
 * its live measurement spec and its shoulder, back and elbow protectors), the product seed's SEED-KS-01 "Knee slider, molded" (our
 * range: no customer), sessions from the test authenticator.
 *   - s.1 `GET /product/styles?family=`: OUR_RANGE returns only styles of no customer, FOR_CUSTOMER only styles made for one; with
 *     every other filter (a customer's brandPartyId with OUR_RANGE: none); a word of neither: 400.
 *   - s.2 Sales reads Sizes: a person with only product.styles.view reads the size table (the measurement spec, its points' how-to
 *     words) and the protectors; every write stays refused (403); a person with neither right: 403.
 * Every code is made up. Not run in the build (Owner rule: checks at the end).
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'

const NS = 'owb-pd4s-reads'
const idOf = (key: string): string => seedUuid(NS, key)
const tenant = idOf('tenant')
const P1 = idOf('party:P1')

const PEOPLE: Record<string, readonly Permission[]> = {
  // Sales: the product's own right only (no BOM).
  sales: ['product.styles.view'],
  bom: ['product.styles.view', 'product.bom.view'],
  // Neither right of the Sizes tab.
  nobody: ['orders.view'],
}
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, permissions]) => {
    const grant: Grant = { permissions: [...permissions], companies: 'all', sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant] }]
  }),
)

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seed: SizesDepthSeed

const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': newId() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<void> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
}
const list = async (session: string, query: string): Promise<Json> => ok(session, 'GET', `/product/styles?status=ALL&limit=200${query}`)
const specUrl = () => `/product/styles/${seed.jacket.styleId}/revisions/${seed.jacket.revisionId}/measurement-spec`
const protectorsUrl = () => `/product/styles/${seed.jacket.styleId}/revisions/${seed.jacket.revisionId}/protectors`

beforeAll(async () => {
  db = await migratedDatabase('owb_pd4s_reads')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  seed = await seedSizesDepth({ db: database, namespace: NS })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('s.1 the family filter of the office list (GET /product/styles?family=)', () => {
  it('each value returns only its family, with every other filter; a word of neither is refused', async () => {
    const all = await list('sales', '')
    const codes = (answer: Json): string[] => answer.styles.map((row: Json) => row.code)
    expect(codes(all)).toEqual(expect.arrayContaining(['SEED-JKT-01', 'SEED-KS-01']))

    const ours = await list('sales', '&family=OUR_RANGE')
    expect(ours.styles.length).toBeGreaterThan(0)
    expect(ours.styles.every((row: Json) => row.family === 'OUR_RANGE')).toBe(true)
    expect(codes(ours)).toContain('SEED-KS-01')
    expect(codes(ours)).not.toContain('SEED-JKT-01')

    const theirs = await list('sales', '&family=FOR_CUSTOMER')
    expect(theirs.styles.length).toBeGreaterThan(0)
    expect(theirs.styles.every((row: Json) => row.family === 'FOR_CUSTOMER')).toBe(true)
    expect(codes(theirs)).toContain('SEED-JKT-01')
    expect(codes(theirs)).not.toContain('SEED-KS-01')

    // The two families are the whole list, and nothing else.
    expect(ours.count + theirs.count).toBe(all.count)
    // With every other filter: a customer's own styles are never our range; made for that customer: SEED-JKT-01.
    expect((await list('sales', `&family=OUR_RANGE&brandPartyId=${P1}`)).count).toBe(0)
    expect(codes(await list('sales', `&family=FOR_CUSTOMER&brandPartyId=${P1}`))).toContain('SEED-JKT-01')
    expect(codes(await list('sales', '&family=OUR_RANGE&productType=OTHER'))).toContain('SEED-KS-01')
    await refused('sales', 'GET', '/product/styles?family=BOTH', undefined, 400)
  })
})

describe('s.2 Sales reads the Sizes tab with product.styles.view', () => {
  it('reads the size table with its how-to words and the protectors, as the BOM reader does', async () => {
    const spec = (await ok('sales', 'GET', specUrl())).spec
    const asBom = (await ok('bom', 'GET', specUrl())).spec
    expect(spec.points.length).toBeGreaterThan(0)
    expect(spec.points.map((point: Json) => [point.code, point.howTo])).toEqual(asBom.points.map((point: Json) => [point.code, point.howTo]))
    expect(spec.points.every((point: Json) => 'howTo' in point)).toBe(true)
    // A point's own how-to words (the library) read with the product's right as before.
    const point = (await ok('sales', 'GET', `/product/points-of-measure/${seed.pointIds.backLen}`)).point
    expect(point).toHaveProperty('howTo')

    const protectors = (await ok('sales', 'GET', protectorsUrl())).protectors
    expect(protectors.placements.map((placement: Json) => placement.pocket).sort()).toEqual(['BACK', 'ELBOW', 'SHOULDER'])
  })

  it('every write stays refused; a person with neither right reads nothing', async () => {
    const spec = (await ok('bom', 'GET', specUrl())).spec
    await refused('sales', 'PUT', `${specUrl()}/cells`, { version: spec.spec.version, cells: [{ pointOfMeasureId: seed.pointIds.chestW, size: '52', nominal: '60' }] }, 403)
    await refused('sales', 'POST', protectorsUrl(), { pocket: 'KNEE', protectorItemId: seed.protectorIds.limb }, 403)
    await refused('nobody', 'GET', specUrl(), undefined, 403)
    await refused('nobody', 'GET', protectorsUrl(), undefined, 403)
    // Another style id: not found, as before.
    await refused('sales', 'GET', `/product/styles/${newId()}/revisions/${seed.jacket.revisionId}/measurement-spec`, undefined, 404)
  })
})
