import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * The leather dashboard's own reads (B-W2b-131; SCM-285) through the app's real routes on a throwaway PostgreSQL 17 database
 * from the migrations (the runtime login: row-level security is real), tenant A from EVERY seed (SEED-HIDE-0002 whole in
 * A1-STORE-01, 51.8 ft²; SEED-HIDE-0001 partly cut at WO-0001; the seed workshop P2's empty place A1-TERZ-P2) and tenant B
 * bare. Made-up figures only. In order:
 *   - the hides' photos, newest first, with the cutting table and the incoming inspection where a record names them, and
 *     none without files.read (first: a held lot is not cut, and the dashboard's test holds one);
 *   - what lies at a subcontractor's place: a hide moved there by a transfer, per place, article and colour, hides beside area;
 *   - what is on hold: the seed's quality hold on the hide (its lot released), once even with its lot held too, the sums;
 *   - nothing out of the caller's scope or tenant.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/inventory/hides/dashboard`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'leather-dash-a'
let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let serial = 0
const idem = () => `leather-dash-${Date.now()}-${++serial}`

const id = (key: string) => seedUuid(NS, key)
const A = {
  tenant: id('tenant'),
  companyA: id('company:A'),
  siteA1: id('site:A1'),
  siteB1: id('site:B1'),
  leather: id('product:item:leather'),
  leatherBLK: id('product:item-colour:leather:BLK'),
  lot: id('inventory:lot:LEA-01'),
  H1: id('inventory:hide:H1'),
  H2: id('inventory:hide:H2'),
  bin: id('inventory:location:A1-STORE-01'),
  workshop: id('subcontract:location:A1-TERZ-P2'),
}
const tenantB = newId()

const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  keeper: office(A.tenant, [grant(['inventory.stock.view', 'inventory.transfer', 'quality.holds.view', 'quality.holds.place', 'files.read'])]),
  // Stock, but no files: the photos are left out.
  viewer: office(A.tenant, [grant(['inventory.stock.view'])]),
  // Stock of the other site only.
  otherSite: office(A.tenant, [grant(['inventory.stock.view', 'files.read'], { sites: [A.siteB1] })]),
  nobody: office(A.tenant, [grant(['sites.view'])]),
  keeperB: office(tenantB, [grant(['inventory.stock.view', 'files.read'])]),
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
type Method = 'GET' | 'POST'
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': idem() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
const dashboard = (session = 'keeper', query = '') => ok(session, 'GET', `/inventory/leather/dashboard${query}`)

/** A photo of a hide as the files platform stores it (made-up bytes: only the row matters here). */
async function photo(hideId: string, name: string, at: string, floor: boolean): Promise<string> {
  const fileId = newId()
  const store = (await admin<{ id: string }>(`SELECT id FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2' ORDER BY id LIMIT 1`, [A.tenant]))[0]!.id
  await admin(
    `INSERT INTO "StoredFile" (id, "tenantId", "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256, "storeAccountId", "storageKey", status, visibility, "floorSiteId", "availableAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'Hide', $4, 'PHOTO', $5, 'image/jpeg', 1200, repeat('a', 64), $6, $7, 'AVAILABLE', $8::"FileAudience"[], $9, $10, $10, $10)`,
    [fileId, A.tenant, A.companyA, hideId, name, store, `t/${A.tenant}/c/${A.companyA}/2026/${fileId}`, floor ? ['OFFICE', 'FLOOR'] : ['OFFICE'], floor ? A.siteA1 : null, at],
  )
  return fileId
}

beforeAll(async () => {
  db = await migratedDatabase('leather_dashboard')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: NS })
  }
  await admin(`INSERT INTO "Tenant" (id, slug, name) VALUES ($1, 'leather-dash-b', 'Gruppo Nuovo')`, [tenantB])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('the hides photos (MES-060; design hd-photos, hd-photo)', () => {
  it('lists the photos newest first, says where they were taken when a record names it, and hides them without files.read', async () => {
    const office = await photo(A.H1, 'office.jpg', '2026-11-01T09:00:00.000Z', false)
    const table = await photo(A.H1, 'table.jpg', '2026-11-02T09:00:00.000Z', true)
    const inspection = await photo(A.H2, 'incoming.jpg', '2026-11-03T09:00:00.000Z', true)
    // The cutting table's entry names its photo (a copy of a seed cut of the hide, made-up), the incoming inspection's mark names another.
    await admin(
      `INSERT INTO "CutLog" (id, "tenantId", "siteId", "workOrderId", "lotId", "hideId", uom, "areaUsed", "baseAreaUsed", "workerId", "stationId", "deviceId", "clientEventId", "photoFileId")
       SELECT $1, "tenantId", "siteId", "workOrderId", "lotId", "hideId", uom, 0.5, 0.5, "workerId", "stationId", "deviceId", $2, $3 FROM "CutLog" WHERE "hideId" = $4 AND "reversalOfId" IS NULL ORDER BY id LIMIT 1`,
      [newId(), `leather-dash-${newId()}`, table, A.H1],
    )
    await admin(
      `INSERT INTO "HideMark" (id, "tenantId", "siteId", "lotId", "hideId", kind, x, y, outline, "zoneGradeId", "photoFileId") VALUES ($1, $2, $3, $4, $5, 'ZONE', 0.5, 0.5, '[{"x":0.1,"y":0.1},{"x":0.9,"y":0.1},{"x":0.5,"y":0.9}]', $6, $7)`,
      [newId(), A.tenant, A.siteA1, A.lot, A.H2, id('leather:grade:A'), inspection],
    )

    const answer = await ok('keeper', 'GET', `/inventory/leather/photos?hideIds=${A.H1},${A.H2},${A.H1}`)
    expect(answer.canRead).toBe(true)
    const h1 = (answer.hides as Json[]).find((hide) => hide.hideId === A.H1)!
    expect(h1.photos.map((entry: Json) => [entry.fileId, entry.place, entry.floor, entry.workOrder?.number ?? null])).toEqual([
      [table, 'CUTTING_TABLE', true, 'SEED-WO-0001'],
      [office, null, false, null],
    ])
    const h2 = (answer.hides as Json[]).find((hide) => hide.hideId === A.H2)!
    expect(h2.photos.map((entry: Json) => [entry.fileId, entry.place])).toEqual([[inspection, 'INSPECTION']])

    const blind = await ok('viewer', 'GET', `/inventory/leather/photos?hideIds=${A.H1}`)
    expect(blind).toEqual({ canRead: false, hides: [{ hideId: A.H1, photos: [] }] })
    expect((await ok('keeperB', 'GET', `/inventory/leather/photos?hideIds=${A.H1}`)).hides).toEqual([])
    expect((await call('keeper', 'GET', '/inventory/leather/photos?hideIds=not-an-id')).statusCode).toBe(400)
  })
})

describe('the leather dashboard: at subcontractors and on hold (SCM-285)', () => {
  it('counts a hide moved to a subcontractor place, per place, article and colour', async () => {
    const before = await dashboard()
    expect((before.atSubcontractors.rows as Json[]).some((row) => row.location.id === A.workshop)).toBe(false)

    await ok('keeper', 'POST', '/inventory/transfers', { siteId: A.siteA1, itemId: A.leather, hideId: A.H2, fromLocationId: A.bin, toLocationId: A.workshop, quantity: '51.8000', note: 'Out for skiving' }, 201)
    const after = await dashboard()
    const row = (after.atSubcontractors.rows as Json[]).find((entry) => entry.location.id === A.workshop)!
    expect(row).toMatchObject({ location: { code: 'A1-TERZ-P2' }, item: { id: A.leather }, colour: { id: A.leatherBLK }, uom: 'FT2', hides: 1, area: '51.8000' })
    expect(row.party?.name).toBeTruthy()
    expect(row.words).toEqual({ it: '1 pelle · 51,80 ft² (4,8 m²)', en: '1 hide · 51.80 ft² (4.8 m²)' })
    expect((after.atSubcontractors.sums as Json[]).find((sum) => sum.uom === 'FT2')).toMatchObject({ hides: 1, area: '51.8000' })
    // Never money.
    expect(JSON.stringify(after)).not.toMatch(/value|cost|price/i)
  })

  it('counts a hide on a quality hold while its lot is released, once even when its lot is held too, and the sums per unit', async () => {
    const blackOf = (answer: Json) => (answer.onHold.rows as Json[]).find((entry) => entry.item.id === A.leather && entry.colour?.id === A.leatherBLK) ?? null
    // The seed's operator holds SEED-HIDE-0002 at the cutting table (made-up grain crack); its lot is released.
    const before = blackOf(await dashboard())!
    expect(before).toMatchObject({ uom: 'FT2', lotNotReleased: { hides: 0, area: '0.0000' }, qualityHold: { hides: 1, area: '51.8000' } })
    expect(before.words.en).toBe('1 hide · 51.80 ft² (4.8 m²)')
    // A hold on its lot too: the hide still counts once.
    await ok('keeper', 'POST', '/quality/holds', { subjectType: 'Lot', subjectIds: [A.lot], reasonCode: 'SUPPLIER_CHECK', reasonNote: 'Made-up check of the dye batch' }, 201)
    const answer = await dashboard()
    expect(blackOf(answer)).toMatchObject({ lotNotReleased: { hides: 0, area: '0.0000' }, qualityHold: { hides: 1, area: '51.8000' } })
    const ft2 = (answer.onHold.sums as Json[]).find((sum) => sum.uom === 'FT2')!
    expect(ft2.qualityHold.hides).toBeGreaterThanOrEqual(1)
    // The site filter keeps it; another site's filter drops it.
    expect(blackOf(await dashboard('keeper', `?siteId=${A.siteA1}`))).not.toBeNull()
    expect(blackOf(await dashboard('keeper', `?siteId=${A.siteB1}`))).toBeNull()
  })

  it('shows nothing out of the caller scope or tenant, and refuses a caller without stock', async () => {
    const other = await dashboard('otherSite')
    expect((other.atSubcontractors.rows as Json[]).some((row) => row.location.id === A.workshop)).toBe(false)
    expect((other.onHold.rows as Json[]).some((row) => row.item.id === A.leather)).toBe(false)
    const b = await dashboard('keeperB')
    expect(b.atSubcontractors.rows).toEqual([])
    expect(b.onHold.rows).toEqual([])
    expect((await call('nobody', 'GET', '/inventory/leather/dashboard')).statusCode).toBe(403)
  })
})
