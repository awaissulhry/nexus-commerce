import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedMoney } from '../../../../../../packages/factory-db/seed/money'
import { seed as seedOptions } from '../../../../../../packages/factory-db/seed/options'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedSalesIntake } from '../../../../../../packages/factory-db/seed/sales-intake'
import { seed as seedStylesDepth } from '../../../../../../packages/factory-db/seed/styles-depth'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createFilesRuntime, processFiles, useFiles } from '../../../platform/files/service'
import { smallKeyOf } from '../../../platform/files/thumbs/small'
import { createGateway } from '../../../platform/gateway/gateway'
import { useGateway } from '../../../platform/gateway/service'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'

/**
 * B-SA-011 (sales page plan N8, picks P13, P18, R9; 12-lists-board §2.5; review C-12, BW-8) with B-SA-013 (the three single-row
 * picture routes went; their cases are here): the small pictures of a page of records in ONE read — POST /sales/orders/pictures,
 * /sales/quotes/pictures and /sales/inquiries/pictures, one helper (modules/product/images/small-pictures.ts), one answer shape —
 * through the app's real routes on a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security
 * is real), the files on the local store behind the gateway (every presign writes its ledger row), on the factory-db seeds up to
 * the sales intake and the styles' pictures:
 *   SEED-SO-0001  customer SEED-C1 (P1), first line SEED-JKT-01 — P1's own private-label jacket, whose photo is the main picture;
 *   TEST-SO-C1B   SEED-SO-0001 copied for SEED-C1 (the same style: one presign for both);
 *   TEST-SO-R1    SEED-SO-0001 copied for SEED-R1 (P4), every line the own-collection liner SEED-LNR-01 (no main picture);
 *   the quote of SEED-SO-0001 (P1); SEED-INQ-0004 (P1's line for SEED-JKT-01); SEED-INQ-0001 (a prospect's lines in words).
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/orders/pictures`.
 */

vi.setConfig({ testTimeout: 120_000 })

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string

const NS = 'sa011-pictures'
const id = (key: string): string => seedUuid(NS, key)
const tenant = id('tenant')
const C1 = id('party:P1')
const P3 = id('party:P3')
const R1 = id('party:P4')

const grant = (permissions: readonly Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const office = (permissions: readonly Permission[], parties: Grant['parties'] = 'all') => (): SessionContext => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(permissions, parties)] })
const READS: Permission[] = ['orders.view', 'quotes.view', 'sales.inquiries.view', 'files.read']
const SESSIONS: Record<string, () => SessionContext> = {
  all: office(READS),
  // Reads the records, not their files: the style, never its file.
  noFiles: office(READS.filter((name) => name !== 'files.read')),
  // Brand Alpha's people (a rider's team: SEED-C1) and two other customers'.
  onlyC1: office(READS, [C1]),
  onlyR1: office(READS, [R1]),
  onlyP3: office(READS, [P3]),
  partner: () => ({ audience: 'partner', tenantId: tenant, actorId: newId(), partyId: C1, grants: [grant(READS, [C1])] }),
}

type Json = Record<string, any>
const run = randomBytes(4).toString('hex')
let serial = 0
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const post = (session: string, url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object, headers: { 'x-test-session': session, 'idempotency-key': `sa011-${run}-${++serial}` } })
async function pictures(session: string, route: 'orders' | 'quotes' | 'inquiries', ids: readonly string[]): Promise<Json[]> {
  const key = route === 'orders' ? 'orderIds' : route === 'quotes' ? 'quoteIds' : 'inquiryIds'
  const response = await post(session, `/sales/${route}/pictures`, { [key]: ids })
  expect(response.statusCode, response.body).toBe(200)
  const answer = response.json()
  expect(Date.parse(answer.asOf)).not.toBeNaN()
  return answer.pictures as Json[]
}
const idOf = async (table: 'SalesOrder' | 'Inquiry', number: string): Promise<string> => (await admin<{ id: string }>(`SELECT id FROM "${table}" WHERE "tenantId" = $1 AND number = $2`, [tenant, number]))[0]!.id
/** The quote SEED-SO-0001 was accepted from. */
const quoteOfOrder = async (): Promise<string> =>
  (await admin<{ id: string }>(`SELECT v."quoteId" AS id FROM "SalesOrder" o JOIN "QuoteVersion" v ON v.id = o."quoteVersionId" WHERE o."tenantId" = $1 AND o.number = 'SEED-SO-0001'`, [tenant]))[0]!.id
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
/** The ledger rows of the presigns of one small preview (the gateway writes one per store call). */
const presignsOf = async (key: string): Promise<number> =>
  Number((await admin<{ n: string }>(`SELECT count(*) AS n FROM "IntegrationCall" WHERE operation = 'files.presign_download' AND "requestSummary"->>'key' = $1`, [key]))[0]!.n)

const SMALL = Buffer.from('made-up small preview bytes')
let smallKey = ''

beforeAll(async () => {
  db = await migratedDatabase('sales_pictures')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  // In the CLI's name order (each seed runs the ones it builds on itself).
  await seedCore({ db: database, namespace: NS })
  await seedAuth({ db: database, namespace: NS })
  await seedMoney({ db: database, namespace: NS })
  await seedOptions({ db: database, namespace: NS }) // the own-collection liner SEED-LNR-01
  await seedRoles({ db: database, namespace: NS })
  await seedSalesIntake({ db: database, namespace: NS })
  await seedStylesDepth({ db: database, namespace: NS })
  await admin(copyOrderSql('TEST-SO-C1B', C1))
  // Every line the liner: P1's private-label jacket stays on P1's orders only (BW-8).
  await admin(
    copyOrderSql(
      'TEST-SO-R1',
      R1,
      `UPDATE l SET "styleId" = (SELECT id FROM "Style" WHERE "tenantId" = '${tenant}' AND code = 'SEED-LNR-01'),
        "colourwayId" = (SELECT c.id FROM "Colourway" c JOIN "Style" st ON st.id = c."styleId" WHERE st."tenantId" = '${tenant}' AND st.code = 'SEED-LNR-01' ORDER BY c.id LIMIT 1);`,
    ),
  )
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-sales-pictures-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useGateway(gateway)
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 900_000)

afterAll(async () => {
  useFiles(undefined)
  useGateway(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

describe('one read for a page of records, one answer shape (B-SA-011)', () => {
  it('each route names the record\'s first style, its count of styles and its main picture; no preview yet: small null', async () => {
    const [order, quote, request] = [await idOf('SalesOrder', 'SEED-SO-0001'), await quoteOfOrder(), await idOf('Inquiry', 'SEED-INQ-0004')]
    for (const [route, recordId] of [['orders', order], ['quotes', quote], ['inquiries', request]] as const) {
      const [one, ...rest] = await pictures('all', route, [recordId])
      expect(rest, route).toEqual([])
      expect(one, route).toMatchObject({ id: recordId, styleId: expect.any(String), styleCode: 'SEED-JKT-01', styleName: expect.any(String), fileId: expect.any(String), contentType: expect.stringMatching(/^image\//), small: null })
      expect(one.styleCount, route).toBeGreaterThanOrEqual(1)
      // The one shape: nothing else on a picture.
      expect(Object.keys(one).sort(), route).toEqual(['contentType', 'fileId', 'id', 'small', 'styleCode', 'styleCount', 'styleId', 'styleName'])
    }
  })

  it('once the small preview exists: its presigned address — the small bytes, never the original; two orders of one style, one presign', async () => {
    const [order, copy] = [await idOf('SalesOrder', 'SEED-SO-0001'), await idOf('SalesOrder', 'TEST-SO-C1B')]
    const [before] = await pictures('all', 'orders', [order])
    const fileId = before!.fileId as string
    // The strip job's result, as it records it: the copy's key; its small preview under the derived key.
    const file = (await admin<{ storageKey: string; storeAccountId: string }>('SELECT "storageKey", "storeAccountId" FROM "StoredFile" WHERE id = $1', [fileId]))[0]!
    const thumbnailKey = file.storageKey.replace(/[0-9a-f-]{36}$/, newId())
    await admin(`UPDATE "StoredFile" SET "thumbnailKey" = $2, "exifStrippedAt" = now() WHERE id = $1`, [fileId, thumbnailKey])
    smallKey = smallKeyOf(thumbnailKey)
    const caller = callerFor(database, { audience: 'office', tenantId: tenant, actorId: newId(), grants: [], requestId: newId() })
    await processFiles().storage.put(caller, file.storeAccountId, { key: smallKey, contentType: 'image/jpeg', body: SMALL, sha256: createHash('sha256').update(SMALL).digest('hex') })

    const presigned = await presignsOf(smallKey)
    const both = await pictures('all', 'orders', [copy, order])
    // In the asked order; one file, one address, ONE presign (one ledger row) for the two orders.
    expect(both.map((picture) => picture.id)).toEqual([copy, order])
    expect(new Set(both.map((picture) => picture.fileId))).toEqual(new Set([fileId]))
    expect(both[0]!.small).toEqual({ url: expect.any(String), expiresAt: expect.any(String) })
    expect(both[1]!.small).toEqual(both[0]!.small)
    expect(await presignsOf(smallKey)).toBe(presigned + 1)
    expect(Date.parse(both[0]!.small.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000)
    const fetched = await app.inject({ method: 'GET', url: both[0]!.small.url })
    expect(fetched.statusCode).toBe(200)
    expect(fetched.rawPayload.equals(SMALL)).toBe(true)
    // The quote and the request of the same style read the same small preview.
    expect((await pictures('all', 'quotes', [await quoteOfOrder()]))[0]).toMatchObject({ fileId, small: { url: expect.any(String) } })
    expect((await pictures('all', 'inquiries', [await idOf('Inquiry', 'SEED-INQ-0004')]))[0]).toMatchObject({ fileId, small: { url: expect.any(String) } })
  })

  it('a record without a main picture names its style and no file; one with no style (a request in words) is absent', async () => {
    const [liner] = await pictures('all', 'orders', [await idOf('SalesOrder', 'TEST-SO-R1')])
    expect(liner).toMatchObject({ styleCode: 'SEED-LNR-01', fileId: null, contentType: null, small: null })
    expect(await pictures('all', 'inquiries', [await idOf('Inquiry', 'SEED-INQ-0001')])).toEqual([])
  })

  it('without files.read: the style and its count, never the file or its address', async () => {
    const answer = await pictures('noFiles', 'orders', [await idOf('SalesOrder', 'SEED-SO-0001')])
    expect(answer[0]).toMatchObject({ styleCode: 'SEED-JKT-01', fileId: null, contentType: null, small: null })
    expect(JSON.stringify(answer)).not.toContain('"url"')
    expect((await pictures('noFiles', 'quotes', [await quoteOfOrder()]))[0]).toMatchObject({ fileId: null, small: null })
    expect((await pictures('noFiles', 'inquiries', [await idOf('Inquiry', 'SEED-INQ-0004')]))[0]).toMatchObject({ fileId: null, small: null })
  })

  it('the ids: 200 in one answer; 201, an id twice, an id that is no uuid or none at all: 400 in words', async () => {
    const order = await idOf('SalesOrder', 'SEED-SO-0001')
    const many = [order, ...Array.from({ length: 199 }, () => newId())]
    expect((await pictures('all', 'orders', many)).map((picture) => picture.id)).toEqual([order])
    expect((await post('all', '/sales/orders/pictures', { orderIds: [...many, newId()] })).statusCode).toBe(400)
    const twice = await post('all', '/sales/orders/pictures', { orderIds: [order, order] })
    expect(twice.statusCode).toBe(400)
    expect(twice.json().error.message).toBe('Each id once: the same record was asked twice.')
    expect((await post('all', '/sales/orders/pictures', { orderIds: ['not-an-id'] })).statusCode).toBe(400)
    expect((await post('all', '/sales/orders/pictures', { orderIds: [] })).statusCode).toBe(400)
    expect((await post('all', '/sales/quotes/pictures', { orderIds: [order] })).statusCode).toBe(400)
  })
})

describe('the brand wall: a record the reader may not see is simply absent (B-SA-011; BW-8)', () => {
  it('Brand Alpha\'s people ask for Alpha\'s, another customer\'s and an unknown id: only Alpha\'s answer, nothing of the others', async () => {
    const [alpha, other, unknown] = [await idOf('SalesOrder', 'SEED-SO-0001'), await idOf('SalesOrder', 'TEST-SO-R1'), newId()]
    const answer = await pictures('onlyC1', 'orders', [alpha, other, unknown])
    expect(answer.map((picture) => picture.id)).toEqual([alpha])
    // A rider's team sees its own private-label style's picture (P1's jacket on P1's order).
    expect(answer[0]).toMatchObject({ styleCode: 'SEED-JKT-01', fileId: expect.any(String) })
    expect(JSON.stringify(answer)).not.toContain('SEED-LNR-01')
    // The other way: SEED-R1's people get their own order, nothing of P1's — no style, no file, no address.
    const theirs = await pictures('onlyR1', 'orders', [alpha, other, unknown])
    expect(theirs.map((picture) => picture.id)).toEqual([other])
    expect(JSON.stringify(theirs)).not.toContain('SEED-JKT-01')
    expect(JSON.stringify(theirs)).not.toContain(alpha)
    // An id of another customer answers exactly as an unknown one: an empty list, no count, no error.
    expect(await pictures('onlyP3', 'orders', [alpha])).toEqual([])
    expect(await pictures('onlyP3', 'orders', [unknown])).toEqual([])
  })

  it('quotes and requests alike: another customer\'s quote or request is absent', async () => {
    const [quote, request, prospect] = [await quoteOfOrder(), await idOf('Inquiry', 'SEED-INQ-0004'), await idOf('Inquiry', 'SEED-INQ-0001')]
    expect((await pictures('onlyC1', 'quotes', [quote, newId()])).map((picture) => picture.id)).toEqual([quote])
    expect(await pictures('onlyR1', 'quotes', [quote])).toEqual([])
    expect((await pictures('onlyC1', 'inquiries', [request, prospect, newId()])).map((picture) => picture.id)).toEqual([request])
    const p3 = await pictures('onlyP3', 'inquiries', [request, prospect])
    expect(p3).toEqual([])
    expect(JSON.stringify(p3)).not.toContain('SEED-JKT-01')
  })

  it('a private-label style belongs to one customer: no other customer\'s order holds it (sales line-checks), so no other customer reads its picture', async () => {
    const strays = await admin<{ n: string }>(
      `SELECT count(*) AS n FROM "SalesOrderLine" l JOIN "Style" s ON s.id = l."styleId" WHERE s."tenantId" = $1 AND s."brandPartyId" IS NOT NULL AND l."partyId" <> s."brandPartyId"`,
      [tenant],
    )
    expect(Number(strays[0]!.n)).toBe(0)
    const label = await admin<{ party: string }>(`SELECT "brandPartyId" AS party FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-01'`, [tenant])
    expect(label[0]!.party).toBe(C1)
  })

  it('office only: a portal person is refused by audience (the portal has its own walled reads)', async () => {
    const order = await idOf('SalesOrder', 'SEED-SO-0001')
    expect((await post('partner', '/sales/orders/pictures', { orderIds: [order] })).statusCode).toBe(403)
    expect((await post('partner', '/sales/quotes/pictures', { quoteIds: [await quoteOfOrder()] })).statusCode).toBe(403)
    expect((await post('partner', '/sales/inquiries/pictures', { inquiryIds: [await idOf('Inquiry', 'SEED-INQ-0004')] })).statusCode).toBe(403)
  })
})
