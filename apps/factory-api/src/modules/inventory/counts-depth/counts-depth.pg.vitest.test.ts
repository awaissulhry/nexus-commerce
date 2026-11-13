import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { plusCalendarDays } from '@nexus/factory-domain/timers/rules'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type RequestContext, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applyQueued } from '../../../platform/floor-sync/kinds'
import { receiverRefusals } from '../../payables/matching'
import { runTimedTaskSources } from '../tasks/handlers'

/**
 * Counts in depth on the local stack (B-W2b-299; SCM-226 frozen lines, SCM-227 count schedules, SCM-228 counting by scanning
 * every unit, SCM-229 recount and approval, SCM-293 separation of duties), through the app's real routes on the whole made-up
 * seed (plant A1, the lining SEED-LIN-W36 tracked by lot without a cost, the tenant's warehouse rules with both separation
 * switches on) and made-up lots of that lining in made-up bins of their own:
 *   - the separation switches: read in force, a switch off asks the reason and a fresh code, a tighter one saves;
 *   - a schedule of a bin: due, its COUNT task, "Start count" (frozen), scanned on the tablet blind, Bin done, Finish bin,
 *     the rule's recount asked at once and refused to the counter, done by a colleague, the submit asking a yes of kind
 *     COUNT_VARIANCE (a rule switched on), the counts' own approve and apply waiting for it, the yes in Approvals, the apply
 *     moving the schedule on and doing its task;
 *   - a frozen line refuses a move of its lot at its bin until it is counted; a queued scan and finish from the floor;
 *   - the counter never approves their own variance (a worker as the office user they are), unless the switch is off;
 *   - the receiver never approves their invoice while the receiver's switch is on.
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/inventory/counts-depth/`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'counts-depth'

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `counts-${run}-${++keys}`
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })

const A = { tenant: '', companyA: '', siteA1: '', worker: '', colleague: '', device: '', lining: '', colour: null as string | null, reason: '' }
const PEOPLE = { clerk: newId(), approver: newId(), keeper: newId() }
let SESSIONS: Record<string, SessionContext> = {}
const today = businessDate(new Date())

const FLOOR: Permission[] = ['floor.work', 'inventory.locations.view', 'inventory.transfer', 'inventory.counts.scan']
const OFFICE: Permission[] = [
  'inventory.locations.view',
  'inventory.stock.view',
  'inventory.transfer',
  'inventory.adjust',
  'inventory.counts.view',
  'inventory.counts.manage',
  'inventory.counts.approve',
  'inventory.counts.scan',
  'inventory.rules.manage',
  'inventory.tasks.manage',
  'approvals.view',
  'approvals.request',
  'approvals.decide',
  'payables.view',
  'payables.approve',
]

const call = (session: string, method: Method, url: string, payload?: unknown, key: string | null = method === 'GET' ? null : freshKey()): Promise<LightMyRequestResponse> =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(response: Promise<LightMyRequestResponse>, status = 200): Promise<Json> {
  const answer = await response
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.json() as Json
}
async function refused(response: Promise<LightMyRequestResponse>, status: number): Promise<Json> {
  const answer = await response
  expect(answer.statusCode, answer.body).toBe(status)
  return (answer.json() as Json).error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const caller = (session: string) => callerFor(database, { ...SESSIONS[session]!, requestId: newId() } as RequestContext)

/** A made-up bin of A1 (at the top: no other count's place holds it) with its label, and a lot of the lining lying there. */
async function binWithLot(tag: string, metres: string): Promise<{ bin: string; label: string; lotId: string; lotCode: string }> {
  const bin = newId()
  const label = `BIN-${tag}-${run}`.toUpperCase()
  await admin(`INSERT INTO "Location" (id, "tenantId", "companyId", "siteId", code, name, kind, "labelCode") VALUES ($1, $2, $3, $4, $5, $6, 'BIN', $7)`, [bin, A.tenant, A.companyA, A.siteA1, `A1-${tag}-${run}`.toUpperCase(), `Made-up bin ${tag}`, label])
  const lotId = newId()
  const lotCode = `T299-${tag}-${run}`.toUpperCase()
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "qualityStatus", "qualityDecidedAt", "requiresCrViTest", "crViStatus", "receivedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'RELEASED', now(), false, 'NOT_REQUIRED', now() - interval '20 days')`,
    [lotId, A.tenant, A.companyA, A.siteA1, A.lining, A.colour, lotCode],
  )
  await admin(
    `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt", note)
     VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, $9, 'M', $9, $10, now() - interval '10 days', 'Made-up opening stock')`,
    [newId(), A.tenant, A.companyA, A.siteA1, A.lining, A.colour, lotId, bin, metres, `w2b299-${run}-${lotId}`],
  )
  return { bin, label, lotId, lotCode }
}

const lineOf = async (countId: string) => one<Json>(`SELECT id, seq, version, "frozenAt", "countedQuantity"::text AS counted, "countedById", "recountRequestedAt", "recountQuantity"::text AS recount FROM "StockCountLine" WHERE "countId" = $1 ORDER BY seq LIMIT 1`, [countId])
const countRow = async (countId: string) => one<Json>(`SELECT status::text, version, "approvedById", "freezeMoves", "approvalRequired" FROM "StockCount" WHERE id = $1`, [countId])
async function outbox(type: string): Promise<Json[]> {
  return (await admin<Json>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [A.tenant, type])).map((row) => row.payload)
}

beforeAll(async () => {
  db = await migratedDatabase('counts_in_depth')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: NS })
  }
  const a1 = await one<Json>(`SELECT s.id, s."tenantId", s."companyId" FROM "Site" s JOIN "Tenant" t ON t.id = s."tenantId" WHERE s.code = 'A1' ORDER BY t.slug LIMIT 1`)
  Object.assign(A, { tenant: a1.tenantId, companyA: a1.companyId, siteA1: a1.id })
  const workers = await admin<Json>(`SELECT id FROM "Worker" WHERE "tenantId" = $1 AND "siteId" = $2 ORDER BY "displayName", id`, [A.tenant, A.siteA1])
  A.worker = workers[0]!.id
  A.colleague = workers[1]!.id
  A.device = (await one<Json>(`SELECT id FROM "Device" WHERE "tenantId" = $1 AND "siteId" = $2 ORDER BY id LIMIT 1`, [A.tenant, A.siteA1])).id
  const lot = await one<Json>(`SELECT "itemId", "itemColourId" FROM "Lot" WHERE "tenantId" = $1 AND code = 'SEED-LOT-W36-01'`, [A.tenant])
  A.lining = lot.itemId
  A.colour = lot.itemColourId
  A.reason = (await one<Json>(`SELECT code FROM "ReasonCode" WHERE "tenantId" = $1 AND list = 'ADJUSTMENT' AND active ORDER BY code LIMIT 1`, [A.tenant])).code
  for (const [person, userId] of Object.entries(PEOPLE)) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [userId, A.tenant, `w2b299-${person}-${run}@example.com`, `Made-up ${person}`])
  }
  const floor = (workerId: string): SessionContext => ({ audience: 'floor', tenantId: A.tenant, actorId: workerId, siteId: A.siteA1, deviceId: A.device, grants: [grant(FLOOR, { companies: [A.companyA], sites: [A.siteA1] })] })
  const office = (userId: string): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: userId, grants: [grant(OFFICE)] })
  SESSIONS = {
    tablet: floor(A.worker),
    colleague: floor(A.colleague),
    clerk: office(PEOPLE.clerk),
    approver: office(PEOPLE.approver),
    keeper: office(PEOPLE.keeper),
    viewer: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['inventory.stock.view', 'inventory.counts.view'])] },
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
}, 1_500_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('separation of duties in the warehouse rules (SCM-293)', () => {
  it('reads both switches in force; switching one off asks the reason, then a fresh code; a tighter one saves', async () => {
    const view = await ok(call('clerk', 'GET', `/inventory/rules/separation-of-duties?companyId=${A.companyA}`))
    expect(view.switches.map((entry: Json) => [entry.rule, entry.inForce.on, entry.inForce.source])).toEqual([['COUNTER_NOT_APPROVER', true, 'TENANT'], ['RECEIVER_NOT_MATCHER', true, 'TENANT']])
    expect(view.switches[0].words.en).toMatch(/never approves the count/)
    expect(paths(await refused(call('clerk', 'PUT', '/inventory/rules/separation-of-duties', { companyId: A.companyA, version: view.version, counterNotApprover: false }), 400))).toEqual(['body/reason'])
    // With the reason it asks a fresh code: no office sign-in in this test process (503); the live check proves the step-up.
    expect((await refused(call('clerk', 'PUT', '/inventory/rules/separation-of-duties', { companyId: A.companyA, version: view.version, counterNotApprover: false, reason: 'Made-up: one person on night shift' }), 503)).code).toBe('not_ready')
    const saved = await ok(call('clerk', 'PUT', '/inventory/rules/separation-of-duties', { companyId: A.companyA, version: view.version, receiverNotMatcher: true }))
    expect(saved).toMatchObject({ loosened: [], rules: { version: view.version + 1, changedBy: { id: PEOPLE.clerk }, switches: [{ rule: 'COUNTER_NOT_APPROVER', own: null }, { rule: 'RECEIVER_NOT_MATCHER', own: true, inForce: { on: true, source: 'COMPANY' } }] } })
    expect((await outbox('inventory.rules_changed')).at(-1)).toEqual({ companyId: A.companyA, card: 'SEPARATION_OF_DUTIES', fields: ['receiverNotMatcher'], loosened: false })
    await refused(call('viewer', 'PUT', '/inventory/rules/separation-of-duties', { companyId: A.companyA, version: view.version + 1, receiverNotMatcher: null }), 403)
  })
})

describe('a scheduled bin counted by scan, recounted by another person, approved in Approvals (SCM-227, SCM-228, SCM-229)', () => {
  let stock: Awaited<ReturnType<typeof binWithLot>>
  let scheduleId = ''
  let countId = ''
  let ruleId = ''

  it('a schedule of the bin is due, makes its COUNT task, and starts a frozen count from its row', async () => {
    stock = await binWithLot('SCH', '40.0000')
    expect(paths(await refused(call('clerk', 'POST', '/inventory/count-schedules', { siteId: A.siteA1, name: 'Made-up', everyDays: 7 }), 400))).toContain('body/locationId')
    const { schedule } = await ok(call('clerk', 'POST', '/inventory/count-schedules', { siteId: A.siteA1, name: `Made-up bin ${run}`, locationId: stock.bin, everyDays: 30, nextDueOn: plusCalendarDays(today, -2) }), 201)
    scheduleId = schedule.id
    expect(schedule).toMatchObject({ due: 'OVERDUE', overdueDays: 2, everyDays: 30, active: true, location: { id: stock.bin }, scope: { en: expect.stringContaining('everything inside it') } })
    const due = await ok(call('clerk', 'GET', `/inventory/count-schedules/due?siteId=${A.siteA1}`))
    // B-W2b-F45: most overdue first. The seed's schedules keep their fixed days: once those are as old as this one's
    // (two days ago), they come first; every row before this one is due on its day or earlier.
    const ours = due.rows.findIndex((row: Json) => row.id === scheduleId)
    expect(ours).toBeGreaterThanOrEqual(0)
    expect(due.rows[ours]).toMatchObject({ id: scheduleId, due: 'OVERDUE', nextDueOn: schedule.nextDueOn })
    expect(due.rows.slice(0, ours).every((row: Json) => row.due === 'OVERDUE' && row.nextDueOn <= schedule.nextDueOn)).toBe(true)
    // B-W2b-F45 end
    expect(due.tiles.overdue).toBeGreaterThanOrEqual(1)
    expect(due.tiles.dueThisWeek).toBeGreaterThanOrEqual(due.tiles.overdue)
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined }
    expect((await runTimedTaskSources({ database, log })).failed).toBe(0)
    expect((await ok(call('clerk', 'GET', `/inventory/count-schedules?siteId=${A.siteA1}`))).schedules.find((row: Json) => row.id === scheduleId).openTaskId).toBeTruthy()
    // Retired: no count starts from it; active again.
    const retired = (await ok(call('clerk', 'PATCH', `/inventory/count-schedules/${scheduleId}`, { version: schedule.version, active: false }))).schedule
    expect(retired).toMatchObject({ active: false, due: 'RETIRED' })
    expect(paths(await refused(call('clerk', 'POST', `/inventory/count-schedules/${scheduleId}/start`, {}), 400))).toEqual(['scheduleId'])
    await ok(call('clerk', 'PATCH', `/inventory/count-schedules/${scheduleId}`, { version: retired.version, active: true }))
    const started = await ok(call('clerk', 'POST', `/inventory/count-schedules/${scheduleId}/start`, {}), 201)
    countId = started.countId
    expect(started.lines).toBe(1)
    expect(await countRow(countId)).toMatchObject({ status: 'COUNTING', freezeMoves: true })
    expect((await lineOf(countId)).frozenAt).not.toBeNull()
    const record = (await ok(call('clerk', 'GET', `/inventory/stock-counts/${countId}`))).count
    expect(record).toMatchObject({ freezeMoves: true, note: expect.stringContaining('Count schedule') })
    const frozen = await ok(call('clerk', 'GET', `/inventory/stock-counts/frozen?siteId=${A.siteA1}&locationId=${stock.bin}`))
    expect(frozen.lines).toEqual([expect.objectContaining({ count: { id: countId, number: record.number }, waitsFor: 'COUNT', location: expect.objectContaining({ id: stock.bin }) })])
  })

  it('the tablet counts the bin blind, unit by unit; Bin done shows what is short; Finish bin asks the rule\'s recount', async () => {
    const toCount = await ok(call('tablet', 'GET', '/inventory/stock-counts/to-count'))
    expect(toCount.bins).toContainEqual(expect.objectContaining({ count: expect.objectContaining({ id: countId }), location: expect.objectContaining({ id: stock.bin }), kind: 'COUNT', lines: 1, yours: false }))
    const bin = await ok(call('tablet', 'GET', `/inventory/stock-counts/bin?placeCode=${stock.label.toLowerCase()}`))
    expect(bin.count).toMatchObject({ id: countId })
    expect(bin.lines).toEqual([expect.objectContaining({ pass: 'COUNT', scans: 0, scanned: '0.0000' })])
    expect(bin.lines[0].expected).toBeUndefined()
    // A lot's label says no length: typed on the number pad.
    expect(paths(await refused(call('tablet', 'POST', `/inventory/stock-counts/${countId}/scans`, { placeCode: stock.label, code: stock.lotCode }), 400))).toContain('refusal/QUANTITY')
    const first = await ok(call('tablet', 'POST', `/inventory/stock-counts/${countId}/scans`, { placeCode: stock.label, code: stock.lotCode, quantity: '20.0000' }), 201)
    expect(first).toMatchObject({ added: false, line: { pass: 'COUNT', scans: 1, scanned: '20.0000' } })
    // The second roll of the lot comes through the tablet's queue (offline).
    const queued = await applyQueued(caller('tablet'), { clientEventId: newId(), kind: 'inventory.count.scan', payload: { countId, placeCode: stock.label, code: stock.lotCode, quantity: '15.0000' } }, { key: `q-${run}-1` })
    expect(queued).toMatchObject({ status: 'accepted', result: { type: 'StockCountScan' } })
    expect((await outbox('inventory.count_scanned')).at(-1)).toMatchObject({ countId, pass: 'COUNT', scans: 2, added: false })
    const done = await ok(call('tablet', 'GET', `/inventory/stock-counts/${countId}/bins/${stock.bin}`))
    expect(done).toMatchObject({ none: false, differences: [expect.objectContaining({ kind: 'SHORT', expected: '40.0000', scanned: '35.0000', scans: 2 })] })
    const finished = await ok(call('tablet', 'POST', `/inventory/stock-counts/${countId}/bins/${stock.bin}/finish`, {}))
    expect(finished).toMatchObject({ recountsAsked: [{ seq: 10 }], differences: [expect.objectContaining({ kind: 'SHORT' })] })
    const line = await lineOf(countId)
    expect(line).toMatchObject({ counted: '35.0000', countedById: null })
    expect(line.recountRequestedAt).not.toBeNull()
    expect((await outbox('inventory.count_recorded')).slice(-2).map((payload) => payload.change)).toEqual(['COUNTED', 'RECOUNT_ASKED'])
  })

  it('a recount is another person\'s: refused to the counter, done by a colleague', async () => {
    const mine = await ok(call('tablet', 'GET', '/inventory/stock-counts/to-count'))
    expect(mine.bins).toContainEqual(expect.objectContaining({ kind: 'RECOUNT', yours: true, location: expect.objectContaining({ id: stock.bin }) }))
    expect(paths(await refused(call('tablet', 'POST', `/inventory/stock-counts/${countId}/scans`, { placeCode: stock.label, code: stock.lotCode, quantity: '36.0000' }), 409))).toContain('refusal/OWN_RECOUNT')
    await ok(call('colleague', 'POST', `/inventory/stock-counts/${countId}/scans`, { placeCode: stock.label, code: stock.lotCode, quantity: '36.0000' }), 201)
    const queued = await applyQueued(caller('colleague'), { clientEventId: newId(), kind: 'inventory.count.finishBin', payload: { countId, locationId: stock.bin } }, { key: `q-${run}-2` })
    expect(queued).toMatchObject({ status: 'accepted', result: { type: 'StockCount', id: countId } })
    expect(await lineOf(countId)).toMatchObject({ counted: '35.0000', recount: '36.0000' })
    // The bin is finished: a scan into it now is refused in words.
    expect(paths(await refused(call('colleague', 'POST', `/inventory/stock-counts/${countId}/scans`, { placeCode: stock.label, code: stock.lotCode, quantity: '1.0000' }), 409))).toContain('refusal/LINE_COUNTED')
  })

  it('the submit asks a yes (COUNT_VARIANCE) under a switched-on rule; the counts\' own approve and apply wait for it', async () => {
    ruleId = newId()
    await admin(
      `INSERT INTO "ApprovalRule" (id, "tenantId", "companyId", kind, name, condition, "approverUserId", active, sequence) VALUES ($1, $2, $3, 'COUNT_VARIANCE', 'Made-up: count differences', '{"combinator":"and","rows":[]}', $4, true, 10)`,
      [ruleId, A.tenant, A.companyA, PEOPLE.approver],
    )
    const line = await lineOf(countId)
    await ok(call('clerk', 'POST', `/inventory/stock-counts/${countId}/lines/record`, { lines: [{ lineId: line.id, version: line.version, reasonCode: A.reason }] }))
    const submitted = (await ok(call('clerk', 'POST', `/inventory/stock-counts/${countId}/submit`, { version: (await countRow(countId)).version }))).count
    expect(submitted.status).toBe('SUBMITTED')
    expect(submitted.approval).toMatchObject({ required: true, held: 'NO_RIGHT', heldReason: expect.stringContaining('waits for a yes in Approvals by Made-up approver'), request: { status: 'PENDING' } })
    expect(submitted.actions.apply).toMatchObject({ allowed: false })
    const taskId = submitted.approval.request.taskId
    const task = (await ok(call('approver', 'GET', `/approvals/tasks/${taskId}`))).task
    expect(task).toMatchObject({ kind: 'COUNT_VARIANCE', status: 'PENDING', record: { type: 'StockCount', id: countId } })
    expect(paths(await refused(call('approver', 'POST', `/inventory/stock-counts/${countId}/approve`, { version: submitted.version }), 409))).toContain('problem/IN_APPROVALS')
    expect(paths(await refused(call('clerk', 'POST', `/inventory/stock-counts/${countId}/apply`, { version: submitted.version }), 409))).toContain('problem/IN_APPROVALS')
    // Nobody approves their own request (the clerk asked it by submitting).
    expect(paths(await refused(call('clerk', 'POST', `/approvals/tasks/${taskId}/approve`, { version: task.version }), 403))).toContain('refusal/OWN_REQUEST')
    await ok(call('approver', 'POST', `/approvals/tasks/${taskId}/approve`, { version: task.version, comment: 'Made-up: checked' }))
    expect(await countRow(countId)).toMatchObject({ status: 'APPROVED', approvedById: PEOPLE.approver })
    await admin(`UPDATE "ApprovalRule" SET active = false WHERE id = $1`, [ruleId])
  })

  it('the apply moves the schedule on and does its COUNT task', async () => {
    const applied = await ok(call('clerk', 'POST', `/inventory/stock-counts/${countId}/apply`, { version: (await countRow(countId)).version }))
    expect(applied.moves).toEqual([expect.objectContaining({ direction: 'OUT', baseQuantity: '4.0000' })])
    const schedule = (await ok(call('clerk', 'GET', `/inventory/count-schedules?siteId=${A.siteA1}`))).schedules.find((row: Json) => row.id === scheduleId)
    expect(schedule).toMatchObject({ lastCountedOn: today, lastCount: { id: countId }, nextDueOn: plusCalendarDays(today, 30), due: 'LATER', openTaskId: null })
    const task = await one<Json>(`SELECT status::text, "doneById" FROM "WarehouseTask" WHERE "sourceType" = 'CountSchedule' AND "sourceId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [scheduleId])
    expect(task).toEqual({ status: 'DONE', doneById: PEOPLE.clerk })
    expect((await outbox('inventory.count_schedule_changed')).at(-1)).toMatchObject({ scheduleId, change: 'COUNTED', countId, nextDueOn: plusCalendarDays(today, 30) })
  })
})

describe('frozen lines hold their moves until counted (SCM-226)', () => {
  it('a move of the lot at its bin is refused in words until its line is counted', async () => {
    const stock = await binWithLot('FRZ', '12.0000')
    const other = await binWithLot('FRZ2', '1.0000')
    // A count of the lot (no place blocked), frozen.
    const { count } = await ok(call('clerk', 'POST', '/inventory/stock-counts', { siteId: A.siteA1, kind: 'CYCLE', lotId: stock.lotId, start: true, freeze: true }), 201)
    expect(count).toMatchObject({ status: 'COUNTING', freezeMoves: true })
    const error = await refused(call('clerk', 'POST', '/inventory/transfers', { siteId: A.siteA1, itemId: A.lining, lotId: stock.lotId, fromLocationId: stock.bin, toLocationId: other.bin, quantity: '1' }), 409)
    expect(paths(error)).toContain('warehouse/COUNT_FROZEN')
    await ok(call('tablet', 'POST', `/inventory/stock-counts/${count.id}/scans`, { placeCode: stock.label, code: stock.lotCode, quantity: '12.0000' }), 201)
    const finished = await ok(call('tablet', 'POST', `/inventory/stock-counts/${count.id}/bins/${stock.bin}/finish`, {}))
    expect(finished).toMatchObject({ recountsAsked: [], differences: [expect.objectContaining({ kind: 'MATCH' })] })
    await ok(call('clerk', 'POST', '/inventory/transfers', { siteId: A.siteA1, itemId: A.lining, lotId: stock.lotId, fromLocationId: stock.bin, toLocationId: other.bin, quantity: '1' }), 201)
    expect((await ok(call('clerk', 'GET', `/inventory/stock-counts/frozen?siteId=${A.siteA1}&locationId=${stock.bin}`))).lines).toEqual([])
    await ok(call('clerk', 'POST', `/inventory/stock-counts/${count.id}/cancel`, { version: (await countRow(count.id)).version, reason: 'Made-up: test over' }))
  })

  it('a class count starts at once; a draft of a class is refused', async () => {
    expect(paths(await refused(call('clerk', 'POST', '/inventory/stock-counts', { siteId: A.siteA1, kind: 'CYCLE', abcClass: 'A' }), 400))).toContain('body/abcClass')
    const abc = await ok(call('viewer', 'GET', `/inventory/count-schedules/abc?siteId=${A.siteA1}`))
    expect(abc.materials.length).toBeGreaterThan(0)
    expect(abc.materials[0].sharePercent).toBeUndefined()
  })
})

describe('the counter never approves their own variance (SCM-229, SCM-293)', () => {
  it('a worker who scanned a differing line is the office user they are; switched off, they may approve', async () => {
    const stock = await binWithLot('OWN', '50.0000')
    const { count } = await ok(call('clerk', 'POST', '/inventory/stock-counts', { siteId: A.siteA1, kind: 'CYCLE', lotId: stock.lotId, start: true }), 201)
    await ok(call('tablet', 'POST', `/inventory/stock-counts/${count.id}/scans`, { placeCode: stock.label, code: stock.lotCode, quantity: '49.0000' }), 201)
    await ok(call('tablet', 'POST', `/inventory/stock-counts/${count.id}/bins/${stock.bin}/finish`, {}))
    const line = await lineOf(count.id)
    expect(line.recountRequestedAt).toBeNull()
    await ok(call('clerk', 'POST', `/inventory/stock-counts/${count.id}/lines/record`, { lines: [{ lineId: line.id, version: line.version, reasonCode: A.reason }] }))
    const submitted = (await ok(call('clerk', 'POST', `/inventory/stock-counts/${count.id}/submit`, { version: (await countRow(count.id)).version }))).count
    // The lining has no cost: the value is unknown, so a second person approves.
    expect(submitted).toMatchObject({ status: 'SUBMITTED', approvalRequired: true, approval: { request: null } })
    await admin(`UPDATE "Worker" SET "userId" = $1 WHERE id = $2`, [PEOPLE.keeper, A.worker])
    expect((await ok(call('keeper', 'GET', `/inventory/stock-counts/${count.id}`))).count.approval).toMatchObject({ held: 'OWN_VARIANCE' })
    expect(paths(await refused(call('keeper', 'POST', `/inventory/stock-counts/${count.id}/approve`, { version: submitted.version }), 409))).toContain('problem/OWN_VARIANCE')
    // The company's switch off (the warehouse rules' reason kept with it): the same person may approve.
    await admin(`INSERT INTO "InventorySettings" (id, "tenantId", "companyId", "counterNotApprover", "separationOffReason") VALUES ($1, $2, $1, false, 'Made-up: a one-person site') ON CONFLICT (id) DO UPDATE SET "counterNotApprover" = false, "separationOffReason" = 'Made-up: a one-person site'`, [A.companyA, A.tenant])
    expect((await ok(call('keeper', 'POST', `/inventory/stock-counts/${count.id}/approve`, { version: submitted.version }))).count.status).toBe('APPROVED')
    await admin(`UPDATE "InventorySettings" SET "counterNotApprover" = NULL, "separationOffReason" = NULL WHERE id = $1`, [A.companyA])
    await admin(`UPDATE "Worker" SET "userId" = NULL WHERE id = $1`, [A.worker])
  })
})

describe('the receiver never approves their invoice (SCM-293)', () => {
  it('refuses who posted the receipt an invoice matches, while the switch is on', async () => {
    const invoice = await one<Json>(`SELECT id, "companyId", number FROM "SupplierInvoice" WHERE "tenantId" = $1 AND number = '2026/0412'`, [A.tenant])
    const poster = (await one<Json>(`SELECT gr."postedById" FROM "SupplierInvoiceMatch" m JOIN "GoodsReceiptLine" l ON l.id = m."goodsReceiptLineId" JOIN "GoodsReceipt" gr ON gr.id = l."receiptId" WHERE m."invoiceId" = $1 LIMIT 1`, [invoice.id])).postedById
    const other = PEOPLE.clerk
    const read = (personId: string) => caller('clerk').withClient((client) => receiverRefusals(client, invoice as never, personId, 'APPROVE'))
    expect(await read(poster)).toEqual([expect.objectContaining({ code: 'RECEIVED_THE_GOODS', message: expect.stringContaining(invoice.number) })])
    expect(await read(other)).toEqual([])
    await admin(`UPDATE "InventorySettings" SET "receiverNotMatcher" = false, "separationOffReason" = 'Made-up: a two-person office' WHERE id = $1`, [A.companyA])
    expect(await read(poster)).toEqual([])
    await admin(`UPDATE "InventorySettings" SET "receiverNotMatcher" = NULL, "separationOffReason" = NULL WHERE id = $1`, [A.companyA])
  })
})
