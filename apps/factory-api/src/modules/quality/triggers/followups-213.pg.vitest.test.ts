import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../platform/outbox/system'
import { inspectionTriggerHandlers } from './handler'

/**
 * B-W2b-213 (W2b schema wave 24/33's readers) through the app's real routes and the worker's real handler on a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security and B-W2b-204's guards are real),
 * tenant A from EVERY seed. Made-up words only.
 *   - a PACKING rule opens the final inspection of the garments that wait, with no inspector, due its hours later; nobody's
 *     in My inspections until the first inspector records it; a rule that opened records is switched off, not deleted;
 *   - the count is Inspection.inspectedCount: an AQL_SAMPLE entry kept before the column is copied once; a counted unit
 *     freezes the AQL profile (in words, never a 500);
 *   - an in-process check a rule opened: due its hours later; its frozen sample counted ("2 of 3"); the office moves it;
 *   - a counted incoming lot's units inspected;
 *   - the tenant's severity words per class and language (critical's meaning locked), read by the floor's vocabulary.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/quality/triggers`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'followups-213'
const id = (key: string) => seedUuid(NS, key)
const firstId = (key: string) => `00000000${id(key).slice(8)}`
const A = {
  tenant: id('tenant'),
  companyA: id('company:A'),
  siteA1: id('site:A1'),
  operator: id('worker:A1:operator'),
  inLine: id('inspection-plans:plan:INL-FIRST'),
  final: firstId('inspection-plans:plan:FIN-JACKET'),
  ruleBundle: id('inspection-plans:trigger:bundle'),
  ruleOperation: id('inspection-plans:trigger:operation'),
  workOrder: id('production:work-order:WO-0001'),
  opQc: id('production:WO-0001:operation:30'),
  opPack: id('production:WO-0001:operation:40'),
  bundles: [id('production:bundle:WO-0001:1'), id('production:bundle:WO-0001:2')] as const,
  profileStd: id('inspection-plans:aql:AQL-STD'),
}

let h: Harness
let app: FastifyInstance
const grant = (permissions: readonly Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const INSPECT: Permission[] = ['quality.inspections.view', 'quality.inspections.record', 'quality.inprocess.view', 'quality.inprocess.record', 'quality.incoming.view', 'quality.incoming.record', 'quality.aql.view']
const inspectorId = newId()
const SESSIONS: Record<string, SessionContext> = {
  keeper: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['quality.triggers.view', 'quality.triggers.manage', 'quality.inspections.view', 'quality.plans.view'])] },
  inspector: { audience: 'office', tenantId: A.tenant, actorId: inspectorId, grants: [grant(INSPECT)] },
  viewer: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['quality.inspections.view', 'quality.inprocess.view', 'quality.defects.view'])] },
  words: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['quality.defects.view', 'quality.defects.manage'])] },
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
/** Planted rows, with the triggers off (made-up states the seed has not). */
const force = async (sql: string) => {
  await h.db.admin.query(`BEGIN; SET LOCAL session_replication_role = replica; ${sql}; COMMIT;`)
}
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `fu213-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, key = freshKey()) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
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
const trail = async (ruleId: string) => admin<{ action: string; after: Json }>(`SELECT action, after FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'InspectionTrigger' AND "recordId" = $2 AND action IN ('quality.inspectionOpenedByRule', 'quality.inspectionSkippedByRule') ORDER BY at, id`, [A.tenant, ruleId])

const handler = inspectionTriggerHandlers()[0]!
const envelope = (type: string, payload: Json, eventId = newId()): EventEnvelope => ({
  eventId,
  type,
  version: 1,
  context: type.split('.')[0]!,
  tenantId: A.tenant,
  companyId: A.companyA,
  siteId: A.siteA1,
  subject: A.workOrder,
  correlationId: `test-${run}`,
  causationId: null,
  source: 'test',
  occurredAt: new Date().toISOString(),
  payload,
})
const handle = (event: EventEnvelope) => handler.handle(event, { caller: callerFor(h.database, systemContext(A.tenant, `fu213-${run}`)), attempt: 1 })
const scanEvent = (scanId: string, bundleId: string, eventId?: string) =>
  envelope('production.scan_recorded', { workOrderId: A.workOrder, number: 'SEED-WO-0001', bundleId, scanId, kind: 'REPORT', operationId: null, operationSeq: 40, correctsId: null, goodQuantity: 1, scrapQuantity: 0, reworkQuantity: 0, postedBy: 'FLOOR' }, eventId)

/** A bundle reported at an operation on the tablet, as the seed writes it (the floor scope, now). */
async function report(bundleId: string, workOrderOperationId: string, goodQuantity = 1): Promise<string> {
  const scanId = newId()
  const at = new Date()
  await h.database.withScope({ audience: 'floor', tenantId: A.tenant, actorId: A.operator, siteId: A.siteA1 }, (client) =>
    client.$transaction((tx) =>
      tx.operationScan.create({
        data: { id: scanId, siteId: A.siteA1, workOrderId: A.workOrder, workOrderOperationId, bundleId, kind: 'REPORT', goodQuantity, workerId: A.operator, deviceId: id('device:A1:cutting'), clientScanId: `fu213-${run}-${scanId}`, deviceTime: at, serverTime: at, createdById: A.operator },
        select: { id: true },
      }),
    ),
  )
  return scanId
}

const refs = { packingRule: '', inspection: '', rovingRule: '', check: '', qcScan: '' }

beforeAll(async () => {
  h = await startHarness('quality_fu_213')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, clock: h.clock, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  // The seed's scan rules are switched off: each test names the one rule it watches.
  for (const ruleId of [A.ruleBundle, A.ruleOperation]) {
    const rule = (await ok('keeper', 'GET', `/quality/inspection-triggers/${ruleId}`)).rule
    await ok('keeper', 'PATCH', `/quality/inspection-triggers/${ruleId}`, { version: rule.version, active: false })
  }
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 120_000)

describe('a PACKING rule opens a final inspection with no inspector, due its hours later (FQ4:02, FQ4:03)', () => {
  it('opens the final inspection of the garments that wait; nobody\'s until an inspector takes it', async () => {
    const created = await ok('keeper', 'POST', '/quality/inspection-triggers', { companyId: A.companyA, event: 'PACKING', planId: A.final, frequency: 'EVERY_LOT', dueHours: 8 }, 201)
    refs.packingRule = created.rule.id
    expect(created.rule).toMatchObject({ event: 'PACKING', recordKind: 'FINAL', recordKindWords: { en: 'Final inspection' }, dueHours: 8, dueWords: { it: 'Da fare entro 8 h', en: 'Due within 8 h' } })
    // Planted: the seed's open inspections and releases of SEED-WO-0001 set aside, its second bundle made one of whole
    // garments (the seed's are sleeves), and both bundles reported through inspection (30) and packing (40), the whole
    // garments first at packing: two finished garments wait for a final inspection.
    await force(`UPDATE "Inspection" SET status = 'CANCELLED' WHERE "workOrderId" = '${A.workOrder}' AND status = 'OPEN'; DELETE FROM "QualityReleaseReversal" WHERE "releaseId" IN (SELECT r.id FROM "QualityRelease" r JOIN "WorkOrderSize" c ON c.id = r."workOrderSizeId" WHERE c."workOrderId" = '${A.workOrder}'); DELETE FROM "QualityRelease" WHERE "workOrderSizeId" IN (SELECT id FROM "WorkOrderSize" WHERE "workOrderId" = '${A.workOrder}'); UPDATE "Bundle" SET part = NULL WHERE id = '${A.bundles[1]}'`)
    await report(A.bundles[0], A.opQc)
    refs.qcScan = await report(A.bundles[1], A.opQc, 2)
    const scanId = await report(A.bundles[1], A.opPack, 2)
    const secondScan = await report(A.bundles[0], A.opPack)
    const bench = (await ok('inspector', 'GET', '/quality/final/work-orders?number=SEED-WO-0001&limit=5')).workOrders.find((row: Json) => row.id === A.workOrder)
    const waiting = (bench.finished ?? 0) - bench.released
    expect(waiting).toBeGreaterThan(0)
    const event = scanEvent(scanId, A.bundles[1])
    await handle(event)
    await handle(event) // a repeated job answers from its receipt: never a second one
    const rows = await admin<Json>(`SELECT id, number, status, "lotSize", "sampleSize", "inspectorUserId", "inspectorWorkerId", "openedByTriggerId", "inspectedCount", "dueAt", "createdAt", "planVersionId" FROM "Inspection" WHERE "workOrderId" = $1 AND status = 'OPEN'`, [A.workOrder])
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    refs.inspection = row.id
    expect(row).toMatchObject({ openedByTriggerId: refs.packingRule, inspectorUserId: null, inspectorWorkerId: null, lotSize: waiting, inspectedCount: 0 })
    expect(row.number).toMatch(/\S/)
    expect(new Date(row.dueAt).getTime() - new Date(row.createdAt).getTime()).toBe(8 * 3_600_000)
    expect((await trail(refs.packingRule)).map((entry) => [entry.action, entry.after.recordType])).toEqual([['quality.inspectionOpenedByRule', 'Inspection']])
    expect((await events('inspection_trigger.inspection_opened')).filter((payload) => payload.triggerId === refs.packingRule)).toEqual([expect.objectContaining({ recordType: 'Inspection', recordId: row.id, kind: 'FINAL', event: 'PACKING', inspectionNumber: row.number })])

    // The second bundle at packing: every lot = the work order's first bundle there; nothing more opens.
    await handle(scanEvent(secondScan, A.bundles[0]))
    expect(await admin(`SELECT id FROM "Inspection" WHERE "workOrderId" = $1 AND status = 'OPEN'`, [A.workOrder])).toHaveLength(1)

    // Nobody's: My inspections lists it for every inspector, due; the record says a rule opened it and nobody took it.
    const queue = await ok('inspector', 'GET', '/quality/queue?scope=mine')
    expect(queue.rows.find((entry: Json) => entry.id === row.id)).toMatchObject({ kind: 'FINAL', taken: 'NOBODY', may: { record: true }, dueAt: new Date(row.dueAt).toISOString() })
    const read = await ok('inspector', 'GET', `/quality/inspections/${row.id}`)
    expect(read).toMatchObject({ yours: true, inspection: { openedByRule: true, taken: false, inspected: 0 } })
  })

  it('the count is the column; an AQL_SAMPLE entry kept before it is copied once; the first count takes the inspection', async () => {
    // Planted: an inspection counted before the column (its count in the AQL_SAMPLE entry of checklist).
    await force(`UPDATE "Inspection" SET "inspectedCount" = NULL, checklist = '[{"code":"AQL_SAMPLE","ok":null,"note":"1 of 2 inspected","inspected":1}]'::jsonb WHERE id = '${refs.inspection}'`)
    let sheet = await ok('inspector', 'GET', `/quality/inspections/${refs.inspection}/sheet`)
    expect(sheet.counter.inspected).toBe(1)
    expect((await refused('viewer', 'POST', `/quality/inspections/${refs.inspection}/count`, { version: sheet.inspection.version, add: 1 }, 403)).code).toBe('forbidden')
    const sample = sheet.counter.sampleSize as number
    sheet = await ok('inspector', 'POST', `/quality/inspections/${refs.inspection}/count`, { version: sheet.inspection.version, add: 1 })
    expect(sheet.counter.inspected).toBe(Math.min(2, sample))
    const [row] = await admin<Json>(`SELECT "inspectedCount", checklist, "inspectorUserId" FROM "Inspection" WHERE id = $1`, [refs.inspection])
    expect(row).toMatchObject({ inspectedCount: Math.min(2, sample), inspectorUserId: inspectorId })
    expect((row!.checklist as Json[]).some((entry) => entry.code === 'AQL_SAMPLE')).toBe(false)
    const [audit] = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordType" = 'Inspection' AND "recordId" = $1 AND action = 'quality.inspection.count' ORDER BY at DESC LIMIT 1`, [refs.inspection])
    expect(audit!.after).toMatchObject({ copiedFrom: 'AQL_SAMPLE' })
    // Taken: it is the inspector's now (the queue says MINE); past the sample is refused in words.
    expect((await ok('inspector', 'GET', '/quality/queue?scope=mine')).rows.find((entry: Json) => entry.id === refs.inspection)).toMatchObject({ taken: 'MINE', progress: { done: Math.min(2, sample), of: sample } })
    expect(paths(await refused('inspector', 'POST', `/quality/inspections/${refs.inspection}/count`, { version: sheet.inspection.version, inspected: sample + 1 }, 400))).toEqual(['body/inspected'])
    // A counted unit freezes the AQL profile: the profile route says so (409), never a 500.
    const frozen = await refused('inspector', 'POST', `/quality/aql/inspections/${refs.inspection}/profile`, { version: sheet.inspection.version, profileId: A.profileStd, reason: 'Made-up reason: another profile.' }, 409)
    expect(frozen.message).toMatch(/frozen once counting starts: \d+ units? counted/)
  })

  it('a rule that opened records is switched off, never deleted', async () => {
    const rule = (await ok('keeper', 'GET', `/quality/inspection-triggers/${refs.packingRule}`)).rule
    const error = await refused('keeper', 'DELETE', `/quality/inspection-triggers/${refs.packingRule}?version=${rule.version}`, undefined, 409)
    expect(paths(error)).toEqual(['refusal/OPENED_RECORDS'])
    expect(error.message).toBe('This rule opened 1 inspection: each keeps it as the rule that opened it, so it is not deleted. Switch it off instead: it opens nothing more.')
    const off = await ok('keeper', 'PATCH', `/quality/inspection-triggers/${refs.packingRule}`, { version: rule.version, active: false, dueHours: null })
    expect(off.rule).toMatchObject({ active: false, dueHours: null, dueWords: null })
  })
})

describe('an in-process check a rule opened: due, its frozen sample counted, moved by the office (FQ4:01, FQ4:03)', () => {
  it('due its hours later; "2 of 3"; the office moves the due time', async () => {
    const created = await ok('keeper', 'POST', '/quality/inspection-triggers', { companyId: A.companyA, event: 'BUNDLE_SCAN', planId: A.inLine, frequency: 'EVERY_NTH_BUNDLE', frequencyValue: 1, dueHours: 4 }, 201)
    refs.rovingRule = created.rule.id
    // The second bundle's first report at inspection (30), planted above: the rule takes every bundle there.
    await handle(envelope('production.scan_recorded', { workOrderId: A.workOrder, number: 'SEED-WO-0001', bundleId: A.bundles[1], scanId: refs.qcScan, kind: 'REPORT', operationId: null, operationSeq: 30, correctsId: null, goodQuantity: 1, scrapQuantity: 0, reworkQuantity: 0, postedBy: 'FLOOR' }))
    const [check] = await admin<Json>(`SELECT id, kind, "openedByTriggerId", "dueAt", "createdAt", "sampleSize" FROM "InProcessCheck" WHERE "openedByTriggerId" = $1`, [refs.rovingRule])
    expect(check).toMatchObject({ kind: 'ROVING', openedByTriggerId: refs.rovingRule })
    expect(new Date(check!.dueAt).getTime() - new Date(check!.createdAt).getTime()).toBe(4 * 3_600_000)
    refs.check = check!.id
    // INL-FIRST v1 samples a fixed number (no AQL sample): nothing to count, in words.
    let view = (await ok('inspector', 'GET', `/quality/inprocess/checks/${refs.check}`)).check
    expect(view).toMatchObject({ sampleSize: null, inspected: null, progress: null, openedByRule: true })
    expect(paths(await refused('inspector', 'POST', `/quality/inprocess/checks/${refs.check}/count`, { version: view.version, add: 1 }, 409))).toContain('refusal/NO_SAMPLE')
    // Planted: an AQL sample of 3 frozen at opening.
    await force(`UPDATE "InProcessCheck" SET "sampleSize" = 3 WHERE id = '${refs.check}'`)
    view = (await ok('inspector', 'GET', `/quality/inprocess/checks/${refs.check}`)).check
    view = (await ok('inspector', 'POST', `/quality/inprocess/checks/${refs.check}/count`, { version: view.version, add: 2 })).check
    expect(view.progress).toEqual({ inspected: 2, sampleSize: 3, words: { it: '2 di 3 controllati', en: '2 of 3 inspected' } })
    expect(paths(await refused('inspector', 'POST', `/quality/inprocess/checks/${refs.check}/count`, { version: view.version, add: 2 }, 400))).toEqual(['body/inspected'])
    const due = new Date(Date.now() + 2 * 24 * 3_600_000).toISOString()
    view = (await ok('inspector', 'PATCH', `/quality/inprocess/checks/${refs.check}/due`, { version: view.version, dueAt: due })).check
    expect(view.dueAt).toBe(due)
    expect(paths(await refused('inspector', 'PATCH', `/quality/inprocess/checks/${refs.check}/due`, { version: view.version, dueAt: new Date(Date.now() - 3_600_000).toISOString() }, 400))).toEqual(['body/dueAt'])
    expect((await refused('viewer', 'PATCH', `/quality/inprocess/checks/${refs.check}/due`, { version: view.version, dueAt: null }, 403)).code).toBe('forbidden')
    // My inspections: its due time and "2 of 3".
    expect((await ok('inspector', 'GET', '/quality/queue?scope=mine')).rows.find((entry: Json) => entry.id === refs.check)).toMatchObject({ dueAt: due, progress: { done: 2, of: 3 } })
    expect((await events('in_process_check.changed')).filter((payload) => payload.checkId === refs.check).map((payload) => payload.change)).toEqual(['COUNTED', 'DUE'])
  })
})

describe("a counted incoming lot's units inspected (FQ4:01)", () => {
  it('the counter writes IncomingInspection.inspectedCount; the record shows n of N', async () => {
    const [seeded] = await admin<{ id: string }>(`SELECT id FROM "IncomingInspection" WHERE "tenantId" = $1 AND number = 'SEED-IIN-0001'`, [A.tenant])
    // Planted: the lot counted in pieces (not hide by hide), waiting for its inspector.
    await force(`UPDATE "IncomingInspection" SET uom = 'PCS', "inspectorWorkerId" = NULL, "inspectorUserId" = NULL WHERE id = '${seeded!.id}'`)
    let record = await ok('inspector', 'GET', `/quality/incoming/${seeded!.id}`)
    const sample = record.inspection?.sampleSize ?? record.progress.sampleSize
    record = await ok('inspector', 'PUT', `/quality/incoming/${seeded!.id}/counters`, { version: record.inspection.version, found: { critical: 0, major: 0, minor: 0 }, inspected: 1 })
    expect(record.progress).toMatchObject({ done: 1, sampleSize: sample })
    const [row] = await admin<{ inspectedCount: number }>(`SELECT "inspectedCount" FROM "IncomingInspection" WHERE id = $1`, [seeded!.id])
    expect(row!.inspectedCount).toBe(1)
    expect(paths(await refused('inspector', 'PUT', `/quality/incoming/${seeded!.id}/counters`, { version: record.inspection.version, found: { critical: 0, major: 0, minor: 0 }, inspected: sample + 1 }, 400))).toEqual(['body/inspected'])
  })
})

describe('the severity words per class and language (FQ4:04)', () => {
  it('written by the keeper; critical keeps its locked meaning; the floor reads them in its language', async () => {
    let read = await ok('words', 'GET', '/quality/severity')
    expect(read).toMatchObject({ editable: true, canManage: true })
    const v0 = read.version as number
    const critical = read.classes.find((entry: Json) => entry.class === 'CRITICAL')
    const lockedMeaning = critical.meaning.en
    expect(paths(await refused('words', 'PUT', '/quality/severity', { version: v0, texts: { CRITICAL: { meaning: { en: 'Made-up: sometimes fine.' } } } }, 400))).toEqual(['body/texts/CRITICAL/meaning'])
    expect(paths(await refused('words', 'PUT', '/quality/severity', { version: v0, texts: { MAJOR: { words: { en: '   ' } } } }, 400))).toEqual(['body/texts/MAJOR/words/en'])
    expect((await refused('viewer', 'PUT', '/quality/severity', { version: v0, texts: null }, 403)).code).toBe('forbidden')
    read = await ok('words', 'PUT', '/quality/severity', { version: v0, texts: { MAJOR: { words: { it: 'Grave (demo)', en: 'Serious (demo)', ro: 'Grav (demo)' }, meaning: { en: 'Made-up meaning of a serious defect.' } }, CRITICAL: { words: { en: 'Safety (demo)' } } } })
    expect(read.version).toBe(v0 + 1)
    const major = read.classes.find((entry: Json) => entry.class === 'MAJOR')
    expect(major).toMatchObject({ words: { it: 'Grave (demo)', en: 'Serious (demo)' }, meaning: { en: 'Made-up meaning of a serious defect.' }, own: { words: { ro: 'Grav (demo)' } } })
    expect(read.classes.find((entry: Json) => entry.class === 'CRITICAL')).toMatchObject({ words: { en: 'Safety (demo)' }, meaning: { en: lockedMeaning }, locked: true })
    expect((await refused('words', 'PUT', '/quality/severity', { version: v0, texts: null }, 409)).code).toBe('conflict')
    const vocabulary = await ok('viewer', 'GET', '/quality/vocabulary?language=ro')
    expect(vocabulary.classes.find((entry: Json) => entry.class === 'MAJOR')).toMatchObject({ label: 'Grav (demo)', missing: false })
    expect(vocabulary.classes.find((entry: Json) => entry.class === 'MINOR')).toMatchObject({ label: 'Minor', missing: true })
    expect((await events('quality.vocabulary_changed')).filter((payload) => payload.list === 'SEVERITY')).toEqual([{ list: 'SEVERITY', change: 'EDITED', codes: ['CRITICAL', 'MAJOR'] }])
    // Back to the standard texts.
    read = await ok('words', 'PUT', '/quality/severity', { version: v0 + 1, texts: null })
    expect(read.classes.find((entry: Json) => entry.class === 'MAJOR').words.en).toBe('Major')
    expect((await admin<{ severityTexts: unknown }>(`SELECT "severityTexts" FROM "QualitySettings" WHERE id = $1`, [A.tenant]))[0]!.severityTexts).toBeNull()
  })
})
