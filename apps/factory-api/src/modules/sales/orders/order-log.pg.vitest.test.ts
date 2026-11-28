import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPortalSales } from '../../../../../../packages/factory-db/seed/portal-sales'
import { seed as seedProduct } from '../../../../../../packages/factory-db/seed/product'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { carryPicture } from '../portal-ordering/office'

/**
 * owb- (order workflow, b3.4): the office's walls of the ONE order log, the order's picture and the departments read — through the
 * app's real routes on a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security is real), on the
 * factory-db seeds up to the customer portal (SEED-SO-0001 and SEED-RQ-0001 are customer SEED-C1's, P1) and the product seed (the nine
 * departments). Audit rows and files the reads read are planted with the database's rules off (the reads are what is tested). Every
 * name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/orders/order-log`.
 *
 *   WS-OWB-1  brand B never reads brand A's order log (order or request): a person limited to another customer gets 404
 *   WS-OWB-3  a role without the price grain gets no price in a log value (nor does one with it: values are typed, never a raw row)
 *   WS-OWB-5  the picture of another party's order is refused (404); a file that is not the order's is refused in words (400)
 *   WS-OWB-6  the Confirm carry copies the request's picture (its three columns) onto the order made from it
 *   WS-OWB-7  the departments read gives the nine seeded in order (office with workorders.view or product.styles.view, the floor)
 * (WS-OWB-2 and WS-OWB-4, the customer's and the floor's faces: ../portal-orders/order-log.pg.vitest.test.ts and the domain's
 * sales/order-log build + faces unit tests.)
 */

vi.setConfig({ testTimeout: 120_000 })

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'owb-order-log'
const id = (key: string): string => seedUuid(NS, key)
const tenant = id('tenant')
const P1 = id('party:P1')
const R1 = id('party:P4')

const grant = (permissions: readonly Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const office = (permissions: readonly Permission[], parties: Grant['parties'] = 'all') => (): SessionContext => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(permissions, parties)] })
const READ: Permission[] = ['orders.view', 'files.read']
const MANAGE: Permission[] = ['orders.view', 'orders.manage', 'files.read']
let floorSite = ''
const SESSIONS: Record<string, () => SessionContext> = {
  reader: office(READ),
  priced: office([...READ, 'money.price' as Permission]),
  manager: office(MANAGE),
  onlyR1: office(MANAGE, [R1]),
  works: office(['workorders.view']),
  products: office(['product.styles.view']),
  none: office(['home.view' as Permission]),
  floor: () => ({ audience: 'floor', tenantId: tenant, actorId: newId(), siteId: floorSite, deviceId: newId(), grants: [{ permissions: ['floor.work' as Permission], companies: 'all', sites: [floorSite], parties: 'all' }] }),
}

type Json = Record<string, any>
const run = randomBytes(4).toString('hex')
let serial = 0
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
const get = (session: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
const post = (session: string, url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object, headers: { 'x-test-session': session, 'idempotency-key': `owb-log-${run}-${++serial}` } })

/** Rows written with the database's rules off (replica): what the reads read. */
async function planted(rows: readonly { readonly sql: string; readonly values: unknown[] }[]): Promise<void> {
  await db.admin.query('BEGIN')
  try {
    await db.admin.query("SET LOCAL session_replication_role = 'replica'")
    for (const row of rows) await db.admin.query(row.sql, row.values)
    await db.admin.query('COMMIT')
  } catch (error) {
    await db.admin.query('ROLLBACK')
    throw error
  }
}
const audit = (row: { recordType: string; recordId: string; action: string; audience?: string; actorId?: string; before?: Json | null; after?: Json | null; reason?: string | null; at?: string }) => ({
  sql: `INSERT INTO "AuditLog" (id, "tenantId", "companyId", at, audience, "actorId", action, "recordType", "recordId", before, after, reason, "requestId") VALUES ($1, $2, $3, $4::timestamptz, $5::"AuditAudience", $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, 'owb-test')`,
  values: [newId(), tenant, seeded.company, row.at ?? new Date().toISOString(), row.audience ?? 'OFFICE', row.actorId ?? seeded.officeUser, row.action, row.recordType, row.recordId, row.before ? JSON.stringify(row.before) : null, row.after ? JSON.stringify(row.after) : null, row.reason ?? null],
})
/** A picture file of a record (an image, AVAILABLE, office only unless shared). */
async function pictureFile(recordType: string, recordId: string, name: string, over: { contentType?: string; priced?: boolean } = {}): Promise<string> {
  const fileId = newId()
  await planted([
    {
      sql: `INSERT INTO "StoredFile" (id, "tenantId", "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256, "storeAccountId", "storageKey", status, visibility, priced) VALUES ($1, $2, $3, $4, $5, 'PHOTO', $6, $7, 2400, repeat('0', 64), $8, $9, 'AVAILABLE', '{OFFICE}', $10)`,
      values: [fileId, tenant, seeded.company, recordType, recordId, name, over.contentType ?? 'image/jpeg', seeded.store, `test/${fileId}`, over.priced ?? false],
    },
  ])
  return fileId
}

const seeded = { order: '', request: '', company: '', store: '', officeUser: '', orderVersion: 0 }

beforeAll(async () => {
  db = await migratedDatabase('owb_order_log')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedProduct({ db: database, namespace: NS })
  await seedPortalSales({ db: database, namespace: NS })
  const order = await one<{ id: string; companyId: string; version: number }>(`SELECT id, "companyId", version FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0001'`, [tenant])
  seeded.order = order.id
  seeded.company = order.companyId
  seeded.orderVersion = order.version
  seeded.request = (await one<{ id: string }>(`SELECT id FROM "PortalOrderRequest" WHERE "tenantId" = $1 AND number = 'SEED-RQ-0001'`, [tenant])).id
  seeded.store = (await one<{ id: string }>(`SELECT id::text AS id FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2' LIMIT 1`, [tenant])).id
  seeded.officeUser = (await one<{ id: string }>(`SELECT id FROM "User" WHERE "tenantId" = $1 AND audience = 'OFFICE' ORDER BY "createdAt" LIMIT 1`, [tenant])).id
  floorSite = (await one<{ id: string }>(`SELECT id FROM "Site" WHERE "tenantId" = $1 ORDER BY code LIMIT 1`, [tenant])).id
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('WS-OWB-1: the order log behind the brand wall (office)', () => {
  it('a person of the order\'s customer reads it in the ONE shape; a person limited to another customer gets 404 on the order and the request', async () => {
    await planted([audit({ recordType: 'SalesOrder', recordId: seeded.order, action: 'orders.changePromise', after: { previous: '2026-12-01', promiseDate: '2026-12-08' }, reason: 'Made-up office note' })])
    const read = await get('reader', `/sales/orders/${seeded.order}/log`)
    expect(read.statusCode, read.body).toBe(200)
    const answer = read.json()
    expect(Object.keys(answer).sort()).toEqual(['nextCursor', 'rows'])
    const moved = (answer.rows as Json[]).find((row) => row.action === 'PROMISE_MOVED')!
    expect(Object.keys(moved).sort()).toEqual(['action', 'at', 'from', 'icon', 'id', 'reason', 'subject', 'to', 'who'])
    expect(moved).toMatchObject({ who: { face: 'PERSON' }, from: { kind: 'DATE', date: '2026-12-01' }, to: { kind: 'DATE', date: '2026-12-08' }, reason: 'Made-up office note', subject: { kind: 'ORDER', label: 'SEED-SO-0001' } })
    expect((await get('reader', `/sales/order-requests/${seeded.request}/log`)).statusCode).toBe(200)
    for (const url of [`/sales/orders/${seeded.order}/log`, `/sales/order-requests/${seeded.request}/log`]) {
      const refused = await get('onlyR1', url)
      expect(refused.statusCode, url).toBe(404)
      expect(refused.body, url).not.toContain('SEED-SO-0001')
    }
    // An unknown order is the same 404 (nothing says it exists).
    expect((await get('reader', `/sales/orders/${newId()}/log`)).statusCode).toBe(404)
  })

  it('pages newest first with the cursor; a cursor that is not ours is refused in words', async () => {
    await planted([1, 2, 3].map((n) => audit({ recordType: 'SalesOrder', recordId: seeded.order, action: 'orders.priority', after: { priorityLevel: 'NORMAL' }, at: `2026-11-0${n}T10:00:00.000Z` })))
    const first = (await get('reader', `/sales/orders/${seeded.order}/log?limit=2`)).json()
    expect(first.rows).toHaveLength(2)
    expect(first.nextCursor).toEqual(expect.any(String))
    const second = (await get('reader', `/sales/orders/${seeded.order}/log?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).json()
    expect(second.rows.map((row: Json) => row.id)).not.toContain(first.rows[0].id)
    expect(Date.parse(second.rows[0].at)).toBeLessThanOrEqual(Date.parse(first.rows[1].at))
    expect((await get('reader', `/sales/orders/${seeded.order}/log?cursor=not-ours`)).statusCode).toBe(400)
  })
})

describe('WS-OWB-3: no price in a log value', () => {
  it('rows that carry prices give no amount to a reader without the price grain — nor to one with it (typed values only)', async () => {
    await planted([
      audit({ recordType: 'SalesOrder', recordId: seeded.order, action: 'orders.amend', after: { lines: [{ unitPrice: '481.250000', netAmount: { minor: 4812500, currency: 'EUR' } }] } }),
      audit({ recordType: 'PortalOrderRequest', recordId: seeded.request, action: 'portalOrdering.takePrices', audience: 'PARTNER', after: { prices: [{ unitPrice: { minor: 48125, currency: 'EUR' } }] } }),
    ])
    for (const session of ['reader', 'priced']) {
      const body = (await get(session, `/sales/orders/${seeded.order}/log?limit=100`)).body
      for (const amount of ['481.25', '4812500', '48125']) expect(body, `${session} ${amount}`).not.toContain(amount)
    }
  })
})

describe('WS-OWB-5: the order\'s picture (office)', () => {
  it('another customer\'s person: 404; a file that is not the order\'s, or a priced one: 400 in words; the order\'s own: set, logged', async () => {
    const own = await pictureFile('SalesOrder', seeded.order, 'made-up front.jpg')
    const elsewhere = await pictureFile('Party', R1, 'made-up other brand.jpg')
    const priced = await pictureFile('SalesOrder', seeded.order, 'made-up priced.pdf', { contentType: 'application/pdf', priced: true })
    const version = (await one<{ version: number }>('SELECT version FROM "SalesOrder" WHERE id = $1', [seeded.order])).version
    expect((await post('onlyR1', `/sales/orders/${seeded.order}/picture`, { fileId: own, version })).statusCode).toBe(404)
    for (const fileId of [elsewhere, priced, newId()]) {
      const refused = await post('manager', `/sales/orders/${seeded.order}/picture`, { fileId, version })
      expect(refused.statusCode, fileId).toBe(400)
      expect(refused.json().error).toMatchObject({ code: 'validation_failed', issues: [{ path: 'body/fileId' }] })
      expect(refused.json().error.message).toContain('cannot be the order’s picture')
    }
    expect((await post('manager', `/sales/orders/${seeded.order}/picture`, { fileId: own, version: version + 7 })).statusCode).toBe(409)
    const set = await post('manager', `/sales/orders/${seeded.order}/picture`, { fileId: own, version })
    expect(set.statusCode, set.body).toBe(200)
    expect(set.json()).toEqual({ pictureFileId: own, pictureSetAt: expect.any(String), version: version + 1 })
    const log = (await get('reader', `/sales/orders/${seeded.order}/log?limit=100`)).json()
    expect((log.rows as Json[]).find((row) => row.action === 'PICTURE_SET')).toMatchObject({ icon: 'image', to: { kind: 'PICTURE', fileId: own } })
    // The batch read shows the chosen picture first.
    const pictures = await post('reader', '/sales/orders/pictures', { orderIds: [seeded.order] })
    expect(pictures.json().pictures[0]).toMatchObject({ id: seeded.order, fileId: own })
    // Back to the default.
    const cleared = await post('manager', `/sales/orders/${seeded.order}/picture`, { fileId: null, version: version + 1 })
    expect(cleared.json()).toEqual({ pictureFileId: null, pictureSetAt: null, version: version + 2 })
  })
})

describe('WS-OWB-6: the Confirm carry', () => {
  it('copies the request\'s picture (file, when, who) onto the order made from it, in the accept\'s transaction', async () => {
    const fileId = await pictureFile('PortalOrderRequest', seeded.request, 'made-up mockup.png', { contentType: 'image/png' })
    const at = '2026-11-20T08:30:00.000Z'
    await planted([{ sql: `UPDATE "PortalOrderRequest" SET "pictureFileId" = $2, "pictureSetAt" = $3::timestamptz, "pictureSetById" = $4 WHERE id = $1`, values: [seeded.request, fileId, at, seeded.officeUser] }])
    // A fresh order of the same customer, made the way an accept makes it (planted), then the carry in a command.
    const orderId = newId()
    await planted([{ sql: `INSERT INTO "SalesOrder" SELECT * FROM jsonb_populate_record(NULL::"SalesOrder", (SELECT to_jsonb(o) || $2::jsonb FROM "SalesOrder" o WHERE o.id = $1))`, values: [seeded.order, JSON.stringify({ id: orderId, number: 'OWB-SO-CARRY', customerSeq: 9901, customerRef: null, quoteVersionId: null, pictureFileId: null, pictureSetAt: null, pictureSetById: null, version: 1 })] }])
    const caller = callerFor(database, { audience: 'office', tenantId: tenant, actorId: seeded.officeUser, grants: [grant(MANAGE)], requestId: newId() })
    await command(caller, { name: 'orders.picture.carryTest' as Permission, input: { orderId } }, async (tools) => {
      await carryPicture(tools.tx, seeded.request, orderId)
      tools.audit({ recordType: 'SalesOrder', recordId: orderId, companyId: seeded.company, after: { carried: true } })
      return null
    })
    const carried = await one<{ pictureFileId: string; pictureSetAt: Date; pictureSetById: string }>('SELECT "pictureFileId", "pictureSetAt", "pictureSetById" FROM "SalesOrder" WHERE id = $1', [orderId])
    expect(carried).toEqual({ pictureFileId: fileId, pictureSetAt: new Date(at), pictureSetById: seeded.officeUser })
  })
})

describe('WS-OWB-7: the departments read', () => {
  it('gives the nine seeded in order, to the office (work orders or products) and the floor; refuses anyone else in words', async () => {
    for (const session of ['works', 'products', 'floor']) {
      const read = await get(session, '/production/departments')
      expect(read.statusCode, `${session} ${read.body}`).toBe(200)
      const departments = read.json().departments as Json[]
      expect(departments.map((department) => department.number), session).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
      expect(departments[0], session).toMatchObject({ number: 1, tone: 'blue', icon: 'ruler', workCentreKind: 'CUTTING', status: 'ACTIVE', floorReady: true })
      expect(departments[8], session).toMatchObject({ number: 9, workCentreKind: 'ASSEMBLY', floorReady: false })
      expect(Object.keys(departments[0]!).sort(), session).toEqual(['floorReady', 'icon', 'id', 'name', 'nameI18n', 'number', 'seq', 'shortName', 'status', 'tone', 'workCentreKind'])
    }
    const refused = await get('none', '/production/departments')
    expect(refused.statusCode).toBe(403)
    expect(refused.json().error.message).not.toMatch(/workorders\.view|product\.styles\.view/)
  })
})
