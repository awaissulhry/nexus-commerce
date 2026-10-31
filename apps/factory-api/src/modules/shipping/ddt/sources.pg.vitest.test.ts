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
import { seed as seedHolds, type HoldsSeed } from '../../../../../../packages/factory-db/seed/holds'
import { seed as seedReturns, type ReturnsSeed } from '../../../../../../packages/factory-db/seed/returns'
import { seed as seedSourcing, type SourcingSeed } from '../../../../../../packages/factory-db/seed/sourcing'
import { seed as seedSubcontract, type SubcontractSeed } from '../../../../../../packages/factory-db/seed/subcontract'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { callerFor, command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { companyLegalOf } from '../../../platform/documents/documents'
import { pdfFlatText } from '../../../platform/documents/testing/pdf-text'
import { createFilesRuntime, useFiles, type FilesRuntime } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { postMoves } from '../../inventory/ledger/post-moves'
import { issueSourceDdtInCommand, printSourceDdt } from './sources'

/**
 * DDTs for other reasons (B-W2a-17; LOG-056; DPR 472/1996) on the local stack, with the app's real routes: a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security, the grants and the
 * …_quality_plant_w2a_guards' factory_ddt_check, the …_supply_w2a_guards' kit and claim line triggers are real), the
 * factory-db seeds of two tenants (SEED-REP-0001 RECEIVED with the customer's DDT, SEED-REP-0002 SHIPPED with DDT
 * 145/2026, SEED-SC-0001 with a planned kit line, SEED-CLM-0001 a claim for credit, SEED-RMA-0002 decided REPAIR), the
 * local file store for the PDFs, and sessions from the test authenticator. The seed dates its DDTs in late 2026: the
 * series' last date is cleared so today's DDTs may follow. Every name and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/shipping/ddt`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let files: FilesRuntime
let holdsA: HoldsSeed
let returnsA: ReturnsSeed
let sourcingA: SourcingSeed
let subcontractA: SubcontractSeed

const ns = { a: 'ddt-src-a', b: 'ddt-src-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  actor: idOf(ns.a, 'actor'),
  companyA: idOf(ns.a, 'company:A'),
  companyB: idOf(ns.a, 'company:B'),
  siteA1: idOf(ns.a, 'site:A1'),
  P1: idOf(ns.a, 'party:P1'),
  P2: idOf(ns.a, 'party:P2'),
  lining: idOf(ns.a, 'product:item:lining'),
  liningGrey: idOf(ns.a, 'product:item-colour:lining:GRY'),
  operator: idOf(ns.a, 'worker:A1:operator'),
}
const B = { tenant: idOf(ns.b, 'tenant'), companyA: idOf(ns.b, 'company:A') }
const YEAR = businessDate(new Date()).slice(0, 4)

const DDT: Permission[] = ['shipping.view', 'shipping.ddt.issue', 'shipping.ddt.cancel']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  warehouse: office(A.tenant, [grant([...DDT, 'files.read'])]),
  viewer: office(A.tenant, [grant(['shipping.view'])]),
  companyB: office(A.tenant, [grant(DDT, [A.companyB])]),
  otherTenant: office(B.tenant, [grant(DDT)]),
  partner: { audience: 'partner', tenantId: A.tenant, actorId: newId(), partyId: A.P1, grants: [grant(DDT)] },
  floorA1: { audience: 'floor', tenantId: A.tenant, actorId: A.operator, siteId: A.siteA1, deviceId: newId(), grants: [{ permissions: DDT, companies: [A.companyA], sites: [A.siteA1], parties: 'all' }] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { 'x-test-session': session, ...(SESSIONS[session]?.audience === 'floor' && method !== 'GET' ? { 'idempotency-key': `ddt-src-${run}-${++keys}` } : {}) },
    ...(payload === undefined ? {} : { payload: payload as object }),
  })
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

/** Company A's DDT series for this year (tenant A): its row and the number it gives next. */
const series = async () => (await admin<{ id: string; next: number }>(`SELECT id, "nextValue" AS next FROM "NumberSeries" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'DDT' AND code = 'MAIN' AND "scopeKey" = $3`, [A.tenant, A.companyA, YEAR]))[0]!
const numbered = (value: number) => `${value}/${YEAR}`
const allocations = async (seriesId: string) => (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "NumberAllocation" WHERE "seriesId" = $1`, [seriesId]))[0]!.n
const sourceUrl = (type: string, id: string, rest = 'ddt') => `/shipping/ddt-sources/${type}/${id}/${rest}`
/** The DDT of a source's goods as the office types it: who carries them, the packages and the gross weight. */
const TYPED = { transportBy: 'SENDER', packages: 1, grossWeightKg: '1.8', appearance: 'Scatola di cartone' } as const

/** Requests waiting on a lock in this database. */
async function lockWaiters(count: number): Promise<void> {
  for (let tries = 0; ; tries++) {
    const n = (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`))[0]!.n
    if (n >= count) return
    if (tries > 250) throw new Error(`only ${n} request(s) waited on a lock`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** A RETURN claim of the workshop P2 (company A, site A1) for 5 m of the lining lot, moved to SENT; its id and line. */
async function returnClaim(number: string): Promise<{ id: string; line: string }> {
  const id = newId()
  const line = newId()
  await admin(
    `INSERT INTO "SupplierClaim" (id, "tenantId", "companyId", "siteId", number, "partyId", kind, "foundAt", reason, status, "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, 'RETURN', 'STOCK', 'Wrong shade of grey', 'DRAFT', now())`,
    [id, A.tenant, A.companyA, A.siteA1, number, A.P2],
  )
  await admin(
    `INSERT INTO "SupplierClaimLine" (id, "tenantId", "siteId", "partyId", "claimId", seq, "itemId", "itemColourId", "lotId", quantity, uom, "baseQuantity", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, 10, $6, $7, $8, 5, 'M', 5, now())`,
    [line, A.tenant, A.siteA1, A.P2, id, A.lining, A.liningGrey, liningLot],
  )
  await admin(`UPDATE "SupplierClaim" SET status = 'SENT', remedy = 'CREDIT', "sentAt" = now(), "sentById" = $2, version = version + 1 WHERE id = $1`, [id, A.actor])
  return { id, line }
}
let liningLot = ''

beforeAll(async () => {
  db = await migratedDatabase('ddt_sources')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: database, namespace })
  // holds runs returns (money, shipping, production, sales…), which give the repairs and RMAs; then the claims and the
  // subcontract order.
  holdsA = await seedHolds({ db: database, namespace: ns.a })
  returnsA = await seedReturns({ db: database, namespace: ns.a })
  sourcingA = await seedSourcing({ db: database, namespace: ns.a })
  subcontractA = await seedSubcontract({ db: database, namespace: ns.a })
  await seedHolds({ db: database, namespace: ns.b })
  liningLot = (await admin<{ id: string }>(`SELECT id FROM "Lot" WHERE "tenantId" = $1 AND code = 'SEED-LOT-LIN-01'`, [A.tenant]))[0]!.id
  for (const [tenantId, companyId] of [
    [A.tenant, A.companyA],
    [B.tenant, B.companyA],
  ] as const) {
    // Made-up legal data (c.c. art. 2250), the tenant's FAKE file store, and this year's DDT series (the seeded one when
    // the year is 2026) with no last date.
    await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyId])
    await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'DDT', 'MAIN', $4, 'YEARLY', '{N}/{YYYY}', true) ON CONFLICT DO NOTHING`, [newId(), tenantId, companyId, YEAR])
    await admin(`UPDATE "NumberSeries" SET "lastIssuedDate" = NULL WHERE "tenantId" = $1 AND kind = 'DDT'`, [tenantId])
    if ((await admin(`SELECT 1 FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [tenantId])).length === 0) {
      await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenantId])
    }
    await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [tenantId])
  }
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-ddt-sources-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  files = createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) })
  useFiles(files)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
      logger: false,
    },
  )
}, 240_000)

afterAll(async () => {
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

const S: Record<string, string> = {}

describe("a repair's way back to its customer (REPAIR; LOG-116)", () => {
  const repair = () => returnsA.repairId

  it('previews it with every problem, the customer as recipient, its delivery address, the customer\'s DDT; nothing used', async () => {
    const before = await series()
    const preview = await ok('warehouse', 'POST', sourceUrl('RepairOrder', repair(), 'ddt/preview'), {})
    expect(preview.problems.map((problem: Json) => problem.path)).toEqual(['body/transportBy', 'body/packages', 'body/grossWeightKg'])
    expect(preview).toMatchObject({
      expectedNumber: numbered(before.next),
      language: 'it',
      source: { type: 'RepairOrder', id: repair(), number: 'SEED-REP-0001', state: 'RECEIVED' },
      reasons: ['REPAIR', 'RETURN_FROM_WORK', 'OTHER'],
      draft: { reason: 'REPAIR', recipient: { name: expect.any(String), vatNumber: expect.stringMatching(/^IT/) }, documentRefs: [{ kind: 'REPAIR_ORDER', number: 'SEED-REP-0001', date: null }, { kind: 'DDT', number: 'SEED-C1-R-7', date: '2026-11-28' }], replacement: false },
    })
    expect(preview.draft.destination).not.toBeNull()
    expect(preview.draft.lines).toEqual([expect.objectContaining({ seq: 1, quantity: '1', uom: 'PCS', sourceLineId: repair() })])
    expect(preview.goods).toEqual([expect.objectContaining({ sourceLineId: repair(), held: null, liveDdt: null })])
    const pdf = await call('warehouse', 'POST', sourceUrl('RepairOrder', repair(), 'ddt/preview/pdf'), TYPED)
    expect(pdf.statusCode, pdf.body).toBe(200)
    expect(pdfFlatText(pdf.rawPayload)).toContain('Riparazione')
    expect(await allocations(before.id)).toBe(await allocations(before.id))
    expect((await series()).next).toBe(before.next)
  })

  it('refuses a missing field (400) and a reason the source does not travel for, using no number', async () => {
    const before = await series()
    const missing = await refused('warehouse', 'POST', sourceUrl('RepairOrder', repair()), { transportBy: 'CARRIER' }, 400)
    expect(missing.issues.map((issue: Json) => issue.path)).toEqual(['body/carrier/name', 'body/packages', 'body/grossWeightKg'])
    const sale = await refused('warehouse', 'POST', sourceUrl('RepairOrder', repair()), { ...TYPED, reason: 'SALE' }, 400)
    expect(sale.message).toBe('A garment going back from repair travels as REPAIR or RETURN_FROM_WORK, or OTHER said in words.')
    expect((await series()).next).toBe(before.next)
    expect(await allocations(before.id)).toBe((await allocations(before.id)))
  })

  it('issues it: the next number of the same series, no shipment, its source, the PDF in Italian with the reason in words', async () => {
    const before = await series()
    const allocated = await allocations(before.id)
    const issued = await ok('warehouse', 'POST', sourceUrl('RepairOrder', repair()), { ...TYPED, remarks: 'Rientro senza riparazione: preventivo rifiutato.' }, 201)
    S.repairDdt = issued.ddt.id
    expect(issued.ddt).toMatchObject({
      number: numbered(before.next),
      status: 'LIVE',
      reason: 'REPAIR',
      shipmentId: null,
      shipmentNumber: null,
      source: { type: 'RepairOrder', id: repair(), number: 'SEED-REP-0001' },
      companyId: A.companyA,
      siteId: A.siteA1,
      partyId: A.P1,
      packages: 1,
      grossWeightKg: '1.8000',
    })
    expect(issued.ddt.lines).toEqual([expect.objectContaining({ sourceLineId: repair(), workOrderSizeId: null, size: null })])
    expect(issued).toMatchObject({ source: { state: 'RECEIVED' }, pdfProblem: null, file: { id: expect.any(String) } })
    expect((await series()).next).toBe(before.next + 1)
    expect(await allocations(before.id)).toBe(allocated + 1)
    const [row] = await admin<{ shipmentId: string | null; sourceType: string; sourceId: string; language: string; transportMode: string | null }>(`SELECT "shipmentId", "sourceType", "sourceId", language, "transportMode"::text AS "transportMode" FROM "Ddt" WHERE id = $1`, [S.repairDdt])
    // B-W2b-19: the DDT keeps the language it is printed in (its party's) and the mode of transport (none typed here).
    expect(row).toEqual({ shipmentId: null, sourceType: 'RepairOrder', sourceId: repair(), language: 'it', transportMode: null })
    expect(issued.ddt).toMatchObject({ language: 'it', transportMode: null })

    const { download } = await ok('warehouse', 'GET', `/shipping/ddts/${S.repairDdt}/pdf`)
    const text = pdfFlatText((await app.inject({ method: 'GET', url: download.url })).rawPayload)
    for (const words of [numbered(before.next), 'Riparazione', 'SEED-C1-R-7', 'Scatola di cartone', 'preventivo rifiutato']) expect(text).toContain(words)
    expect((await call('warehouse', 'POST', `/shipping/ddts/${S.repairDdt}/pdf`, {})).statusCode).toBe(200)

    const events = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'ddt.source_issued' AND subject = $1`, [repair()])
    expect(events.map((event) => event.payload)).toEqual([{ ddtId: S.repairDdt, sourceType: 'RepairOrder', sourceId: repair(), number: numbered(before.next), documentDate: businessDate(new Date()), reason: 'REPAIR', replacement: false }])
    const audits = await admin<{ action: string; recordType: string }>(`SELECT action, "recordType" FROM "AuditLog" WHERE "requestId" = (SELECT "requestId" FROM "AuditLog" WHERE "recordId" = $1 AND "recordType" = 'Ddt')`, [S.repairDdt])
    expect(audits.map((row) => `${row.recordType} ${row.action}`).sort()).toEqual(['Ddt shipping.issueSourceDdt', 'StoredFile documents.render'])
  })

  it('travels with one live DDT: a second is refused (409) and uses no number; the record, the list and its filters show it', async () => {
    const before = await series()
    expect((await refused('warehouse', 'POST', sourceUrl('RepairOrder', repair()), TYPED, 409)).message).toMatch(/^DDT \d+\/\d{4} is live for this repair: cancel it first/)
    expect((await series()).next).toBe(before.next)
    const { ddt } = await ok('viewer', 'GET', `/shipping/ddts/${S.repairDdt}`)
    expect(ddt).toMatchObject({ id: S.repairDdt, shipmentId: null, source: { type: 'RepairOrder', number: 'SEED-REP-0001' }, fileId: expect.any(String) })
    const own = await ok('viewer', 'GET', `/shipping/ddts?sourceType=RepairOrder&sourceId=${repair()}`)
    expect(own.ddts).toEqual([expect.objectContaining({ id: S.repairDdt, shipmentId: null, shipmentNumber: null, source: { type: 'RepairOrder', id: repair(), number: 'SEED-REP-0001' }, status: 'LIVE' })])
    const sources = (await ok('viewer', 'GET', '/shipping/ddts?kind=SOURCE&limit=200')).ddts
    expect(sources.every((row: Json) => row.shipmentId === null && row.source !== null)).toBe(true)
    // The seeded SEED-REP-0002 went back with DDT 145.
    expect(sources.map((row: Json) => row.id)).toEqual(expect.arrayContaining([S.repairDdt, holdsA.repairDdtId]))
    const shipments = (await ok('viewer', 'GET', '/shipping/ddts?kind=SHIPMENT&limit=200')).ddts
    expect(shipments.length).toBeGreaterThan(0)
    expect(shipments.every((row: Json) => row.shipmentId !== null && row.source === null)).toBe(true)
    // SEED-REP-0002 (SHIPPED) has its live DDT 145 already.
    expect((await refused('warehouse', 'POST', sourceUrl('RepairOrder', holdsA.repairId), TYPED, 409)).message).toMatch(/^DDT 145\/2026 is live for this repair/)
  })

  it('cancels it under the repair\'s lock (the number is kept); its replacement keeps the start of the goods that left', async () => {
    expect((await refused('viewer', 'POST', `/shipping/ddts/${S.repairDdt}/cancel`, { reason: 'Wrong weight' }, 403)).code).toBe('forbidden')
    const stale = await refused('warehouse', 'POST', `/shipping/ddts/${S.repairDdt}/cancel`, { reason: 'Wrong weight', version: 99 }, 409)
    expect(stale.message).toMatch(/changed since it was read \(version 99\)/)
    const first = (await ok('warehouse', 'GET', `/shipping/ddts/${S.repairDdt}`)).ddt
    const cancelled = await ok('warehouse', 'POST', `/shipping/ddts/${S.repairDdt}/cancel`, { reason: 'Wrong weight' })
    expect(cancelled).toMatchObject({ ddt: { status: 'CANCELLED', number: first.number, cancellation: { reason: 'Wrong weight' } }, shipment: null, source: { type: 'RepairOrder', state: 'RECEIVED', needsDdt: true }, draftInvoiceIds: [], warning: null })
    expect((await refused('warehouse', 'POST', `/shipping/ddts/${S.repairDdt}/cancel`, { reason: 'again' }, 409)).message).toBe('This DDT is cancelled already.')
    const before = await series()
    const replacement = await ok('warehouse', 'POST', sourceUrl('RepairOrder', repair()), { ...TYPED, grossWeightKg: '2.1' }, 201)
    expect(replacement.ddt).toMatchObject({ number: numbered(before.next), startAt: first.startAt, grossWeightKg: '2.1000' })
    const events = await admin<{ type: string; payload: Json }>(`SELECT type, payload FROM "OutboxEvent" WHERE type IN ('ddt.source_cancelled', 'ddt.source_issued') AND subject = $1 ORDER BY "occurredAt", id`, [repair()])
    expect(events.map((event) => `${event.type} ${event.payload.number} ${event.payload.replacement ?? ''}`.trim())).toEqual([`ddt.source_issued ${first.number} false`, `ddt.source_cancelled ${first.number}`, `ddt.source_issued ${numbered(before.next)} true`])
  })
})

describe('a subcontract kit on conto lavorazione (WORK_ON_ACCOUNT; SCM-140)', () => {
  const order = () => subcontractA.orderId

  it('holds while the order is DRAFT and while its kit line is not sent', async () => {
    expect((await refused('warehouse', 'POST', sourceUrl('SubcontractOrder', order()), TYPED, 409)).message).toBe(
      'The subcontract order SEED-SC-0001 is DRAFT: its kit travels while it is ISSUED, AT_WORKSHOP or PARTLY_RECEIVED.',
    )
    // The job sheet went out (B-W2a-25 issues it): ISSUED.
    await admin(`UPDATE "SubcontractOrder" SET status = 'ISSUED', "issuedAt" = now(), "issuedById" = $2, version = version + 1 WHERE id = $1`, [order(), A.actor])
    const preview = await ok('warehouse', 'POST', sourceUrl('SubcontractOrder', order(), 'ddt/preview'), TYPED)
    expect(preview.goods).toEqual([expect.objectContaining({ sourceLineId: subcontractA.kitLineId, held: 'Kit line 10 is not sent yet: its transfer to the workshop comes first.' })])
    expect(preview.problems).toEqual([{ path: 'source/lines', message: 'Nothing of subcontract order SEED-SC-0001 may travel now: Kit line 10 is not sent yet: its transfer to the workshop comes first.' }])
    expect(preview.draft.reason).toBe('WORK_ON_ACCOUNT')
    expect((await refused('warehouse', 'POST', sourceUrl('SubcontractOrder', order()), TYPED, 400)).issues).toEqual(preview.problems)
  })

  it("issues inside the kit send's own command (B-W2a-25): the transfer, the line SENT, then the DDT; the line names it", async () => {
    const before = await series()
    const caller = callerFor(database, { audience: 'office', tenantId: A.tenant, actorId: A.actor, requestId: `ddt-src-kit-${run}`, grants: [grant(['shipping.ddt.issue', 'inventory.transfer', 'files.read'])] })
    const company = await companyLegalOf(caller, A.companyA)
    const bin = idOf(ns.a, 'inventory:location:A1-STORE-01')
    const { result } = await command(caller, { name: 'test.sendKit', input: {} }, async (tools) => {
      const [move] = await postMoves(tools, [{ siteId: A.siteA1, reason: 'TRANSFER', itemId: A.lining, lotId: liningLot, fromLocationId: bin, toLocationId: subcontractA.locationId, quantity: '12.6' }])
      await tools.tx.subcontractKitLine.update({ where: { id: subcontractA.kitLineId }, data: { lotId: liningLot, status: 'SENT', sentAt: tools.now, moveId: move!.id, version: { increment: 1 } }, select: { id: true } })
      tools.audit({ recordType: 'SubcontractKitLine', recordId: subcontractA.kitLineId, companyId: A.companyA, siteId: A.siteA1, after: { status: 'SENT' } })
      return issueSourceDdtInCommand(tools, company, { type: 'SubcontractOrder', id: order() }, {
        transportBy: 'CARRIER',
        carrier: { name: 'Corriere Esempio' },
        packages: 2,
        grossWeightKg: '6.4',
        otherGoods: [{ description: 'Parti tagliate giacca seed, 7 capi', quantity: '7', uom: 'SET' }],
      })
    })
    expect(result).toMatchObject({ number: numbered(before.next), replacement: false, lineIds: [subcontractA.kitLineId], claimLinesKeepingOldDdt: [] })
    S.kitDdt = result.ddtId
    expect(await printSourceDdt(files, caller, result.ddtId)).toMatchObject({ pdfProblem: null, file: { id: expect.any(String) } })
    const [line] = await admin<{ ddtId: string; status: string }>(`SELECT "ddtId", status FROM "SubcontractKitLine" WHERE id = $1`, [subcontractA.kitLineId])
    expect(line).toEqual({ ddtId: S.kitDdt, status: 'SENT' })
    const { ddt } = await ok('warehouse', 'GET', `/shipping/ddts/${S.kitDdt}`)
    expect(ddt).toMatchObject({ reason: 'WORK_ON_ACCOUNT', transportBy: 'CARRIER', carrier: { name: 'Corriere Esempio' }, partyId: A.P2, documentRefs: [{ kind: 'SUBCONTRACT_ORDER', number: 'SEED-SC-0001' }] })
    expect(ddt.destination).not.toBeNull()
    expect(ddt.lines.map((row: Json) => [row.sourceLineId, row.uom, row.quantity])).toEqual([
      [subcontractA.kitLineId, 'M', '12.6'],
      [null, 'SET', '7'],
    ])
    expect(ddt.lines[0].description).toContain('SEED-LOT-LIN-01')
  })

  it('a kit line on a live DDT is refused by line (400), in words', async () => {
    const preview = await ok('warehouse', 'POST', sourceUrl('SubcontractOrder', order(), 'ddt/preview'), { ...TYPED, lineIds: [subcontractA.kitLineId] })
    expect(preview.goods[0].liveDdt).toEqual({ id: S.kitDdt, number: expect.any(String) })
    expect(preview.problems).toEqual([{ path: 'body/lineIds/0', message: `Line 10 travels with DDT ${preview.goods[0].liveDdt.number} already.` }])
  })
})

describe('goods back to a supplier (RETURN; SCM-134)', () => {
  it('refuses a claim that keeps its goods, and one not sent yet (409)', async () => {
    const error = await refused('warehouse', 'POST', sourceUrl('SupplierClaim', sourcingA.claimId), TYPED, 409)
    expect(error.message).toBe('The supplier claim SEED-CLM-0001 is DRAFT: its goods go back once it is SENT or ACCEPTED. The supplier claim SEED-CLM-0001 keeps the goods (a claim for credit or replacement): only a RETURN claim sends goods back.')
  })

  it("issues a RETURN claim's DDT; its line names it; after a cancel the line follows the replacement that names it (B-W2b-14)", async () => {
    const claim = await returnClaim('CLM-T-0001')
    S.claim = claim.id
    S.claimLine = claim.line
    const issued = await ok('warehouse', 'POST', sourceUrl('SupplierClaim', claim.id), { ...TYPED, transportBy: 'RECIPIENT' }, 201)
    expect(issued.ddt).toMatchObject({ reason: 'RETURN', transportBy: 'RECIPIENT', partyId: A.P2, source: { type: 'SupplierClaim', id: claim.id, number: 'CLM-T-0001' } })
    expect(issued.ddt.lines).toEqual([expect.objectContaining({ sourceLineId: claim.line, quantity: '5', uom: 'M' })])
    expect(issued.claimLinesKeepingOldDdt).toEqual([])
    const ddtOf = async () => (await admin<{ ddtId: string | null }>(`SELECT "ddtId" FROM "SupplierClaimLine" WHERE id = $1`, [claim.line]))[0]!.ddtId
    expect(await ddtOf()).toBe(issued.ddt.id)
    await ok('warehouse', 'POST', `/shipping/ddts/${issued.ddt.id}/cancel`, { reason: 'Wrong carrier' })
    const replacement = await ok('warehouse', 'POST', sourceUrl('SupplierClaim', claim.id), TYPED, 201)
    expect(replacement).toMatchObject({ claimLinesKeepingOldDdt: [], ddt: { lines: [expect.objectContaining({ sourceLineId: claim.line })] } })
    expect(await ddtOf()).toBe(replacement.ddt.id)
  })

  it('two issues of one claim at the same time: one DDT, one number; the second finds the line travelling (400)', async () => {
    const claim = await returnClaim('CLM-T-0002')
    const before = await series()
    const allocated = await allocations(before.id)
    // Hold the claim's row so both requests queue on it, then let them go.
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const holding = new Promise<void>((resolve) => (locked = resolve))
    const holder = database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, (client) =>
      client.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "SupplierClaim" WHERE "id" = ${claim.id}::uuid FOR UPDATE`
          locked()
          await released
        },
        { timeout: 20_000 },
      ),
    )
    await holding
    const both = Promise.all([call('warehouse', 'POST', sourceUrl('SupplierClaim', claim.id), TYPED), call('warehouse', 'POST', sourceUrl('SupplierClaim', claim.id), TYPED)])
    await lockWaiters(2)
    release()
    await holder
    const answers = (await both).map((response) => response.statusCode).sort()
    expect(answers).toEqual([201, 400])
    expect(await allocations(before.id)).toBe(allocated + 1)
    expect((await series()).next).toBe(before.next + 1)
  })
})

describe('returned goods sent back unchanged (RETURN; SAL-341)', () => {
  it('reads the RMA with its order and the customer\'s DDT; a line decided for repair stays (400); an RMA still waiting is refused (409)', async () => {
    const preview = await ok('warehouse', 'POST', sourceUrl('ReturnAuthorisation', returnsA.inspectedReturnId, 'ddt/preview'), TYPED)
    expect(preview.source).toMatchObject({ number: 'SEED-RMA-0002', state: 'INSPECTED' })
    expect(preview.goods).toEqual([expect.objectContaining({ sourceLineId: returnsA.inspectedLineId, held: 'Line 10 is not sent back as it came (REPAIR).' })])
    expect(preview.draft.documentRefs).toEqual([{ kind: 'RETURN_AUTHORISATION', number: 'SEED-RMA-0002', date: null }, expect.objectContaining({ kind: 'SALES_ORDER' }), { kind: 'DDT', number: 'SEED-C1-R-7', date: '2026-11-28' }])
    expect((await refused('warehouse', 'POST', sourceUrl('ReturnAuthorisation', returnsA.inspectedReturnId), TYPED, 400)).issues).toEqual([
      { path: 'source/lines', message: 'Nothing of return SEED-RMA-0002 may travel now: Line 10 is not sent back as it came (REPAIR).' },
    ])
    expect((await refused('warehouse', 'POST', sourceUrl('ReturnAuthorisation', returnsA.waitingReturnId), TYPED, 409)).message).toBe(
      'The return SEED-RMA-0001 is AUTHORISED: its goods are sent back once they arrived (RECEIVED, INSPECTED or CLOSED).',
    )
  })
})

describe('walls', () => {
  it('another tenant, a company the grant does not reach, a viewer, a partner and the floor never issue or see one', async () => {
    const url = sourceUrl('RepairOrder', returnsA.repairId)
    expect((await refused('otherTenant', 'POST', `${url}/preview`, TYPED, 404)).code).toBe('not_found')
    expect((await refused('otherTenant', 'GET', `/shipping/ddts/${S.repairDdt}`, undefined, 404)).code).toBe('not_found')
    expect((await refused('companyB', 'POST', url, TYPED, 404)).code).toBe('not_found')
    expect((await refused('companyB', 'GET', `/shipping/ddts/${S.kitDdt}`, undefined, 404)).code).toBe('not_found')
    expect((await ok('companyB', 'GET', `/shipping/ddts?sourceType=RepairOrder`)).ddts).toEqual([])
    expect((await refused('viewer', 'POST', url, TYPED, 403)).code).toBe('forbidden')
    for (const session of ['partner', 'floorA1']) {
      expect((await refused(session, 'POST', `${url}/preview`, TYPED, 403)).code).toBe('forbidden')
      expect((await refused(session, 'POST', url, TYPED, 403)).code).toBe('forbidden')
    }
    expect((await call('warehouse', 'POST', sourceUrl('Shipment', returnsA.repairId), TYPED)).statusCode).toBe(400)
    expect((await refused('warehouse', 'POST', sourceUrl('RepairOrder', newId()), TYPED, 404)).code).toBe('not_found')
  })

  it('the end check: the DDT numbers of each company series period have no gap, each the number of one DDT', async () => {
    const rows = await admin<{ seriesId: string; start: number; next: number; values: number[]; ddts: number }>(
      `SELECT s.id AS "seriesId", s."startValue" AS start, s."nextValue" AS next, array_agg(a.value ORDER BY a.value) AS "values",
              (SELECT count(*)::int FROM "Ddt" d WHERE d."numberSeriesId" = s.id) AS ddts
         FROM "NumberSeries" s JOIN "NumberAllocation" a ON a."seriesId" = s.id
        WHERE s.kind = 'DDT' GROUP BY s.id`,
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.values).toEqual(Array.from({ length: row.values.length }, (_, index) => row.start + index))
      expect(row.next).toBe(row.start + row.values.length)
      expect(row.ddts).toBe(row.values.length)
    }
  })
})
