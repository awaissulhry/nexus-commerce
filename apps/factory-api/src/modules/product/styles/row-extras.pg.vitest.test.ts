import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedCosting } from '../../../../../../packages/factory-db/seed/costing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * B-W2b-25 on the local stack with the app's real routes: the style's gender apart from the CN code, and what a style
 * list row adds (thumbnail, certificate coverage, cost per garment), each only for a person who may see it. A throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security and the triggers are real), the
 * compliance seed's jacket (its certificate covers every colourway and size; revision 1 a draft) and the costing seed's
 * rates (a complete cost sheet). Every code, picture and figure is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs row-extras`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'row-extras-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const jacket = seedId('product:style:JKT-01')
const revision1 = seedId('product:revision:JKT-01:1')
const coverage = seedId('compliance:coverage:JKT-01')

const STYLES: Permission[] = ['product.styles.view', 'product.styles.manage', 'audit.read']
const PEOPLE: Record<string, readonly Permission[]> = {
  everything: [...STYLES, 'compliance.certificates.view', 'costing.view', 'files.read', 'money.cost'],
  noGrain: [...STYLES, 'compliance.certificates.view', 'costing.view', 'files.read'],
  grainOnly: [...STYLES, 'money.cost'],
  plain: ['product.styles.view'],
}
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, permissions]) => {
    const grant: Grant = { permissions: [...permissions], companies: 'all', sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant] }]
  }),
)

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'PATCH', url: string, payload?: unknown): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
const rowOf = async (session: string): Promise<Json> => (await ok(session, 'GET', '/product/styles?status=ALL')).styles.find((row: Json) => row.id === jacket)

let store: string
async function file(name: string, contentType: string, kind: 'PHOTO' | 'ATTACHMENT' | 'DOCUMENT', at: string, status: 'AVAILABLE' | 'PENDING_UPLOAD' = 'AVAILABLE'): Promise<string> {
  const id = newId()
  await admin(
    `INSERT INTO "StoredFile" (id, "tenantId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256, "storeAccountId", "storageKey", status, "availableAt", "createdAt", "updatedAt")
     VALUES ($1, $2, 'Style', $3, $4::"FileKind", $5, $6, 10, $7, $8, $9, $10::"FileStatus", CASE WHEN $10::text = 'AVAILABLE' THEN $11::timestamptz END, $11::timestamptz, $11::timestamptz)`,
    [id, tenant, jacket, kind, name, contentType, 'a'.repeat(64), store, `t/${tenant}/tenant/2026/${id}`, status, at],
  )
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('row_extras')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedCompliance({ db: database, namespace: NS })
  await seedCosting({ db: database, namespace: NS })
  store = newId()
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [store, tenant])
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

describe("a style's gender, apart from the CN code (B-W2b-25)", () => {
  it('is set, shown on the record and the list, audited and said in style.updated; cleared with null; refused when no gender', async () => {
    const before = (await ok('everything', 'GET', `/product/styles/${jacket}`)).style
    expect(before).toMatchObject({ gender: null, copiedFrom: null })
    const style = (await ok('everything', 'PATCH', `/product/styles/${jacket}`, { version: before.version, gender: 'UNISEX', hsCode: '6202 40 00' })).style
    expect(style).toMatchObject({ gender: 'UNISEX', hsCode: '62024000', version: before.version + 1 })
    expect(await rowOf('plain')).toMatchObject({ gender: 'UNISEX' })
    const updated = (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE subject = $1 AND type = 'style.updated' ORDER BY "occurredAt" DESC, id DESC LIMIT 1`, [jacket]))[0]
    expect(updated?.payload.fields).toEqual(['hsCode', 'gender'])
    const entry = (await ok('everything', 'GET', `/audit/Style/${jacket}`)).entries.find((row: Json) => row.after?.gender === 'UNISEX')
    expect(entry).toMatchObject({ before: { gender: null }, after: { gender: 'UNISEX' } })
    const cleared = (await ok('everything', 'PATCH', `/product/styles/${jacket}`, { version: style.version, gender: null })).style
    expect(cleared.gender).toBeNull()
    const wrong = await call('everything', 'PATCH', `/product/styles/${jacket}`, { version: cleared.version, gender: 'KIDS' })
    expect(wrong.statusCode).toBe(400)
    expect(JSON.stringify(wrong.json().error.issues)).toContain('body/gender')
  })
})

describe('what a style list row adds (B-W2b-25)', () => {
  it('shows the first available picture of the style, only with files.read', async () => {
    expect((await rowOf('everything')).thumbnail).toBeNull()
    await file('drawing.pdf', 'application/pdf', 'ATTACHMENT', '2026-10-01T08:00:00Z')
    await file('pending.png', 'image/png', 'PHOTO', '2026-10-01T09:00:00Z', 'PENDING_UPLOAD')
    const front = await file('front.jpg', 'image/jpeg', 'PHOTO', '2026-10-02T08:00:00Z')
    await file('back.png', 'image/png', 'ATTACHMENT', '2026-10-03T08:00:00Z')
    expect((await rowOf('everything')).thumbnail).toEqual({ fileId: front, name: 'front.jpg', contentType: 'image/jpeg' })
    expect((await rowOf('plain')).thumbnail).toBeNull()
  })

  it('counts the certificate coverage as the Compliance tab does, only with compliance.certificates.view', async () => {
    const tab = (await ok('everything', 'GET', `/product/styles/${jacket}/compliance`)).compliance.coverage
    const row = await rowOf('everything')
    expect(row.coverage).toEqual({ state: 'ALL_COVERED', cells: tab.counts.offered, covered: tab.counts.covered, notCovered: 0, expiringSoon: tab.counts.expiringSoon, sizesNotCovered: [] })
    expect(row.coverage.cells).toBe(6)
    expect((await rowOf('plain')).coverage).toBeNull()
    // The certificate's coverage left out of size 54: two cells (BLK 54, RED 54) and one size not covered.
    await admin(`UPDATE "CertificateCoverage" SET sizes = '{50,52}' WHERE id = $1`, [coverage])
    try {
      const gaps = (await rowOf('everything')).coverage
      expect(gaps).toEqual({ state: 'GAPS', cells: 6, covered: 4, notCovered: 2, expiringSoon: 0, sizesNotCovered: ['54'] })
      expect((await ok('everything', 'GET', `/product/styles/${jacket}/compliance`)).compliance.coverage.counts).toMatchObject({ covered: 4, notCovered: 2 })
    } finally {
      await admin(`UPDATE "CertificateCoverage" SET sizes = '{}' WHERE id = $1`, [coverage])
    }
  })

  it('gives the cost per garment of the base size from the cost sheet, only with costing.view and the cost grain', async () => {
    const sheet = (await ok('everything', 'GET', `/costing/styles/${jacket}/revisions/${revision1}/cost-sheet`)).sheet
    const totals = sheet.cells.filter((cell: Json) => cell.size === '52').map((cell: Json) => Number(cell.total)).sort((a: number, b: number) => a - b)
    expect(totals).toHaveLength(2)
    const cost = (await rowOf('everything')).cost
    expect(cost).toEqual({ revision: 1, estimate: true, size: '52', currency: 'EUR', lowest: expect.any(String), highest: expect.any(String), complete: true })
    expect([Number(cost.lowest), Number(cost.highest)]).toEqual([totals[0], totals[1]])
    // Without the grain the field is not there at all; without costing.view it is null.
    expect('cost' in (await rowOf('noGrain'))).toBe(false)
    expect((await rowOf('grainOnly')).cost).toBeNull()
    expect('cost' in (await rowOf('plain'))).toBe(false)
  })

  it('says a cost sheet that lacks an input: the colourways with every input only, and not complete', async () => {
    const price = (await admin<{ id: string; standardCost: string }>(`SELECT id::text, "standardCost"::text FROM "Item" WHERE code = 'SEED-LIN-200'`))[0]!
    await admin(`UPDATE "Item" SET "standardCost" = NULL WHERE id = $1`, [price.id])
    try {
      expect((await rowOf('everything')).cost).toEqual({ revision: 1, estimate: true, size: '52', currency: 'EUR', lowest: null, highest: null, complete: false })
    } finally {
      await admin(`UPDATE "Item" SET "standardCost" = $2::numeric WHERE id = $1`, [price.id, price.standardCost])
    }
  })
})
