import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { localInstant, plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAccounting, type AccountingSeed } from '../../../../../../packages/factory-db/seed/accounting'
import { seed as seedAndon } from '../../../../../../packages/factory-db/seed/andon'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPeople, type PeopleSeed } from '../../../../../../packages/factory-db/seed/people'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../platform/outbox/system'
import { switchOnPerformance } from '../../people/privacy/testing/performance-gate'
import { postWorkOrderCosts } from '../../costing/actual/post'
import { readSamples, readWork, siteLines } from '../../people/efficiency/store'
import { earnBundleNow } from '../../people/earnings/jobs'
import { factsOfPeriod } from '../../people/earnings/periods'
import { PayFacts, periodOfMonth } from '../../people/earnings/store'

vi.setConfig({ testTimeout: 60_000 })

/**
 * An unplanned operation as a real step (B-W2b-82; MES-086) through the app's real routes on a throwaway PostgreSQL 17 database
 * from the migrations (runtime and floor logins: row-level security, the grants and the triggers are real), on the factory-db
 * seeds up to accounting, people and the help-call types: SEED-WO-0001 IN_PROGRESS with its routing 10 cut, 20 sew, 30 final
 * inspection, 40 pack, made-up tablets at SEW-01 and SEW-02, a made-up library operation, a made-up piece rate and scheme for
 * the pay part. Every figure and name is made up; none is any CCNL's. It walks the add on the tablet and in the office, the scan
 * at it, the next operation's guard, WIP, labour cost and the estimate, pay (its rate, no rate, outside the piece-pay window),
 * efficiency and the plan. The law the tests name: c.c. art. 2101 (a report pays the person it names, at a rate published
 * first), Statuto dei Lavoratori art. 4 (no person in an event or a record of the add), MES-005 (the routing's copies stay
 * frozen). Run with `node scripts/factory/run-pg-tests.mjs modules/production/extraops`.
 */

let h: Harness
let app: FastifyInstance
let seeded: AccountingSeed
let people: PeopleSeed

const NS = 'w2b82-extraops'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const siteA1 = idOf('site:A1')
const sew1 = idOf('site:A1:station:SEW-01')
const sew2 = idOf('site:A1:station:SEW-02')
const operator = idOf('worker:A1:operator')
const lead = idOf('worker:A1:lead')
const tablets = { sew: newId(), lead: newId() }
const ROME = 'Europe/Rome'
const today = businessDate(new Date(), ROME)
const FIRST = `${today.slice(0, 7)}-01`
const actors = { hr: newId(), manager: newId() }

const OPERATOR: Permission[] = ['production.scan', 'floor.work']
const LEAD: Permission[] = ['production.scan', 'floor.work', 'floor.lead', 'production.extraops.add']
const grant = (permissions: readonly string[]): Grant => ({ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties: 'all' })
const floor = (deviceId: string, actorId: string, permissions: Permission[]): SessionContext => ({ audience: 'floor', tenantId: T, actorId, siteId: siteA1, deviceId, grants: [{ permissions, companies: [companyA], sites: [siteA1], parties: 'all' }] })
const SESSIONS: Record<string, SessionContext> = {
  op: floor(tablets.sew, operator, OPERATOR),
  lead: floor(tablets.lead, lead, LEAD),
  manager: { audience: 'office', tenantId: T, actorId: actors.manager, grants: [grant(['workorders.view', 'production.extraops.add', 'production.reports.view', 'planning.view', 'production.labour.view'])] },
  finance: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['costing.view', 'costing.ledger.manage', 'money.cost'])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const run = randomBytes(4).toString('hex')
let serial = 0
const cid = (name: string) => `t-${run}-${name}-${++serial}`
const call = (session: string, method: Method, url: string, payload?: unknown, key: string | null = cid('key')) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key && method === 'POST' && !(payload as Json | undefined)?.clientScanId ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const refusalOf = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const system = () => callerFor(h.database, systemContext(T, `extraops-${run}`))

let wo = ''
let cell = ''
const ops: Record<'cut' | 'sew' | 'qc' | 'pack', string> = { cut: '', sew: '', qc: '', pack: '' }
const library = { fix: { id: newId(), code: `W2B82-FIX-${run}` }, press: { id: newId(), code: `W2B82-PRESS-${run}` }, late: { id: newId(), code: `W2B82-LATE-${run}` } }
const base = () => `/production/extra-operations/work-orders/${wo}`
let step = ''

async function bundle(quantity = 20): Promise<{ id: string; code: string }> {
  const id = newId()
  const code = `W2B82-${run}-${++serial}`.toUpperCase()
  await admin(`INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())`, [id, T, siteA1, wo, cell, code, quantity])
  return { id, code }
}
const report = (bundleId: string, workOrderOperationId: string, good: number, extra: Json = {}) => ({ clientScanId: cid('scan'), bundleId, workOrderOperationId, good, ...extra })
const rules = (quantityGuard: string, skippedOperationRule: string) => admin(`UPDATE "ProductionSettings" SET "quantityGuard" = $2, "skippedOperationRule" = $3 WHERE id = $1`, [siteA1, quantityGuard, skippedOperationRule])

beforeAll(async () => {
  h = await startHarness('extraops')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedPrivacy({ db: h.database, namespace: NS })
  seeded = await seedAccounting({ db: h.database, namespace: NS })
  people = await seedPeople({ db: h.database, namespace: NS })
  await seedAndon({ db: h.database, namespace: NS })
  const production = seeded.money.shipping.quality.production
  wo = production.workOrderId
  cell = production.cellIds['BLK-52']!
  Object.assign(ops, production.operationIds)
  const device = (id: string, station: string, name: string) => admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, $6, 'TABLET', 'ACTIVE', now())`, [id, T, companyA, siteA1, station, name])
  await device(tablets.sew, sew1, 'Sewing tablet W2B82-1')
  await device(tablets.lead, sew2, 'Sewing tablet W2B82-2')
  const operation = (row: { id: string; code: string }, name: string, kind: string, minutes: number) => admin(`INSERT INTO "Operation" (id, "tenantId", "companyId", code, name, "workCentreKind", "standardMinutes", status, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6::"WorkCentreKind", $7, 'ACTIVE', now())`, [row.id, T, companyA, row.code, name, kind, minutes])
  await operation(library.fix, 'Made-up collar fix', 'SEWING', 1.5)
  await operation(library.press, 'Made-up extra press', 'SEWING', 0.8)
  await operation(library.late, 'Made-up late step', 'SEWING', 2)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the add: a WorkOrderOperation row, not an audit row (MES-086)', () => {
  it('writes the step on the tablet: no routing step, the library\'s copy, its reason, after every operation', async () => {
    const before = (await admin('SELECT max(seq)::int AS seq FROM "WorkOrderOperation" WHERE "workOrderId" = $1', [wo]))[0]!.seq
    const choices = await ok('lead', 'GET', `${base()}/choices`)
    expect(choices.operations.find((row: Json) => row.id === library.fix.id)).toMatchObject({ code: library.fix.code, pays: 'NO_PIECE_PAY' })
    const key = cid('add')
    const first = await call('lead', 'POST', base(), { operationId: library.fix.id, reasonCode: 'QUALITY_FIX' }, key)
    expect(first.statusCode, first.body).toBe(201)
    const record = first.json()
    expect(record).toMatchObject({ seq: before + 10, reasonCode: 'QUALITY_FIX', addedOn: 'FLOOR', pays: 'NO_PIECE_PAY', operation: { id: library.fix.id, code: library.fix.code } })
    expect(record.workOrderOperationId).toBe(record.id)
    step = record.workOrderOperationId
    const [row] = await admin('SELECT "routingSeq", "operationId", "unplannedReason", code, name, "standardMinutes"::text AS minutes, "scanRequired", "parallelGroup", "createdById", seq FROM "WorkOrderOperation" WHERE id = $1', [step])
    expect(row).toEqual({ routingSeq: null, operationId: library.fix.id, unplannedReason: 'QUALITY_FIX', code: library.fix.code, name: 'Made-up collar fix', minutes: '1.500', scanRequired: false, parallelGroup: null, createdById: null, seq: before + 10 })
    // The same key answers the first; no second row.
    const again = await call('lead', 'POST', base(), { operationId: library.fix.id, reasonCode: 'QUALITY_FIX' }, key)
    expect(again.statusCode).toBe(200)
    expect(again.json().id).toBe(record.id)
    expect((await admin('SELECT count(*)::int AS n FROM "WorkOrderOperation" WHERE "workOrderId" = $1 AND "routingSeq" IS NULL', [wo]))[0]!.n).toBe(1)
    // Who stays in the audit log; the event names nobody.
    const [audit] = await admin(`SELECT "actorId", reason, after FROM "AuditLog" WHERE action = 'production.extraOperationAdded' AND "recordId" = $1`, [wo])
    expect(audit).toMatchObject({ actorId: lead, reason: 'To fix a defect', after: { recordId: step, seq: before + 10 } })
    const [event] = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'production.extra_operation_added' AND subject = $1`, [wo])
    expect(JSON.stringify(event!.payload)).not.toContain(lead)
  })

  it('in the office too, with Other in words; a second place; both in the list, each with its step', async () => {
    const answer = await ok('manager', 'POST', base(), { operationId: library.press.id, reasonCode: 'OTHER', note: 'Made-up words' }, 201)
    expect(answer).toMatchObject({ addedOn: 'OFFICE', reason: 'Other (say why): Made-up words' })
    const list = await ok('manager', 'GET', base())
    expect(list.added.map((row: Json) => [row.operation.code, row.workOrderOperationId !== null, row.addedOn])).toEqual([
      [library.fix.code, true, 'FLOOR'],
      [library.press.code, true, 'OFFICE'],
    ])
    expect(list.added[1].seq).toBe(list.added[0].seq + 10)
    const [row] = await admin('SELECT "unplannedReason", "createdById" FROM "WorkOrderOperation" WHERE id = $1', [answer.workOrderOperationId])
    expect(row).toEqual({ unplannedReason: 'OTHER', createdById: actors.manager })
  })

  it('refuses in words: added already, on the routing, not of the library, "Other" alone', async () => {
    expect((await no('lead', 'POST', base(), { operationId: library.fix.id, reasonCode: 'QUALITY_FIX' }, 409)).message).toMatch(/added to this work order already/)
    expect((await no('lead', 'POST', base(), { operationId: newId(), reasonCode: 'QUALITY_FIX' }, 409)).message).toMatch(/not an active operation/)
    expect((await no('lead', 'POST', base(), { operationId: library.late.id, reasonCode: 'OTHER' }, 409)).message).toMatch(/few words/)
    // A routing operation of this work order.
    const planned = (await admin<{ id: string }>(`SELECT r."operationId" AS id FROM "RoutingOperation" r JOIN "WorkOrderOperation" o ON r."revisionId" = o."styleRevisionId" AND r.seq = o."routingSeq" WHERE o.id = $1`, [ops.sew]))[0]!.id
    expect((await no('manager', 'POST', base(), { operationId: planned, reasonCode: 'QUALITY_FIX' }, 409)).message).toMatch(/routing already/)
    expect((await ok('lead', 'GET', `${base()}/choices`)).operations.map((row: Json) => row.id)).not.toContain(library.fix.id)
    // An operator holds no right.
    expect((await call('op', 'POST', base(), { operationId: library.late.id, reasonCode: 'QUALITY_FIX' })).statusCode).toBe(403)
    // The work order's other state: a draft takes none.
    const draft = (await admin<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND status = 'DRAFT' LIMIT 1`, [T]))[0]!.id
    expect((await no('manager', 'POST', `/production/extra-operations/work-orders/${draft}`, { operationId: library.late.id, reasonCode: 'QUALITY_FIX' }, 409)).message).toMatch(/not released or in progress/)
  })
})

describe('the scan at it', () => {
  it('stands on the bundle\'s card, marked, picked by hand; the card still opens the routing\'s next step', async () => {
    const bundleRow = await bundle()
    const card = await ok('op', 'GET', `/production/scans/card?code=${bundleRow.code}`)
    const row = card.operations.find((entry: Json) => entry.id === step)
    expect(row).toMatchObject({ unplanned: true, scanRequired: false, final: false, sewn: false, state: 'OPEN', expected: 20 })
    expect(card.operations.filter((entry: Json) => !entry.unplanned).map((entry: Json) => entry.unplanned)).toEqual([false, false, false, false])
    expect(card.next).toBe(ops.sew)
  })

  it('takes a bundle no routing operation reported, at a site that holds skipped operations; nothing is flagged', async () => {
    await rules('STRICT', 'STRICT')
    const row = await bundle()
    const check = await ok('op', 'GET', `/production/guards/check?code=${row.code}&workOrderOperationId=${step}`)
    expect(check).toMatchObject({ expected: 20, skipped: [], findings: [] })
    const answer = await ok('op', 'POST', '/production/scans', report(row.id, step, 12), 201)
    expect(answer.scan).toMatchObject({ kind: 'REPORT', goodQuantity: 12, operation: { id: step } })
    expect(await admin(`SELECT 1 FROM "AuditLog" WHERE action = 'production.scanGuardFlagged' AND "recordId" = $1`, [answer.scan.id])).toEqual([])
    // One report per bundle per operation; undo takes it back.
    expect(refusalOf(await no('op', 'POST', '/production/scans', report(row.id, step, 3), 409))).toBe('refusal/ALREADY_REPORTED')
    const undone = await ok('op', 'POST', `/production/scans/${answer.scan.id}/undo`, { clientScanId: cid('undo') }, 201)
    expect(undone.scan.kind).toBe('UNDO')
    await ok('op', 'POST', '/production/scans', report(row.id, step, 12), 201)
  })

  it('counts good garments only, and at most the bundle\'s own', async () => {
    const row = await bundle()
    const scrap = (await admin<{ code: string }>(`SELECT code FROM "ScrapReason" WHERE "tenantId" = $1 AND kind = 'SCRAP' ORDER BY code LIMIT 1`, [T]))[0]!.code
    const refused = await no('op', 'POST', '/production/scans', report(row.id, step, 19, { scrap: [{ reason: scrap, quantity: 1 }] }), 409)
    expect(refusalOf(refused)).toBe('refusal/UNPLANNED_GOOD_ONLY')
    expect(refused.message).toMatch(/counts good garments only/)
    expect(refusalOf(await no('op', 'POST', '/production/scans', report(row.id, step, 21), 409))).toBe('refusal/MORE_THAN_BUNDLE')
  })

  it('never counts for the next operation: its quantity guard reads what the routing passed', async () => {
    await rules('STRICT', 'WARN')
    const row = await bundle()
    await ok('op', 'POST', '/production/scans', report(row.id, step, 20), 201)
    // Nothing of the routing passed it, so the first operation still has all 20; one reported at 15 caps the next at 15.
    await ok('op', 'POST', '/production/scans', report(row.id, ops.cut, 15, { kindReason: 'Made-up reason' }), 201)
    const check = await ok('op', 'GET', `/production/guards/check?code=${row.code}&workOrderOperationId=${ops.sew}`)
    expect(check.expected).toBe(15)
    expect(refusalOf(await no('op', 'POST', '/production/scans', report(row.id, ops.sew, 16), 409))).toBe('refusal/MORE_THAN_PASSED')
    await ok('op', 'POST', '/production/scans', report(row.id, ops.sew, 15), 201)
    // A bundle not reported at it moves on with no word about it.
    const other = await bundle()
    await ok('op', 'POST', '/production/scans', report(other.id, ops.cut, 20, { kindReason: 'Made-up reason' }), 201)
    const skipped = await ok('op', 'GET', `/production/guards/check?code=${other.code}&workOrderOperationId=${ops.sew}`)
    expect(skipped).toMatchObject({ expected: 20, skipped: [], findings: [] })
  })

  it('runs the bundle\'s clock like any operation', async () => {
    const row = await bundle()
    const started = await ok('op', 'POST', '/production/terminal/start', { clientScanId: cid('start'), code: row.code, workOrderOperationId: step }, 201)
    expect(started.timing.state).toBe('RUNNING')
    await ok('op', 'POST', '/production/scans', report(row.id, step, 20), 201)
    const [running] = (await ok('op', 'GET', '/production/terminal/open')).items.filter((item: Json) => item.bundleId === row.id)
    expect(running).toBeUndefined()
  })
})

describe('what it does to the figures', () => {
  it('in WIP: marked, and nothing waits for it; the work order\'s finished garments stay the routing\'s', async () => {
    const wip = await ok('manager', 'GET', `/production/scans/work-orders/${wo}/wip`)
    const row = wip.operations.find((entry: Json) => entry.operationId === step)
    expect(row).toMatchObject({ unplanned: true, final: false, sewn: false, waiting: 0, missing: 0 })
    expect(row.arrived).toBe(row.good)
    expect(row.bundles.waiting).toBe(0)
    expect(wip.operations.find((entry: Json) => entry.final).code).not.toBe(library.fix.code)
    expect(wip.finalOperationId).toBe(ops.pack)
    const site = await ok('manager', 'GET', `/production/scans/wip?siteId=${siteA1}&limit=50`)
    expect(site.workOrders.find((entry: Json) => entry.workOrder.id === wo).operations.find((entry: Json) => entry.operationId === step)).toMatchObject({ unplanned: true, waiting: 0 })
  })

  it('in the work order: on the frozen spec, but none of its planned minutes', async () => {
    const { workOrder } = await ok('manager', 'GET', `/production/work-orders/${wo}`)
    const spec = workOrder.spec
    expect(spec.operations.filter((op: Json) => op.routingSeq === null).map((op: Json) => op.code)).toEqual([library.fix.code, library.press.code])
    const routing = spec.operations.filter((op: Json) => op.routingSeq !== null).reduce((sum: number, op: Json) => sum + Number(op.standardMinutes), 0)
    expect(Number(spec.standardMinutes.perGarment)).toBeCloseTo(routing, 6)
  })

  it('costs: labour at its own standard minutes, none of it in the estimate, so it shows as variance', async () => {
    const before = await ok('finance', 'GET', `/costing/work-orders/${wo}`)
    const estimate = before.detail.estimate.total
    await postWorkOrderCosts(system(), wo)
    const row = await bundle()
    const scan = await ok('op', 'POST', '/production/scans', report(row.id, step, 10), 201)
    const posted = await postWorkOrderCosts(system(), wo, { scope: { scanIds: [scan.scan.id] } })
    const labour = posted.posted.filter((entry) => entry.kind === 'LABOUR' && entry.operationScanId === scan.scan.id)
    expect(labour).toHaveLength(1)
    // 10 good × 1.5 standard minutes.
    expect(Number(labour[0]!.minutes)).toBeCloseTo(15, 6)
    const { detail } = await ok('finance', 'GET', `/costing/work-orders/${wo}`)
    expect(detail.estimate.total).toBe(estimate)
    const line = detail.labour.find((entry: Json) => entry.operation.id === step)
    expect(line).toMatchObject({ unplanned: true, plannedMinutes: '0' })
    expect(Number(line.earnedMinutes)).toBeGreaterThanOrEqual(15)
    expect(detail.labour.filter((entry: Json) => entry.unplanned).map((entry: Json) => entry.operation.code)).toEqual([library.fix.code, library.press.code])
    // A resend posts nothing twice.
    expect((await postWorkOrderCosts(system(), wo, { scope: { scanIds: [scan.scan.id] } })).posted).toEqual([])
  })

  it('earns minutes on the line and the person figures; the standard review and the cycle times stay the routing\'s', async () => {
    const place = { id: siteA1, companyId: companyA, timezone: ROME }
    await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
      const { sources } = await siteLines(client, place)
      const work = await readWork(client, place, sources, { from: today, to: today })
      const unplanned = work.records.filter((entry) => entry.step === null)
      expect(unplanned.length).toBeGreaterThan(0)
      expect(unplanned.every((entry) => entry.record.workOrderOperationId === step)).toBe(true)
      expect(Number(unplanned[0]!.record.earnedMinutes)).toBeGreaterThan(0)
      const samples = await readSamples(client, place, sources, { from: today, to: today })
      expect([...samples.steps.values()].some((entry) => entry.step.code === library.fix.code)).toBe(false)
    })
  })

  it('stands in the labour record: its standard minutes, the minutes earned', async () => {
    const [scan] = await admin<{ id: string }>(`SELECT id FROM "OperationScan" WHERE "workOrderOperationId" = $1 AND kind = 'REPORT' AND "goodQuantity" = 20 ORDER BY "serverTime" DESC LIMIT 1`, [step])
    const { record } = await ok('manager', 'GET', `/production/labour/records/${scan!.id}`)
    expect(record.operation).toMatchObject({ id: step, code: library.fix.code, standardMinutes: '1.5' })
    expect(Number(record.earnedMinutes)).toBeCloseTo(30, 6)
  })

  it('stays off the planning board: no bar and no minutes to place', async () => {
    const popover = await ok('manager', 'GET', `/planning/schedule/work-orders/${wo}`)
    expect(popover.workOrder.operations.map((operation: Json) => operation.code)).not.toContain(library.fix.code)
    expect(popover.workOrder.operations).toHaveLength(4)
  })

  it('leaves the line\'s output alone: a garment leaves the line once', async () => {
    const daily = await ok('manager', 'GET', `/production/reports/daily?siteId=${siteA1}&date=${today}`)
    expect(JSON.stringify(daily)).not.toContain(library.fix.code)
  })
})

describe('pay: at its rate, or nothing per piece (c.c. art. 2101)', () => {
  const employee = () => people.employeeIds.e1
  const entries = () => admin('SELECT kind::text AS kind, pieces, "rateEntryId", amount FROM "EarningsEntry" WHERE "tenantId" = $1 AND "employeeId" = $2 ORDER BY "createdAt", id', [T, employee()])
  const earn = (bundleId: string, workOrderOperationId: string) => earnBundleNow(system(), { bundleId, workOrderOperationId, siteId: siteA1 })
  let fixRate = ''
  let version = ''

  async function publishRates(): Promise<void> {
    const notice = (await admin<{ id: string }>(`SELECT id FROM "PrivacyNotice" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'WORKER_FLOOR' AND status = 'PUBLISHED'`, [T, companyA]))[0]!.id
    const dpia = (await admin<{ id: string }>(`SELECT id FROM "PrivacyDpia" WHERE "tenantId" = $1 AND "companyId" = $2 AND status = 'STORED'`, [T, companyA]))[0]!.id
    const before = new Date(`${plusDays(FIRST, -2)}T08:00:00Z`)
    const scheme = newId()
    await admin(
      `INSERT INTO "PeopleLegalGate" (id, "tenantId", "companyId", "siteId", purpose, basis, "basisReference", "basisCoversLeads", "leadsSeeFigures", "noticeId", "dpiaId", "switchedOnAt", "switchedOnById", "updatedAt")
       VALUES ($1, $2, $3, $4, 'PERFORMANCE', 'UNION_AGREEMENT', 'SAMPLE - made-up basis for the test', true, true, $5, $6, $7, $8, now())`,
      [newId(), T, companyA, siteA1, notice, dpia, before, actors.hr],
    )
    await admin(`INSERT INTO "IncentiveScheme" (id, "tenantId", "companyId", name, kind, "guaranteedBasis", "guaranteedHourlyRate", "reworkOwnFault", "scrapOwnFault", "ownFaultRatePct", "validFrom", "updatedAt") VALUES ($1, $2, $3, 'Made-up piece rate', 'PIECE_RATE', 'CCNL_MINIMUM', 9, 'REDUCED_RATE', 'UNPAID', 50, $4::date, now())`, [scheme, T, companyA, FIRST])
    await admin(`UPDATE "IncentiveScheme" SET status = 'ACTIVE', "activatedAt" = now(), "activatedById" = $2 WHERE id = $1`, [scheme, actors.hr])
    const table = newId()
    version = newId()
    fixRate = newId()
    await admin(`INSERT INTO "PieceRateTable" (id, "tenantId", "companyId", "siteId", code, name, "updatedAt") VALUES ($1, $2, $3, $4, 'T-EXTRA', 'Made-up rates', now())`, [table, T, companyA, siteA1])
    await admin(`INSERT INTO "PieceRateVersion" (id, "tenantId", "companyId", "siteId", "tableId", "versionNo", "changeReason", "effectiveFrom", "updatedAt") VALUES ($1, $2, $3, $4, $5, 1, 'NEW', $6::date, now())`, [version, T, companyA, siteA1, table, FIRST])
    await admin(`INSERT INTO "PieceRateEntry" (id, "tenantId", "siteId", "versionId", "operationId", basis, "ratePerPiece", "updatedAt") VALUES ($1, $2, $3, $4, $5, 'FIXED', 1.5, now())`, [fixRate, T, siteA1, version, library.fix.id])
    await admin(`INSERT INTO "RatePublication" (id, "tenantId", "companyId", "siteId", "versionId", "workerIds", "onFloor", printed, "publishedAt", "publishedById", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6::uuid[], true, false, $7, $8, now())`, [newId(), T, companyA, siteA1, version, [operator, lead], before, actors.hr])
    await admin(`UPDATE "PieceRateVersion" SET status = 'PUBLISHED' WHERE id = $1`, [version])
    await admin(`INSERT INTO "PiecePaySwitch" (id, "tenantId", "companyId", "siteId", "updatedAt") VALUES ($1, $2, $3, $1, now())`, [siteA1, T, companyA])
    await admin(
      `UPDATE "PiecePaySwitch" SET state = 'ON', "ccnlName" = 'Made-up CCNL', "ccnlArticle" = 'art. 0', "workerNoticeId" = $2, "dpiaId" = $3, "consultantName" = 'Made-up consultant', "consultantAgreedOn" = $4::date, "schemeId" = $5, "onFrom" = $4::date, "switchedOnAt" = $6, "switchedOnById" = $7 WHERE id = $1`,
      [siteA1, notice, dpia, FIRST, scheme, localInstant(FIRST, 0, ROME), actors.hr],
    )
  }

  it('outside a site\'s piece-pay window nothing is paid, and the add says nothing of a rate', async () => {
    const row = await bundle()
    await ok('op', 'POST', '/production/scans', report(row.id, step, 5), 201)
    expect(await earn(row.id, step)).toBe(false)
    expect(await entries()).toEqual([])
  })

  it('pays its own published rate, by the library operation; no rate: no pieces, and the add says so', async () => {
    await publishRates()
    const choices = await ok('lead', 'GET', `${base()}/choices`)
    expect(choices.operations.find((row: Json) => row.id === library.late.id).pays).toBe('OFF_STANDARD')
    const rated = await bundle()
    await ok('op', 'POST', '/production/scans', report(rated.id, step, 4), 201)
    await earn(rated.id, step)
    const paid = await entries()
    expect(paid).toEqual([expect.objectContaining({ kind: 'SCAN', pieces: 4, rateEntryId: fixRate })])
    expect(paid[0]!.amount).toBe(600)

    const added = await ok('lead', 'POST', base(), { operationId: library.late.id, reasonCode: 'MATERIAL_ISSUE' }, 201)
    expect(added.pays).toBe('OFF_STANDARD')
    const unrated = await bundle()
    await ok('op', 'POST', '/production/scans', report(unrated.id, added.workOrderOperationId, 3), 201)
    await earn(unrated.id, added.workOrderOperationId)
    expect(await entries()).toHaveLength(1)
    // The month's check tells it, and stops nothing.
    await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
      const period = (await periodOfMonth(client, companyA, today.slice(0, 7)))!
      expect((await factsOfPeriod(client, new PayFacts(client, new Date()), period)).scansWithoutRate).toBeGreaterThan(0)
    })
  })

  it('never pays a rate of another operation: the database holds it', async () => {
    const other = newId()
    await admin(`ALTER TABLE "PieceRateEntry" DISABLE TRIGGER USER`)
    await admin(`INSERT INTO "PieceRateEntry" (id, "tenantId", "siteId", "versionId", "operationId", basis, "ratePerPiece", "updatedAt") VALUES ($1, $2, $3, $4, $5, 'FIXED', 2, now())`, [other, T, siteA1, version, library.press.id])
    await admin(`ALTER TABLE "PieceRateEntry" ENABLE TRIGGER USER`)
    const scan = (await admin<{ id: string }>(`SELECT id FROM "OperationScan" WHERE "workOrderOperationId" = $1 AND kind = 'REPORT' LIMIT 1`, [step]))[0]!
    const period = (await admin<{ id: string }>(`SELECT id FROM "PayPeriod" WHERE "tenantId" = $1 LIMIT 1`, [T]))[0]!.id
    await expect(
      admin(
        `INSERT INTO "EarningsEntry" (id, "tenantId", "companyId", "siteId", "payPeriodId", "employeeId", "workDate", kind, "operationScanId", "rateEntryId", pieces, rate, amount, currency, "idempotencyKey")
         VALUES ($1, $2, $3, $4, $5, $6, $7::date, 'SCAN', $8, $9, 1, 2, 200, 'EUR', $10)`,
        [newId(), T, companyA, siteA1, period, employee(), today, scan.id, other, `t-${run}-other-rate`],
      ),
    ).rejects.toThrow()
  })
})

describe('two adds at once', () => {
  it('take turns: each its own place, none refused', async () => {
    const pair = [
      { id: newId(), code: `W2B82-RACE-A-${run}` },
      { id: newId(), code: `W2B82-RACE-B-${run}` },
    ]
    for (const row of pair) await admin(`INSERT INTO "Operation" (id, "tenantId", "companyId", code, name, "workCentreKind", "standardMinutes", status, "updatedAt") VALUES ($1, $2, $3, $4, 'Made-up race', 'SEWING', 1, 'ACTIVE', now())`, [row.id, T, companyA, row.code])
    const answers = await Promise.all(pair.map((row, index) => call(index === 0 ? 'lead' : 'manager', 'POST', base(), { operationId: row.id, reasonCode: 'CUSTOMER_CHANGE' })))
    expect(answers.map((answer) => answer.statusCode)).toEqual([201, 201])
    const seqs = answers.map((answer) => answer.json().seq as number)
    expect(new Set(seqs).size).toBe(2)
  })
})

describe('who approved a correction, in the office list of a work order\'s scans (asked by B-W2b-83)', () => {
  it('a team leader\'s id stays behind the PERFORMANCE gate like the worker; an office user\'s stays', async () => {
    // The pay part above opened the site's gate: closed first, so the read starts with it off.
    await admin(`UPDATE "PeopleLegalGate" SET "switchedOffAt" = now(), "switchedOffById" = $2, "switchOffReason" = 'The pay part of the test is over.', "updatedAt" = now() WHERE "tenantId" = $1 AND "siteId" = $3 AND purpose = 'PERFORMANCE' AND "switchedOffAt" IS NULL`, [T, actors.hr, siteA1])
    const row = await bundle()
    const reported = await ok('op', 'POST', '/production/scans', report(row.id, step, 10), 201)
    // A correction decided on the floor (B-W2b-83's path, not on main yet) and one decided in the office: written as the database
    // owner with the triggers held back, made up, for this read only.
    const correction = async (correctsId: string, approvedById: string, good: number) => {
      const id = newId()
      await h.db.admin.query(
        `BEGIN;
         SET LOCAL session_replication_role = replica;
         INSERT INTO "OperationScan" (id, "tenantId", "siteId", "workOrderId", "workOrderOperationId", "bundleId", kind, "correctsId", "goodQuantity", "scrapQuantity", "reworkQuantity", reason, "approvedById", "workerId", "stationId", "clientScanId", "serverTime", "createdById")
         VALUES ('${id}', '${T}', '${siteA1}', '${wo}', '${step}', '${row.id}', 'CORRECTION', '${correctsId}', ${good}, 0, 0, 'Made-up correction', '${approvedById}', '${operator}', '${sew1}', 'correction-${id}', now(), '${approvedById}');
         COMMIT`,
      )
      return id
    }
    const byLead = await correction(reported.scan.id, lead, 9)
    const byOffice = await correction(byLead, actors.manager, 8)
    const list = async () => (await ok('manager', 'GET', `/production/scans/work-orders/${wo}/scans?bundleId=${row.id}`)).scans as Json[]
    const of = (rows: Json[], id: string) => rows.find((entry) => entry.id === id)!
    const closed = await list()
    expect(of(closed, byLead)).toMatchObject({ approvedById: null, approvedByHidden: true, worker: null, workerHidden: true })
    expect(of(closed, byOffice)).toMatchObject({ approvedById: actors.manager, approvedByHidden: false })
    expect(JSON.stringify(closed)).not.toContain(lead)
    const off = await switchOnPerformance((sql, params) => h.db.admin.query(sql, params), { tenantId: T, companyId: companyA, siteId: siteA1, byId: actors.hr })
    try {
      const open = await list()
      expect(of(open, byLead)).toMatchObject({ approvedById: lead, approvedByHidden: false, worker: { id: operator } })
      expect(of(open, byOffice)).toMatchObject({ approvedById: actors.manager, approvedByHidden: false })
    } finally {
      await off()
    }
  })
})
