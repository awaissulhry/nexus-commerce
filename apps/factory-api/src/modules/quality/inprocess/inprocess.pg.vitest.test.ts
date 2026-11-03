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
import type { CommandCaller } from '../../../core/command'
import { testAuthenticator, withContextClient, type RequestContext, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applyQueued } from '../../../platform/floor-sync/kinds'
import { switchOnPerformance } from '../../people/privacy/testing/performance-gate'
import { firstPieceRefusalAt } from '../../production/terminal/first-piece'
import { decideCheck } from './checks'

/**
 * In-process checks (B-W2b-99; QHS-039 first piece, QHS-040 cutting, QHS-041 roving, QHS-042 end of line and DHU, MES-127)
 * through the app's real routes on a throwaway PostgreSQL 17 database from the migrations (the runtime logins: row-level
 * security, InProcessCheck_guard, the results guard and the first-piece hold OperationScan_awaits_first_piece are real),
 * tenant A from EVERY seed (SEED-WO-0001 in progress with SEED-BN-0001 and -0002, its first piece at sewing APPROVED,
 * INL-FIRST v1 in force with its critical SAFETY seam check, line L1, the defect library, AQL-STD). Made-up words only.
 *   - a first piece holds its run from the moment it is written: the hook and the trigger agree; the first bundle goes
 *     through; one open per run; results, then APPROVED signed (the hash kept) lifts the hold; REJECTED keeps it; cancel
 *     lifts it; the bundle card and the operation screen's flag say it;
 *   - roving and end of line in one step, per operation; the line's DHU from end-of-line checks, on the line TV too;
 *   - the defects charged per operation; the operator named only with the PERFORMANCE gate in force (system scope), the
 *     worker's own charges with the report a dispute goes on; no person in a list;
 *   - the floor's queue records a roving or end-of-line check, never a first piece.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/quality/inprocess`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'inprocess-a'
let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let serial = 0
const idem = () => `ipc-${Date.now()}-${++serial}`

const id = (key: string) => seedUuid(NS, key)
const A = {
  tenant: id('tenant'),
  company: id('company:A'),
  site: id('site:A1'),
  line: id('site:A1:line:L1'),
  wo1: id('production:work-order:WO-0001'),
  bn1: id('production:bundle:WO-0001:1'),
  bn2: id('production:bundle:WO-0001:2'),
  lead: id('worker:A1:lead'),
  operator: id('worker:A1:operator'),
  device: id('device:A1:cutting'),
  member: id('user:member'),
}
const ops: Record<'cut' | 'sew' | 'qc' | 'pack', string> = { cut: '', sew: '', qc: '', pack: '' }
let stitchSkip = ''
let critical = ''

const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const office = (actorId: string, permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId, grants: [grant(permissions)] })
const floor = (actorId: string, permissions: Permission[]): SessionContext => ({ audience: 'floor', tenantId: A.tenant, actorId, siteId: A.site, deviceId: A.device, grants: [grant(permissions, { companies: [A.company], sites: [A.site] })] })
const RECORD: Permission[] = ['quality.inprocess.view', 'quality.inprocess.record']
const SESSIONS: Record<string, SessionContext> = {
  quality: office(A.member, [...RECORD, 'production.boards.view', 'production.scan']),
  viewer: office(newId(), ['quality.inprocess.view']),
  bench: floor(A.lead, ['floor.work', ...RECORD, 'production.scan']),
  operator: floor(A.operator, ['floor.work', 'production.scan']),
}
/** A caller as a request is one: its client follows `factoryContext`, so the tenant's system view (Object.create) reads as the system. */
const callerAs = (session: string): CommandCaller => ({
  factoryContext: { ...SESSIONS[session]!, requestId: newId() } as RequestContext,
  withClient(work) {
    return withContextClient(database, this.factoryContext!, work)
  },
})

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
type Method = 'GET' | 'POST' | 'PUT'
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': idem() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const events = async (type: string, subject?: string) =>
  (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ${subject ? 'AND subject = $3' : ''} ORDER BY "occurredAt", id`, subject ? [A.tenant, type, subject] : [A.tenant, type])).map((row) => row.payload)
const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : [])
/** Words that name a person: never in a list. */
const PERSON = /^(workerId|employeeId|worker|operator|inspector|createdById|recordedById|recordedByWorkerId|displayName)$/

/** Would the database take a scan of this bundle at this operation now? A REPORT tried and rolled back. */
async function triggerTakes(bundleId: string, operationId: string): Promise<boolean> {
  const client = db.admin
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO "OperationScan" (id, "tenantId", "siteId", "workOrderId", "workOrderOperationId", "bundleId", kind, "goodQuantity", "workerId", "deviceId", "clientScanId", "createdById")
       VALUES ($1, $2, $3, $4, $5, $6, 'REPORT', 1, $7, $8, $9, $7)`,
      [newId(), A.tenant, A.site, A.wo1, operationId, bundleId, A.operator, A.device, `ipc-try-${newId()}`],
    )
    return true
  } catch (error) {
    if (/waits for its first piece/.test(String((error as Error).message))) return false
    throw error
  } finally {
    await client.query('ROLLBACK')
  }
}
const hookHolds = async (bundleId: string, operationId: string) => (await callerAs('bench').withClient((client) => firstPieceRefusalAt(client, { workOrderId: A.wo1, bundleId, workOrderOperationId: operationId }))) !== null

beforeAll(async () => {
  db = await migratedDatabase('quality_inprocess')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: NS })
  }
  for (const row of await admin<{ id: string; kind: string }>(`SELECT o.id, c.kind::text FROM "WorkOrderOperation" o JOIN "WorkCentre" c ON c.id = o."workCentreId" WHERE o."workOrderId" = $1`, [A.wo1])) {
    ops[row.kind === 'CUTTING' ? 'cut' : row.kind === 'INSPECTION' ? 'qc' : row.kind === 'PACKING' ? 'pack' : 'sew'] = row.id
  }
  stitchSkip = (await admin<{ id: string }>(`SELECT id FROM "DefectCode" WHERE "tenantId" = $1 AND code = 'STITCH-SKIP'`, [A.tenant]))[0]!.id
  critical = (await admin<{ id: string }>(`SELECT id FROM "DefectCode" WHERE "tenantId" = $1 AND severity = 'CRITICAL' AND "parentId" IS NOT NULL AND active ORDER BY code LIMIT 1`, [A.tenant]))[0]!.id
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 1_500_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

let firstPiece: Json

describe('a first piece holds its run (QHS-039)', () => {
  it('opens on the plan in force; from that moment other bundles wait at the operation, the hook and the trigger alike', async () => {
    expect(await triggerTakes(A.bn2, ops.qc)).toBe(true)
    firstPiece = (await ok('bench', 'POST', '/quality/inprocess/checks', { kind: 'FIRST_PIECE', workOrderId: A.wo1, bundleId: A.bn1, workOrderOperationId: ops.qc }, 201)).check
    expect(firstPiece).toMatchObject({ kind: 'FIRST_PIECE', status: 'OPEN', holdsRun: true, plan: { code: 'INL-FIRST', number: 1 }, blockers: ['SEAM'], inspector: { kind: 'FLOOR', own: true, workerId: null } })
    expect(await hookHolds(A.bn2, ops.qc)).toBe(true)
    expect(await triggerTakes(A.bn2, ops.qc)).toBe(false)
    // The first bundle goes through; another operation is free.
    expect(await hookHolds(A.bn1, ops.qc)).toBe(false)
    expect(await triggerTakes(A.bn1, ops.qc)).toBe(true)
    expect(await triggerTakes(A.bn2, ops.pack)).toBe(true)
    expect(await events('in_process_check.first_piece', A.wo1)).toEqual([expect.objectContaining({ checkId: firstPiece.id, status: 'OPEN', held: true })])
    const audit = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordId" = $1`, [firstPiece.id])
    expect(audit[0]!.after).toMatchObject({ kind: 'FIRST_PIECE', postedBy: 'FLOOR', operatorNamed: false })
  })

  it('the operation screen reads the flag: on the bundle card and on its own read, in words', async () => {
    const code = (await admin<{ code: string }>(`SELECT code FROM "Bundle" WHERE id = $1`, [A.bn2]))[0]!.code
    const card = await ok('operator', 'GET', `/production/scans/card?code=${code}`)
    expect(card.firstPiece).toMatchObject({ heldOperationIds: [ops.qc], firstBundle: false, check: { id: firstPiece.id, status: 'OPEN' } })
    expect(card.firstPiece.message).toMatch(/Waiting for first-piece approval/)
    const read = await ok('operator', 'GET', `/quality/inprocess/first-piece?bundleId=${A.bn1}`)
    expect(read.firstPiece).toMatchObject({ heldOperationIds: [], firstBundle: true, message: null })
  })

  it('refuses a second open first piece of the run, and a first piece decided in one step', async () => {
    expect(paths(await refused('bench', 'POST', '/quality/inprocess/checks', { kind: 'FIRST_PIECE', workOrderId: A.wo1, bundleId: A.bn2, workOrderOperationId: ops.qc }, 409))).toEqual(['refusal/FIRST_PIECE_OPEN', 'fix'])
    expect(paths(await refused('bench', 'POST', '/quality/inprocess/checks', { kind: 'FIRST_PIECE', workOrderId: A.wo1, bundleId: A.bn1, decision: { outcome: 'APPROVED', pieces: 1 } }, 400))).toEqual(['body/decision'])
    // The run at sewing is approved already (the seed): nothing to hold there.
    expect(paths(await refused('bench', 'POST', '/quality/inprocess/checks', { kind: 'FIRST_PIECE', workOrderId: A.wo1, bundleId: A.bn1, workOrderOperationId: ops.sew }, 409))).toEqual(['refusal/ALREADY_APPROVED', 'fix'])
  })

  it('records the plan results; a passing outcome waits for every mandatory one; the route asks the PIN', async () => {
    expect(paths(await refused('bench', 'PUT', `/quality/inprocess/checks/${firstPiece.id}/results`, { version: firstPiece.version, results: [{ code: 'NOPE', outcome: 'PASS' }] }, 400))).toEqual(['body/results/0/code'])
    await expect(decideCheck(callerAs('bench'), firstPiece.id, { version: firstPiece.version, outcome: 'APPROVED', pieces: 1 }, { sign: () => undefined, idempotencyKey: idem() })).rejects.toMatchObject({ issues: [expect.objectContaining({ path: 'refusal/PLAN_RESULTS' }), expect.anything()] })
    firstPiece = (await ok('bench', 'PUT', `/quality/inprocess/checks/${firstPiece.id}/results`, { version: firstPiece.version, results: [{ code: 'SEAM', outcome: 'PASS' }] })).check
    expect(firstPiece).toMatchObject({ results: [expect.objectContaining({ code: 'SEAM', outcome: 'PASS' })], blockers: [] })
    // Without a real floor session's fresh PIN the signing route signs nothing (the test sign-in has none).
    const unsigned = await call('bench', 'POST', `/quality/inprocess/checks/${firstPiece.id}/decide`, { version: firstPiece.version, outcome: 'APPROVED', pieces: 1 })
    expect(unsigned.statusCode).not.toBe(200)
    expect((await admin<{ status: string }>(`SELECT status::text FROM "InProcessCheck" WHERE id = $1`, [firstPiece.id]))[0]!.status).toBe('OPEN')
  })

  it('APPROVED, signed with its hash, lifts the hold: the trigger takes the other bundles again', async () => {
    const decided = (await decideCheck(callerAs('bench'), firstPiece.id, { version: firstPiece.version, outcome: 'APPROVED', pieces: 1 }, { sign: () => undefined, idempotencyKey: idem() })).check
    expect(decided).toMatchObject({ status: 'DECIDED', outcome: 'APPROVED', holdsRun: false })
    expect(decided.signatureSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(await hookHolds(A.bn2, ops.qc)).toBe(false)
    expect(await triggerTakes(A.bn2, ops.qc)).toBe(true)
    expect((await events('in_process_check.first_piece', A.wo1)).at(-1)).toMatchObject({ checkId: firstPiece.id, outcome: 'APPROVED', held: false })
    expect(paths(await refused('bench', 'POST', `/quality/inprocess/checks/${firstPiece.id}/cancel`, { version: decided.version, reason: 'Too late.' }, 409))).toEqual(['refusal/NOT_OPEN', 'fix'])
  })

  it('REJECTED keeps the hold; a cancelled first piece holds nothing', async () => {
    const opened = (await ok('quality', 'POST', '/quality/inprocess/checks', { kind: 'FIRST_PIECE', workOrderId: A.wo1, bundleId: A.bn1, workOrderOperationId: ops.pack, planVersionId: null }, 201)).check
    expect(opened).toMatchObject({ plan: null, inspector: { kind: 'OFFICE', userId: A.member } })
    const rejected = (await decideCheck(callerAs('quality'), opened.id, { version: opened.version, outcome: 'REJECTED', pieces: 1, defectivePieces: 1, defects: 1, defectCodeId: stitchSkip }, { sign: () => undefined, idempotencyKey: idem() })).check
    expect(rejected).toMatchObject({ outcome: 'REJECTED', holdsRun: true })
    expect(await triggerTakes(A.bn2, ops.pack)).toBe(false)
    const again = (await ok('quality', 'POST', '/quality/inprocess/checks', { kind: 'FIRST_PIECE', workOrderId: A.wo1, bundleId: A.bn1, workOrderOperationId: ops.pack, planVersionId: null }, 201)).check
    expect(paths(await refused('quality', 'POST', `/quality/inprocess/checks/${again.id}/cancel`, { version: again.version, reason: '' }, 400))).toEqual(['body/reason'])
    const cancelled = (await ok('quality', 'POST', `/quality/inprocess/checks/${again.id}/cancel`, { version: again.version, reason: 'Opened on the wrong bundle.' })).check
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'Opened on the wrong bundle.' })
    // The rejected one still holds the run: only an approval lifts it.
    expect(await triggerTakes(A.bn2, ops.pack)).toBe(false)
  })
})

let failCheck: Json

describe('roving and end of line, per operation (QHS-041, QHS-042)', () => {
  it('a roving light in one step: amber with one piece wrong; green with one is refused; a critical defect is red', async () => {
    const amber = (await ok('bench', 'POST', '/quality/inprocess/checks', { kind: 'ROVING', lineId: A.line, workOrderId: A.wo1, workOrderOperationId: ops.sew, decision: { outcome: 'AMBER', pieces: 7, defectivePieces: 1, defects: 1, defectCodeId: stitchSkip } }, 201)).check
    expect(amber).toMatchObject({ status: 'DECIDED', outcome: 'AMBER', suggested: 'AMBER', plan: null, operator: null, operatorHidden: false, line: { id: A.line } })
    expect(paths(await refused('bench', 'POST', '/quality/inprocess/checks', { kind: 'ROVING', lineId: A.line, decision: { outcome: 'GREEN', pieces: 7, defectivePieces: 1, defects: 1 } }, 400))).toEqual(['body/decision/outcome'])
    expect(paths(await refused('bench', 'POST', '/quality/inprocess/checks', { kind: 'ROVING', lineId: A.line, decision: { outcome: 'AMBER', pieces: 7, defectivePieces: 1, defects: 1, defectCodeId: critical } }, 400))).toEqual(['body/decision/outcome'])
    const board = await ok('bench', 'GET', `/quality/inprocess/roving?lineId=${A.line}`)
    expect(board.line).toMatchObject({ id: A.line })
    expect(board.tiles.length + board.lineChecksToday).toBeGreaterThanOrEqual(0)
  })

  it("end of line: a pass and a defect charged to sewing; the line's DHU from them, on the line TV too", async () => {
    await ok('bench', 'POST', '/quality/inprocess/checks', { kind: 'END_OF_LINE', lineId: A.line, workOrderId: A.wo1, bundleId: A.bn1, decision: { outcome: 'PASS', pieces: 20 } }, 201)
    expect(paths(await refused('bench', 'POST', '/quality/inprocess/checks', { kind: 'END_OF_LINE', lineId: A.line, decision: { outcome: 'FAIL', pieces: 20, defectivePieces: 2, defects: 3 } }, 400))).toEqual(['body/decision/defectCodeId'])
    failCheck = (await ok('bench', 'POST', '/quality/inprocess/checks', { kind: 'END_OF_LINE', lineId: A.line, workOrderId: A.wo1, bundleId: A.bn2, workOrderOperationId: ops.sew, decision: { outcome: 'FAIL', pieces: 20, defectivePieces: 2, defects: 3, defectCodeId: stitchSkip } }, 201)).check
    expect(failCheck).toMatchObject({ outcome: 'FAIL', dhu: '15.0', sendBack: { workOrderOperationId: ops.sew, bundleId: A.bn2, pieces: 2 } })
    const dhu = await ok('bench', 'GET', `/quality/inprocess/dhu?lineId=${A.line}`)
    expect(dhu).toMatchObject({ dhu: '7.5', defects: 3, pieces: 40, checks: 2, byOperation: [{ code: 'SEED-SEW-ASM', defects: 3 }] })
    const tv = await ok('quality', 'GET', `/production/boards/tv?lineId=${A.line}`)
    expect(tv.quality).toEqual({ dhu: '7.5', defects: 3, units: 40, source: 'END_OF_LINE' })
  })

  it('the defects charged per operation, and the list: per line and operation, no person anywhere', async () => {
    const charges = await ok('viewer', 'GET', `/quality/inprocess/charges?lineId=${A.line}`)
    expect(charges.operations).toEqual([expect.objectContaining({ operation: expect.objectContaining({ id: ops.sew }), defects: 4, bySource: { END_OF_LINE: 3, ROVING: 1, SCAN: 0 } })])
    const list = await ok('viewer', 'GET', `/quality/inprocess/checks?lineId=${A.line}`)
    expect(list.checks.length).toBeGreaterThanOrEqual(3)
    expect([...keysOf(list), ...keysOf(charges)].filter((key) => PERSON.test(key))).toEqual([])
    await refused('viewer', 'POST', '/quality/inprocess/checks', { kind: 'ROVING', lineId: A.line, decision: { outcome: 'GREEN', pieces: 3 } }, 403)
  })
})

describe('the operator, only behind the PERFORMANCE gate (Statuto art. 4)', () => {
  it('gate closed: nobody named; the worker has no personal list', async () => {
    expect((await admin<{ workerId: string | null }>(`SELECT "workerId" FROM "InProcessCheck" WHERE id = $1`, [failCheck.id]))[0]!.workerId).toBeNull()
    expect(await ok('operator', 'GET', '/quality/inprocess/floor/mine')).toMatchObject({ open: false, charges: [] })
  })

  it('gate on: an end-of-line defect names who did the operation (system scope); the office sees them, the floor never; the worker sees the charge and the report to dispute', async () => {
    const off = await switchOnPerformance(admin, { tenantId: A.tenant, companyId: A.company, siteId: A.site, byId: A.member })
    try {
      const named = (await ok('bench', 'POST', '/quality/inprocess/checks', { kind: 'END_OF_LINE', lineId: A.line, workOrderId: A.wo1, bundleId: A.bn2, workOrderOperationId: ops.sew, decision: { outcome: 'FAIL', pieces: 1, defectivePieces: 1, defects: 1, defectCodeId: stitchSkip } }, 201)).check
      const stored = (await admin<{ workerId: string | null; inspectorWorkerId: string }>(`SELECT "workerId", "inspectorWorkerId" FROM "InProcessCheck" WHERE id = $1`, [named.id]))[0]!
      const reporter = (await admin<{ workerId: string; id: string }>(`SELECT "workerId", id FROM "OperationScan" WHERE "bundleId" = $1 AND "workOrderOperationId" = $2 AND kind = 'REPORT'`, [A.bn2, ops.sew]))[0]!
      expect(stored).toEqual({ workerId: reporter.workerId, inspectorWorkerId: A.lead })
      expect(named).toMatchObject({ operator: null, operatorHidden: true })
      const asOffice = (await ok('quality', 'GET', `/quality/inprocess/checks/${named.id}`)).check
      expect(asOffice).toMatchObject({ operator: { id: reporter.workerId }, operatorHidden: false })
      SESSIONS.reporter = floor(reporter.workerId, ['floor.work'])
      const mine = await ok('reporter', 'GET', '/quality/inprocess/floor/mine')
      expect(mine.open).toBe(true)
      expect(mine.charges).toEqual([expect.objectContaining({ source: 'END_OF_LINE', checkId: named.id, defects: 1, dispute: expect.objectContaining({ recordType: 'OperationScan', recordId: reporter.id, reasons: ['WRONG_QUANTITY', 'NOT_ME', 'WRONG_OPERATION', 'OTHER'] }) })])
    } finally {
      await off()
    }
    expect((await ok('quality', 'GET', `/quality/inprocess/checks/${(await events('in_process_check.changed')).at(-1)!.checkId}`)).check).toMatchObject({ operator: null, operatorHidden: true })
  })
})

describe("the floor's queue", () => {
  it('records a roving or end-of-line check offline, never a first piece', async () => {
    const caller = callerAs('bench')
    const event = { clientEventId: `q-${newId()}`, kind: 'quality.inprocess.record' as const, payload: { kind: 'END_OF_LINE', lineId: A.line, decision: { outcome: 'PASS', pieces: 1 } } }
    const applied = await applyQueued(caller, event, { key: `${A.device}.${event.clientEventId}` })
    expect(applied).toMatchObject({ status: 'accepted', result: { type: 'InProcessCheck' } })
    const first = await applyQueued(caller, { clientEventId: `q-${newId()}`, kind: 'quality.inprocess.record', payload: { kind: 'FIRST_PIECE', workOrderId: A.wo1, bundleId: A.bn1 } }, { key: `${A.device}.q-${newId()}` })
    expect(first.status).toBe('refused')
  })
})
