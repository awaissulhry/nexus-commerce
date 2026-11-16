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
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedMoney } from '../../../../../../packages/factory-db/seed/money'
import { seed as seedOptions } from '../../../../../../packages/factory-db/seed/options'
import { seed as seedStylesDepth } from '../../../../../../packages/factory-db/seed/styles-depth'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { processFiles, createFilesRuntime, useFiles } from '../../../platform/files/service'
import { smallKeyOf } from '../../../platform/files/thumbs/small'
import { createGateway } from '../../../platform/gateway/gateway'
import { useGateway } from '../../../platform/gateway/service'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'

/**
 * What a Sales › Orders row carries beside the order (B-TH-017; threads plan TH-1a, pictures 23 + 24; wall check W27) and
 * the Picture cell's small preview (GET /sales/orders/:orderId/picture, with B-TH-063), on a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security and the money guards are real) with the factory-db
 * seeds up to money and the styles' pictures: SEED-SO-0001 (customer SEED-C1: its quote, its deposit invoice TD02 issued),
 * SEED-SO-0002 (SEED-C1: shipment SH-0001 with DDT 143 cancelled and DDT 144 live, a DRAFT TD24 of 2 of its 7 jackets),
 * and TEST-SO-R1, a copy of SEED-SO-0001 for the second customer SEED-R1 whose first line is the own-collection liner and
 * whose second keeps SEED-C1's private-label jacket. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/orders`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string

const NS = 'th1a-row-extras'
const id = (key: string): string => seedUuid(NS, key)
const tenant = id('tenant')
const C1 = id('party:P1')
const R1 = id('party:P4')

const grant = (permissions: readonly Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const office = (permissions: readonly Permission[], parties: Grant['parties'] = 'all') => (): SessionContext => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(permissions, parties)] })
const EVERYTHING: Permission[] = ['orders.view', 'quotes.view', 'invoices.view', 'shipping.view', 'files.read', 'money.price']
const SESSIONS: Record<string, () => SessionContext> = {
  all: office(EVERYTHING),
  // Sales without the money documents: orders and files only.
  sales: office(['orders.view', 'files.read']),
  // Finance without the price grain: the documents, no amounts.
  finance: office(['orders.view', 'invoices.view', 'shipping.view']),
  noFiles: office(['orders.view', 'quotes.view', 'invoices.view', 'shipping.view', 'money.price']),
  onlyR1: office(EVERYTHING, [R1]),
  onlyC1: office(EVERYTHING, [C1]),
  partner: () => ({ audience: 'partner', tenantId: tenant, actorId: newId(), partyId: C1, grants: [grant(EVERYTHING, [C1])] }),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
async function ok(session: string, url: string): Promise<Json> {
  const response = await call(session, url)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
const rows = async (session: string): Promise<Json[]> => (await ok(session, '/sales/orders?limit=200')).orders as Json[]
const rowOf = async (session: string, number: string): Promise<Json | undefined> => (await rows(session)).find((row) => row.number === number)
/** A version-4 UUID derived from an id and a salt (the copies' ids are valid UUIDs, as the contracts ask). */
const v4 = (expression: string, salt: string): string => {
  const hash = `md5(${expression}::text || '${salt}')`
  return `(substr(${hash}, 1, 8) || '-' || substr(${hash}, 9, 4) || '-4' || substr(${hash}, 14, 3) || '-8' || substr(${hash}, 18, 3) || '-' || substr(${hash}, 21, 12))::uuid`
}
/** SEED-SO-0001 copied as `number` for `partyId` (its lines and sizes too), `adjust` run on the copied lines first. */
const copyOrderSql = (number: string, partyId: string, adjust = ''): string => {
  const salt = number.toLowerCase()
  return `
    CREATE TEMP TABLE o AS SELECT * FROM "SalesOrder" WHERE "tenantId" = '${tenant}' AND number = 'SEED-SO-0001';
    CREATE TEMP TABLE l AS SELECT * FROM "SalesOrderLine" WHERE "orderId" = (SELECT id FROM o);
    CREATE TEMP TABLE s AS SELECT * FROM "SalesOrderLineSize" WHERE "lineId" IN (SELECT id FROM l);
    UPDATE s SET id = ${v4('id', salt)}, "lineId" = ${v4('"lineId"', salt)}, "partyId" = '${partyId}';
    UPDATE l SET id = ${v4('id', salt)}, "orderId" = ${v4('"orderId"', salt)}, "partyId" = '${partyId}', "quoteLineId" = NULL, "styleRevisionId" = NULL;
    ${adjust}
    UPDATE o SET id = ${v4('id', salt)}, "partyId" = '${partyId}', number = '${number}', "quoteVersionId" = NULL, "customerRef" = NULL;
    INSERT INTO "SalesOrder" SELECT * FROM o;
    INSERT INTO "SalesOrderLine" SELECT * FROM l;
    INSERT INTO "SalesOrderLineSize" SELECT * FROM s;
    DROP TABLE o, l, s;`
}
/** Issues the draft TD24 as allocateNumber and the issue do: its series' next number, the allocation row, the series moved on. */
const issueDraftTd24Sql = (): string => `
  DO $issue$
  DECLARE inv record; ser record; formatted text;
  BEGIN
    SELECT * INTO inv FROM "Invoice" WHERE "tenantId" = '${tenant}' AND "docType" = 'TD24' AND status = 'DRAFT' LIMIT 1;
    SELECT * INTO ser FROM "NumberSeries" WHERE "tenantId" = '${tenant}' AND "companyId" = inv."companyId" AND kind = 'INVOICE' AND status = 'ACTIVE' LIMIT 1;
    formatted := 'FT-' || to_char(current_date, 'YYYY') || '-' || lpad(ser."nextValue"::text, 5, '0');
    INSERT INTO "NumberAllocation" (id, "tenantId", "companyId", "seriesId", kind, value, formatted, "documentDate", "recordType", "recordId", "allocatedAt", "allocatedById", "requestId")
      VALUES (gen_random_uuid(), inv."tenantId", inv."companyId", ser.id, 'INVOICE', ser."nextValue", formatted, current_date, 'Invoice', inv.id, now(), '${id('actor')}', 'test-th1a-issue');
    UPDATE "NumberSeries" SET "nextValue" = ser."nextValue" + 1, "lastIssuedDate" = current_date WHERE id = ser.id;
    UPDATE "Invoice" SET status = 'ISSUED', "numberSeriesId" = ser.id, number = formatted, year = extract(year FROM current_date)::int, "issueDate" = current_date,
      "issuedAt" = now(), "issuedById" = '${id('actor')}', "partyId" = inv."buyerPartyId", version = inv.version + 1,
      seller = (SELECT seller FROM "Invoice" WHERE "tenantId" = '${tenant}' AND "docType" = 'TD01' AND status <> 'DRAFT' LIMIT 1)
      WHERE id = inv.id;
  END
  $issue$;`
const orderId = async (number: string): Promise<string> => (await admin<{ id: string }>('SELECT id FROM "SalesOrder" WHERE number = $1', [number]))[0]!.id

beforeAll(async () => {
  db = await migratedDatabase('orders_row_extras')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedMoney({ db: database, namespace: NS })
  await seedStylesDepth({ db: database, namespace: NS })
  await seedOptions({ db: database, namespace: NS }) // the own-collection liner SEED-LNR-01
  // TEST-SO-R1: SEED-SO-0001 copied for SEED-R1, its first line the own-collection liner (no main picture).
  await admin(copyOrderSql('TEST-SO-R1', R1, `UPDATE l SET "styleId" = (SELECT id FROM "Style" WHERE "tenantId" = '${tenant}' AND code = 'SEED-LNR-01'),
      "colourwayId" = (SELECT c.id FROM "Colourway" c JOIN "Style" st ON st.id = c."styleId" WHERE st."tenantId" = '${tenant}' AND st.code = 'SEED-LNR-01' ORDER BY c.id LIMIT 1)
      WHERE seq = (SELECT min(seq) FROM l);`))
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-row-extras-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useGateway(gateway)
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 600_000)

afterAll(async () => {
  useFiles(undefined)
  useGateway(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

describe('the row carries the picture, the label, Invoiced and the ids its doors open (B-TH-017)', () => {
  it('for a reader with every right: the first line style\'s main picture, the label, None while nothing is issued, and each door', async () => {
    const mainPicture = (await admin<{ id: string }>(`SELECT f.id FROM "StyleImage" si JOIN "Style" st ON st.id = si."styleId" JOIN "StoredFile" f ON f.id = si."fileId" WHERE st.code = 'SEED-JKT-01' AND si."isMain"`))[0]!.id
    const one = (await rowOf('all', 'SEED-SO-0001'))!
    expect(one.picture).toEqual({ styleId: expect.any(String), styleCode: 'SEED-JKT-01', styleName: expect.any(String), fileId: mainPicture, contentType: 'image/jpeg', small: false })
    expect(one.styleCount).toBe(1)
    expect(one.brands).toEqual([{ partyId: C1, name: 'Seed Customer One S.r.l.', own: false }])
    // The deposit invoice (TD02) is issued, yet the order is not "Part": it bills money in advance, not goods.
    expect(one.invoiced).toEqual({ state: 'NONE', pieces: '0', toInvoice: 12, amount: 0 })
    expect(one.doors.quote).toEqual({ id: one.quote.id, versionId: one.quote.versionId })
    expect(one.doors.depositInvoice).toEqual({ id: expect.any(String), number: expect.stringMatching(/^FT-\d{4}-00003$/) })
    expect(one.doors.invoices).toEqual({ count: 0, only: null })

    const two = (await rowOf('all', 'SEED-SO-0002'))!
    // A DRAFT TD24 of two jackets: still None (only issued invoices count).
    expect(two.invoiced).toEqual({ state: 'NONE', pieces: '0', toInvoice: 7, amount: 0 })
    const shipment = (await admin<{ id: string }>(`SELECT id FROM "Shipment" WHERE number = 'SEED-SH-0001'`))[0]!.id
    // DDT 143 was cancelled: only 144 opens.
    expect(two.doors.deliveryNotes).toEqual({ count: 1, only: { id: expect.any(String), number: expect.stringMatching(/^144\//) }, shipmentId: shipment })

    const rider = (await rowOf('all', 'TEST-SO-R1'))!
    expect(rider.picture).toMatchObject({ styleCode: 'SEED-LNR-01', fileId: null, contentType: null, small: false })
    expect(rider.styleCount).toBe(2)
    // Mixed labels: the private label first, our own collection last.
    expect(rider.brands).toEqual([{ partyId: C1, name: 'Seed Customer One S.r.l.', own: false }, { partyId: null, name: null, own: true }])
    expect(rider.partyName).toBe('Seed Private Rider')
  })

  it('opens only what the reader may open: the doors are null without their right, the words stay', async () => {
    const sales = (await rowOf('sales', 'SEED-SO-0001'))!
    expect(sales.doors).toEqual({ quote: null, depositInvoice: null, deliveryNotes: null, invoices: null })
    expect(sales.quote.number).toEqual(expect.any(String))
    expect(sales.deposit.state).toEqual(expect.any(String))
    // No price grain: the state and the pieces, never the amount.
    expect(sales.invoiced).toEqual({ state: 'NONE', pieces: '0', toInvoice: 12 })
    expect(sales.picture.fileId).not.toBeNull()
    const finance = (await rowOf('finance', 'SEED-SO-0002'))!
    expect(finance.doors.quote).toBeNull()
    expect(finance.doors.deliveryNotes.count).toBe(1)
    expect(finance.invoiced).not.toHaveProperty('amount')
    // Without files.read the row names no file: the placeholder.
    expect((await rowOf('noFiles', 'SEED-SO-0001'))!.picture).toMatchObject({ styleCode: 'SEED-JKT-01', fileId: null, small: false })
  })

  it('Invoiced counts the pieces of issued invoices: the TD24 issued makes SEED-SO-0002 Part, with its invoice behind the door', async () => {
    await admin(issueDraftTd24Sql())
    const issued = (await admin<{ number: string }>(`SELECT number FROM "Invoice" WHERE "tenantId" = $1 AND "docType" = 'TD24'`, [tenant]))[0]!.number
    const two = (await rowOf('all', 'SEED-SO-0002'))!
    expect(two.invoiced).toEqual({ state: 'PART', pieces: '2', toInvoice: 7, amount: 80000 })
    expect(two.doors.invoices).toEqual({ count: 1, only: { id: expect.any(String), number: issued, docType: 'TD24' } })
    expect((await rowOf('finance', 'SEED-SO-0002'))!.invoiced).toEqual({ state: 'PART', pieces: '2', toInvoice: 7 })
    expect((await rowOf('sales', 'SEED-SO-0002'))!.doors.invoices).toBeNull()
  })
})

describe('the brand wall (W27): a person limited to one customer', () => {
  it('limited to SEED-R1: only its order, and no name of the other customer, not even as the label of a garment', async () => {
    const answer = await ok('onlyR1', '/sales/orders?limit=200')
    expect((answer.orders as Json[]).map((row) => row.number)).toEqual(['TEST-SO-R1'])
    const rider = answer.orders[0] as Json
    expect(rider.brands).toEqual([{ partyId: null, name: null, own: false }, { partyId: null, name: null, own: true }])
    expect(JSON.stringify(answer)).not.toContain('Seed Customer One')
    expect(JSON.stringify(answer)).not.toContain(C1)
  })

  it('limited to SEED-C1: no row, picture or name of SEED-R1', async () => {
    const answer = await ok('onlyC1', '/sales/orders?limit=200')
    expect((answer.orders as Json[]).map((row) => row.number)).not.toContain('TEST-SO-R1')
    expect(JSON.stringify(answer)).not.toContain('Seed Private Rider')
    expect(JSON.stringify(answer)).not.toContain(R1)
  })
})

describe('the Picture cell reads the small preview, never the original (B-TH-017 with B-TH-063)', () => {
  it('names no preview until the stripped copy exists, then a presigned address of the small one', async () => {
    const order = await orderId('SEED-SO-0001')
    const before = await ok('all', `/sales/orders/${order}/picture`)
    expect(before.picture).toMatchObject({ contentType: 'image/jpeg', small: null })
    const fileId = before.picture.fileId as string
    // The strip job's result, as it records it: the copy's key; its small preview under the derived key.
    const file = (await admin<{ storageKey: string; storeAccountId: string }>('SELECT "storageKey", "storeAccountId" FROM "StoredFile" WHERE id = $1', [fileId]))[0]!
    const thumbnailKey = file.storageKey.replace(/[0-9a-f-]{36}$/, newId())
    await admin(`UPDATE "StoredFile" SET "thumbnailKey" = $2, "exifStrippedAt" = now() WHERE id = $1`, [fileId, thumbnailKey])
    const small = Buffer.from('made-up small preview bytes')
    const caller = callerFor(database, { audience: 'office', tenantId: tenant, actorId: newId(), grants: [], requestId: newId() })
    await processFiles().storage.put(caller, file.storeAccountId, { key: smallKeyOf(thumbnailKey), contentType: 'image/jpeg', body: small, sha256: createHash('sha256').update(small).digest('hex') })

    expect((await rowOf('all', 'SEED-SO-0001'))!.picture.small).toBe(true)
    const after = await ok('all', `/sales/orders/${order}/picture`)
    expect(after.picture).toMatchObject({ fileId, contentType: 'image/jpeg', small: { method: 'GET', url: expect.any(String), expiresAt: expect.any(String) } })
    const fetched = await app.inject({ method: 'GET', url: after.picture.small.url })
    expect(fetched.statusCode).toBe(200)
    expect(fetched.rawPayload.equals(small)).toBe(true)
  })

  it('only to a reader of the order and of its file; an order without a main picture has none to show', async () => {
    const order = await orderId('SEED-SO-0001')
    expect((await call('noFiles', `/sales/orders/${order}/picture`)).statusCode).toBe(404)
    // A person limited to the other customer: the order is not found, as anywhere else.
    expect((await call('onlyR1', `/sales/orders/${order}/picture`)).statusCode).toBe(404)
    expect((await call('partner', `/sales/orders/${order}/picture`)).statusCode).toBe(403)
    const none = await call('all', `/sales/orders/${await orderId('TEST-SO-R1')}/picture`)
    expect(none.statusCode).toBe(404)
    expect(none.json().error.message).toBe('This order has no picture to show.')
    expect((await call('all', '/sales/orders/not-an-id/picture')).statusCode).toBe(400)
  })
})
