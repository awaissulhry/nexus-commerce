import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import type { Clock } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedShipping, type ShippingSeed } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, COMMAND_SETTINGS, runCommand } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { systemContext } from '../../../platform/outbox/system'
import { openRegisterEntryFor } from './hook'
import { useRegisterClock } from './register'

/**
 * The PPE register (B-W1-43; QHS-118; Reg. (EU) 2016/425 art. 8(4), 8(8)) on the local stack, with the app's real routes:
 * a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the
 * …_quality_shipping_guards triggers are real) and the factory-db seeds of two tenants: WO-0001 (SEED-JKT-02, batch
 * SEED-BT-0001, the leather lot issued to it) whose BLK 50 and RED 52 left on SEED-SH-0001 for the customer P1 with a
 * live DDT (and a cancelled one); WO-0003 (serial-tracked SEED-JKT-03) with one serial on the DRAFT SEED-SH-0002; the
 * seed's OPEN complaint SEED-REG-2026-001. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs register`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seedA: ShippingSeed

let current = new Date('2026-12-01T09:00:00.000Z').getTime()
const clock: Clock & { advance(ms: number): void } = { now: () => new Date(current), advance: (ms) => void (current += ms) }
const HOUR = 60 * 60 * 1000
const YEAR = '2026'

const ns = { a: 'register-a', b: 'register-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  companyA: idOf(ns.a, 'company:A'),
  companyB: idOf(ns.a, 'company:B'),
  siteA1: idOf(ns.a, 'site:A1'),
  P1: idOf(ns.a, 'party:P1'),
  P2: idOf(ns.a, 'party:P2'),
}
const B = { tenant: idOf(ns.b, 'tenant'), companyA: idOf(ns.b, 'company:A') }

const VIEW: Permission = 'compliance.register.view'
const MANAGE: Permission = 'compliance.register.manage'
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties })
const quality = newId()
const SESSIONS: Record<string, SessionContext> = {
  quality: { audience: 'office', tenantId: A.tenant, actorId: quality, grants: [grant([VIEW, MANAGE, 'threads.read', 'threads.post'])] },
  viewer: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant([VIEW, 'threads.read'])] },
  companyB: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant([VIEW, MANAGE], [A.companyB])] },
  partyP2: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant([VIEW, MANAGE], 'all', [A.P2])] },
  otherTenant: { audience: 'office', tenantId: B.tenant, actorId: newId(), grants: [grant([VIEW, MANAGE])] },
  floor: { audience: 'floor', tenantId: A.tenant, actorId: newId(), siteId: A.siteA1, deviceId: newId(), grants: [{ permissions: [VIEW, MANAGE], companies: [A.companyA], sites: [A.siteA1], parties: 'all' }] },
  portal: { audience: 'partner', tenantId: A.tenant, actorId: newId(), partyId: A.P1, grants: [grant([VIEW, MANAGE])] },
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { 'x-test-session': session, ...(SESSIONS[session]?.audience === 'floor' && method !== 'GET' ? { 'idempotency-key': `reg-${run}-${++keys}` } : {}) },
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
const problemCodes = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path).replace('problem/', ''))
const auditOf = (recordId: string) => admin('SELECT action, before, after, reason, audience FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id', [recordId])
const eventsOf = (type: string, subject: string) => admin('SELECT type, "companyId", payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2 ORDER BY "occurredAt", id', [type, subject])
const url = (entryId: string, tail = '') => `/compliance/register/${entryId}${tail}`

let jkt02: string
let jkt03: string
let liveDdt: string
const entries: Record<string, Json> = {}

beforeAll(async () => {
  db = await migratedDatabase('ppe_register')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: database, namespace })
  seedA = await seedShipping({ db: database, namespace: ns.a })
  await seedShipping({ db: database, namespace: ns.b })
  jkt02 = seedA.quality.production.styleId
  jkt03 = seedA.quality.serialStyleId
  const [ddt] = await admin<{ number: string }>(
    `SELECT d.number FROM "Ddt" d WHERE d."shipmentId" = $1 AND NOT EXISTS (SELECT 1 FROM "DdtCancellation" c WHERE c."ddtId" = d.id)`,
    [seedA.shipmentId],
  )
  liveDdt = ddt!.number
  useRegisterClock(clock)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      clock,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
      logger: false,
    },
  )
}, 180_000)

afterAll(async () => {
  useRegisterClock(undefined)
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the PPE register (QHS-118; Reg. (EU) 2016/425 art. 8(4))', () => {
  it('records a non-conformity on a seeded batch; its trace lists the shipment that left, its live DDT and the customer', async () => {
    const created = (
      await ok(
        'quality',
        'POST',
        '/compliance/register',
        { companyId: A.companyA, kind: 'NON_CONFORMITY', styleId: jkt02, batchNumbers: [' SEED-BT-0001 ', 'SEED-BT-0001'], description: 'A shoulder protector pocket seam opens under load.', reportedAt: '2026-11-30T08:00:00.000Z' },
        201,
      )
    ).entry
    entries.nc = created
    expect(created).toMatchObject({ reference: `REG-${YEAR}-0001`, kind: 'NON_CONFORMITY', status: 'OPEN', risk: 'ASSESSING', batchNumbers: ['SEED-BT-0001'], version: 1, source: null, style: { id: jkt02, code: 'SEED-JKT-02' } })
    const trace = created.trace
    expect(trace.workOrders.map((workOrder: Json) => [workOrder.number, workOrder.reach, workOrder.via])).toEqual([['SEED-WO-0001', 'WHOLE', ['BATCH']]])
    expect(trace.shipments).toEqual([expect.objectContaining({ id: seedA.shipmentId, number: 'SEED-SH-0001', status: 'SHIPPED', left: true, partyId: A.P1, ddtNumbers: [liveDdt], garments: 2 })])
    expect(trace.customers).toEqual([expect.objectContaining({ partyId: A.P1, garments: 2, shipmentNumbers: ['SEED-SH-0001'], ddtNumbers: [liveDdt] })])
    expect(trace).toMatchObject({ shippedGoods: true, problems: [] })
    expect(created.duties.find((duty: Json) => duty.code === 'DISTRIBUTORS')).toMatchObject({ required: true, done: false })
    expect(created.toClose.map((problem: Json) => problem.code)).toEqual(['RISK_NOT_ASSESSED', 'NO_CORRECTIVE_ACTION', 'DISTRIBUTORS_NOT_INFORMED'])

    expect(await auditOf(created.id)).toMatchObject([{ action: 'compliance.register.create', audience: 'OFFICE', after: { reference: created.reference, status: 'OPEN', risk: 'ASSESSING', batchNumbers: ['SEED-BT-0001'] } }])
    // The reference is the company's PPE_REGISTER series' number (allocateNumber: its NumberAllocation row).
    expect(await admin('SELECT kind::text AS kind, formatted FROM "NumberAllocation" WHERE "recordType" = $1 AND "recordId" = $2', ['PpeRegisterEntry', created.id])).toEqual([{ kind: 'PPE_REGISTER', formatted: created.reference }])
    expect(await eventsOf('compliance.register_entry_opened', created.id)).toEqual([
      { type: 'compliance.register_entry_opened', companyId: A.companyA, payload: { entryId: created.id, reference: created.reference, kind: 'NON_CONFORMITY', styleId: jkt02, risk: 'ASSESSING', sourceType: null, sourceId: null, shippedGoods: true } },
    ])
    // The next entry of the year takes the next reference.
    const second = (await ok('quality', 'POST', '/compliance/register', { companyId: A.companyA, kind: 'COMPLAINT', styleId: jkt02, description: 'A customer reports a stiff zip.', partyId: A.P2 }, 201)).entry
    expect(second.reference).toBe(`REG-${YEAR}-0002`)
    entries.complaint = second
  })

  it('traces a material lot to the work orders it went into, serials to the lines that hold them, and says what it cannot follow', async () => {
    const lot = (await ok('quality', 'POST', '/compliance/register/trace', { companyId: A.companyA, styleId: jkt02, lotIds: [seedA.quality.production.inventory.leatherLotId] })).trace
    expect(lot.workOrders.map((workOrder: Json) => [workOrder.number, workOrder.via])).toEqual([['SEED-WO-0001', ['LOT']]])
    expect(lot.customers.map((customer: Json) => customer.partyId)).toEqual([A.P1])
    expect(lot.lots).toEqual([{ id: seedA.quality.production.inventory.leatherLotId, code: expect.any(String), workOrderNumbers: ['SEED-WO-0001'] }])

    // A released serial of WO-0003 on no shipment: the DRAFT SEED-SH-0002 holds another garment of its cell, not this one.
    const [released] = await admin<{ serial: string }>('SELECT serial FROM "GarmentSerial" WHERE id = $1', [seedA.quality.serialIds[1]])
    const serials = (await ok('quality', 'POST', '/compliance/register/trace', { companyId: A.companyA, styleId: jkt03, serials: [released!.serial, 'NO-SUCH-SERIAL'], batchNumbers: ['SEED-BT-0001'] })).trace
    expect(serials.workOrders.map((workOrder: Json) => [workOrder.number, workOrder.reach])).toEqual([['SEED-WO-0003', 'PART']])
    expect(serials.workOrders[0].cells[0]).toMatchObject({ pieces: 4, concerned: 1, packed: 0, shipped: 0, serials: [{ serial: released!.serial, status: 'RELEASED', shipmentNumber: null }] })
    expect(serials).toMatchObject({ shipments: [], customers: [], shippedGoods: false })
    expect(serials.problems.map((problem: Json) => [problem.path, problem.code])).toEqual([
      ['concern/batchNumbers/0', 'OTHER_STYLE_BATCH'],
      ['concern/serials/1', 'UNKNOWN_SERIAL'],
    ])
    // Its batch: the whole work order, the DRAFT shipment's garment packed, nothing left yet.
    const batch = (await ok('quality', 'POST', '/compliance/register/trace', { companyId: A.companyA, styleId: jkt03, batchNumbers: ['SEED-BT-0003'] })).trace
    expect(batch.workOrders.map((workOrder: Json) => workOrder.reach)).toEqual(['WHOLE'])
    expect(batch.shipments).toEqual([expect.objectContaining({ number: 'SEED-SH-0002', status: 'DRAFT', left: false, garments: 1, ddtNumbers: [] })])
    expect(batch).toMatchObject({ counts: { concerned: 4, packed: 1, shipped: 0, customers: 0 }, shippedGoods: false })
    // A named shipment: its garments of the style only (the shipments a reversed release's garments left on).
    const shipped = (await ok('quality', 'POST', '/compliance/register/trace', { companyId: A.companyA, styleId: jkt02, shipmentIds: [seedA.shipmentId] })).trace
    expect(shipped.workOrders.map((workOrder: Json) => [workOrder.number, workOrder.reach, workOrder.via])).toEqual([['SEED-WO-0001', 'PART', ['SHIPMENT']]])
    expect(shipped).toMatchObject({ counts: { concerned: 2, shipped: 2 }, customers: [{ partyId: A.P1, garments: 2 }], shippedGoods: true })
    // Another company's lot or a work order of another style is refused before anything is read.
    const wrong = await refused('quality', 'POST', '/compliance/register/trace', { companyId: A.companyA, styleId: jkt03, workOrderIds: [seedA.quality.production.workOrderId], lotIds: [newId()] }, 400)
    expect(wrong.issues.map((issue: Json) => issue.path)).toEqual(['body/lotIds/0', 'body/workOrderIds/0'])
  })

  it('refuses to close without the corrective action done and, since goods left, the distributors informed; then closes', async () => {
    let entry = entries.nc!
    const first = await refused('quality', 'POST', url(entry.id, '/close'), { version: entry.version, reason: '' }, 409)
    expect(problemCodes(first)).toEqual(['NO_REASON', 'RISK_NOT_ASSESSED', 'NO_CORRECTIVE_ACTION', 'DISTRIBUTORS_NOT_INFORMED'])
    expect(first.message).toContain('SEED-SH-0001')

    entry = (await ok('quality', 'PATCH', url(entry.id), { version: entry.version, risk: 'NO', investigation: 'Seam allowance below the specification on one machine.', actionTaken: 'Machine reset; the seams of the batch re-checked.' })).entry
    expect(entry).toMatchObject({ risk: 'NO', version: 2 })
    expect(await eventsOf('compliance.register_entry_changed', entry.id)).toMatchObject([{ payload: { change: 'EDITED', risk: 'NO', previousRisk: 'ASSESSING' } }])
    // A stale version is refused.
    expect((await refused('quality', 'PATCH', url(entry.id), { version: 1, description: 'Late edit.' }, 409)).code).toBe('conflict')

    const recorded = await refused('quality', 'POST', url(entry.id, '/close'), { version: entry.version, reason: 'Fixed.' }, 409)
    expect(problemCodes(recorded)).toEqual(['CORRECTIVE_ACTION_NOT_DONE', 'DISTRIBUTORS_NOT_INFORMED'])

    clock.advance(HOUR)
    expect((await refused('quality', 'POST', url(entry.id, '/corrective-action/complete'), { version: entry.version, completedAt: '2026-11-29T08:00:00.000Z' }, 400)).issues[0].path).toBe('body/completedAt')
    entry = (await ok('quality', 'POST', url(entry.id, '/corrective-action/complete'), { version: entry.version })).entry
    expect(entry.actionCompletedAt).toBe(new Date(current).toISOString())
    // Done: its text stays as it was done.
    expect(problemCodes(await refused('quality', 'PATCH', url(entry.id), { version: entry.version, actionTaken: 'Something else.' }, 409))).toEqual(['ACTION_DONE'])

    const distributors = await refused('quality', 'POST', url(entry.id, '/close'), { version: entry.version, reason: 'Fixed.' }, 409)
    expect(problemCodes(distributors)).toEqual(['DISTRIBUTORS_NOT_INFORMED'])
    // The database holds the same duty for every login: garments it concerns left on SEED-SH-0001.
    await expect(admin(`UPDATE "PpeRegisterEntry" SET status = 'CLOSED', "closedAt" = now(), "closedById" = $2, "closeReason" = 'x' WHERE id = $1`, [entry.id, quality])).rejects.toThrow(/left for customers: it closes once the distributors were informed/)

    entry = (await ok('quality', 'POST', url(entry.id, '/distributors-informed'), { version: entry.version, note: 'P1 told by e-mail and phone; no garment to return.' })).entry
    expect(entry.distributorsInformedAt).toBe(new Date(current).toISOString())
    const [message] = await admin<{ bodyText: string; direction: string; audience: string }>(
      `SELECT m."bodyText", m.direction::text AS direction, m.audience::text AS audience FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordType" = 'PpeRegisterEntry' AND t."recordId" = $1`,
      [entry.id],
    )
    expect(message).toMatchObject({ direction: 'INTERNAL_NOTE', audience: 'OFFICE', bodyText: expect.stringContaining('P1 told by e-mail and phone') })

    entry = (await ok('quality', 'POST', url(entry.id, '/close'), { version: entry.version, reason: 'Seams fixed; P1 informed; nothing presents a risk.' })).entry
    expect(entry).toMatchObject({ status: 'CLOSED', closedById: quality, closeReason: 'Seams fixed; P1 informed; nothing presents a risk.', toClose: [] })
    expect((await auditOf(entry.id)).at(-1)).toMatchObject({ action: 'compliance.register.close', reason: 'Seams fixed; P1 informed; nothing presents a risk.', after: { status: 'CLOSED' } })
    expect(await eventsOf('compliance.register_entry_closed', entry.id)).toMatchObject([{ payload: { reference: entry.reference, shippedGoods: true } }])

    // Closed: it never changes (a note on its thread is the correction); the trigger holds it for every write.
    expect(problemCodes(await refused('quality', 'PATCH', url(entry.id), { version: entry.version, description: 'Changed.' }, 409))).toEqual(['CLOSED'])
    expect(problemCodes(await refused('quality', 'POST', url(entry.id, '/distributors-informed'), { version: entry.version, note: 'Again.' }, 409))).toEqual(['CLOSED'])
    const note = await ok('quality', 'POST', url(entry.id, '/notes'), { body: 'Correction: the seam was on the left shoulder.' }, 201)
    expect(note).toMatchObject({ messageId: expect.any(String), threadId: expect.any(String) })
    await expect(admin(`UPDATE "PpeRegisterEntry" SET description = 'x' WHERE id = $1`, [entry.id])).rejects.toThrow(/CLOSED; it never changes/)
    await expect(admin(`DELETE FROM "PpeRegisterEntry" WHERE id = $1`, [entry.id])).rejects.toThrow(/never deleted/)
  })

  it('asks a recall that may present a risk for the authority notice, with its date and reference, before it closes', async () => {
    const bare = await refused('quality', 'POST', '/compliance/register', { companyId: A.companyA, kind: 'RECALL', styleId: jkt03, description: 'Recall.' }, 400)
    expect(bare.issues).toEqual([{ path: 'body/batchNumbers', message: expect.stringContaining('A recall names what it calls back') }])

    const serials = (await admin<{ serial: string }>('SELECT serial FROM "GarmentSerial" WHERE "workOrderId" = $1 ORDER BY serial', [seedA.quality.serialWorkOrderId])).map((row) => row.serial)
    let entry = (
      await ok(
        'quality',
        'POST',
        '/compliance/register',
        { companyId: A.companyA, kind: 'RECALL', styleId: jkt03, serials, risk: 'YES', description: 'Back protector may detach in a crash.', actionTaken: 'Every garment called back; protectors replaced.' },
        201,
      )
    ).entry
    expect(entry.trace.shippedGoods).toBe(false)
    expect(entry.duties.find((duty: Json) => duty.code === 'AUTHORITY')).toMatchObject({ required: true, done: false })
    entry = (await ok('quality', 'POST', url(entry.id, '/corrective-action/complete'), { version: entry.version })).entry

    const noNotice = await refused('quality', 'POST', url(entry.id, '/close'), { version: entry.version, reason: 'Recalled.' }, 409)
    expect(problemCodes(noNotice)).toEqual(['AUTHORITY_NOT_NOTIFIED'])
    expect(noNotice.message).toContain('art. 8(8)')
    await expect(admin(`UPDATE "PpeRegisterEntry" SET status = 'CLOSED', "closedAt" = now(), "closedById" = $2, "closeReason" = 'x' WHERE id = $1`, [entry.id, quality])).rejects.toThrow(/may present a risk: it closes once the authorities were told/)

    const early = await refused('quality', 'POST', url(entry.id, '/authority-notified'), { version: entry.version, notifiedAt: '2026-11-01T09:00:00.000Z', reference: 'MSA-TEST-1', note: 'Sent the notice.' }, 400)
    expect(early.issues).toEqual([{ path: 'body/notifiedAt', message: expect.stringContaining('before the entry was reported') }])
    expect((await refused('quality', 'POST', url(entry.id, '/authority-notified'), { version: entry.version, notifiedAt: '2027-01-01T09:00:00.000Z', reference: 'MSA-TEST-1', note: 'x' }, 400)).issues[0].message).toBe('This date is in the future.')
    expect((await refused('quality', 'POST', url(entry.id, '/authority-notified'), { version: entry.version, reference: ' ', note: 'x' }, 400)).code).toBe('validation_failed')

    entry = (await ok('quality', 'POST', url(entry.id, '/authority-notified'), { version: entry.version, reference: 'MSA-TEST-1', note: 'Notice to the national market surveillance authority (made-up).' })).entry
    expect(entry).toMatchObject({ authorityReference: 'MSA-TEST-1', authorityNotifiedAt: new Date(current).toISOString(), toClose: [] })
    entry = (await ok('quality', 'POST', url(entry.id, '/close'), { version: entry.version, reason: 'Recall complete; authority told.' })).entry
    expect(entry.status).toBe('CLOSED')
  })

  it('lists the register with its filters, and reads the seed entry with its defaults', async () => {
    const all = (await ok('quality', 'GET', '/compliance/register')).entries
    expect(all.map((entry: Json) => entry.reference)).toEqual([`REG-${YEAR}-0003`, `REG-${YEAR}-0002`, `REG-${YEAR}-0001`, 'SEED-REG-2026-001'])
    const filtered = async (query: string) => (await ok('quality', 'GET', `/compliance/register?${query}`)).entries.map((entry: Json) => entry.reference)
    expect(await filtered('status=OPEN')).toEqual([`REG-${YEAR}-0002`, 'SEED-REG-2026-001'])
    expect(await filtered('kind=RECALL')).toEqual([`REG-${YEAR}-0003`])
    expect(await filtered('risk=YES')).toEqual([`REG-${YEAR}-0003`])
    expect(await filtered(`styleId=${jkt02}&status=OPEN&risk=ASSESSING`)).toEqual([`REG-${YEAR}-0002`, 'SEED-REG-2026-001'])
    expect(await filtered('from=2026-11-30&to=2026-11-30')).toEqual([`REG-${YEAR}-0001`])
    expect(await filtered('q=stiff%20zip')).toEqual([`REG-${YEAR}-0002`])

    const seeded = (await ok('quality', 'GET', url(seedA.quality.registerEntryId))).entry
    expect(seeded).toMatchObject({ reference: 'SEED-REG-2026-001', kind: 'COMPLAINT', risk: 'ASSESSING', party: { id: A.P1 }, trace: { shippedGoods: true } })
  })

  it('opens an entry from another step inside its command (B-W1-45: garments of a reversed release that already left)', async () => {
    const caller = callerFor(database, systemContext(A.tenant, newId()))
    const { result } = await runCommand(caller, { name: 'quality.reverseRelease', input: { test: 'hook' } }, (tools) =>
      openRegisterEntryFor(tools, {
        companyId: A.companyA,
        workOrderIds: [seedA.quality.production.workOrderId],
        description: 'Garments of a reversed release had already left: a stain found after release.',
        source: { type: 'QualityReleaseReversal', id: seedA.quality.reversalId },
      }),
    { ...COMMAND_SETTINGS, clock })
    expect(result).toMatchObject({ reference: `REG-${YEAR}-0004`, opened: true, shippedGoods: true })
    const entry = (await ok('quality', 'GET', url(result.entryId))).entry
    expect(entry).toMatchObject({ kind: 'NON_CONFORMITY', styleId: jkt02, batchNumbers: ['SEED-BT-0001'], workOrderIds: [seedA.quality.production.workOrderId], source: { type: 'QualityReleaseReversal', id: seedA.quality.reversalId }, createdAt: expect.any(String) })
    expect(entry.trace.workOrders[0].via).toEqual(['BATCH', 'WORK_ORDER'])
    expect(await auditOf(result.entryId)).toMatchObject([{ action: 'compliance.register.openFrom', audience: 'SYSTEM' }])
    expect(await eventsOf('compliance.register_entry_opened', result.entryId)).toMatchObject([{ payload: { sourceType: 'QualityReleaseReversal', shippedGoods: true } }])
    // One entry per source record: a repeat answers the same entry and writes nothing (the partial unique index holds it).
    const again = await runCommand(caller, { name: 'quality.reverseRelease', input: { test: 'hook again' } }, (tools) =>
      openRegisterEntryFor(tools, { companyId: A.companyA, workOrderIds: [seedA.quality.production.workOrderId], description: 'Again.', source: { type: 'QualityReleaseReversal', id: seedA.quality.reversalId } }).then((opened) => {
        tools.audit({ recordType: 'QualityReleaseReversal', recordId: seedA.quality.reversalId, after: { test: true } })
        return opened
      }),
    { ...COMMAND_SETTINGS, clock })
    expect(again.result).toEqual({ entryId: result.entryId, reference: result.reference, opened: false, shippedGoods: true })
    expect(await auditOf(result.entryId)).toHaveLength(1)
    await expect(
      admin(
        `INSERT INTO "PpeRegisterEntry" (id, "tenantId", "companyId", reference, kind, "styleId", "reportedAt", description, "sourceType", "sourceId") VALUES ($1, $2, $3, 'TEST-DUP', 'NON_CONFORMITY', $4, now(), 'x', 'QualityReleaseReversal', $5)`,
        [newId(), A.tenant, A.companyA, jkt02, seedA.quality.reversalId],
      ),
    ).rejects.toThrow(/PpeRegisterEntry_tenantId_sourceType_sourceId_key/)
  })

  it('holds the lists and the source in the database: rows of the company (work orders of the style), source both or neither', async () => {
    const entry = entries.complaint!
    const set = (column: string, value: unknown) => admin(`UPDATE "PpeRegisterEntry" SET "${column}" = $2 WHERE id = $1`, [entry.id, value])
    await expect(set('workOrderIds', [seedA.quality.serialWorkOrderId])).rejects.toThrow(/names a work order that is not of its company and style/)
    await expect(set('lotIds', [newId()])).rejects.toThrow(/names a material lot that is not of its company/)
    await expect(set('shipmentIds', [newId()])).rejects.toThrow(/names a shipment that is not of its company/)
    await expect(set('sourceType', 'QualityReleaseReversal')).rejects.toThrow(/names its source as a known record type and an id, or not at all/)
    await expect(set('authorityReference', 'MSA-X')).rejects.toThrow(/authority reference without the date/)
    await expect(set('actionCompletedAt', new Date())).rejects.toThrow(/corrective action done without the action/)
    // Valid lists pass (the leather lot of the company, the style's work order, the company's shipment).
    await set('lotIds', [seedA.quality.production.inventory.leatherLotId])
    await set('lotIds', [])
    // No PPE_REGISTER series open for the year: recording is refused in words, and nothing is written.
    await admin(`UPDATE "NumberSeries" SET status = 'CLOSED' WHERE "tenantId" = $1 AND kind = 'PPE_REGISTER'`, [B.tenant])
    const closed = await refused('otherTenant', 'POST', '/compliance/register', { companyId: B.companyA, kind: 'COMPLAINT', styleId: idOf(ns.b, 'production:style:JKT-02'), description: 'x' }, 404)
    expect(closed.message).toBe('This company has no active PPE register series; an admin sets it up under numbering.')
    expect(await admin(`SELECT id FROM "PpeRegisterEntry" WHERE "tenantId" = $1 AND reference LIKE 'REG-%'`, [B.tenant])).toEqual([])
  })

  it('keeps the walls: viewers only read, other companies, parties and tenants see nothing, the floor and the portal are refused', async () => {
    const entry = entries.complaint!
    expect((await ok('viewer', 'GET', url(entry.id))).entry.id).toBe(entry.id)
    expect((await refused('viewer', 'PATCH', url(entry.id), { version: entry.version, risk: 'NO' }, 403)).code).toBe('forbidden')
    expect((await refused('viewer', 'POST', '/compliance/register', { companyId: A.companyA, kind: 'COMPLAINT', styleId: jkt02, description: 'x' }, 403)).code).toBe('forbidden')

    // Company B's staff: company A's entries are not found, and they cannot record one for company A.
    await refused('companyB', 'GET', url(entry.id), undefined, 404)
    expect((await ok('companyB', 'GET', '/compliance/register')).entries).toEqual([])
    await refused('companyB', 'POST', '/compliance/register', { companyId: A.companyA, kind: 'COMPLAINT', styleId: jkt02, description: 'x' }, 403)
    await refused('companyB', 'POST', url(entry.id, '/close'), { version: entry.version, reason: 'x' }, 404)
    await refused('companyB', 'POST', '/compliance/register/trace', { companyId: A.companyA, styleId: jkt02, batchNumbers: ['SEED-BT-0001'] }, 403)

    // A grant over the party P2 reaches P2's complaint and the entries no party reported, never P1's.
    const partyList = (await ok('partyP2', 'GET', '/compliance/register')).entries.map((row: Json) => row.reference)
    expect(partyList).toContain(entry.reference)
    expect(partyList).not.toContain('SEED-REG-2026-001')
    await refused('partyP2', 'GET', url(seedA.quality.registerEntryId), undefined, 404)

    // Another tenant: nothing of tenant A, whatever its grants (row-level security).
    await refused('otherTenant', 'GET', url(entry.id), undefined, 404)
    expect((await ok('otherTenant', 'GET', '/compliance/register')).entries.map((row: Json) => row.reference)).toEqual(['SEED-REG-2026-001'])
    await refused('otherTenant', 'POST', '/compliance/register', { companyId: A.companyA, kind: 'COMPLAINT', styleId: jkt02, description: 'x' }, 400)

    // Office only: a floor device and a portal user are refused, even holding the permissions.
    await refused('floor', 'GET', '/compliance/register', undefined, 403)
    await refused('floor', 'POST', url(entry.id, '/close'), { version: entry.version, reason: 'x' }, 403)
    await refused('portal', 'GET', url(entry.id), undefined, 403)
    await refused('portal', 'POST', '/compliance/register', { companyId: A.companyA, kind: 'COMPLAINT', styleId: jkt02, description: 'x' }, 403)
  })
})
