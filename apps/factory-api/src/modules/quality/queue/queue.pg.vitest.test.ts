import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { formatScanId } from '@nexus/factory-domain/numbering/scan-id'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import type { CommandCaller } from '../../../core/command'
import { testAuthenticator, withContextClient, type RequestContext, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applyQueued } from '../../../platform/floor-sync/kinds'

/**
 * My inspections (B-W2b-106; QHS-068 the inspector queue, QHS-065 scan to start, QHS-062 offline inspections) through the
 * app's real routes and the floor-sync apply, on a throwaway PostgreSQL 17 database from the migrations (the runtime logins:
 * row-level security and the inspection guards are real), tenant A from EVERY seed: SEED-INS-0002 (W1, no plan) and
 * SEED-INS-0009 (FIN-JACKET v1) OPEN by A1's team leader at the bench, SEED-IIN-0001 OPEN on leather lot SEED-LOT-LEA-01 (made
 * here as a rule opens one: nobody's yet, the lot in quarantine), SEED-WO-0001 in progress. Planted (facts only, never what is
 * proved): whole-garment bundles of SEED-WO-0001 reported good at every operation. Made-up words only.
 *   - the queue: blocking first (a first piece's run, then a lot work orders need), waiting time, whose it is in words, no
 *     person in a row; scope mine and all; each kind only to whoever may view it;
 *   - scan to start: the bench decides where a code leads; an open record is answered; else its module opens the one thing
 *     with the plan that applies; a code of another bench, a code that names nothing, two records to choose from, in words;
 *   - offline: the pack of open records with their plans; a write tried online and then from the queue under one client id
 *     is ONE write (a "+ one piece" counts once, also when the two race); queued writes apply on the record as it stands; a
 *     decided record, another inspector's, a bad payload are final refusals in words.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/quality/queue`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'quality-queue'
let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let serial = 0
const idem = () => `qq-${Date.now()}-${++serial}`

const id = (key: string) => seedUuid(NS, key)
const A = {
  tenant: id('tenant'),
  company: id('company:A'),
  site: id('site:A1'),
  wo1: id('production:work-order:WO-0001'),
  bn1: id('production:bundle:WO-0001:1'),
  lead: id('worker:A1:lead'),
  operator: id('worker:A1:operator'),
  device: id('device:A1:cutting'),
}
const R = { ins2: '', ins9: '', iin1: '', lot: '', hide2: '', qcOp: '', ins1: '', shade: '', ce: '' }

const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const ALL: Permission[] = ['quality.inspections.view', 'quality.inspections.record', 'quality.incoming.view', 'quality.incoming.record', 'quality.inprocess.view', 'quality.inprocess.record']
const floor = (actorId: string, permissions: Permission[]): SessionContext => ({ audience: 'floor', tenantId: A.tenant, actorId, siteId: A.site, deviceId: A.device, grants: [grant(permissions, { companies: [A.company], sites: [A.site] })] })
const qaUser = newId()
const SESSIONS: Record<string, SessionContext> = {
  bench: floor(A.lead, ['floor.work', ...ALL]),
  // Another worker with the same rights on the same tablet (inspections of the lead are someone else's to them).
  other: floor(A.operator, ['floor.work', ...ALL]),
  qa: { audience: 'office', tenantId: A.tenant, actorId: qaUser, grants: [grant(ALL)] },
  incomingOnly: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['quality.incoming.view'])] },
  nobody: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['production.boards.view'])] },
}
const callerAs = (session: string): CommandCaller => ({
  factoryContext: { ...SESSIONS[session]!, requestId: newId() } as RequestContext,
  withClient(work) {
    return withContextClient(database, this.factoryContext!, work)
  },
})

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const force = async (sql: string) => {
  await db.admin.query(`BEGIN; SET LOCAL session_replication_role = replica; ${sql}; COMMIT;`)
}
type Method = 'GET' | 'POST' | 'PUT'
const call = (session: string, method: Method, url: string, payload?: unknown, key = idem()) =>
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
const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : [])
/** Words that name a person: never in a queue row. */
const PERSON = /^(workerId|userId|employeeId|worker|operator|inspector|assigned|createdById|recordedById|recordedByWorkerId|displayName)$/
const inspected = async (inspectionId: string) => {
  // B-W2b-213: Inspection.inspectedCount (an inspection counted before it keeps the AQL_SAMPLE entry).
  const [row] = await admin<{ checklist: Json[]; inspectedCount: number | null }>(`SELECT checklist, "inspectedCount" FROM "Inspection" WHERE id = $1`, [inspectionId])
  return row!.inspectedCount ?? Number((row!.checklist ?? []).find((entry: Json) => entry.code === 'AQL_SAMPLE')?.inspected ?? 0)
}
const queued = (session: string, kind: string, payload: Json, clientEventId = `q-${newId()}`) =>
  applyQueued(callerAs(session), { clientEventId, kind: kind as never, payload }, { key: `${A.device}.${clientEventId}` })

beforeAll(async () => {
  db = await migratedDatabase('quality_queue')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: NS })
  }
  const one = async (sql: string, values: unknown[] = []) => (await admin<{ id: string }>(sql, values))[0]!.id
  R.ins2 = await one(`SELECT id FROM "Inspection" WHERE "tenantId" = $1 AND number = 'SEED-INS-0002'`, [A.tenant])
  R.ins9 = await one(`SELECT id FROM "Inspection" WHERE "tenantId" = $1 AND number = 'SEED-INS-0009'`, [A.tenant])
  R.ins1 = await one(`SELECT id FROM "Inspection" WHERE "tenantId" = $1 AND number = 'SEED-INS-0001'`, [A.tenant])
  R.iin1 = await one(`SELECT id FROM "IncomingInspection" WHERE "tenantId" = $1 AND number = 'SEED-IIN-0001'`, [A.tenant])
  R.lot = await one(`SELECT id FROM "Lot" WHERE "tenantId" = $1 AND code = 'SEED-LOT-LEA-01'`, [A.tenant])
  R.hide2 = await one(`SELECT id FROM "Hide" WHERE "tenantId" = $1 AND code = 'SEED-HIDE-0002'`, [A.tenant])
  R.qcOp = await one(`SELECT o.id FROM "WorkOrderOperation" o JOIN "WorkCentre" c ON c.id = o."workCentreId" WHERE o."workOrderId" = $1 AND c.kind = 'INSPECTION'`, [A.wo1])
  R.shade = await one(`SELECT c.id FROM "InspectionPlanCheck" c JOIN "IncomingInspection" i ON i."planVersionId" = c."planVersionId" WHERE i.id = $1 AND c.code = 'SHADE'`, [R.iin1])
  R.ce = (await admin<{ code: string }>(`SELECT c.code FROM "InspectionPlanCheck" c JOIN "Inspection" i ON i."planVersionId" = c."planVersionId" WHERE i.id = $1 AND c.type = 'PASS_FAIL' ORDER BY c."sortOrder" LIMIT 1`, [R.ins9]))[0]!.code
  // Planted facts: the lot back in quarantine and its open inspection nobody's (as a rule opens one at goods receipt, B-W2b-101);
  // a whole-garment bundle per cell of SEED-WO-0001 reported good at every operation (finished garments for the bench).
  await force(`UPDATE "Lot" SET "qualityStatus" = 'QUARANTINE' WHERE id = '${R.lot}'; UPDATE "IncomingInspection" SET "inspectorWorkerId" = NULL WHERE id = '${R.iin1}'`)
  const operations = await admin<{ id: string; seq: number }>(`SELECT id, seq FROM "WorkOrderOperation" WHERE "workOrderId" = $1 ORDER BY seq`, [A.wo1])
  for (const [index, cell] of (await admin<{ id: string; quantity: number }>(`SELECT id, quantity FROM "WorkOrderSize" WHERE "workOrderId" = $1 ORDER BY id`, [A.wo1])).entries()) {
    const bundleId = newId()
    await force(`INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity) VALUES ('${bundleId}', '${A.tenant}', '${A.site}', '${A.wo1}', '${cell.id}', 'PLANTED-QQ-${index}', ${cell.quantity})`)
    for (const operation of operations) {
      await force(`INSERT INTO "OperationScan" (id, "tenantId", "siteId", "workOrderId", "workOrderOperationId", "bundleId", kind, "goodQuantity", "workerId", "clientScanId") VALUES ('${newId()}', '${A.tenant}', '${A.site}', '${A.wo1}', '${operation.id}', '${bundleId}', 'REPORT', ${cell.quantity}, '${A.operator}', 'planted-qq-${index}-${operation.seq}')`)
    }
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 1_500_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 120_000)

describe('the inspector queue (QHS-068)', () => {
  it('lists the bench’s inspections, blocking first, with waiting time, whose they are in words and no person', async () => {
    const queue = await ok('bench', 'GET', '/quality/queue')
    expect(queue.scope).toBe('mine')
    const byKey = new Map(queue.rows.map((row: Json) => [row.key, row]))
    const iin = byKey.get(`IncomingInspection:${R.iin1}`) as Json
    expect(iin).toMatchObject({ kind: 'INCOMING', number: 'SEED-IIN-0001', taken: 'NOBODY', lot: { code: 'SEED-LOT-LEA-01', qualityStatus: 'QUARANTINE' }, plan: { code: 'INC-LEATHER', number: 1 }, may: { record: true }, open: { path: `/quality/incoming/${R.iin1}` } })
    expect(iin.blocks).toMatchObject({ what: 'WORK_ORDERS', rank: 1, count: 1 })
    expect(iin.blocks.words.en).toMatch(/^1 work order needs lot SEED-LOT-LEA-01/)
    expect(iin.waiting.words.en).toMatch(/^Waiting /)
    expect(iin.progress.words.en).toBe('Inspect all 2 hides · 1 done')
    const ins9 = byKey.get(`Inspection:${R.ins9}`) as Json
    expect(ins9).toMatchObject({ kind: 'FINAL', taken: 'MINE', plan: { code: 'FIN-JACKET', number: 1 }, blocks: { what: 'SHIPPING', count: 2 }, may: { record: true }, open: { path: `/quality/inspections/${R.ins9}/sheet` } })
    expect(byKey.get(`Inspection:${R.ins2}`)).toMatchObject({ kind: 'FINAL', plan: null, taken: 'MINE', open: { path: `/quality/inspections/${R.ins2}` } })
    // The order: never a lower rank after a higher one.
    const ranks = queue.rows.map((row: Json) => row.blocks.rank)
    expect(ranks).toEqual([...ranks].sort((a: number, b: number) => a - b))
    expect(keysOf(queue.rows).filter((key) => PERSON.test(key))).toEqual([])
  })

  it('mine and all: another inspector’s open inspection is theirs, unnamed, and only in all', async () => {
    const mine = await ok('other', 'GET', '/quality/queue')
    expect(mine.rows.map((row: Json) => row.key)).not.toContain(`Inspection:${R.ins9}`)
    expect(mine.rows.map((row: Json) => row.key)).toContain(`IncomingInspection:${R.iin1}`)
    const all = await ok('other', 'GET', '/quality/queue?scope=all')
    expect(all.rows.find((row: Json) => row.key === `Inspection:${R.ins9}`)).toMatchObject({ taken: 'OTHER', may: { record: false } })
    expect(keysOf(all.rows).filter((key) => PERSON.test(key))).toEqual([])
  })

  it('shows each kind only to whoever may view it; none of the three is refused in words', async () => {
    const incoming = await ok('incomingOnly', 'GET', '/quality/queue?scope=all')
    expect(new Set(incoming.rows.map((row: Json) => row.kind))).toEqual(new Set(['INCOMING']))
    expect(incoming.rows[0].may).toEqual({ record: false, start: false })
    const error = await refused('nobody', 'GET', '/quality/queue', undefined, 403)
    expect(error.message).toMatch(/quality\.inspections\.view, quality\.incoming\.view or quality\.inprocess\.view/)
    const kind = await ok('bench', 'GET', '/quality/queue?kind=INCOMING')
    expect(kind.rows.map((row: Json) => row.kind)).toEqual(['INCOMING'])
  })
})

let firstPiece = ''
let started = ''

describe('scan to start (QHS-065)', () => {
  it('a lot at the incoming bench leads to its open inspection; at the final bench it is refused in words', async () => {
    const scan = await ok('bench', 'GET', '/quality/queue/scan?code=seed-lot-lea-01&stage=INCOMING')
    expect(scan).toMatchObject({ outcome: 'OPEN', target: 'INCOMING', found: { type: 'LOT', code: 'SEED-LOT-LEA-01' }, open: { recordType: 'IncomingInspection', id: R.iin1, taken: 'NOBODY' } })
    const hide = await ok('bench', 'GET', '/quality/queue/scan?code=SEED-HIDE-0002')
    expect(hide).toMatchObject({ outcome: 'OPEN', found: { type: 'HIDE' }, open: { id: R.iin1 } })
    const wrong = await ok('bench', 'GET', '/quality/queue/scan?code=SEED-LOT-LEA-01&stage=FINAL')
    expect(wrong).toMatchObject({ outcome: 'NOTHING', found: { type: 'LOT' } })
    expect(wrong.words.en).toBe('This is a lot: it is not inspected at this bench. Scan the work order, a bundle, a garment serial or a carton here.')
    expect(paths(await refused('bench', 'POST', '/quality/queue/scan', { code: 'SEED-LOT-LEA-01', stage: 'FINAL' }, 409))).toEqual(['refusal/OTHER_BENCH'])
    // POST answers the open record with its model, writes nothing.
    const opened = await ok('bench', 'POST', '/quality/queue/scan', { code: 'SEED-LOT-LEA-01', stage: 'INCOMING' })
    expect(opened).toMatchObject({ outcome: 'OPEN', started: false, open: { id: R.iin1 }, model: { incoming: { inspection: { id: R.iin1 } }, final: null } })
  })

  it('a code that names nothing, and a label of another factory, are said in words', async () => {
    const unknown = await ok('bench', 'GET', '/quality/queue/scan?code=NOPE-0000')
    expect(unknown).toMatchObject({ outcome: 'NOTHING', found: null })
    expect(unknown.words.en).toMatch(/^No lot, hide, bundle, garment serial, carton, work order or inspection has the code NOPE-0000/)
    expect((await refused('bench', 'POST', '/quality/queue/scan', { code: 'NOPE-0000' }, 404)).message).toMatch(/NOPE-0000/)
    const foreign = await ok('bench', 'GET', `/quality/queue/scan?code=${formatScanId({ type: 'LOT', tenantTag: 'ZZ', ref: 77 })}`)
    expect(foreign).toMatchObject({ outcome: 'NOTHING', words: { en: 'This label belongs to another factory.' } })
  })

  it('a work order with two open inspections of mine: choose; another inspector’s garments: nothing to start, in words', async () => {
    const two = await ok('bench', 'GET', '/quality/queue/scan?code=SEED-WO-0001&stage=FINAL')
    expect(two.outcome).toBe('CHOOSE')
    expect(two.choices.map((choice: Json) => choice.id).sort()).toEqual([R.ins2, R.ins9].sort())
    // A garment serial leads to its own work order (the seed's serials are SEED-WO-0003's: released, nothing finished waits).
    const serial = await ok('bench', 'GET', '/quality/queue/scan?code=SEED-SN-0001')
    expect(serial).toMatchObject({ outcome: 'NOTHING', found: { type: 'SERIAL' } })
    expect(serial.words.en).toMatch(/^SEED-WO-0003: no finished garment waits for inspection/)
    const office = await ok('qa', 'GET', '/quality/queue/scan?code=SEED-WO-0001&stage=FINAL')
    expect(office.outcome).toBe('NOTHING')
    expect(office.words.en).toMatch(/SEED-WO-0001: no finished garment waits for inspection.*another inspector's/)
  })

  it('garments that wait show as nobody’s in the queue; a scan opens their final inspection on the plan that applies, once', async () => {
    // The bench gives up its W1 inspection (cancel, through B-W1-45's route): its garments wait again.
    await ok('bench', 'POST', `/quality/inspections/${R.ins2}/cancel`, { version: (await admin<{ version: number }>(`SELECT version FROM "Inspection" WHERE id = $1`, [R.ins2]))[0]!.version, reason: 'Opened by mistake' })
    const queue = await ok('qa', 'GET', '/quality/queue')
    const due = queue.rows.find((row: Json) => row.kind === 'FINAL_DUE') as Json
    expect(due).toMatchObject({ key: `WorkOrder:${A.wo1}`, taken: 'NOBODY', recordType: null, may: { record: false, start: true }, start: { code: 'SEED-WO-0001', stage: 'FINAL' }, blocks: { what: 'SHIPPING' } })
    expect(due.waiting.words.en).toMatch(/^Waiting /)
    const preview = await ok('qa', 'GET', '/quality/queue/scan?code=SEED-WO-0001&stage=FINAL')
    expect(preview).toMatchObject({ outcome: 'START', start: { target: 'FINAL', kind: 'FINAL', plan: { code: 'FIN-JACKET', number: 1 }, lotSize: String(due.progress.of) } })
    const key = idem()
    const answer = await ok('qa', 'POST', '/quality/queue/scan', { code: 'SEED-WO-0001', stage: 'FINAL' }, 201, key)
    expect(answer).toMatchObject({ outcome: 'STARTED', started: true, open: { recordType: 'Inspection', kind: 'FINAL', taken: 'MINE' }, model: { final: { inspection: { planVersion: { code: 'FIN-JACKET', number: 1 }, plan: { lotSize: due.progress.of } } }, sheet: { inspection: { status: 'OPEN' } } } })
    started = answer.open.id
    // The same scan again (a resend, or a second tap): the open inspection, nothing opened twice.
    const again = await ok('qa', 'POST', '/quality/queue/scan', { code: 'SEED-WO-0001', stage: 'FINAL' }, 200, key)
    expect(again).toMatchObject({ outcome: 'OPEN', started: false, open: { id: started } })
    expect(await admin(`SELECT id FROM "Inspection" WHERE "workOrderId" = $1 AND status = 'OPEN'`, [A.wo1])).toHaveLength(2)
    const after = await ok('qa', 'GET', '/quality/queue')
    expect(after.rows.find((row: Json) => row.kind === 'FINAL_DUE')).toBeUndefined()
    expect(after.rows.find((row: Json) => row.key === `Inspection:${started}`)).toMatchObject({ taken: 'MINE' })
  })

  it('a bundle at the in-line bench: choose the check; a first piece needs its operation; opened, it tops the queue (it holds the run)', async () => {
    const code = (await admin<{ code: string }>(`SELECT code FROM "Bundle" WHERE id = $1`, [A.bn1]))[0]!.code
    const choose = await ok('bench', 'GET', `/quality/queue/scan?code=${code}&stage=IN_LINE`)
    expect(choose).toMatchObject({ outcome: 'CHOOSE', found: { type: 'BUNDLE' } })
    expect(choose.choices.map((choice: Json) => choice.kind)).toEqual(['FIRST_PIECE', 'CUTTING'])
    expect(paths(await refused('bench', 'POST', '/quality/queue/scan', { code, stage: 'IN_LINE' }, 409))[0]).toBe('refusal/CHOOSE')
    expect(paths(await refused('bench', 'POST', '/quality/queue/scan', { code, stage: 'IN_LINE', kind: 'FIRST_PIECE' }, 400))).toEqual(['body/workOrderOperationId'])
    const answer = await ok('bench', 'POST', '/quality/queue/scan', { code, stage: 'IN_LINE', kind: 'FIRST_PIECE', workOrderOperationId: R.qcOp }, 201)
    expect(answer).toMatchObject({ outcome: 'STARTED', open: { recordType: 'InProcessCheck', kind: 'FIRST_PIECE' }, model: { check: { kind: 'FIRST_PIECE', status: 'OPEN', holdsRun: true } } })
    firstPiece = answer.open.id
    const queue = await ok('bench', 'GET', '/quality/queue')
    expect(queue.rows[0]).toMatchObject({ key: `InProcessCheck:${firstPiece}`, kind: 'FIRST_PIECE', blocks: { what: 'RUN', rank: 0 }, operation: { id: R.qcOp } })
    expect(queue.rows[0].blocks.words.en).toMatch(/^Holds the run of SEED-WO-0001 at 30 Final inspection/)
    // Now the bundle's open check is where the scan leads at the in-line bench; with no bench named, the bundle also leads to
    // its work order's open final inspection: choose.
    expect(await ok('bench', 'GET', `/quality/queue/scan?code=${code}&stage=IN_LINE`)).toMatchObject({ outcome: 'OPEN', open: { id: firstPiece } })
    const both = await ok('bench', 'GET', `/quality/queue/scan?code=${code}`)
    expect(both.outcome).toBe('CHOOSE')
    expect(both.choices.map((choice: Json) => choice.id).sort()).toEqual([firstPiece, R.ins9].sort())
  })
})

describe('offline inspections (QHS-062)', () => {
  it('the pack: the open records the tablet may record, with their plans, and what queues and what waits', async () => {
    const pack = await ok('bench', 'GET', '/quality/queue/offline')
    const records = new Map(pack.records.map((record: Json) => [record.key, record]))
    expect(records.get(`Inspection:${R.ins9}`)).toMatchObject({ recordType: 'Inspection', model: { final: { inspection: { id: R.ins9 } }, sheet: { inspection: { id: R.ins9 } }, incoming: null } })
    expect(records.get(`IncomingInspection:${R.iin1}`)).toMatchObject({ model: { incoming: { inspection: { id: R.iin1 } } } })
    expect(records.get(`InProcessCheck:${firstPiece}`)).toMatchObject({ model: { check: { id: firstPiece } } })
    expect(pack.queues.kinds).toEqual(['quality.final.record', 'quality.incoming.record', 'quality.inprocess.results'])
    expect(Date.parse(pack.keepUntil)).toBeGreaterThan(Date.parse(pack.asOf))
    expect(pack.words.held.en).toMatch(/signing with the PIN/)
    expect((await refused('qa', 'GET', '/quality/queue/offline', undefined, 403)).code).toBe('forbidden')
  })

  it('"+ one piece" tried online, its answer lost, sent again from the queue: counted once (B-W2b-77)', async () => {
    // The counter set from the queue (a whole number), so the sample of 2 has room for the pieces below.
    expect(await queued('bench', 'quality.final.record', { inspectionId: R.ins9, what: 'COUNT', inspected: 0 })).toMatchObject({ status: 'accepted' })
    const before = await inspected(R.ins9)
    expect(before).toBe(0)
    const clientEventId = `count-${newId()}`
    const online = await ok('bench', 'POST', '/quality/queue/record', { clientEventId, kind: 'quality.final.record', payload: { inspectionId: R.ins9, what: 'COUNT', add: 1 } })
    expect(online).toMatchObject({ status: 'accepted', result: { type: 'Inspection', id: R.ins9 }, model: { sheet: { inspection: { id: R.ins9 } } } })
    const retry = await queued('bench', 'quality.final.record', { inspectionId: R.ins9, what: 'COUNT', add: 1 }, clientEventId)
    expect(retry).toMatchObject({ status: 'duplicate', result: { type: 'Inspection', id: R.ins9 } })
    expect(await inspected(R.ins9)).toBe(before + 1)
  })

  it('two sends of one tap racing each other: still one piece', async () => {
    const before = await inspected(R.ins9)
    const clientEventId = `race-${newId()}`
    const body = { clientEventId, kind: 'quality.final.record', payload: { inspectionId: R.ins9, what: 'COUNT', add: 1 } }
    const answers = await Promise.all([call('bench', 'POST', '/quality/queue/record', body), call('bench', 'POST', '/quality/queue/record', body)])
    for (const answer of answers) expect(answer.statusCode, answer.body).toBe(200)
    expect(await inspected(R.ins9)).toBe(before + 1)
  })

  it('queued writes apply on the record as it stands (no version from the tablet), each kind through its module', async () => {
    const version = (await admin<{ version: number }>(`SELECT version FROM "Inspection" WHERE id = $1`, [R.ins9]))[0]!.version
    expect(await queued('bench', 'quality.final.record', { inspectionId: R.ins9, what: 'RESULTS', results: [{ checkCode: R.ce, outcome: 'PASS' }] })).toMatchObject({ status: 'accepted' })
    // One piece taken back (the sample of 2 is full after the two above): a relative count commutes with another tablet's.
    expect(await queued('bench', 'quality.final.record', { inspectionId: R.ins9, what: 'COUNT', add: -1 })).toMatchObject({ status: 'accepted' })
    expect(await inspected(R.ins9)).toBe(1)
    expect((await admin<{ version: number }>(`SELECT version FROM "Inspection" WHERE id = $1`, [R.ins9]))[0]!.version).toBe(version + 2)
    // An incoming inspection nobody took: the first write takes it; a whole hide joins the sample, once.
    expect(await queued('bench', 'quality.incoming.record', { inspectionId: R.iin1, what: 'RESULTS', results: [{ planCheckId: R.shade, outcome: 'PASS', value: (await admin<{ choices: string[] }>(`SELECT choices FROM "InspectionPlanCheck" WHERE id = $1`, [R.shade]))[0]!.choices[0] }] })).toMatchObject({ status: 'accepted' })
    expect((await admin<{ inspectorWorkerId: string }>(`SELECT "inspectorWorkerId" FROM "IncomingInspection" WHERE id = $1`, [R.iin1]))[0]!.inspectorWorkerId).toBe(A.lead)
    const hideId = `hide-${newId()}`
    expect(await queued('bench', 'quality.incoming.record', { inspectionId: R.iin1, what: 'HIDE', hideId: R.hide2, decision: 'ACCEPTED' }, hideId)).toMatchObject({ status: 'accepted' })
    expect(await queued('bench', 'quality.incoming.record', { inspectionId: R.iin1, what: 'HIDE', hideId: R.hide2, decision: 'ACCEPTED' }, hideId)).toMatchObject({ status: 'duplicate' })
    expect(await admin(`SELECT id FROM "IncomingHideResult" WHERE "incomingInspectionId" = $1`, [R.iin1])).toHaveLength(2)
    // The first piece's plan check (the run still waits: its signature is online).
    expect(await queued('bench', 'quality.inprocess.results', { checkId: firstPiece, results: [{ code: 'SEAM', outcome: 'PASS' }] })).toMatchObject({ status: 'accepted', result: { type: 'InProcessCheck', id: firstPiece } })
  })

  it('refuses for good, in words: a decided inspection, another inspector’s, a hide of another lot, a bad payload', async () => {
    const decided = await queued('bench', 'quality.final.record', { inspectionId: R.ins1, what: 'DEFECTS', defects: [] })
    expect(decided).toMatchObject({ status: 'refused', refusal: { final: true } })
    expect(['CONFLICT', 'NOT_ALLOWED']).toContain((decided as Json).refusal.code)
    const others = await queued('other', 'quality.final.record', { inspectionId: R.ins9, what: 'COUNT', add: -1 })
    expect(others).toMatchObject({ status: 'refused', refusal: { code: 'NOT_ALLOWED', final: true, message: 'This inspection is recorded and signed by the inspector who opened it.' } })
    const extra = (await admin<{ id: string }>(`SELECT h.id FROM "Hide" h WHERE h."lotId" <> $1 AND h."tenantId" = $2 LIMIT 1`, [R.lot, A.tenant]))[0]
    if (extra) expect(await queued('bench', 'quality.incoming.record', { inspectionId: R.iin1, what: 'HIDE', hideId: extra.id })).toMatchObject({ status: 'refused', refusal: { final: true } })
    const bad = await queued('bench', 'quality.final.record', { inspectionId: R.ins9, what: 'COUNT', add: 'one' })
    expect(bad).toMatchObject({ status: 'refused', refusal: { code: 'BAD_EVENT', final: true } })
    expect(paths(await refused('bench', 'POST', '/quality/queue/record', { clientEventId: `bad-${newId()}`, kind: 'quality.final.record', payload: { inspectionId: R.ins9, what: 'NOPE' } }, 400))[0]).toMatch(/^body\/payload/)
    expect((await refused('qa', 'POST', '/quality/queue/record', { clientEventId: `office-${newId()}`, kind: 'quality.final.record', payload: { inspectionId: started, what: 'COUNT', add: 1 } }, 403)).code).toBe('forbidden')
  })

  it('through the tablet’s real send (POST /floor/sync): recorded once, the ledger answers a resend', async () => {
    const before = await inspected(R.ins9)
    const event = { clientEventId: `sync-${newId()}`, seq: 1, kind: 'quality.final.record', occurredAt: new Date().toISOString(), payload: { inspectionId: R.ins9, what: 'COUNT', add: 1 } }
    const sent = await ok('bench', 'POST', '/floor/sync', { events: [event] })
    expect(sent.events[0], JSON.stringify(sent.events[0])).toMatchObject({ status: 'accepted', result: { type: 'Inspection', id: R.ins9 } })
    const again = await ok('bench', 'POST', '/floor/sync', { events: [event] })
    expect(again.events[0]).toMatchObject({ status: 'duplicate' })
    expect(await inspected(R.ins9)).toBe(before + 1)
  })
})
