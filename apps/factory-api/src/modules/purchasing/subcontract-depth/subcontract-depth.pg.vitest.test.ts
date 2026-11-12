import { randomBytes } from 'node:crypto'
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
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedSubcontract, type SubcontractSeed } from '../../../../../../packages/factory-db/seed/subcontract'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'

/**
 * Subcontracting in depth (B-W2b-331; SCM-049 written terms, SCM-143/144 the material balance and its adjustment, SCM-145
 * partial returns by bundle, SCM-146 the cost on the work order, SCM-150 days out) on the local stack with the app's real
 * routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: grants, row-level security, the
 * agreement, consumption, cost-entry, stock and cost-ledger triggers are real), the factory-db seeds (WO-0001 IN_PROGRESS,
 * the workshop P2 with its place A1-TERZ-P2, 120 m of grey lining lot SEED-LOT-LIN-01 in A1-STORE-01), the sewing step done
 * by P2 (5.25 a piece), three made-up whole-garment bundles, and sessions from the test authenticator. Every name, number,
 * price and quantity is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/purchasing/subcontract-depth`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let seed: SubcontractSeed

const ns = { a: 'subcontract-depth-a', b: 'subcontract-depth-b' } as const
const idOf = (key: string) => seedUuid(ns.a, key)
const A = {
  tenant: idOf('tenant'),
  companyA: idOf('company:A'),
  siteA1: idOf('site:A1'),
  P1: idOf('party:P1'),
  P2: idOf('party:P2'),
  lining: idOf('product:item:lining'),
  liningGrey: idOf('product:item-colour:lining:GRY'),
}
const YEAR = businessDate(new Date()).slice(0, 4)
const TODAY = businessDate(new Date())
const buyerId = newId()

const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const office = (grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId, grants })
const BUYER: Permission[] = [
  'purchasing.view',
  'purchasing.subcontract.manage',
  'purchasing.subcontract.kit',
  'purchasing.subcontract.receive',
  'purchasing.subcontract.terms',
  'purchasing.subcontract.balance',
  'purchasing.subcontract.cost',
  'money.cost',
  'workorders.view',
  'costing.view',
  'files.read',
]
const SESSIONS: Record<string, SessionContext> = {
  buyer: office([grant(BUYER)], buyerId),
  /** The warehouse: the kit out, goods back and the workshop's declaration; no cost grain, no charges, no terms. */
  warehouse: office([grant(['purchasing.view', 'purchasing.subcontract.kit', 'purchasing.subcontract.receive', 'purchasing.subcontract.balance'])]),
  /** Reads only. */
  planner: office([grant(['purchasing.view'])]),
  /** May book charges but holds no cost grain. */
  blind: office([grant(['purchasing.view', 'purchasing.subcontract.cost'])]),
  /** The buyer's permissions, for the workshop P1 only. */
  otherWorkshop: office([grant(BUYER, [A.P1])]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `subcontract-depth-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const paths = (error: Json) => (error.issues ?? []).map((issue: Json) => issue.path)
const url = (id: string, rest = '') => `/purchasing/subcontracting/orders/${id}${rest}`
const eventsOf = async (subject: string) => (await admin<{ type: string }>('SELECT type FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])).map((row) => row.type)
const atWorkshop = async () =>
  (await admin<{ n: string }>(
    `SELECT (coalesce((SELECT sum("baseQuantity") FROM "StockMove" WHERE "toLocationId" = $1 AND "lotId" = $2), 0) - coalesce((SELECT sum("baseQuantity") FROM "StockMove" WHERE "fromLocationId" = $1 AND "lotId" = $2), 0))::numeric(18,4)::text AS n`,
    [seed.locationId, liningLot],
  ))[0]!.n
const ledgerSum = async (orderId: string) => (await admin<{ n: string }>(`SELECT coalesce(sum(amount), 0)::text AS n FROM "WorkOrderCostEntry" WHERE "subcontractOrderId" = $1 AND kind = 'SUBCONTRACT'`, [orderId]))[0]!.n

let bin = ''
let liningLot = ''
let bundles: { id: string; code: string; quantity: number }[] = []
let fileAccount = ''
const fileOf = async (recordType: string, recordId: string, status = 'AVAILABLE') => {
  const fileId = newId()
  await admin(
    `INSERT INTO "StoredFile" (id, "tenantId", "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256, "storeAccountId", "storageKey", status, "availableAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, 'DOCUMENT', 'terms signed.pdf', 'application/pdf', 1200, $6, $7, $8, $9::"FileStatus", CASE WHEN $9 = 'AVAILABLE' THEN now() END, now())`,
    [fileId, A.tenant, A.companyA, recordType, recordId, 'b'.repeat(64), fileAccount, `t/${fileId}`, status],
  )
  return fileId
}

beforeAll(async () => {
  db = await migratedDatabase('subcontract_depth')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 10 } })
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: database, namespace })
  seed = await seedSubcontract({ db: database, namespace: ns.a })
  await seedNumbering({ db: database, namespace: ns.a })
  bin = (await admin<{ id: string }>(`SELECT id FROM "Location" WHERE "tenantId" = $1 AND code = 'A1-STORE-01'`, [A.tenant]))[0]!.id
  liningLot = (await admin<{ id: string }>(`SELECT id FROM "Lot" WHERE "tenantId" = $1 AND code = 'SEED-LOT-LIN-01'`, [A.tenant]))[0]!.id
  // The released revision's sewing step done by the workshop P2 (a released routing is frozen: its guard is off for this).
  await admin(`ALTER TABLE "RoutingOperation" DISABLE TRIGGER "RoutingOperation_revision_guard"`)
  await admin(
    `UPDATE "RoutingOperation" r SET "supplierId" = $1, "pricePerPiece" = 5.25, "transitDays" = 7
       FROM "WorkOrderOperation" o WHERE o.id = $2 AND r."revisionId" = o."styleRevisionId" AND r.seq = o."routingSeq"`,
    [A.P2, seed.production.operationIds.sew],
  )
  await admin(`ALTER TABLE "RoutingOperation" ENABLE TRIGGER "RoutingOperation_revision_guard"`)
  // Three made-up whole-garment bundles of the work order (2, 1 and 1 garments): the first two go out, the third never.
  const cells = await admin<{ id: string }>(`SELECT id FROM "WorkOrderSize" WHERE "workOrderId" = $1 ORDER BY id LIMIT 3`, [seed.production.workOrderId])
  for (const [index, quantity] of [2, 1, 1].entries()) {
    await admin(`INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [newId(), A.tenant, A.siteA1, seed.production.workOrderId, cells[index]!.id, `T-SD-${run}-${index + 1}`, quantity])
  }
  bundles = await admin(`SELECT id, code, quantity FROM "Bundle" WHERE "workOrderId" = $1 AND code LIKE 'T-SD-%' ORDER BY code`, [seed.production.workOrderId])
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'SUBCONTRACT', 'MAIN', $4, 'YEARLY', 'SC-{YYYY}-{N:4}', false) ON CONFLICT DO NOTHING`, [newId(), A.tenant, A.companyA, YEAR])
  await admin(`UPDATE "NumberSeries" SET "lastIssuedDate" = NULL WHERE "tenantId" = $1 AND kind = 'SUBCONTRACT'`, [A.tenant])
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, 'Made-up buyer', 'ACTIVE')`, [buyerId, A.tenant, `${buyerId}@example.test`])
  if ((await admin(`SELECT 1 FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [A.tenant])).length === 0) {
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), A.tenant])
  }
  fileAccount = (await admin<{ id: string }>(`SELECT id FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2' LIMIT 1`, [A.tenant]))[0]!.id
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-subcontract-depth-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
  // The seed's draft holds the sewing's pieces: cancelled; the test's own order is made, its lining kit planned, issued.
  const seedOrder = (await ok('buyer', 'GET', url(seed.orderId))).order
  await ok('buyer', 'POST', url(seed.orderId, '/cancel'), { version: seedOrder.version, reason: 'Made again for the subcontract depth test' })
  order = (await ok('buyer', 'POST', '/purchasing/subcontracting/orders', { workOrderId: seed.production.workOrderId, operations: [{ workOrderOperationId: seed.production.operationIds.sew }] }, 201)).order
  order = (await ok('buyer', 'POST', url(order.id, '/kit'), { version: order.version, lines: [{ itemId: A.lining, itemColourId: A.liningGrey, lotId: liningLot, quantity: '12.6' }] }, 201)).order
  order = (await ok('buyer', 'POST', url(order.id, '/issue'), { version: order.version })).order
}, 240_000)

afterAll(async () => {
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

let order: Json
let kitLineId = ''
const fresh = async () => (order = (await ok('buyer', 'GET', url(order.id))).order)

describe('the written terms with a workshop (SCM-049, L. 192/1998 art. 2)', () => {
  let first: Json
  it('says in words that no written terms cover the order yet', async () => {
    const terms = await ok('planner', 'GET', url(order.id, '/terms'))
    expect(terms).toMatchObject({ covering: null, law: 'L. 192/1998 art. 2', revisions: [] })
    expect(terms.words).toContain('L. 192/1998 art. 2')
  })

  it('writes a numbered draft for the company and the workshop; refuses a party that is no workshop, and a reader', async () => {
    first = (await ok('buyer', 'POST', '/purchasing/subcontracting/agreements', { companyId: A.companyA, partyId: A.P2, title: 'Contratto di subfornitura 2026', validFrom: `${YEAR}-01-01` }, 201)).agreement
    expect(first).toMatchObject({ revision: 1, status: 'DRAFT', workshop: { id: A.P2 }, file: null, inForceToday: false, actions: { sign: expect.stringContaining('Attach the signed terms') } })
    const notWorkshop = await refused('buyer', 'POST', '/purchasing/subcontracting/agreements', { companyId: A.companyA, partyId: A.P1, title: 'Terms', validFrom: TODAY }, 400)
    expect(notWorkshop.message).toContain('no subcontractor')
    await refused('planner', 'POST', '/purchasing/subcontracting/agreements', { companyId: A.companyA, partyId: A.P2, title: 'Terms', validFrom: TODAY }, 403)
    expect(paths(await refused('buyer', 'POST', '/purchasing/subcontracting/agreements', { companyId: A.companyA, partyId: A.P2, title: 'Terms', validFrom: TODAY, validUntil: `${Number(YEAR) - 1}-12-31` }, 400))).toEqual(['body/validUntil'])
    expect((await ok('planner', 'GET', `/purchasing/subcontracting/agreements?partyId=${A.P2}`)).items.map((row: Json) => row.revision)).toEqual([1])
    expect((await ok('otherWorkshop', 'GET', `/purchasing/subcontracting/agreements?partyId=${A.P2}`)).items).toEqual([])
    await refused('otherWorkshop', 'GET', `/purchasing/subcontracting/agreements/${first.id}`, undefined, 404)
  })

  it('signs only with an available file of the revision, then keeps the file ten years; the order links to the signed terms', async () => {
    expect(paths(await refused('buyer', 'POST', `/purchasing/subcontracting/agreements/${first.id}/sign`, { version: first.version }, 400))).toEqual(['body/termsFileId'])
    const pending = await fileOf('SubcontractAgreement', first.id, 'PENDING_UPLOAD')
    expect((await refused('buyer', 'POST', `/purchasing/subcontracting/agreements/${first.id}/sign`, { version: first.version, termsFileId: pending }, 400)).message).toContain('finish its upload')
    const elsewhere = await fileOf('Party', A.P1)
    expect((await refused('buyer', 'POST', `/purchasing/subcontracting/agreements/${first.id}/sign`, { version: first.version, termsFileId: elsewhere }, 400)).message).toContain('file of this revision or of its workshop')
    const fileId = await fileOf('SubcontractAgreement', first.id)
    first = (await ok('buyer', 'POST', `/purchasing/subcontracting/agreements/${first.id}/sign`, { version: first.version, termsFileId: fileId })).agreement
    expect(first).toMatchObject({ status: 'SIGNED', file: { id: fileId }, inForceToday: true, actions: { edit: expect.stringContaining('fixed'), terminate: null } })
    const [kept] = await admin<{ until: string }>(`SELECT "retainUntil"::date::text AS until FROM "StoredFile" WHERE id = $1`, [fileId])
    expect(Number(kept!.until.slice(0, 4))).toBeGreaterThanOrEqual(Number(YEAR) + 9)
    const terms = await ok('planner', 'GET', url(order.id, '/terms'))
    expect(terms).toMatchObject({ covering: { id: first.id, revision: 1 }, words: null })
    expect((await refused('buyer', 'PATCH', `/purchasing/subcontracting/agreements/${first.id}`, { version: first.version, title: 'Changed' }, 409)).message).toContain('fixed')
    expect((await refused('buyer', 'DELETE', `/purchasing/subcontracting/agreements/${first.id}?version=${first.version}`, undefined, 409)).message).toContain('fixed')
  })

  it('signs the next revision and supersedes the one in force in the same act; a draft is deleted; the signed one ends with why', async () => {
    let second = (await ok('buyer', 'POST', '/purchasing/subcontracting/agreements', { companyId: A.companyA, partyId: A.P2, title: 'Contratto di subfornitura 2026-2027', validFrom: TODAY }, 201)).agreement
    expect(second.revision).toBe(2)
    second = (await ok('buyer', 'PATCH', `/purchasing/subcontracting/agreements/${second.id}`, { version: second.version, termsFileId: await fileOf('Party', A.P2) })).agreement
    second = (await ok('buyer', 'POST', `/purchasing/subcontracting/agreements/${second.id}/sign`, { version: second.version })).agreement
    expect(second).toMatchObject({ status: 'SIGNED', inForceToday: true })
    const list = (await ok('buyer', 'GET', `/purchasing/subcontracting/agreements?partyId=${A.P2}`)).items
    expect(list.map((row: Json) => [row.revision, row.status])).toEqual([
      [2, 'SIGNED'],
      [1, 'SUPERSEDED'],
    ])
    expect(list[1].endReason).toContain('Replaced by revision 2')
    expect((await ok('planner', 'GET', url(order.id, '/terms'))).covering).toMatchObject({ revision: 2 })
    const third = (await ok('buyer', 'POST', '/purchasing/subcontracting/agreements', { companyId: A.companyA, partyId: A.P2, title: 'Draft 2027', validFrom: `${Number(YEAR) + 1}-01-01` }, 201)).agreement
    expect((await ok('buyer', 'DELETE', `/purchasing/subcontracting/agreements/${third.id}?version=${third.version}`)).deleted).toBe(third.id)
    expect(paths(await refused('buyer', 'POST', `/purchasing/subcontracting/agreements/${second.id}/terminate`, { version: second.version, reason: ' ' }, 400))).toEqual(['body/reason'])
    const ended = (await ok('buyer', 'POST', `/purchasing/subcontracting/agreements/${second.id}/terminate`, { version: second.version, reason: 'The workshop closed its sewing line (made-up).' })).agreement
    expect(ended).toMatchObject({ status: 'TERMINATED', inForceToday: false, endReason: 'The workshop closed its sewing line (made-up).' })
    expect((await ok('planner', 'GET', url(order.id, '/terms'))).covering).toBeNull()
    expect(await eventsOf(second.id)).toEqual(['subcontract_agreement.changed', 'subcontract_agreement.changed', 'subcontract_agreement.changed', 'subcontract_agreement.changed'])
  })
})

describe('the kit out, partial returns by bundle (SCM-145) and the workshop’s kit check (TZ1:01)', () => {
  it('sends the lining and two bundles; the balance starts with what was sent', async () => {
    await fresh()
    const line = order.kitLines[0]
    kitLineId = line.id
    order = (
      await ok('warehouse', 'POST', url(order.id, '/kit/send'), {
        version: order.version,
        lines: [{ lineId: line.id, fromLocationId: bin }],
        pieces: [{ operationId: order.operations[0].id, pieces: 7 }],
        bundles: bundles.slice(0, 2).map((bundle) => ({ bundleId: bundle.id })),
        ddt: null,
      }, 201)
    ).order
    expect(order.status).toBe('AT_WORKSHOP')
    const balance = await ok('planner', 'GET', url(order.id, '/balance'))
    expect(balance).toMatchObject({ balanceOpen: false, order: { allBack: false, someBack: false } })
    expect(balance.lines).toEqual([expect.objectContaining({ kitLineId, sent: '12.6000', used: '0.0000', open: '12.6000', flags: [], daysOut: 0, checkedByWorkshop: null, actions: { declare: expect.stringContaining('purchasing.subcontract.balance'), adjust: expect.any(String) } })])
    expect(await atWorkshop()).toBe('12.6000')
    const out = await ok('planner', 'GET', url(order.id, '/bundles'))
    expect(out).toMatchObject({ onRecord: true, counts: { out: 2, partlyBack: 0, back: 0 } })
  })

  it('reads the workshop’s kit check and what its send-back announces', async () => {
    // Set-up: the workshop's kit check and its send-back notice as B-W2b-176's acts write them (the live check walks those
    // routes; this test app has no office sign-in, which their links need).
    await admin(`UPDATE "SubcontractKitLine" SET "receivedByWorkshopAt" = now(), "receivedByWorkshopQuantity" = 12.4, "receivedByWorkshopNote" = 'Short by 20 cm on arrival (made-up).' WHERE id = $1`, [kitLineId])
    await admin(
      `INSERT INTO "SubcontractReturnNotice" (id, "tenantId", "siteId", "workOrderId", "partyId", "subcontractOrderId", seq, quantities, "materialBack", parcels, "expectedDate", "announcedByName", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7::jsonb, $8::jsonb, 1, $9::date, 'Rosa (made-up)', now())`,
      [newId(), A.tenant, A.siteA1, seed.production.workOrderId, A.P2, order.id, JSON.stringify([{ subcontractOperationId: order.operations[0].id, bundleId: bundles[0]!.id, finished: 2, scrapped: 0 }]), JSON.stringify([{ kitLineId, quantity: '2.0000' }]), TODAY],
    )
    const line = (await ok('buyer', 'GET', url(order.id, '/balance'))).lines[0]
    expect(line).toMatchObject({ checkedByWorkshop: { quantity: '12.4000' }, short: '-0.2000', announcedBack: '2.0000' })
    expect(line.flags.map((flag: Json) => flag.flag)).toEqual(['SHORT_AT_WORKSHOP'])
  })

  it('takes a bundle back in part: only bundles the order sent, never more of one than it carried out', async () => {
    await fresh()
    const operationId = order.operations[0].id
    const never = await refused('warehouse', 'POST', url(order.id, '/receive'), { version: order.version, lines: [{ operationId, bundleId: bundles[2]!.id, good: 1, defective: 0, scrapped: 0 }] }, 400)
    expect(never.message).toContain('did not go out with this order')
    const back = await ok('warehouse', 'POST', url(order.id, '/receive'), {
      version: order.version,
      lines: [{ operationId, bundleId: bundles[0]!.id, good: 1, defective: 0, scrapped: 0 }],
      returns: [{ itemId: A.lining, itemColourId: A.liningGrey, lotId: liningLot, quantity: '2', toLocationId: bin }],
    }, 201)
    order = back.order
    expect(order.status).toBe('PARTLY_RECEIVED')
    let view = await ok('planner', 'GET', url(order.id, '/bundles'))
    expect(view.counts).toEqual({ out: 1, partlyBack: 1, back: 0 })
    expect(view.bundles.find((row: Json) => row.bundle.id === bundles[0]!.id)).toMatchObject({ garments: 2, state: 'PARTLY_BACK', operations: [expect.objectContaining({ good: 1, back: 1, stillOut: 1 })] })
    const over = await refused('warehouse', 'POST', url(order.id, '/receive'), { version: order.version, lines: [{ operationId, bundleId: bundles[0]!.id, good: 2, defective: 0, scrapped: 0 }] }, 400)
    expect(over.message).toContain('at most 1 more')
    order = (await ok('warehouse', 'POST', url(order.id, '/receive'), { version: order.version, lines: [{ operationId, bundleId: bundles[0]!.id, good: 0, defective: 1, scrapped: 0, reason: 'Open seam' }] }, 201)).order
    view = await ok('planner', 'GET', url(order.id, '/bundles'))
    expect(view.bundles.find((row: Json) => row.bundle.id === bundles[0]!.id)).toMatchObject({ state: 'BACK', receipts: [expect.objectContaining({ seq: 1 }), expect.objectContaining({ seq: 2 })] })
    expect(await atWorkshop()).toBe('10.6000')
  })
})

describe('the material balance per job (SCM-144) and its adjustment after the receipt (SCM-143)', () => {
  it('flags goods back without a declaration and material back the workshop has not declared; suggests the declaration', async () => {
    const balance = await ok('warehouse', 'GET', url(order.id, '/balance'))
    const line = balance.lines[0]
    expect(line).toMatchObject({ backInOurPlaces: '2.0000', open: '12.6000' })
    expect(line.flags.map((flag: Json) => flag.flag)).toEqual(['SHORT_AT_WORKSHOP', 'NOT_DECLARED', 'BACK_NOT_DECLARED'])
    expect(line.suggestion.returned).toBe('2.0000')
    expect(line.actions).toEqual({ declare: null, adjust: expect.stringContaining('book its declaration first') })
  })

  it('books the declaration: the used material leaves the workshop’s place to the work order, the scrap is written off there', async () => {
    await fresh()
    expect(paths(await refused('warehouse', 'POST', url(order.id, '/balance/declare'), { version: order.version, lines: [{ kitLineId, used: '12', returned: '2', scrapped: '0' }] }, 400))).toEqual(['body/lines/0/used'])
    await refused('planner', 'POST', url(order.id, '/balance/declare'), { version: order.version, lines: [{ kitLineId, used: '1', returned: '0', scrapped: '0' }] }, 403)
    await refused('otherWorkshop', 'GET', url(order.id, '/balance'), undefined, 404)
    const receiptId = (await admin<{ id: string }>(`SELECT id FROM "SubcontractReceipt" WHERE "subcontractOrderId" = $1 AND seq = 1`, [order.id]))[0]!.id
    const booked = await ok('warehouse', 'POST', url(order.id, '/balance/declare'), { version: order.version, receiptId, lines: [{ kitLineId, used: '3.6', returned: '2', scrapped: '0.5', reasonCode: 'STAIN', reason: 'A stained panel (made-up).' }] }, 201)
    expect(booked.moveIds).toHaveLength(2)
    const moves = await admin<{ reason: string; q: string; work: string | null }>(`SELECT reason::text AS reason, "baseQuantity"::text AS q, "workOrderId"::text AS work FROM "StockMove" WHERE id = ANY($1::uuid[]) ORDER BY reason`, [booked.moveIds])
    expect(moves).toEqual([
      { reason: 'ISSUE', q: '3.6000', work: seed.production.workOrderId },
      { reason: 'SCRAP', q: '0.5000', work: seed.production.workOrderId },
    ])
    expect(await atWorkshop()).toBe('6.5000')
    const line = booked.balance.lines[0]
    expect(line).toMatchObject({ used: '3.6000', returned: '2.0000', scrapped: '0.5000', open: '6.5000', rows: [expect.objectContaining({ kind: 'DECLARED', receipt: expect.objectContaining({ seq: 1 }), reasonCode: 'STAIN' })] })
    expect(line.flags.map((flag: Json) => flag.flag)).toEqual(['SHORT_AT_WORKSHOP'])
  })

  it('adjusts after the receipt with its reason, in both directions, the stock following: less used, more scrap, scrap taken back', async () => {
    let current = await fresh()
    expect((await refused('warehouse', 'POST', url(current.id, '/balance/adjust'), { version: current.version, kitLineId, used: '-4', reason: 'Too much' }, 400)).message).toContain('below 0')
    expect(paths(await refused('warehouse', 'POST', url(current.id, '/balance/adjust'), { version: current.version, kitLineId, used: '0.1' }, 400))).toEqual(['body/reason'])
    let booked = await ok('warehouse', 'POST', url(current.id, '/balance/adjust'), { version: current.version, kitLineId, used: '-0.1', scrapped: '0.1', reason: 'One sleeve re-cut: the first one scrapped (made-up).' }, 201)
    const reasons = await admin<{ reason: string }>(`SELECT reason::text AS reason FROM "StockMove" WHERE id = ANY($1::uuid[]) ORDER BY reason`, [booked.moveIds])
    expect(reasons.map((row) => row.reason)).toEqual(['RETURN', 'SCRAP'])
    expect(await atWorkshop()).toBe('6.5000')
    current = await fresh()
    booked = await ok('warehouse', 'POST', url(current.id, '/balance/adjust'), { version: current.version, kitLineId, used: '0.3', scrapped: '-0.3', reason: 'The workshop found the scrap was sewn in after all (made-up).' }, 201)
    const back = await admin<{ reason: string; reversal: string | null; q: string }>(`SELECT reason::text AS reason, "reversalOfId"::text AS reversal, "baseQuantity"::text AS q FROM "StockMove" WHERE id = ANY($1::uuid[]) ORDER BY "reversalOfId" NULLS LAST, reason`, [booked.moveIds])
    // The newest scrap (0.1) and the declaration's (0.5) are taken back whole; 0.3 of them is scrapped again; 0.3 used.
    expect(back.filter((row) => row.reversal !== null).map((row) => row.q).sort()).toEqual(['0.1000', '0.5000'])
    expect(back.filter((row) => row.reversal === null).map((row) => [row.reason, row.q]).sort()).toEqual([
      ['ISSUE', '0.3000'],
      ['SCRAP', '0.3000'],
    ])
    expect(await atWorkshop()).toBe('6.5000')
    expect(booked.balance.lines[0]).toMatchObject({ used: '3.8000', scrapped: '0.3000', open: '6.5000' })
    expect(booked.balance.lines[0].rows.map((row: Json) => row.kind)).toEqual(['DECLARED', 'ADJUSTMENT', 'ADJUSTMENT'])
    expect(await eventsOf(current.id)).toEqual(expect.arrayContaining(['subcontract_order.balance_booked']))
  })

  it('reads the stock at the workshop first in, first out: since when, the days out and the buckets (SCM-150)', async () => {
    const ageing = await ok('planner', 'GET', `/purchasing/subcontracting/ageing?partyId=${A.P2}`)
    expect(ageing).toMatchObject({ asOf: TODAY, longOutDays: 60, truncated: false })
    expect(ageing.rows).toEqual([
      expect.objectContaining({ workshop: expect.objectContaining({ id: A.P2 }), location: expect.objectContaining({ id: seed.locationId }), lot: expect.objectContaining({ id: liningLot }), onHand: '6.5000', since: TODAY, daysOut: 0, longOut: false, buckets: { upTo30: '6.5000', upTo60: '0.0000', upTo90: '0.0000', over90: '0.0000' } }),
    ])
    expect(ageing.workshops).toEqual([expect.objectContaining({ workshop: expect.objectContaining({ id: A.P2 }), lines: 1, oldestDaysOut: 0, longOut: 0, linesPerBucket: { upTo30: 1, upTo60: 0, upTo90: 0, over90: 0 } })])
    expect((await ok('otherWorkshop', 'GET', `/purchasing/subcontracting/ageing?partyId=${A.P2}`)).rows).toEqual([])
  })

  it('counts the job as Balance open once every piece is back with material still out, until the rest is declared', async () => {
    let current = await fresh()
    expect((await ok('planner', 'GET', '/purchasing/subcontracting/balances')).items.map((row: Json) => row.order.id)).toContain(current.id)
    current = (await ok('warehouse', 'POST', url(current.id, '/receive'), { version: current.version, lines: [{ operationId: current.operations[0].id, good: 5, defective: 0, scrapped: 0 }] }, 201)).order
    expect(current.status).toBe('RECEIVED')
    let open = await ok('planner', 'GET', '/purchasing/subcontracting/balances?open=true')
    expect(open.items).toEqual([expect.objectContaining({ order: expect.objectContaining({ id: current.id }), openLines: 1, open: [{ uom: 'M', quantity: '6.5000' }], balanceOpen: true, daysOut: 0 })])
    expect(open.counts).toMatchObject({ balanceOpen: 1 })
    expect((await ok('planner', 'GET', url(current.id, '/balance'))).balanceOpen).toBe(true)
    await ok('warehouse', 'POST', url(current.id, '/balance/declare'), { version: current.version, lines: [{ kitLineId, used: '6.5', returned: '0', scrapped: '0' }] }, 201)
    open = await ok('planner', 'GET', '/purchasing/subcontracting/balances?open=true')
    expect(open.counts.balanceOpen).toBe(0)
    expect(await atWorkshop()).toBe('0.0000')
  })
})

describe('the workshop’s cost on the work order (SCM-146)', () => {
  let fee = ''
  it('bridges the earned fee W2a posted with the charges; money only with the cost grain', async () => {
    const cost = await ok('buyer', 'GET', url(order.id, '/cost'))
    // 1 + 5 back good earn 6 × 5.25 (the defective one earns nothing).
    expect(cost.operations[0]).toMatchObject({ piecesBackGood: 6, bookedByFee: 0, bookable: 6, earnedFee: 3150, pricePerPiece: '5.250000' })
    expect(cost.bridge).toMatchObject({ earnedFee: 3150, orderCost: 3150, currency: 'EUR' })
    expect(cost.workOrder).toMatchObject({ onLedger: 3150, waiting: [] })
    expect(await ledgerSum(order.id)).toBe('3150')
    const blind = await ok('warehouse', 'GET', url(order.id, '/cost'))
    expect(blind.operations[0]).not.toHaveProperty('pricePerPiece')
    expect(blind.bridge).not.toHaveProperty('orderCost')
    expect(blind.actions.book).toContain('purchasing.subcontract.cost')
  })

  it('books transport and a fee at the workshop’s price onto the work order: the fee’s pieces leave the earned fee', async () => {
    let current = await fresh()
    await refused('warehouse', 'POST', url(current.id, '/costs'), { version: current.version, kind: 'TRANSPORT', unitPrice: '15' }, 403)
    await refused('blind', 'POST', url(current.id, '/costs'), { version: current.version, kind: 'TRANSPORT' }, 403)
    expect(paths(await refused('buyer', 'POST', url(current.id, '/costs'), { version: current.version, kind: 'OTHER', unitPrice: '3' }, 400))).toEqual(['body/reason'])
    expect((await refused('buyer', 'POST', url(current.id, '/costs'), { version: current.version, kind: 'FEE', subcontractOperationId: current.operations[0].id, quantity: '7', unitPrice: '5.5' }, 400)).message).toContain('6 piece(s) back good')
    let booked = await ok('buyer', 'POST', url(current.id, '/costs'), { version: current.version, kind: 'TRANSPORT', unitPrice: '15', reason: 'Courier back (made-up).' }, 201)
    expect(booked.ledger).toEqual({ posted: 1, waiting: [] })
    expect(await ledgerSum(current.id)).toBe('4650')
    current = await fresh()
    booked = await ok('buyer', 'POST', url(current.id, '/costs'), { version: current.version, kind: 'FEE', subcontractOperationId: current.operations[0].id, quantity: '1', unitPrice: '5.5' }, 201)
    expect(await ledgerSum(current.id)).toBe('4675')
    expect(booked.view.bridge).toMatchObject({ earnedFee: 2625, feeAtWorkshopPrice: 550, transport: 1500, orderCost: 4675 })
    expect(booked.view.workOrder.onLedger).toBe(4675)
    expect(booked.view.entries.map((entry: Json) => [entry.kind, entry.onWorkOrder])).toEqual([
      ['TRANSPORT', true],
      ['FEE', true],
    ])
    fee = booked.entryId
  })

  it('takes an entry back once, with why: the work order follows', async () => {
    let current = await fresh()
    expect(paths(await refused('buyer', 'POST', url(current.id, `/costs/${fee}/reverse`), { version: current.version, reason: ' ' }, 400))).toEqual(['body/reason'])
    const back = await ok('buyer', 'POST', url(current.id, `/costs/${fee}/reverse`), { version: current.version, reason: 'Agreed at the routing fee after all (made-up).' }, 201)
    expect(await ledgerSum(current.id)).toBe('4650')
    expect(back.view.bridge).toMatchObject({ earnedFee: 3150, feeAtWorkshopPrice: 0, orderCost: 4650 })
    current = await fresh()
    expect((await refused('buyer', 'POST', url(current.id, `/costs/${fee}/reverse`), { version: current.version, reason: 'Again' }, 400)).message).toContain('already')
    expect((await refused('buyer', 'POST', url(current.id, `/costs/${back.entryId}/reverse`), { version: current.version, reason: 'Again' }, 400)).message).toContain('not taken back in turn')
    expect(await eventsOf(current.id)).toEqual(expect.arrayContaining(['subcontract_order.cost_booked']))
  })
})
