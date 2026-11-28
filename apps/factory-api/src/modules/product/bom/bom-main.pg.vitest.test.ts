import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedProduct } from '../../../../../../packages/factory-db/seed/product'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * owb-pd3 step 3.3 on the local stack (the app's real routes, the runtime login: the index BomLine_one_main is real): the product
 * seed's jacket, its revision 1 copied to a draft. The main material — marked on a line, moved to another (one per revision), never
 * taken out nor unmarked (MAIN_REQUIRED); the same material twice at the same place refused (SAME_MATERIAL), another place allowed;
 * each line's lead time read (the seed leather's own 14 days). Made-up figures.
 * Run with `node scripts/factory/run-pg-tests.mjs bom-main`. Written, not run (Owner rule: checks at the end).
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'bom-main-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const jacket = seedId('product:style:JKT-01')
const revision1 = seedId('product:revision:JKT-01:1')
const leather = seedId('product:item:leather')
const lining = seedId('product:item:lining')
const protector = seedId('product:item:protector')

const PERMISSIONS: Permission[] = ['product.bom.view', 'product.bom.manage', 'product.bom.release', 'product.styles.view', 'product.styles.manage', 'product.routing.view', 'product.routing.manage']
const grant: Grant = { permissions: PERMISSIONS, companies: 'all', sites: 'all', parties: 'all' }
const SESSIONS: Record<string, SessionContext> = { maker: { audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant] } }

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (method: Method, url: string, payload?: unknown) => app.inject({ method, url, headers: { 'x-test-session': 'maker' }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refusal(method: Method, url: string, payload: unknown, code: string): Promise<void> {
  const response = await call(method, url, payload)
  expect(response.statusCode, response.body).toBe(409)
  expect(response.json().error.issues?.[0]?.path).toBe(`refusal/${code}`)
}
const bomUrl = (revisionId: string) => `/product/styles/${jacket}/revisions/${revisionId}`
const lineOf = (bom: Json, itemId: string): Json => bom.lines.find((line: Json) => line.item.id === itemId)
const mains = (bom: Json): string[] => bom.lines.filter((line: Json) => line.isMain).map((line: Json) => line.item.id)

beforeAll(async () => {
  db = await migratedDatabase('bom_main')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedProduct({ db: database, namespace: NS })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 60_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the main material and the lead times (3.3)', () => {
  let bom: Json
  let draft: string

  it('reads each line\'s lead time: the leather\'s own 14 days; no line is the main material yet', async () => {
    bom = (await ok('POST', `${bomUrl(revision1)}/copy`, { changeNote: 'Main material (made up).' }, 201)).bom
    draft = bom.revision.id
    expect(lineOf(bom, leather).leadTimeDays).toBe(14)
    for (const line of bom.lines) expect(line.leadTimeDays === null || Number.isInteger(line.leadTimeDays)).toBe(true)
    expect(mains(bom)).toEqual([])
  })

  it('marks the leather as the main material, then moves the mark to the lining: one main line a revision', async () => {
    const url = `${bomUrl(draft)}/bom/lines`
    bom = (await ok('PATCH', `${url}/${lineOf(bom, leather).id}`, { version: bom.revision.version, isMain: true })).bom
    expect(mains(bom)).toEqual([leather])
    bom = (await ok('PATCH', `${url}/${lineOf(bom, lining).id}`, { version: bom.revision.version, isMain: true })).bom
    expect(mains(bom)).toEqual([lining])
    expect(await admin('SELECT count(*)::int AS n FROM "BomLine" WHERE "revisionId" = $1 AND "isMain"', [draft])).toEqual([{ n: 1 }])
  })

  it('the main line is never taken out nor unmarked (MAIN_REQUIRED)', async () => {
    const url = `${bomUrl(draft)}/bom/lines/${lineOf(bom, lining).id}`
    await refusal('DELETE', `${url}?version=${bom.revision.version}`, undefined, 'MAIN_REQUIRED')
    await refusal('PATCH', url, { version: bom.revision.version, isMain: false }, 'MAIN_REQUIRED')
    expect(mains((await ok('GET', `${bomUrl(draft)}/bom`)).bom)).toEqual([lining])
  })

  it('the same material twice at the same place is refused (SAME_MATERIAL); at another place it is a line of its own', async () => {
    const url = `${bomUrl(draft)}/bom/lines`
    const twin = lineOf(bom, protector)
    await refusal('POST', url, { version: bom.revision.version, itemId: protector, qty: '1', ...(twin.placement ? { placement: twin.placement } : {}) }, 'SAME_MATERIAL')
    bom = (await ok('POST', url, { version: bom.revision.version, itemId: protector, qty: '1', placement: 'Spare (made up)' }, 201)).bom
    expect(bom.lines.filter((line: Json) => line.item.id === protector)).toHaveLength(2)
  })
})
