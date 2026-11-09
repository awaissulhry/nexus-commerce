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
 * Inspection triggers (B-W2b-101; QHS-010 plan assignment and triggers, QHS-011 inspection frequency) through the app's
 * real routes and the worker's real handler on a throwaway PostgreSQL 17 database from the migrations (the runtime login:
 * row-level security and the …_inspection_plans_w2b_guards triggers are real), tenant A from EVERY seed (B-W2b-76's three
 * rules, INC-LEATHER v1, INL-FIRST v1, SEED-IIN-0001 OPEN on SEED-LOT-LEA-01, the approved first piece of SEED-WO-0001 at
 * sewing). Made-up words only.
 *   - the ordered list with what each event can do; new rules, changes, switching off, the order, deleting, refusals;
 *   - goods received: an incoming inspection per lot, never a second OPEN one; a workshop's receipt with its customer's
 *     AQL profile;
 *   - scans: every Nth bundle, the first piece (held back once the run has gone on; opened while its bundle is alone,
 *     and then the database holds the run), what each rule did on its trail;
 *   - the preview of the last month; which plan the rules pick.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/quality/triggers`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'triggers-a'
const id = (key: string) => seedUuid(NS, key)
const firstId = (key: string) => `00000000${id(key).slice(8)}`
const A = {
  tenant: id('tenant'),
  companyA: id('company:A'),
  companyB: id('company:B'),
  siteA1: id('site:A1'),
  operator: id('worker:A1:operator'),
  workshop: id('party:P2'),
  incoming: id('inspection-plans:plan:INC-LEATHER'),
  inLine: id('inspection-plans:plan:INL-FIRST'),
  final: firstId('inspection-plans:plan:FIN-JACKET'),
  vIncoming1: id('inspection-plans:version:INC-LEATHER:1'),
  vInLine1: id('inspection-plans:version:INL-FIRST:1'),
  ruleReceipt: firstId('inspection-plans:trigger:receipt'),
  ruleBundle: id('inspection-plans:trigger:bundle'),
  ruleOperation: id('inspection-plans:trigger:operation'),
  workOrder: id('production:work-order:WO-0001'),
  opQc: id('production:WO-0001:operation:30'),
  opPack: id('production:WO-0001:operation:40'),
  bundles: [id('production:bundle:WO-0001:1'), id('production:bundle:WO-0001:2')] as const,
  workshopReceipt: firstId('subcontract:SC-0002:receipt:1'),
  profileStd: id('inspection-plans:aql:AQL-STD'),
}
let leatherLot = ''
let leatherItem = ''

let h: Harness
let app: FastifyInstance
const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const KEEP: Permission[] = ['quality.triggers.view', 'quality.triggers.manage', 'quality.inspections.view', 'quality.plans.view', 'quality.plans.manage']
const SESSIONS: Record<string, SessionContext> = {
  keeper: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(KEEP)] },
  viewer: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['quality.triggers.view'])] },
  companyB: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(KEEP, { companies: [A.companyB] })] },
  nobody: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['sites.view'])] },
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `triggers-${run}-${++keys}`
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
const rulesOf = async () => (await ok('keeper', 'GET', `/quality/inspection-triggers?companyId=${A.companyA}`)).rules as Json[]
const ruleOf = async (ruleId: string) => (await ok('keeper', 'GET', `/quality/inspection-triggers/${ruleId}`)).rule as Json

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
const handle = (event: EventEnvelope) => handler.handle(event, { caller: callerFor(h.database, systemContext(A.tenant, `trigger-${run}`)), attempt: 1 })
const scanEvent = (scanId: string, bundleId: string, operationId: string, eventId?: string) =>
  envelope('production.scan_recorded', { workOrderId: A.workOrder, number: 'SEED-WO-0001', bundleId, scanId, kind: 'REPORT', operationId, operationSeq: 30, correctsId: null, goodQuantity: 1, scrapQuantity: 0, reworkQuantity: 0, postedBy: 'FLOOR' }, eventId)

/** A bundle reported at an operation on the cutting tablet, as the seed writes it (the floor scope, its own server time). */
async function report(bundleId: string, workOrderOperationId: string, daysAgo: number): Promise<string> {
  const scanId = newId()
  const at = new Date(Date.now() - daysAgo * 24 * 3_600_000)
  await h.database.withScope({ audience: 'floor', tenantId: A.tenant, actorId: A.operator, siteId: A.siteA1 }, (client) =>
    client.$transaction((tx) =>
      tx.operationScan.create({
        data: { id: scanId, siteId: A.siteA1, workOrderId: A.workOrder, workOrderOperationId, bundleId, kind: 'REPORT', goodQuantity: 1, workerId: A.operator, deviceId: id('device:A1:cutting'), clientScanId: `trigger-${run}-${scanId}`, deviceTime: at, serverTime: at, createdById: A.operator },
        select: { id: true },
      }),
    ),
  )
  return scanId
}

beforeAll(async () => {
  h = await startHarness('quality_triggers')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, clock: h.clock, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  const lot = (await admin<{ lotId: string; itemId: string }>(`SELECT "lotId", "itemId" FROM "IncomingInspection" WHERE "tenantId" = $1 AND number = 'SEED-IIN-0001'`, [A.tenant]))[0]!
  leatherLot = lot.lotId
  leatherItem = lot.itemId
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 120_000)

describe('"When inspections are created": the ordered rules (QHS-010)', () => {
  it('the company\'s rules in order, in words, with what each event can do now', async () => {
    const list = await ok('keeper', 'GET', `/quality/inspection-triggers?companyId=${A.companyA}`)
    expect(list.rules.map((rule: Json) => [rule.position, rule.event, rule.plan.code, rule.frequency, rule.frequencyValue, rule.recordKind, rule.active])).toEqual([
      [1, 'GOODS_RECEIPT', 'INC-LEATHER', 'EVERY_LOT', null, 'INCOMING', true],
      [2, 'BUNDLE_SCAN', 'INL-FIRST', 'FIRST_PIECE', null, 'FIRST_PIECE', true],
      [3, 'OPERATION_FINISHED', 'INL-FIRST', 'PERCENT_OF_OPERATIONS', 10, 'ROVING', true],
    ])
    const [receipt, , share] = list.rules
    expect(receipt.appliesTo).toEqual([expect.objectContaining({ kind: 'MATERIAL', value: leatherItem, kindWords: { it: 'Materiale', en: 'Material' } })])
    expect(receipt.plan).toMatchObject({ id: A.incoming, stage: 'INCOMING', approved: { id: A.vIncoming1, number: 1 } })
    expect(share.frequencyWords).toEqual({ it: '10% delle operazioni', en: '10% of operations' })
    expect(share.eventWords).toEqual({ it: 'Operazione finita', en: 'Operation finished' })
    expect(receipt.opened).toEqual({ last30Days: 0, lastAt: null })
    // B-W2b-213: packing opens a final inspection now; a return is still held.
    const packing = list.events.find((entry: Json) => entry.event === 'PACKING')
    expect(packing).toMatchObject({ available: true, held: null, stages: ['FINAL'] })
    expect(list.events.find((entry: Json) => entry.event === 'RETURN_RECEIVED')).toMatchObject({ available: false, stages: [] })
    expect(list.events.find((entry: Json) => entry.event === 'GOODS_RECEIPT')).toMatchObject({ available: true, stages: ['INCOMING'], frequencies: [{ frequency: 'EVERY_LOT', words: { it: 'Ogni lotto', en: 'Every lot' }, takesValue: false }] })
    expect(list.canManage).toBe(true)
    expect((await ok('viewer', 'GET', '/quality/inspection-triggers')).canManage).toBe(false)
    // Another company's keeper sees none of company A's rules; a person without the right is refused; a rule of company A is not said to exist.
    expect((await ok('companyB', 'GET', '/quality/inspection-triggers')).rules).toEqual([])
    expect((await refused('companyB', 'GET', `/quality/inspection-triggers/${A.ruleReceipt}`, undefined, 404)).code).toBe('not_found')
    expect((await refused('nobody', 'GET', '/quality/inspection-triggers', undefined, 403)).code).toBe('forbidden')
  })

  it('refuses in words: an event that cannot open anything yet, a plan of another stage, a chip the event never knows, a frequency', async () => {
    const base = { companyId: A.companyA, planId: A.inLine, event: 'BUNDLE_SCAN', frequency: 'EVERY_NTH_BUNDLE', frequencyValue: 5 }
    const returned = await refused('keeper', 'POST', '/quality/inspection-triggers', { ...base, event: 'RETURN_RECEIVED', planId: A.final, frequency: 'EVERY_LOT', frequencyValue: null }, 400)
    expect(returned.message).toBe('Not yet: a return has no inspection record; its grading stays on the return.')
    expect(paths(returned)).toEqual(['body/event'])
    // B-W2b-213: packing names a final plan; due within 1 to 720 hours.
    expect(paths(await refused('keeper', 'POST', '/quality/inspection-triggers', { ...base, event: 'PACKING', frequency: 'EVERY_LOT', frequencyValue: null }, 400))).toEqual(['body/planId'])
    expect(paths(await refused('keeper', 'POST', '/quality/inspection-triggers', { ...base, dueHours: 0 }, 400))).toEqual(['body/dueHours'])
    expect(paths(await refused('keeper', 'POST', '/quality/inspection-triggers', { ...base, planId: A.incoming }, 400))).toEqual(['body/planId'])
    const chip = await refused('keeper', 'POST', '/quality/inspection-triggers', { ...base, appliesTo: [{ kind: 'MATERIAL', value: leatherItem }] }, 400)
    expect(chip.message).toBe('Bundle scanned at an operation does not know the material: this chip would never fit.')
    expect(paths(await refused('keeper', 'POST', '/quality/inspection-triggers', { ...base, frequencyValue: 0 }, 400))).toEqual(['body/frequencyValue'])
    expect(paths(await refused('keeper', 'POST', '/quality/inspection-triggers', { ...base, appliesTo: [{ kind: 'STYLE', value: newId() }] }, 400))).toEqual(['body/appliesTo/0/value'])
    expect(paths(await refused('keeper', 'POST', '/quality/inspection-triggers', { ...base, companyId: A.companyB }, 400))).toEqual(['body/planId'])
    expect((await refused('viewer', 'POST', '/quality/inspection-triggers', base, 403)).code).toBe('forbidden')
    // A plan with no approved version: refused active (409), kept switched off.
    const draftOnly = await ok('keeper', 'POST', '/quality/plans', { companyId: A.companyA, code: 'EOL-TRIGGER', stage: 'END_OF_LINE', name: 'End of line, made up' }, 201)
    const noVersion = await refused('keeper', 'POST', '/quality/inspection-triggers', { ...base, planId: draftOnly.plan.id, event: 'OPERATION_FINISHED' }, 409)
    expect(noVersion.issues[0]).toEqual({ path: 'refusal/NO_APPROVED_VERSION', message: 'Plan EOL-TRIGGER has no approved version: a rule opens inspections on the approved version. Approve one first, or save the rule switched off.' })
    const off = await ok('keeper', 'POST', '/quality/inspection-triggers', { ...base, planId: draftOnly.plan.id, event: 'OPERATION_FINISHED', active: false }, 201)
    expect(off.rule).toMatchObject({ active: false, position: 4, recordKind: 'END_OF_LINE', plan: { code: 'EOL-TRIGGER', approved: null } })
    expect(paths(await refused('keeper', 'PATCH', `/quality/inspection-triggers/${off.rule.id}`, { version: off.rule.version, active: true }, 409))).toEqual(['refusal/NO_APPROVED_VERSION'])
    const deleted = await ok('keeper', 'DELETE', `/quality/inspection-triggers/${off.rule.id}?version=${off.rule.version}`)
    expect(deleted.deleted).toEqual({ id: off.rule.id, event: 'OPERATION_FINISHED', planCode: 'EOL-TRIGGER' })
    expect(deleted.rules.map((rule: Json) => rule.id)).toEqual([A.ruleReceipt, A.ruleBundle, A.ruleOperation])
  })

  it('a new rule at a place moves the others down; a change, a switch-off, the order, a stale version', async () => {
    const made = await ok('keeper', 'POST', '/quality/inspection-triggers', { companyId: A.companyA, event: 'OPERATION_FINISHED', planId: A.inLine, frequency: 'EVERY_NTH_BUNDLE', frequencyValue: 2, position: 2 }, 201)
    expect(made.rule).toMatchObject({ position: 2, sortOrder: 20, recordKind: 'ROVING', frequencyWords: { it: 'Un pacco ogni 2', en: 'Every 2nd bundle' } })
    expect(made.rules.map((rule: Json) => [rule.id, rule.sortOrder])).toEqual([[A.ruleReceipt, 10], [made.rule.id, 20], [A.ruleBundle, 30], [A.ruleOperation, 40]])
    // The frequency left out: the plan's own (INL-FIRST v1 says first piece).
    const fromPlan = await ok('keeper', 'POST', '/quality/inspection-triggers', { companyId: A.companyA, event: 'BUNDLE_SCAN', planId: A.inLine, active: false }, 201)
    expect(fromPlan.rule).toMatchObject({ frequency: 'FIRST_PIECE', frequencyValue: null, position: 5, active: false })
    const edited = await ok('keeper', 'PATCH', `/quality/inspection-triggers/${fromPlan.rule.id}`, { version: fromPlan.rule.version, frequency: 'EVERY_NTH_BUNDLE', frequencyValue: 3 })
    expect(edited.rule).toMatchObject({ frequency: 'EVERY_NTH_BUNDLE', frequencyValue: 3, recordKind: 'ROVING', version: fromPlan.rule.version + 1 })
    // The version read before the change: 409, nothing written.
    await refused('keeper', 'PATCH', `/quality/inspection-triggers/${fromPlan.rule.id}`, { version: fromPlan.rule.version, active: true }, 409)
    const order = [fromPlan.rule.id, A.ruleReceipt, made.rule.id, A.ruleBundle, A.ruleOperation]
    expect(paths(await refused('keeper', 'POST', '/quality/inspection-triggers/order', { companyId: A.companyA, order: order.slice(1) }, 400))).toEqual(['body/order'])
    const reordered = await ok('keeper', 'POST', '/quality/inspection-triggers/order', { companyId: A.companyA, order })
    expect(reordered.rules.map((rule: Json) => [rule.id, rule.position])).toEqual(order.map((ruleId, index) => [ruleId, index + 1]))
    await ok('keeper', 'DELETE', `/quality/inspection-triggers/${fromPlan.rule.id}?version=${edited.rule.version}`)
    // The seeded rules are switched off for the scans below: the made rule and the tests' own decide alone.
    for (const ruleId of [A.ruleBundle, A.ruleOperation]) {
      const rule = await ruleOf(ruleId)
      await ok('keeper', 'PATCH', `/quality/inspection-triggers/${ruleId}`, { version: rule.version, active: false })
    }
    expect((await rulesOf()).map((rule) => [rule.id, rule.position, rule.active])).toEqual([[A.ruleReceipt, 1, true], [made.rule.id, 2, true], [A.ruleBundle, 3, false], [A.ruleOperation, 4, false]])
    const changes = (await events('inspection_trigger.changed')).map((payload) => payload.change)
    expect(changes).toEqual(['CREATED', 'DELETED', 'CREATED', 'CREATED', 'EDITED', 'REORDERED', 'DELETED', 'SWITCHED_OFF', 'SWITCHED_OFF'])
    const audit = await admin<{ action: string }>(`SELECT action FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'InspectionTrigger' AND "recordId" = $2 ORDER BY at, id`, [A.tenant, A.ruleBundle])
    expect(audit.map((row) => row.action)).toContain('quality.moveInspectionTrigger')
  })
})

describe('goods received: an incoming inspection per lot, never a second OPEN one', () => {
  it('a lot with an OPEN inspection: nothing, said on the rule; once it is cancelled, the rule opens one on its plan and profile', async () => {
    await handle(envelope('inventory.receipt_posted', { receiptId: newId(), number: 'GR-TEST', purchaseOrderId: null, purchaseOrderStatus: null, lotIds: [leatherLot], quarantinedLotIds: [], hides: 1, moveIds: [newId()], postedBy: 'OFFICE' }))
    const skipped = await trail(A.ruleReceipt)
    expect(skipped.map((row) => [row.action, row.after.reason])).toEqual([['quality.inspectionSkippedByRule', 'ALREADY_OPEN']])
    expect(skipped[0]!.after.words.en).toMatch(/^Lot SEED-LOT-LEA-01 \(.+\): a check of the same kind is open already; a second one is never opened\.$/)
    await admin(`UPDATE "IncomingInspection" SET status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'Made up: opened by mistake.', version = version + 1 WHERE "tenantId" = $1 AND number = 'SEED-IIN-0001'`, [A.tenant])
    const posted = envelope('inventory.receipt_posted', { receiptId: newId(), number: 'GR-TEST', purchaseOrderId: null, purchaseOrderStatus: null, lotIds: [leatherLot], quarantinedLotIds: [], hides: 1, moveIds: [newId()], postedBy: 'OFFICE' })
    await handle(posted)
    await handle(posted) // the job again: its receipt answers
    const opened = await admin<Json>(`SELECT * FROM "IncomingInspection" WHERE "tenantId" = $1 AND "lotId" = $2 AND status = 'OPEN'`, [A.tenant, leatherLot])
    expect(opened).toHaveLength(1)
    const [row] = opened
    expect(row!.number).toMatch(/^IIN-\d{4}-\d{4}$/)
    expect(row).toMatchObject({ planVersionId: A.vIncoming1, itemId: leatherItem, uom: 'HIDE', inspectionLevel: 'II', inspectorWorkerId: null, inspectorUserId: null })
    expect(Number(row!.sampleSize)).toBeGreaterThanOrEqual(1)
    expect(Number(row!.sampleSize)).toBeLessThanOrEqual(Number(row!.lotSize))
    expect(row!.aqlProfileId).not.toBeNull()
    expect((await admin<{ code: string }>(`SELECT code FROM "AqlProfile" WHERE id = $1`, [row!.aqlProfileId]))[0]!.code).toBe('AQL-STD')
    const told = (await events('inspection_trigger.inspection_opened')).filter((payload) => payload.recordId === row!.id)
    expect(told).toEqual([{ triggerId: A.ruleReceipt, event: 'GOODS_RECEIPT', recordType: 'IncomingInspection', recordId: row!.id, kind: 'INCOMING', inspectionNumber: row!.number, planId: A.incoming, planVersionId: A.vIncoming1, lotId: leatherLot, workOrderId: null, bundleId: null }])
    // Another receipt of the same lot while it is OPEN: nothing.
    await handle(envelope('inventory.receipt_posted', { receiptId: newId(), number: 'GR-TEST', purchaseOrderId: null, purchaseOrderStatus: null, lotIds: [leatherLot], quarantinedLotIds: [], hides: 1, moveIds: [newId()], postedBy: 'OFFICE' }))
    expect((await admin(`SELECT id FROM "IncomingInspection" WHERE "tenantId" = $1 AND "lotId" = $2 AND status = 'OPEN'`, [A.tenant, leatherLot]))).toHaveLength(1)
    expect((await trail(A.ruleReceipt)).map((entry) => entry.after.reason ?? entry.after.recordType)).toEqual(['ALREADY_OPEN', 'IncomingInspection', 'ALREADY_OPEN'])
    const rule = await ruleOf(A.ruleReceipt)
    expect(rule.opened.last30Days).toBe(1)
    expect(rule.skipped).toMatchObject({ last30Days: 2 })
    expect(rule.skipped.lastWords.en).toMatch(/a second one is never opened/)
    // The plan's usage counts the record (B-W2b-92's record read).
    expect((await ok('keeper', 'GET', `/quality/plans/${A.incoming}`)).versions[0].usedBy.incoming).toBe(3)
  })

  it("a workshop's receipt: the pieces back, sampled by the work order's customer's AQL profile", async () => {
    const rule = await ok('keeper', 'POST', '/quality/inspection-triggers', { companyId: A.companyA, event: 'GOODS_RECEIPT', planId: A.incoming, appliesTo: [{ kind: 'SUPPLIER', value: A.workshop }] }, 201)
    await handle(envelope('subcontract_order.received', { subcontractOrderId: newId(), number: 'SC-0002', status: 'PARTLY_RECEIVED', receiptId: A.workshopReceipt, good: 1, defective: 0, scrapped: 0, bundles: 1, returnedLines: 0 }))
    const [row] = await admin<Json>(`SELECT * FROM "IncomingInspection" WHERE "tenantId" = $1 AND "subcontractReceiptId" = $2`, [A.tenant, A.workshopReceipt])
    expect(row).toMatchObject({ workOrderId: A.workOrder, uom: 'PCS', status: 'OPEN', planVersionId: A.vIncoming1 })
    expect(row!.lotSize).toBe('1.0000')
    expect(row!.sampleSize).toBe(1)
    expect((await trail(rule.rule.id)).map((entry) => entry.after.recordType)).toEqual(['IncomingInspection'])
  })
})

describe('scans: every Nth bundle and the first piece (QHS-011)', () => {
  let qc: string[] = []
  it('every 2nd bundle at an operation opens a roving check on the 2nd; the 1st opens nothing; never two OPEN on one bundle', async () => {
    const madeId = (await rulesOf()).find((rule) => rule.frequency === 'EVERY_NTH_BUNDLE')!.id
    qc = [await report(A.bundles[0], A.opQc, 2), await report(A.bundles[1], A.opQc, 1)]
    await handle(scanEvent(qc[0]!, A.bundles[0], A.opQc))
    expect(await admin(`SELECT id FROM "InProcessCheck" WHERE "tenantId" = $1 AND "workOrderOperationId" = $2`, [A.tenant, A.opQc])).toEqual([])
    const second = scanEvent(qc[1]!, A.bundles[1], A.opQc)
    await handle(second)
    await handle(second)
    const checks = await admin<Json>(`SELECT * FROM "InProcessCheck" WHERE "tenantId" = $1 AND "workOrderOperationId" = $2`, [A.tenant, A.opQc])
    expect(checks.map((check) => [check.kind, check.status, check.bundleId, check.planVersionId, check.workOrderId])).toEqual([['ROVING', 'OPEN', A.bundles[1], A.vInLine1, A.workOrder]])
    await handle(scanEvent(qc[1]!, A.bundles[1], A.opQc))
    expect((await trail(madeId)).map((entry) => entry.after.reason ?? entry.after.recordType)).toEqual(['InProcessCheck', 'ALREADY_OPEN'])
  })

  it('the first piece: held back once the run has gone on; opened while its bundle is alone, and the database then holds the run', async () => {
    const first = await ok('keeper', 'POST', '/quality/inspection-triggers', { companyId: A.companyA, event: 'BUNDLE_SCAN', planId: A.inLine, frequency: 'FIRST_PIECE' }, 201)
    // At QC two bundles are scanned already: a hold now would stop work in hand.
    await handle(scanEvent(qc[0]!, A.bundles[0], A.opQc))
    const late = await trail(first.rule.id)
    expect(late.map((entry) => entry.after.reason)).toEqual(['FIRST_PIECE_LATE'])
    expect(late[0]!.after.words.en).toMatch(/^.+ · .+ · bundle SEED-BN-0001: the run had gone on \(2 bundles scanned at the operation\) before the rule could hold it; a first piece is checked before the run, so none was opened\.$/)
    // At sewing its first piece is approved already.
    const sewScan = firstId('production:scan:WO-0001:1')
    await handle(scanEvent(sewScan, A.bundles[0], id('production:WO-0001:operation:20')))
    expect((await trail(first.rule.id)).map((entry) => entry.after.reason)).toEqual(['FIRST_PIECE_LATE', 'FIRST_PIECE_DONE'])
    // At packing the first bundle is alone: the first piece opens, and the second bundle waits for it.
    const pack = await report(A.bundles[0], A.opPack, 0)
    await handle(scanEvent(pack, A.bundles[0], A.opPack))
    const [check] = await admin<Json>(`SELECT * FROM "InProcessCheck" WHERE "tenantId" = $1 AND "workOrderOperationId" = $2`, [A.tenant, A.opPack])
    expect(check).toMatchObject({ kind: 'FIRST_PIECE', status: 'OPEN', bundleId: A.bundles[0], planVersionId: A.vInLine1 })
    await expect(report(A.bundles[1], A.opPack, 0)).rejects.toThrow(/first piece/i)
  })
})

describe('the preview of the last month', () => {
  it('what a draft would have opened, at its place among the active rules', async () => {
    const draft = { companyId: A.companyA, event: 'OPERATION_FINISHED', planId: A.inLine, frequency: 'EVERY_NTH_BUNDLE', frequencyValue: 2 }
    // The tests' three reports (QC twice, packing once), and any seeded report of the last 30 days at another operation (each a 1st bundle there).
    const seeded = Number((await admin<{ n: string }>(`SELECT count(DISTINCT ("bundleId", "workOrderOperationId"))::text AS n FROM "OperationScan" WHERE "tenantId" = $1 AND kind = 'REPORT' AND "serverTime" >= now() - interval '30 days' AND "serverTime" < now() AND "workOrderOperationId" NOT IN ($2, $3)`, [A.tenant, A.opQc, A.opPack]))[0]!.n)
    const n = 3 + seeded
    // Last: the made rule (every 2nd bundle, earlier in the list) takes every report of the last days.
    const last = (await ok('viewer', 'POST', '/quality/inspection-triggers/preview', draft)).preview
    expect(last).toMatchObject({ event: 'OPERATION_FINISHED', considered: n, fits: n, earlier: n, opened: 0, truncated: false })
    expect(last.words.en).toBe(`This rule would have created 0 inspections in the last month (${last.from} – ${last.to}): ${n} of ${n} operations finished on a bundle fit it; ${n} went to an earlier rule.`)
    // First: it decides; the 2nd bundle at QC is its one.
    const firstPlace = (await ok('viewer', 'POST', '/quality/inspection-triggers/preview', { ...draft, position: 1 })).preview
    expect(firstPlace).toMatchObject({ considered: n, fits: n, earlier: 0, opened: 1 })
    expect(firstPlace.words.it).toBe(`Questa regola avrebbe creato 1 ispezione nell'ultimo mese (${firstPlace.from} – ${firstPlace.to}): ${n} su ${n} operazioni finite su un pacco le corrispondono.`)
    // A chip that fits nothing; a refusal; a person without the right.
    expect((await ok('viewer', 'POST', '/quality/inspection-triggers/preview', { ...draft, position: 1, appliesTo: [{ kind: 'CATEGORY', value: 'GLOVES' }] })).preview).toMatchObject({ fits: 0, opened: 0 })
    expect(paths(await refused('viewer', 'POST', '/quality/inspection-triggers/preview', { ...draft, event: 'RETURN_RECEIVED' }, 400))).toEqual(['body/event'])
    expect((await refused('nobody', 'POST', '/quality/inspection-triggers/preview', draft, 403)).code).toBe('forbidden')
  })
})

describe('which plan the rules pick (design qi-new)', () => {
  it('the first rule that fits, else the plan of the stage whose own chips fit, else none in words', async () => {
    const lot = await ok('keeper', 'GET', `/quality/inspection-triggers/pick?stage=INCOMING&lotId=${leatherLot}`)
    expect(lot.pick).toMatchObject({ source: 'RULE', rule: { id: A.ruleReceipt, position: 1, event: 'GOODS_RECEIPT' }, plan: { id: A.incoming, code: 'INC-LEATHER' }, version: { id: A.vIncoming1, number: 1 } })
    expect(lot.pick.words.en).toMatch(/^INC-LEATHER v1 applies because: material .+$/)
    const final = await ok('keeper', 'GET', `/quality/inspection-triggers/pick?stage=FINAL&workOrderId=${A.workOrder}`)
    expect(final.pick).toMatchObject({ source: 'PLAN', rule: null, plan: { code: 'FIN-JACKET' } })
    expect(final.pick.words).toEqual({ it: 'FIN-JACKET v1 si applica perché: categoria Giacche', en: 'FIN-JACKET v1 applies because: category Jackets' })
    const none = await ok('keeper', 'GET', `/quality/inspection-triggers/pick?stage=CUTTING&workOrderId=${A.workOrder}`)
    expect(none).toEqual({ pick: null, none: { it: "Nessuna regola e nessun piano della fase taglio si applica: aprite l'ispezione su un piano a scelta.", en: 'No rule or plan of the cutting stage fits: open the inspection on a plan of your choice.' } })
    expect(paths(await refused('keeper', 'GET', '/quality/inspection-triggers/pick?stage=INCOMING', undefined, 400))).toEqual(['query/lotId'])
    expect((await refused('companyB', 'GET', `/quality/inspection-triggers/pick?stage=INCOMING&lotId=${leatherLot}`, undefined, 404)).code).toBe('not_found')
  })
})
