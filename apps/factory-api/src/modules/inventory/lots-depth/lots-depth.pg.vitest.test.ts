import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { systemContext } from '../../../platform/outbox/system'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { lotLifecycleHandler } from './lifecycle'

/**
 * Lots in depth (B-W2b-313; SCM-185, SCM-236, SCM-237, SCM-238, SCM-242, LT1:01) through the app's real routes on a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security and every guard, B-W2b-277's Lot_lifecycle
 * trigger among them, are real), tenant A from EVERY seed and tenant B bare, plus a made-up released cowhide lot T313-LOT-01
 * of six whole hides in A1-STORE-01 (opening stock), received by one made-up person and released by another, and a decided
 * incoming inspection that sorted its hides into shades 1 and 2 and rejected one. Files go to a local store. In order:
 *   - the lot page's W2b facts: lifecycle, attributes, family, incoming inspection, separation of duties, documents;
 *   - attributes per kind recorded, refused in words, searchable in the list;
 *   - the lifecycle moved by the worker's handler: the first issue (IN_USE), the issue undone (RELEASED), once per event;
 *   - split into shade groups from the inspection's proposal: child lots with the parent link, new tags, the stock moved at
 *     its value, the parent depleted; refused hides, a stale version, a replay;
 *   - regroup between the lots of the family and back into the parent;
 *   - the list's Lifecycle column, its Depleted view and tiles;
 *   - the dated trace report as PDF and CSV, with what was asked and when, and the reports made.
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/inventory/lots-depth`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'lots-depth-a'
let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let localRoot: string
const run = randomBytes(4).toString('hex')
let serial = 0
const idem = () => `lots-depth-${run}-${++serial}`

const id = (key: string) => seedUuid(NS, key)
const A = {
  tenant: id('tenant'),
  companyA: id('company:A'),
  companyB: id('company:B'),
  siteA1: id('site:A1'),
  leather: id('product:item:leather'),
  leatherBLK: id('product:item-colour:leather:BLK'),
  bin: id('inventory:location:A1-STORE-01'),
  seedLot: id('inventory:lot:LEA-01'),
  seedH2: id('inventory:hide:H2'),
  workOrder: id('production:work-order:WO-0001'),
  shade1: id('leather:shade:LEA-100:BLK:1'),
  shade2: id('leather:shade:LEA-100:BLK:2'),
}
const tenantB = newId()
const people = { receiver: newId(), releaser: newId(), quality: newId(), keeper: newId() }
const LOT = { id: newId(), code: `T313-LOT-${run}` }
const HIDES = Array.from({ length: 6 }, (_, index) => ({ id: newId(), code: `T313-${run}-H${index + 1}` }))
const inspectionId = newId()

const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const office = (tenantId: string, actorId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId, grants })
const SESSIONS: Record<string, SessionContext> = {
  keeper: office(A.tenant, people.keeper, [grant(['inventory.stock.view', 'inventory.lots.manage', 'files.read'])]),
  quality: office(A.tenant, people.quality, [grant(['inventory.stock.view', 'inventory.lots.manage', 'inventory.trace.report', 'parties.view', 'files.read'])]),
  receiver: office(A.tenant, people.receiver, [grant(['inventory.stock.view'])]),
  viewer: office(A.tenant, newId(), [grant(['inventory.stock.view'])]),
  companyB: office(A.tenant, newId(), [grant(['inventory.stock.view', 'inventory.lots.manage', 'inventory.trace.report'], { companies: [A.companyB] })]),
  keeperB: office(tenantB, newId(), [grant(['inventory.stock.view', 'inventory.lots.manage'])]),
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
type Method = 'GET' | 'POST' | 'PATCH'
const call = (session: string, method: Method, url: string, payload?: unknown, key: string = idem()) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [A.tenant, type])).map((row) => row.payload)
const lotRow = async (lotId: string) => (await admin<Json>(`SELECT code, lifecycle::text, "qualityStatus"::text AS quality, "parentLotId", "createdById", shade, version, attributes FROM "Lot" WHERE id = $1`, [lotId]))[0]!
const onHand = async (hideId: string) =>
  (await admin<{ n: string }>(`SELECT (coalesce(sum(CASE WHEN "toLocationId" IS NOT NULL THEN "baseQuantity" END), 0) - coalesce(sum(CASE WHEN "fromLocationId" IS NOT NULL THEN "baseQuantity" END), 0))::numeric(18,4)::text AS n FROM "StockMove" WHERE "hideId" = $1`, [hideId]))[0]!.n
const depth = (lotId: string, session = 'quality') => ok(session, 'GET', `/inventory/lots/${lotId}/depth`)
const envelope = (type: string, payload: Json): EventEnvelope =>
  ({ eventId: newId(), type, version: 1, context: 'inventory', tenantId: A.tenant, companyId: A.companyA, siteId: A.siteA1, subject: LOT.id, correlationId: newId(), causationId: null, source: 'test', occurredAt: new Date().toISOString(), payload }) as unknown as EventEnvelope

beforeAll(async () => {
  db = await migratedDatabase('inventory_lots_depth')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: NS })
  }
  await admin(`INSERT INTO "Tenant" (id, slug, name) VALUES ($1, 'lots-depth-b', 'Gruppo Nuovo')`, [tenantB])
  for (const [personId, name] of [
    [people.receiver, 'Rita Ricevi'],
    [people.releaser, 'Lara Libera'],
    [people.quality, 'Quinto Qualita'],
    [people.keeper, 'Marco Magazzino'],
  ] as const) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [personId, A.tenant, `${personId.slice(-6)}@example.com`, name])
  }
  // The made-up lot: released with a Cr VI PASS, six whole hides of 50 ft² in the store's bin (opening stock).
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "dyeBatch", "qualityStatus", "qualityNote", "qualityDecidedAt", "qualityDecidedById",
       "requiresCrViTest", "crViLimitMgKg", "crViStatus", "crViMgKg", "crViEvidence", "crViTestedAt", "receivedAt", "createdById")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'T313-DB', 'RELEASED', 'Released for the test.', now(), $8, true, 3.000, 'PASS', 1.200, 'SUPPLIER_REPORT', '2026-11-01', now(), $9)`,
    [LOT.id, A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, LOT.code, people.releaser, people.receiver],
  )
  for (const [index, hide] of HIDES.entries()) {
    await admin(
      `INSERT INTO "Hide" (id, "tenantId", "siteId", "lotId", "itemId", code, "supplierCode", area, "areaUom", "baseArea", grade, "thicknessMm", "createdById")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 50.0000, 'FT2', 50.0000, 'A', 1.20, $8)`,
      [hide.id, A.tenant, A.siteA1, LOT.id, A.leather, hide.code, `TAN-${index + 1}`, people.receiver],
    )
    await admin(
      `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt", "createdById")
       VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, $9, 50.0000, 'FT2', 50.0000, $10, now(), $11)`,
      [newId(), A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, LOT.id, hide.id, A.bin, `t313-opening-${run}-${index}`, people.receiver],
    )
  }
  redis = testRedis()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-lots-depth-test-'))
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [A.tenant])
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: redis.connect(), prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
}, 300_000)

afterAll(async () => {
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

describe('the lot page (SCM-238) and its attributes (SCM-185)', () => {
  it('gives the W2b facts: lifecycle, attributes per kind, separation of duties, no inspection yet', async () => {
    const view = await depth(LOT.id)
    expect(view.lot).toMatchObject({ code: LOT.code, qualityStatus: 'RELEASED', lifecycle: 'RELEASED', onHand: '300.0000', hidesInStock: 6 })
    expect(view.lifecycle).toMatchObject({ state: 'RELEASED', expected: 'RELEASED', depletedAt: null })
    expect(view.attributes).toMatchObject({ kind: 'LEATHER', keys: ['thicknessMinMm', 'thicknessMaxMm', 'finish', 'tannage', 'gradeMix', 'origin'], values: {}, canEdit: true })
    expect(view.separation).toMatchObject({ state: 'KEPT', receivedBy: { id: people.receiver, name: 'Rita Ricevi' }, decidedBy: { id: people.releaser, name: 'Lara Libera' } })
    expect(view.incoming).toMatchObject({ state: 'NOT_INSPECTED', inspections: [] })
    expect(view.family).toEqual({ parent: null, children: [] })
    expect(view.may).toEqual({ manage: true, split: true, report: true })
    expect((await depth(LOT.id, 'viewer')).may).toEqual({ manage: false, split: false, report: false })
    // The seed's leather lot: its LWG certificate runs to the end of 2027; its incoming inspection SEED-IIN-0001 is open.
    const seeded = await depth(A.seedLot, 'viewer')
    expect(seeded.documents).toMatchObject({ expiring: 0, expired: 0, rows: [{ kind: 'LWG_CERTIFICATE', validTo: '2027-12-31', state: 'VALID', from: 'LOT' }] })
    expect(seeded.incoming).toMatchObject({ state: 'OPEN', number: 'SEED-IIN-0001' })
    // Another company's reader and another tenant see nothing.
    await refused('companyB', 'GET', `/inventory/lots/${LOT.id}/depth`, undefined, 404)
    await refused('keeperB', 'GET', `/inventory/lots/${LOT.id}/depth`, undefined, 404)
  })

  it('records attributes typed per kind, refuses others in words, and finds lots by them', async () => {
    const { lot } = await depth(LOT.id)
    const changed = await ok('keeper', 'PATCH', `/inventory/lots/${LOT.id}/attributes`, {
      version: lot.version,
      attributes: { thicknessMinMm: '1.1', thicknessMaxMm: '1.3', finish: 'Full grain', tannage: 'CHROME', gradeMix: { A: '70', B: '30' }, origin: 'Italy' },
    })
    expect(changed.attributes.values).toEqual({ thicknessMinMm: '1.1', thicknessMaxMm: '1.3', finish: 'Full grain', tannage: 'CHROME', gradeMix: { A: '70', B: '30' }, origin: 'Italy' })
    expect((await events('lot.attributes_changed')).at(-1)).toEqual({ lotId: LOT.id, code: LOT.code, keys: ['finish', 'gradeMix', 'origin', 'tannage', 'thicknessMaxMm', 'thicknessMinMm'] })
    const bad = await refused('keeper', 'PATCH', `/inventory/lots/${LOT.id}/attributes`, { version: changed.lot.version, attributes: { widthCm: '140', thicknessMinMm: '1.5', gradeMix: { A: '80', B: '30' } } }, 400)
    expect(paths(bad).sort()).toEqual(['body/attributes/gradeMix', 'body/attributes/thicknessMinMm', 'body/attributes/widthCm'])
    await refused('keeper', 'PATCH', `/inventory/lots/${LOT.id}/attributes`, { version: lot.version, attributes: { origin: 'Spain' } }, 409)
    await refused('viewer', 'PATCH', `/inventory/lots/${LOT.id}/attributes`, { version: changed.lot.version, attributes: { origin: 'Spain' } }, 403)
    const removed = await ok('keeper', 'PATCH', `/inventory/lots/${LOT.id}/attributes`, { version: changed.lot.version, attributes: { finish: null } })
    expect(removed.attributes.values.finish).toBeUndefined()
    const [audit] = await admin<Json>(`SELECT audience::text, before, after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'inventory.lotAttributes' ORDER BY at DESC, id DESC LIMIT 1`, [LOT.id])
    expect(audit).toMatchObject({ audience: 'OFFICE', before: { attributes: { finish: 'Full grain' } } })
    const found = await ok('viewer', 'GET', `/inventory/lots-depth?tannage=CHROME&origin=Ital&q=${LOT.code}`)
    expect(found.lots.map((row: Json) => row.code)).toEqual([LOT.code])
    expect(found.lots[0]).toMatchObject({ lifecycle: 'RELEASED', parentLot: null, childLots: 0, onHand: '300.0000', hides: 6, attributes: { tannage: 'CHROME' } })
    expect((await ok('viewer', 'GET', `/inventory/lots-depth?tannage=VEGETABLE&q=${LOT.code}`)).lots).toEqual([])
  })
})

describe('the lifecycle moved by its events (SCM-236)', () => {
  it('is IN_USE after the first issue and RELEASED again once the issue is undone, once per event', async () => {
    const issueId = newId()
    await admin(
      `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "fromLocationId", "workOrderId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt")
       VALUES ($1, $2, $3, $4, 'ISSUE', $5, $6, $7, $8, $9, $10, 50.0000, 'FT2', 50.0000, $11, now())`,
      [issueId, A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, LOT.id, HIDES[5]!.id, A.bin, A.workOrder, `t313-issue-${run}`],
    )
    expect((await depth(LOT.id)).lifecycle).toMatchObject({ state: 'RELEASED', expected: 'IN_USE' })
    const handler = lotLifecycleHandler()
    const system = callerFor(database, systemContext(A.tenant, newId()))
    const moved = envelope('inventory.moved', { lotId: LOT.id, reason: 'ISSUE' })
    await handler.handle(moved, { caller: system, attempt: 1 })
    await handler.handle(moved, { caller: system, attempt: 2 })
    expect((await lotRow(LOT.id)).lifecycle).toBe('IN_USE')
    const changes = await events('lot.lifecycle_changed')
    expect(changes.filter((change) => change.lotId === LOT.id)).toEqual([{ lotId: LOT.id, code: LOT.code, from: 'RELEASED', to: 'IN_USE', cause: 'FIRST_ISSUE' }])
    expect(await admin(`SELECT audience::text, reason FROM "AuditLog" WHERE "recordId" = $1 AND action = 'inventory.lotLifecycle'`, [LOT.id])).toEqual([{ audience: 'SYSTEM', reason: 'First issue to a work order.' }])
    // The issue undone: the reversal brings the hide back, and the lot is RELEASED again (a person may check it now).
    await admin(
      `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "toLocationId", "workOrderId", quantity, uom, "baseQuantity", "reversalOfId", note, "idempotencyKey", "occurredAt")
       VALUES ($1, $2, $3, $4, 'ISSUE', $5, $6, $7, $8, $9, $10, 50.0000, 'FT2', 50.0000, $11, 'Issued by mistake.', $12, now())`,
      [newId(), A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, LOT.id, HIDES[5]!.id, A.bin, A.workOrder, issueId, `t313-unissue-${run}`],
    )
    const checked = await ok('keeper', 'POST', `/inventory/lots/${LOT.id}/lifecycle/check`)
    expect(checked).toMatchObject({ changed: true, from: 'IN_USE', to: 'RELEASED', lot: { lifecycle: { state: 'RELEASED', expected: 'RELEASED' } } })
    expect((await ok('keeper', 'POST', `/inventory/lots/${LOT.id}/lifecycle/check`)).changed).toBe(false)
    const history = (await depth(LOT.id)).lifecycle.history.filter((row: Json) => row.kind === 'LIFECYCLE')
    expect(history.map((row: Json) => [row.from, row.to, row.cause, row.audience])).toEqual([
      ['RELEASED', 'IN_USE', 'FIRST_ISSUE', 'SYSTEM'],
      ['IN_USE', 'RELEASED', 'ISSUE_UNDONE', 'OFFICE'],
    ])
    await refused('viewer', 'POST', `/inventory/lots/${LOT.id}/lifecycle/check`, undefined, 403)
  })
})

describe('split into shade groups and regroup (SCM-237, LT1:01)', () => {
  let split: Json
  it('proposes the groups the incoming inspection sorted the hides into, and says why a hide cannot move', async () => {
    // A decided incoming inspection of the lot: shades 1 and 2 by record, hide 5 rejected.
    await admin(
      `INSERT INTO "IncomingInspection" (id, "tenantId", "companyId", "siteId", number, "lotId", "itemId", "planVersionId", "aqlProfileId", "codeLetter", "lotSize", uom, "sampleSize", "inspectionLevel", "aqlMajor", "aqlMinor", "acceptMajor", "acceptMinor", "inspectorWorkerId", "createdById")
       SELECT $1, "tenantId", "companyId", "siteId", $2, $3, "itemId", "planVersionId", "aqlProfileId", "codeLetter", 6, uom, 6, "inspectionLevel", "aqlMajor", "aqlMinor", 1, 1, "inspectorWorkerId", "createdById" FROM "IncomingInspection" WHERE "tenantId" = $4 AND number = 'SEED-IIN-0002'`,
      [inspectionId, `T313-IIN-${run}`, LOT.id, A.tenant],
    )
    const shades = [A.shade1, A.shade1, A.shade2, A.shade2, A.shade1, A.shade2]
    for (const [index, hide] of HIDES.entries()) {
      await admin(
        `INSERT INTO "IncomingHideResult" (id, "tenantId", "siteId", "incomingInspectionId", "lotId", "hideId", seq, "measuredArea", "areaUom", "shadeGroup", "shadeRecordType", "shadeRecordId", decision)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 50.0000, 'FT2', $8, 'ShadeGroup', $9, $10)`,
        [newId(), A.tenant, A.siteA1, inspectionId, LOT.id, hide.id, index + 1, shades[index] === A.shade1 ? '1' : '2', shades[index], index === 4 ? 'REJECTED' : 'ACCEPTED'],
      )
    }
    await admin(
      `UPDATE "IncomingInspection" SET status = 'DECIDED', "foundMajor" = 1, "acceptedQuantity" = 5, "rejectedQuantity" = 1, "toSortQuantity" = 0, "decidedAt" = now(), "signatureSha256" = encode(sha256('t313'::bytea), 'hex'), "updatedAt" = now() WHERE id = $1`,
      [inspectionId],
    )
    const dialog = await ok('quality', 'GET', `/inventory/lots/${LOT.id}/split`)
    expect(dialog.parent).toMatchObject({ id: LOT.id, code: LOT.code })
    expect(dialog.refusal).toBeNull()
    expect(dialog.may).toBe(true)
    expect(dialog.hides.map((hide: Json) => [hide.code, hide.onHand, hide.refusal, hide.inspection?.decision])).toEqual(HIDES.map((hide, index) => [hide.code, '50.0000', null, index === 4 ? 'REJECTED' : 'ACCEPTED']))
    expect(dialog.proposal.inspection).toMatchObject({ id: inspectionId, status: 'DECIDED' })
    expect(dialog.proposal.groups).toEqual([
      { shadeGroupId: A.shade1, label: '1', hideIds: [HIDES[0]!.id, HIDES[1]!.id] },
      { shadeGroupId: A.shade2, label: '2', hideIds: [HIDES[2]!.id, HIDES[3]!.id, HIDES[5]!.id] },
      { shadeGroupId: null, label: 'Rejected', hideIds: [HIDES[4]!.id] },
    ])
    expect(dialog.shadeGroups.map((group: Json) => group.label)).toEqual(expect.arrayContaining(['1', '2', '3']))
    // The seed's lot: its hide in stock is on a quality hold (and its lot in an open incoming inspection): it cannot move.
    const seeded = await ok('quality', 'GET', `/inventory/lots/${A.seedLot}/split`)
    expect(seeded.hides.find((hide: Json) => hide.id === A.seedH2).refusal).toBe('Hide SEED-HIDE-0002 is on a quality hold: clear the hold first.')
  })

  it('makes one child lot per group with the parent link, new tags, the stock moved at its value, the parent depleted', async () => {
    const dialog = await ok('quality', 'GET', `/inventory/lots/${LOT.id}/split`)
    const body = { version: dialog.parent.version, groups: dialog.proposal.groups, inspectionId, note: 'Sorted against the swatch.' }
    // A hide of another family, and a stale version, are refused.
    const foreign = await refused('quality', 'POST', `/inventory/lots/${LOT.id}/split`, { ...body, groups: [{ label: 'X', hideIds: [A.seedH2] }] }, 400)
    expect(paths(foreign)).toEqual(['body/groups/0/hideIds/0'])
    await refused('quality', 'POST', `/inventory/lots/${LOT.id}/split`, { ...body, version: dialog.parent.version - 1 }, 409)
    await refused('viewer', 'POST', `/inventory/lots/${LOT.id}/split`, body, 403)
    const key = idem()
    split = await ok('quality', 'POST', `/inventory/lots/${LOT.id}/split`, body, 201, key)
    expect(split.parent).toMatchObject({ id: LOT.id, version: dialog.parent.version + 1 })
    const children = split.lots.filter((lot: Json) => lot.made)
    expect(children.map((lot: Json) => [lot.code, lot.shade, lot.qualityStatus, lot.lifecycle])).toEqual([
      [`${LOT.code}-A`, '1', 'RELEASED', 'RELEASED'],
      [`${LOT.code}-B`, '2', 'RELEASED', 'RELEASED'],
      [`${LOT.code}-C`, 'Rejected', 'RELEASED', 'RELEASED'],
    ])
    expect(split.lots.find((lot: Json) => lot.id === LOT.id)).toMatchObject({ made: false, lifecycle: 'DEPLETED' })
    expect(split.hides).toHaveLength(6)
    // A replay answers the first split; nothing is split twice.
    expect(await ok('quality', 'POST', `/inventory/lots/${LOT.id}/split`, body, 201, key)).toEqual(split)
    expect((await admin(`SELECT count(*)::int AS n FROM "Lot" WHERE "parentLotId" = $1`, [LOT.id]))[0]!.n).toBe(3)
    // Every child keeps the parent link, the receiver (the four-eyes rule), the release, the Cr VI result and the attributes.
    for (const child of children) {
      expect(await lotRow(child.id)).toMatchObject({ parentLotId: LOT.id, createdById: people.receiver, quality: 'RELEASED', attributes: { tannage: 'CHROME', origin: 'Italy' } })
    }
    // The old tags hold nothing; the new ones hold the same area at the same place, shade by record from the article's groups.
    for (const moved of split.hides) {
      expect(await onHand(moved.fromHideId)).toBe('0.0000')
      expect(await onHand(moved.hideId)).toBe('50.0000')
      expect(moved.code).not.toBe(moved.fromCode)
    }
    const shade1 = split.hides.find((moved: Json) => moved.fromHideId === HIDES[0]!.id)
    expect((await admin(`SELECT "shadeGroupId", shade, grade, "supplierCode", "thicknessMm"::text AS t FROM "Hide" WHERE id = $1`, [shade1.hideId]))[0]).toEqual({ shadeGroupId: A.shade1, shade: '1', grade: 'A', supplierCode: 'TAN-1', t: '1.20' })
    // Two ADJUSTMENT moves per hide, coded LOT_SPLIT; the family's value is unchanged (each entry valued as its exit).
    const [moves] = await admin<{ n: number; value: number }>(
      `SELECT count(*)::int AS n, coalesce(sum(v."valueAmount"), 0)::int AS value FROM "StockMove" m LEFT JOIN "StockValuation" v ON v."moveId" = m.id WHERE m."tenantId" = $1 AND m."reasonCode" = 'LOT_SPLIT' AND m.reference = $2`,
      [A.tenant, LOT.code],
    )
    expect(moves).toEqual({ n: 12, value: 0 })
    // The link from each old tag to its new one, on both rows; the new lots name the inspection they came from.
    expect((await admin(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'inventory.hideRelotted' AND "tenantId" = $1 AND after->>'lotId' = ANY($2::text[])`, [A.tenant, children.map((lot: Json) => lot.id)]))[0]!.n).toBe(12)
    expect((await admin(`SELECT after->>'inspectionId' AS i FROM "AuditLog" WHERE action = 'inventory.lotMadeBySplit' AND "recordId" = $1`, [children[0].id]))[0]!.i).toBe(inspectionId)
    expect((await events('lot.split')).at(-1)).toMatchObject({ kind: 'SPLIT', parentLotId: LOT.id, fromLotIds: [LOT.id], newLotIds: children.map((lot: Json) => lot.id), hides: 6 })
    expect((await events('lot.lifecycle_changed')).filter((change) => change.lotId === LOT.id).at(-1)).toMatchObject({ from: 'RELEASED', to: 'DEPLETED', cause: 'LAST_UNIT_OUT' })
    // The parent's page and a child's: the family both ways, the child's inspection and documents from its parent.
    const parentView = await depth(LOT.id)
    expect(parentView.lifecycle).toMatchObject({ state: 'DEPLETED', expected: 'DEPLETED' })
    expect(parentView.lifecycle.depletedAt).not.toBeNull()
    expect(parentView.family.children.map((child: Json) => [child.code, child.hidesInStock, child.onHand])).toEqual([
      [`${LOT.code}-A`, 2, '100.0000'],
      [`${LOT.code}-B`, 3, '150.0000'],
      [`${LOT.code}-C`, 1, '50.0000'],
    ])
    const childView = await depth(children[0].id)
    expect(childView.family).toMatchObject({ parent: { id: LOT.id, code: LOT.code, lifecycle: 'DEPLETED' }, children: [] })
    expect(childView.incoming).toMatchObject({ state: 'PASSED', number: `T313-IIN-${run}`, inspections: [{ from: 'PARENT' }] })
    expect(childView.separation).toMatchObject({ state: 'KEPT', receivedBy: { name: 'Rita Ricevi' } })
  })

  it('regroups a hide between the lots of the family and back into the parent, never into another family', async () => {
    const dialog = await ok('quality', 'GET', `/inventory/lots/${LOT.id}/split`)
    const [childA, childB] = dialog.lots.filter((lot: Json) => lot.id !== LOT.id)
    const inA = dialog.hides.filter((hide: Json) => hide.lot.id === childA.id)
    expect(inA).toHaveLength(2)
    const outside = await refused('keeper', 'POST', `/inventory/lots/${childA.id}/regroup`, { version: dialog.parent.version, moves: [{ hideId: inA[0].id, toLotId: A.seedLot }] }, 400)
    expect(paths(outside)).toEqual(['body/moves/0/toLotId'])
    const same = await refused('keeper', 'POST', `/inventory/lots/${childA.id}/regroup`, { version: dialog.parent.version, moves: [{ hideId: inA[0].id, toLotId: childA.id }] }, 400)
    expect(same.message).toMatch(/already/)
    const regrouped = await ok('keeper', 'POST', `/inventory/lots/${childA.id}/regroup`, { version: dialog.parent.version, moves: [{ hideId: inA[0].id, toLotId: childB.id }, { hideId: inA[1].id, toLotId: LOT.id }], note: 'Shade 2 after all.' })
    expect(regrouped.hides.map((hide: Json) => hide.lot.code)).toEqual([childB.code, LOT.code])
    // Into child B the hide takes B's shade (the article's group 2); child A is empty now, the parent holds stock again.
    expect((await admin(`SELECT "shadeGroupId" FROM "Hide" WHERE id = $1`, [regrouped.hides[0].hideId]))[0]!.shadeGroupId).toBe(A.shade2)
    expect((await lotRow(childA.id)).lifecycle).toBe('DEPLETED')
    expect((await lotRow(LOT.id)).lifecycle).toBe('RELEASED')
    expect((await events('lot.split')).at(-1)).toMatchObject({ kind: 'REGROUP', newLotIds: [], hides: 2 })
  })

  it('lists lots with their lifecycle, hides the depleted ones by default and counts them in the tiles', async () => {
    const family = await ok('viewer', 'GET', `/inventory/lots-depth?q=${LOT.code}`)
    expect(family.lots.map((row: Json) => row.code).sort()).toEqual([LOT.code, `${LOT.code}-B`, `${LOT.code}-C`])
    const depleted = await ok('viewer', 'GET', `/inventory/lots-depth?q=${LOT.code}&view=DEPLETED`)
    expect(depleted.lots.map((row: Json) => row.code)).toEqual([`${LOT.code}-A`])
    const children = await ok('viewer', 'GET', `/inventory/lots-depth?parentLotId=${LOT.id}&view=ALL`)
    expect(children.lots).toHaveLength(3)
    expect(children.lots[0]).toMatchObject({ parentLot: { id: LOT.id, code: LOT.code } })
    expect((await ok('viewer', 'GET', `/inventory/lots-depth?q=${LOT.code}&view=ALL`)).lots.find((row: Json) => row.id === LOT.id)).toMatchObject({ childLots: 3, lifecycle: 'RELEASED' })
    expect(family.counts.lifecycle.DEPLETED).toBeGreaterThanOrEqual(1)
    expect(family.counts.lifecycle.RELEASED).toBeGreaterThanOrEqual(3)
    expect((await ok('keeperB', 'GET', '/inventory/lots-depth?view=ALL')).lots).toEqual([])
    // B-W2b-320: the W2b columns of the rows a W1 view shows, by their ids (another company's lot is never read).
    const byIds = await ok('viewer', 'GET', `/inventory/lots-depth?view=ALL&ids=${LOT.id},${children.lots[0].id}`)
    expect(byIds.lots.map((row: Json) => row.id).sort()).toEqual([LOT.id, children.lots[0].id].sort())
    expect((await ok('keeperB', 'GET', `/inventory/lots-depth?view=ALL&ids=${LOT.id}`)).lots).toEqual([])
    await refused('viewer', 'GET', '/inventory/lots-depth?ids=not-an-id', undefined, 400)
  })
})

describe('the dated trace report (SCM-242)', () => {
  it('makes the report as PDF and CSV with what was asked and when, including the lots split from the lot', async () => {
    const today = businessDate(new Date())
    const body = { kind: 'LOT', id: LOT.id, direction: 'BOTH', audience: 'AUTHORITY', recipient: 'Market surveillance office', reference: 'REQ-313', requestedOn: today, format: 'PDF', language: 'it' }
    await refused('keeper', 'POST', '/inventory/trace/report', body, 403)
    await refused('companyB', 'POST', '/inventory/trace/report', body, 404)
    const future = await refused('quality', 'POST', '/inventory/trace/report', { ...body, requestedOn: '2999-01-01' }, 400)
    expect(paths(future)).toEqual(['body/requestedOn'])
    const pdf = await ok('quality', 'POST', '/inventory/trace/report', body, 201)
    expect(pdf.report).toMatchObject({ recordType: 'Lot', recordId: LOT.id, start: { kind: 'LOT', code: LOT.code }, asOf: today, format: 'PDF' })
    expect(pdf.report.includes.map((include: Json) => include.code)).toEqual([`${LOT.code}-A`, `${LOT.code}-B`, `${LOT.code}-C`])
    expect(pdf.report.counts.nodes).toBeGreaterThanOrEqual(4)
    expect(pdf.file).toMatchObject({ name: `trace-report-${LOT.code}-${today}.pdf`, contentType: 'application/pdf' })
    const [file] = await admin<Json>(`SELECT "recordType", "recordId", kind::text, status::text, visibility::text[] AS visibility, "retainUntil" FROM "StoredFile" WHERE id = $1`, [pdf.file.id])
    expect(file).toMatchObject({ recordType: 'Lot', recordId: LOT.id, kind: 'DOCUMENT', status: 'AVAILABLE', visibility: ['OFFICE'] })
    expect(new Date(file!.retainUntil).getUTCFullYear()).toBe(new Date().getUTCFullYear() + 10)
    const csv = await ok('quality', 'POST', '/inventory/trace/report', { ...body, format: 'CSV', language: 'en', audience: 'NOTIFIED_BODY', recipient: 'Notified body 0000', reference: null, asOf: today }, 201)
    expect(csv.file).toMatchObject({ contentType: 'text/csv' })
    const [audit] = await admin<Json>(`SELECT audience::text, "actorId", after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'inventory.traceReport' ORDER BY at, id LIMIT 1`, [LOT.id])
    expect(audit).toMatchObject({ audience: 'OFFICE', actorId: people.quality, after: { audience: 'AUTHORITY', recipient: 'Market surveillance office', reference: 'REQ-313', requestedOn: today, asOf: today, direction: 'BOTH', format: 'PDF', fileId: pdf.file.id } })
    expect((await events('lot.trace_report_made')).map((event) => event.format)).toEqual(['PDF', 'CSV'])
    const listed = await ok('viewer', 'GET', `/inventory/trace/reports?kind=LOT&id=${LOT.id}`)
    expect(listed.reports.map((report: Json) => [report.audience, report.format, report.madeBy?.name])).toEqual([
      ['NOTIFIED_BODY', 'CSV', 'Quinto Qualita'],
      ['AUTHORITY', 'PDF', 'Quinto Qualita'],
    ])
    // The answer carries no money: no cost, price or value anywhere in it.
    expect(JSON.stringify(pdf)).not.toMatch(/cost|price|valueAmount/i)
  })
})
