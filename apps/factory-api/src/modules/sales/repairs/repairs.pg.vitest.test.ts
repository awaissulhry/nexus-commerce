import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedReturns, type ReturnsSeed } from '../../../../../../packages/factory-db/seed/returns'
import { seed as seedSchedule } from '../../../../../../packages/factory-db/seed/schedule'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * Repairs and alterations (B-W2a-57; SAL-383 repair order from a case, SAL-390 repair stages, LOG-116 repair round trip)
 * on the local stack: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, the
 * …_sales_w2a_guards repair triggers and the DDT's source check are real), the real app with test sessions, the files
 * platform on its FAKE R2. Tenant A from the factory-db seeds up to returns, reasons and the schedule: SEED-REP-0001
 * (RECEIVED, a PPE jacket SEED-JKT-02 BLK 50, from SEED-RMA-0002's line decided Repair, the customer's DDT SEED-C1-R-7),
 * SEED-CMP-0001 (a safety complaint about the same jacket), SH-0001's RED 52 (PPE, not returned yet), the revision's
 * routing at A1's work centres, the DDT series. The safety check is an e-signature: a quality inspector signs in through
 * the harness's real sign-in with two-factor (step-up). Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/repairs`.
 */

let h: Harness
let app: FastifyInstance
let seeded: ReturnsSeed

const NS = 'w2a57-repairs-a'
const idIn = (key: string) => seedUuid(NS, key)
const T = idIn('tenant')
const companyA = idIn('company:A')
const companyB = idIn('company:B')
const siteA = idIn('site:A1')
const P1 = idIn('party:P1')
const RED_LINE = idIn('production:sales-order:SO-0002:20')
const TODAY = businessDate(new Date())
const YEAR = TODAY.slice(0, 4)
const TENANT: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'A' }, { id: companyB, code: 'B' }] }

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let counter = 0
const key = (label = 'k'): string => `repairs-${label}-${++counter}-${newId()}`

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (permissions: Permission[], companies: Grant['companies'] = 'all', actorId = newId()): (() => SessionContext) => () => ({ audience: 'office', tenantId: T, actorId, grants: [grant(permissions, companies)] })
const REPAIRS: Permission[] = ['sales.repairs.view', 'sales.repairs.manage', 'sales.repairs.receive']
const RETURNS: Permission[] = ['sales.returns.view', 'sales.returns.manage', 'sales.returns.receive', 'sales.returns.inspect', 'sales.returns.decide']
const SESSIONS: Record<string, () => SessionContext> = {
  sales: office([...REPAIRS, ...RETURNS, 'threads.read', 'threads.post']),
  production: office(['sales.repairs.view', 'sales.repairs.manage', 'workorders.view', 'workorders.manage', 'workorders.release', 'workorders.complete']),
  warehouse: office(['sales.repairs.view', 'sales.repairs.receive', 'sales.repairs.ship', 'shipping.view', 'shipping.ddt.issue']),
  shipperOnly: office(['sales.repairs.view', 'sales.repairs.ship']),
  viewer: office(['sales.repairs.view']),
  companyB: office([...REPAIRS, 'sales.repairs.ship', 'shipping.ddt.issue'], [companyB]),
}

async function call(session: string, method: Method, url: string, body?: unknown, idempotencyKey = key(session)) {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': idempotencyKey }) }, ...(body === undefined ? {} : { payload: body as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(session: string, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(session, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}
async function refused(session: string, method: Method, url: string, body: unknown, status: number): Promise<Json> {
  const answer = await call(session, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body.error
}
const events = async (type: string, subject: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2 ORDER BY "occurredAt", id`, [type, subject])).map((row) => row.payload)
const recordOf = async (repairId: string, session = 'sales') => (await ok(session, 'GET', `/sales/repairs/${repairId}`)).repair
const steps = (repair: Json) => (repair.steps as Json[]).map((step) => [step.stage, step.state])
const held = (repair: Json, action: string) => (repair.actions as Json[]).find((entry) => entry.action === action)?.held ?? null
const DDT = { transportBy: 'SENDER', packages: 1, grossWeightKg: '1.8', appearance: 'Scatola di cartone' } as const
const PASSED = { seams: 'PASS', abrasionZones: 'PASS', closures: 'PASS', protectors: { result: 'PASS', replaced: false }, certificateCovers: true } as const

let inspector: { browser: Browser; secret: string }

beforeAll(async () => {
  h = await startHarness('sales_repairs')
  await seedCore({ db: h.database, namespace: NS })
  seeded = await seedReturns({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  await seedSchedule({ db: h.database, namespace: NS })
  // The system roles as the templates hold them now (sales.repairs.* for the quality inspector).
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  // Made-up legal data for the DDT (c.c. art. 2250), this year's DDT series with no last date, the FAKE file store's limits.
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA])
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'DDT', 'MAIN', $4, 'YEARLY', '{N}/{YYYY}', true) ON CONFLICT DO NOTHING`, [newId(), T, companyA, YEAR])
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'REPAIR', 'MAIN', $4, 'YEARLY', 'REP-{YYYY}-{N:4}', false) ON CONFLICT DO NOTHING`, [newId(), T, companyA, YEAR])
  await admin(`UPDATE "NumberSeries" SET "lastIssuedDate" = NULL WHERE "tenantId" = $1 AND kind = 'DDT'`, [T])
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE provider = 'R2'`)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
  const user = await addUser(h, TENANT, { email: 'qa.repairs@example.com', role: 'quality_inspector' })
  const browser = new Browser(h.app)
  const signIn = await browser.signIn(TENANT.slug, user.email, user.password)
  if (signIn.body.status !== 'signed_in') throw new Error(`sign-in: ${signIn.status} ${JSON.stringify(signIn.body)}`)
  inspector = { browser, secret: await enrolTotp(h, browser) }
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

async function inspectorCheck(repair: Json, checklist: unknown, status = 200, sign = true): Promise<Json> {
  if (sign) await stepUp(h, inspector.browser, inspector.secret)
  const answer = await inspector.browser.send('POST', `/sales/repairs/${repair.id}/safety-check`, { version: repair.version, checklist }, { headers: { 'idempotency-key': key('check') } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}

let fromRma: Json

describe('a repair order from a return line decided Repair (SAL-383)', () => {
  it('refuses a second repair for a garment that has one, and a line not decided Repair', async () => {
    const taken = await refused('sales', 'POST', '/sales/repairs', { returnLineId: seeded.inspectedLineId }, 409)
    expect(taken.message).toBe('line 10 of SEED-RMA-0002 brought back 1 garment: SEED-REP-0001 is made for it already.')
    // A new return of the RED 52 jacket (PPE), received and graded, not decided yet.
    const made = await ok('sales', 'POST', '/sales/returns', { companyId: companyA, partyId: P1, lines: [{ salesOrderLineId: RED_LINE, size: '52', quantity: 1, reasonCode: 'DEFECT', reasonNote: 'The elbow protector pocket tore open.' }] }, 201)
    const rma = made.return
    const received = await ok('sales', 'POST', `/sales/returns/${rma.id}/receipts`, { version: rma.version, parcels: 1, parcelCondition: 'INTACT', customerDdtNumber: 'P1-DDT-91', customerDdtDate: TODAY, lines: [{ lineId: rma.lines[0].id, quantity: 1 }] }, 201)
    const graded = await ok('sales', 'POST', `/sales/returns/${rma.id}/grades`, { version: received.return.version, lines: [{ lineId: rma.lines[0].id, grade: 'DAMAGED', cause: 'OUR_DEFECT', conditionNote: 'Elbow pocket seam open; protector intact.' }] })
    const early = await ok('sales', 'POST', '/sales/repairs/preview', { returnLineId: rma.lines[0].id })
    expect(early.ok).toBe(false)
    expect(early.problems).toEqual([{ path: 'body/returnLineId', message: `Decide line 10 of ${rma.number} first: a repair order is made for a line decided Repair.` }])
    const decided = await ok('sales', 'POST', `/sales/returns/${rma.id}/decisions`, { version: graded.return.version, lines: [{ lineId: rma.lines[0].id, disposition: 'REPAIR', goodsOutcome: 'REPAIR' }] })
    // B-W2b-16: closing now would leave the garment unrepaired: the record says so before the click, the close too.
    const warning = { code: 'REPAIR_WITHOUT_ORDER', path: 'repairOrder', lineIds: [rma.lines[0].id], seqs: [10], message: 'Line 10 is decided Repair and no repair order was made for the garment (make it from the line, or the garment stays here unrepaired).' }
    expect(decided.return.closeWarnings).toEqual([warning])
    // No stock move for a repair: the garment never entered stock.
    expect(decided.moves).toEqual([])
    fromRma = { rma, lineId: rma.lines[0].id }
  })

  it('makes it RECEIVED with the line’s garment and the customer’s DDT, numbered, with its first stage event', async () => {
    const preview = await ok('sales', 'POST', '/sales/repairs/preview', { returnLineId: fromRma.lineId })
    expect(preview).toMatchObject({ ok: true, problems: [], draft: { stage: 'RECEIVED', siteId: siteA, partyId: P1, size: '52', safetyCheckRequired: true, inboundDdt: { number: 'P1-DDT-91', date: TODAY }, problem: 'Elbow pocket seam open; protector intact.' } })
    const idem = key('create')
    const first = await call('sales', 'POST', '/sales/repairs', { returnLineId: fromRma.lineId }, idem)
    expect(first.status, JSON.stringify(first.body)).toBe(201)
    const repair = first.body.repair
    expect(repair).toMatchObject({
      number: `REP-${YEAR}-0001`,
      kind: 'REPAIR',
      stage: 'RECEIVED',
      site: { code: 'A1' },
      garment: { size: '52', style: { code: 'SEED-JKT-02', ppeCategory: expect.not.stringMatching(/^NOT_PPE$/) }, colourway: { code: 'RED' } },
      source: { returnLine: { id: fromRma.lineId, seq: 10, returnNumber: fromRma.rma.number }, complaint: null },
      inboundDdt: { number: 'P1-DDT-91', date: TODAY },
      safety: { required: true, state: 'NOT_CHECKED' },
      version: 1,
    })
    expect(repair.stages).toMatchObject([{ from: null, to: 'RECEIVED', note: `Made from line 10 of ${fromRma.rma.number}.` }])
    expect(steps(repair)[0]).toEqual(['RECEIVED', 'CURRENT'])
    expect(held(repair, 'startRepair')).toBe(`Make the repair work order of ${repair.number} first and release it: the repair is done on it (Work › Make repair work order).`)
    // The same key answers the same repair; another one for the line is refused.
    expect((await call('sales', 'POST', '/sales/repairs', { returnLineId: fromRma.lineId }, idem)).body.repair.id).toBe(repair.id)
    expect((await refused('sales', 'POST', '/sales/repairs', { returnLineId: fromRma.lineId }, 409)).message).toContain(`${repair.number} is made for it already.`)
    expect(await events('repair.created', repair.id)).toEqual([{ repairId: repair.id, number: repair.number, partyId: P1, kind: 'REPAIR', stage: 'RECEIVED', returnLineId: fromRma.lineId, complaintId: null, safetyCheckRequired: true }])
    expect(await admin(`SELECT action FROM "AuditLog" WHERE "recordId" = $1`, [repair.id])).toEqual([{ action: 'repairs.create' }])
    // B-W2b-16: with its repair order made, closing the return leaves nothing behind.
    expect((await ok('sales', 'GET', `/sales/returns/${fromRma.rma.id}`)).return.closeWarnings).toEqual([])
    expect(repair).toMatchObject({ earlierWorkOrders: [], reworkRound: false })
    fromRma.repair = repair
  })

  it('is reached only within the caller’s companies, and made only with the manage right', async () => {
    expect((await refused('companyB', 'GET', `/sales/repairs/${fromRma.repair.id}`, undefined, 404)).code).toBe('not_found')
    expect((await refused('companyB', 'POST', '/sales/repairs/preview', { returnLineId: fromRma.lineId }, 404)).message).toBe('Return line not found.')
    expect((await refused('viewer', 'POST', '/sales/repairs', { companyId: companyA, partyId: P1, problem: 'x' }, 403)).code).toBe('forbidden')
    expect((await ok('companyB', 'GET', '/sales/repairs?view=all')).repairs).toEqual([])
  })
})

describe('from a complaint, or by hand: waiting for the garment, its arrival, the way back unrepaired (SAL-383, LOG-116)', () => {
  let byComplaint: Json

  it('waits for the garment named by the complaint, then receives it with the customer’s DDT', async () => {
    const made = await ok('sales', 'POST', '/sales/repairs', { complaintId: seeded.complaintId, kind: 'REPAIR' }, 201)
    byComplaint = made.repair
    expect(byComplaint).toMatchObject({ stage: 'AWAITING_GOODS', receivedAt: null, garment: { size: '50', style: { code: 'SEED-JKT-02' } }, source: { complaint: { number: 'SEED-CMP-0001' } }, safety: { required: true } })
    expect(byComplaint.problem).toContain('left shoulder seam')
    expect(steps(byComplaint).every(([, state]) => state === 'WAITING')).toBe(true)
    expect((await refused('sales', 'POST', `/sales/repairs/${byComplaint.id}/stage`, { version: byComplaint.version, to: 'ESTIMATED', note: 'x' }, 409)).message).toBe(`Repair ${byComplaint.number} is waiting for the garment: it cannot be estimated from there (it goes on to received or cancelled).`)
    const received = await ok('warehouse', 'POST', `/sales/repairs/${byComplaint.id}/receive`, { version: byComplaint.version, inboundDdtNumber: 'P1-DDT-95', inboundDdtDate: TODAY })
    expect(received.warnings).toEqual([])
    expect(received.repair).toMatchObject({ stage: 'RECEIVED', inboundDdt: { number: 'P1-DDT-95', date: TODAY }, version: 2 })
    expect(received.repair.stages.map((row: Json) => [row.from, row.to])).toEqual([[null, 'AWAITING_GOODS'], ['AWAITING_GOODS', 'RECEIVED']])
    expect((await refused('warehouse', 'POST', `/sales/repairs/${byComplaint.id}/receive`, { version: 2 }, 409)).message).toBe(`The garment of repair ${byComplaint.number} is here already (received).`)
    byComplaint = received.repair
  })

  it('goes back unrepaired only with why and its DDT; it is not cancelled while the garment is here', async () => {
    expect((await refused('sales', 'POST', `/sales/repairs/${byComplaint.id}/cancel`, { version: byComplaint.version, reason: 'The customer withdrew it.' }, 409)).message).toBe(`The garment of repair ${byComplaint.number} is here: send it back unrepaired instead of cancelling.`)
    expect((await refused('warehouse', 'POST', `/sales/repairs/${byComplaint.id}/ship`, { version: byComplaint.version, ddt: DDT }, 400)).issues).toEqual([{ path: 'body/note', message: 'Say why the garment goes back unrepaired (the estimate was declined, it cannot be repaired).' }])
    expect((await refused('warehouse', 'POST', `/sales/repairs/${byComplaint.id}/ship`, { version: byComplaint.version, note: 'Declined.' }, 400)).issues.map((issue: Json) => issue.path)).toEqual(['body/ddt'])
    expect((await refused('shipperOnly', 'POST', `/sales/repairs/${byComplaint.id}/ship`, { version: byComplaint.version, note: 'Declined.', ddt: DDT }, 403)).message).toContain('shipping.ddt.issue')
    const shipped = await ok('warehouse', 'POST', `/sales/repairs/${byComplaint.id}/ship`, { version: byComplaint.version, note: 'The customer declined the repair.', ddt: { ...DDT, reason: 'RETURN_FROM_WORK' } })
    expect(shipped.repair).toMatchObject({ stage: 'SHIPPED', status: 'Shipped back unrepaired', repairedAt: null, ddts: [{ number: shipped.ddt.number, reason: 'RETURN_FROM_WORK', live: true }] })
    expect(shipped.ddt).toMatchObject({ reason: 'RETURN_FROM_WORK', issuedNow: true, pdfProblem: null })
    expect(shipped.ddt.file).toMatchObject({ status: 'AVAILABLE' })
    expect(shipped.warnings).toEqual([{ path: 'safety', message: 'A protective garment goes back unrepaired and unchecked: tell the customer in writing that it may no longer protect.' }])
    expect(steps(shipped.repair)).toEqual([['RECEIVED', 'DONE'], ['ESTIMATED', 'SKIPPED'], ['APPROVED', 'SKIPPED'], ['IN_REPAIR', 'SKIPPED'], ['REPAIRED', 'SKIPPED'], ['SHIPPED', 'CURRENT']])
    const [ddt] = await admin(`SELECT "sourceType", "sourceId", reason::text, "shipmentId", "documentRefs" FROM "Ddt" WHERE id = $1`, [shipped.ddt.id])
    expect(ddt).toMatchObject({ sourceType: 'RepairOrder', sourceId: byComplaint.id, reason: 'RETURN_FROM_WORK', shipmentId: null, documentRefs: [{ kind: 'REPAIR_ORDER', number: byComplaint.number }, { kind: 'DDT', number: 'P1-DDT-95' }] })
    expect((await events('repair.stage_changed', byComplaint.id)).at(-1)).toEqual({ repairId: byComplaint.id, number: byComplaint.number, from: 'RECEIVED', to: 'SHIPPED', workOrderId: null, ddtId: shipped.ddt.id })
    expect((await refused('sales', 'PATCH', `/sales/repairs/${byComplaint.id}`, { version: shipped.repair.version, problem: 'x' }, 409)).message).toBe(`Repair ${byComplaint.number} is shipped back: it changes no more.`)
  })

  it('by hand: an unknown serial counts as a protective garment, one open repair per serial, cancelled before the garment arrives', async () => {
    expect((await refused('sales', 'POST', '/sales/repairs', { partyId: P1, problem: 'Zip stuck.' }, 400)).issues).toEqual([{ path: 'body/companyId', message: 'Name the company the garment is repaired for (or make it from a return line or a complaint).' }])
    const made = await ok('sales', 'POST', '/sales/repairs', { companyId: companyA, partyId: P1, kind: 'ALTERATION', serial: 'NO-SUCH-SERIAL-1', problem: 'Shorten both sleeves by 2 cm.' }, 201)
    expect(made.repair).toMatchObject({ stage: 'AWAITING_GOODS', kind: 'ALTERATION', site: { code: 'A1' }, garment: { serial: 'NO-SUCH-SERIAL-1', style: null, found: null }, safety: { required: true } })
    expect(made.warnings.map((warning: Json) => warning.path)).toEqual(['body/serial', 'body/styleId'])
    expect((await refused('sales', 'POST', '/sales/repairs', { companyId: companyA, partyId: P1, serial: 'NO-SUCH-SERIAL-1', problem: 'Again.' }, 409)).message).toBe(`Repair ${made.repair.number} is open for serial NO-SUCH-SERIAL-1 (waiting for the garment): one repair at a time per garment.`)
    // The style named: the safety rule follows it.
    const styleId = (await admin<{ id: string }>(`SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-02'`, [T]))[0]!.id
    const changed = await ok('sales', 'PATCH', `/sales/repairs/${made.repair.id}`, { version: made.repair.version, styleId, size: '50' })
    expect(changed.repair).toMatchObject({ garment: { style: { code: 'SEED-JKT-02' }, size: '50' }, safety: { required: true }, version: 2 })
    expect((await events('repair.changed', made.repair.id))[0]).toMatchObject({ fields: ['styleId', 'size'] })
    const cancelled = await ok('sales', 'POST', `/sales/repairs/${made.repair.id}/cancel`, { version: 2, reason: 'The customer had it done elsewhere.' })
    expect(cancelled.repair).toMatchObject({ stage: 'CANCELLED', cancelReason: 'The customer had it done elsewhere.' })
    expect(cancelled.warnings).toEqual([])
    // The serial is free again.
    await ok('sales', 'POST', '/sales/repairs', { companyId: companyA, partyId: P1, serial: 'NO-SUCH-SERIAL-1', problem: 'Shorten both sleeves by 2 cm.' }, 201)
  })
})

describe('the stages through the repair work order (SAL-390, MES-019)', () => {
  let repair: Json
  let workOrderId: string

  it('estimated and approved with words; in repair only once the repair work order is released', async () => {
    repair = await recordOf(seeded.repairId)
    expect(repair).toMatchObject({ number: 'SEED-REP-0001', stage: 'RECEIVED', safety: { required: true } })
    expect((await refused('sales', 'POST', `/sales/repairs/${repair.id}/stage`, { version: repair.version, to: 'ESTIMATED' }, 400)).issues).toEqual([{ path: 'body/note', message: 'Say what was estimated (the parts and work, and what the customer was told): the estimate sheet comes later.' }])
    repair = (await ok('sales', 'POST', `/sales/repairs/${repair.id}/stage`, { version: repair.version, to: 'ESTIMATED', note: 'Re-sew the shoulder seam, 40 minutes; told by phone.' })).repair
    repair = (await ok('sales', 'POST', `/sales/repairs/${repair.id}/stage`, { version: repair.version, to: 'APPROVED', note: 'Approved by e-mail.' })).repair
    expect(repair.stage).toBe('APPROVED')
    expect((await refused('sales', 'POST', `/sales/repairs/${repair.id}/stage`, { version: repair.version, to: 'IN_REPAIR' }, 409)).message).toContain('Make the repair work order of SEED-REP-0001 first')
    const { workOrder } = await ok('production', 'POST', '/production/work-orders/repairs', { repairOrderId: repair.id, version: repair.version, routingSeqs: [20] }, 201)
    workOrderId = workOrder.id
    repair = await recordOf(repair.id)
    expect(repair.workOrder).toEqual({ id: workOrderId, number: workOrder.number, status: 'DRAFT' })
    expect((await refused('production', 'POST', `/sales/repairs/${repair.id}/stage`, { version: repair.version, to: 'IN_REPAIR' }, 409)).message).toBe(`Release repair work order ${workOrder.number} first: the floor works only on a released work order.`)
    await ok('production', 'POST', `/production/work-orders/${workOrderId}/release`, {})
    repair = (await ok('production', 'POST', `/sales/repairs/${repair.id}/stage`, { version: repair.version, to: 'IN_REPAIR' })).repair
    expect(repair.stage).toBe('IN_REPAIR')
    // A stale screen is refused on the version.
    expect((await refused('production', 'POST', `/sales/repairs/${repair.id}/stage`, { version: repair.version - 1, to: 'REPAIRED' }, 409)).code).toBe('conflict')
  })

  it('repaired once its work order is completed', async () => {
    const number = repair.workOrder.number
    expect((await refused('production', 'POST', `/sales/repairs/${repair.id}/stage`, { version: repair.version, to: 'REPAIRED' }, 409)).message).toBe(`Repair work order ${number} is released: complete it first (the repair is done when its work order is).`)
    await ok('production', 'POST', `/production/work-orders/${workOrderId}/start`, {})
    await ok('production', 'POST', `/production/work-orders/${workOrderId}/complete`, {})
    repair = (await ok('production', 'POST', `/sales/repairs/${repair.id}/stage`, { version: repair.version, to: 'REPAIRED' })).repair
    expect(repair).toMatchObject({ stage: 'REPAIRED', status: 'Repaired: waiting for its safety check', safety: { state: 'NOT_CHECKED' }, workOrder: { status: 'COMPLETED' } })
    expect(repair.repairedAt).toEqual(expect.any(String))
    expect(steps(repair)).toEqual([['RECEIVED', 'DONE'], ['ESTIMATED', 'DONE'], ['APPROVED', 'DONE'], ['IN_REPAIR', 'DONE'], ['REPAIRED', 'CURRENT'], ['SHIPPED', 'WAITING']])
    expect(repair.stages.map((row: Json) => row.to)).toEqual(['RECEIVED', 'ESTIMATED', 'APPROVED', 'IN_REPAIR', 'REPAIRED'])
    const rows = await admin<{ fromStage: string | null; stage: string; repairVersion: number }>(`SELECT "fromStage"::text, stage::text, "repairVersion" FROM "RepairStageEvent" WHERE "repairId" = $1 ORDER BY "repairVersion"`, [repair.id])
    expect(rows.map((row) => row.repairVersion)).toEqual([...rows.map((row) => row.repairVersion)].sort((a, b) => a - b))
    expect(rows.at(-1)).toMatchObject({ fromStage: 'IN_REPAIR', stage: 'REPAIRED', repairVersion: repair.version })
  })

  it('a repaired protective garment goes back only after a passed safety check made after the repair', async () => {
    expect((await refused('warehouse', 'POST', `/sales/repairs/${repair.id}/ship`, { version: repair.version, ddt: DDT }, 409)).message).toBe('Repair SEED-REP-0001 is a protective garment: it goes back only after a passed safety check made after the repair (it is not checked yet).')
    // The database holds the same rule for every login, the owner included.
    await expect(admin(`UPDATE "RepairOrder" SET stage = 'SHIPPED', "shippedAt" = now() WHERE id = $1`, [repair.id])).rejects.toThrow(/goes back only after a passed safety check/)
    // A signing act: the inspector's session without a fresh step-up is refused (the last one, at the two-factor set-up, is
    // more than five minutes old).
    h.clock.advance(6 * 60_000)
    expect((await inspectorCheck(repair, PASSED, 403, false)).error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    const incomplete = await inspectorCheck(repair, { ...PASSED, protectors: { result: 'PASS', replaced: true, level: '3' } }, 400, false)
    expect(incomplete.error.issues.map((issue: Json) => issue.path)).toEqual(['body/checklist/protectors/lot', 'body/checklist/protectors/level'])
    const failed = await inspectorCheck(repair, { ...PASSED, seams: 'FAIL', note: 'The new seam pulls at the shoulder.' })
    expect(failed).toMatchObject({ result: 'FAIL', failures: ['the seams'], repair: { safety: { state: 'FAILED', result: 'FAIL', checklist: { seams: 'FAIL', note: 'The new seam pulls at the shoulder.' } } } })
    expect(await events('repair.safety_checked', repair.id)).toEqual([{ repairId: repair.id, number: 'SEED-REP-0001', result: 'FAIL' }])
    repair = failed.repair
    expect((await refused('warehouse', 'POST', `/sales/repairs/${repair.id}/ship`, { version: repair.version, ddt: DDT }, 409)).message).toContain('its last check failed')
  })

  it('back into repair: the check is made again after the next repair, then the garment goes back with its DDT', async () => {
    expect((await refused('production', 'POST', `/sales/repairs/${repair.id}/stage`, { version: repair.version, to: 'IN_REPAIR' }, 400)).issues[0].message).toContain('what still needs doing')
    expect(held(repair, 'makeWorkOrder')).toBe(`Repair work order ${repair.workOrder.number} is completed: one live work order per repair.`)
    repair = (await ok('production', 'POST', `/sales/repairs/${repair.id}/stage`, { version: repair.version, to: 'IN_REPAIR', note: 'Open the seam and sew it again.' })).repair
    expect(repair).toMatchObject({ stage: 'IN_REPAIR', repairedAt: null, reworkRound: true })
    expect(steps(repair).slice(3)).toEqual([['IN_REPAIR', 'CURRENT'], ['REPAIRED', 'WAITING'], ['SHIPPED', 'WAITING']])
    // B-W2b-16: the rework after the failed check gets its own work order once the first one is done.
    const first = { id: workOrderId, number: repair.workOrder.number, status: 'COMPLETED' }
    expect(held(repair, 'makeWorkOrder')).toBeNull()
    expect((await ok('production', 'GET', `/production/work-orders/repair-options?repairOrderId=${repair.id}`)).blockers).toEqual([])
    const { workOrder: rework } = await ok('production', 'POST', '/production/work-orders/repairs', { repairOrderId: repair.id, version: repair.version, routingSeqs: [20] }, 201)
    expect(rework.id).not.toBe(workOrderId)
    repair = await recordOf(repair.id)
    expect(repair).toMatchObject({ workOrder: { id: rework.id, status: 'DRAFT' }, earlierWorkOrders: [first] })
    expect(held(repair, 'makeWorkOrder')).toBe(`Repair work order ${rework.number} is draft: one live work order per repair.`)
    const [audit] = await admin(`SELECT before, reason FROM "AuditLog" WHERE action = 'workorders.createRepair' AND "recordType" = 'RepairOrder' AND "recordId" = $1 ORDER BY at DESC LIMIT 1`, [repair.id])
    expect(audit).toMatchObject({ before: { workOrderId }, reason: `Rework after ${first.number} (COMPLETED): the repair went back into repair.` })
    // Repaired waits for the rework's work order now.
    expect((await refused('production', 'POST', `/sales/repairs/${repair.id}/stage`, { version: repair.version, to: 'REPAIRED' }, 409)).message).toBe(`Repair work order ${rework.number} is draft: complete it first (the repair is done when its work order is).`)
    await ok('production', 'POST', `/production/work-orders/${rework.id}/release`, {})
    await ok('production', 'POST', `/production/work-orders/${rework.id}/start`, {})
    await ok('production', 'POST', `/production/work-orders/${rework.id}/complete`, {})
    workOrderId = rework.id
    repair = await recordOf(repair.id)
    repair = (await ok('production', 'POST', `/sales/repairs/${repair.id}/stage`, { version: repair.version, to: 'REPAIRED' })).repair
    expect(repair.safety.state).toBe('OUTDATED')
    expect((await refused('warehouse', 'POST', `/sales/repairs/${repair.id}/ship`, { version: repair.version, ddt: DDT }, 409)).message).toContain('made before the last repair')
    const passed = await inspectorCheck(repair, { ...PASSED, protectors: { result: 'PASS', replaced: true, lot: 'PRT-LOT-0042', level: '2' } })
    expect(passed.result).toBe('PASS')
    expect(passed.repair.safety).toMatchObject({ state: 'PASSED', checklist: { protectors: { replaced: true, lot: 'PRT-LOT-0042', level: '2' } } })
    expect(passed.repair.people.map((person: Json) => person.name)).toContain('qa repairs')
    repair = passed.repair
    expect(held(repair, 'ship')).toBeNull()

    const shipped = await ok('warehouse', 'POST', `/sales/repairs/${repair.id}/ship`, { version: repair.version, ddt: DDT })
    expect(shipped.repair).toMatchObject({ stage: 'SHIPPED', status: 'Repaired and shipped back', ddts: [{ number: shipped.ddt.number, reason: 'REPAIR', live: true }] })
    expect(shipped.ddt).toMatchObject({ reason: 'REPAIR', issuedNow: true })
    expect(shipped.warnings).toEqual([])
    expect(steps(shipped.repair).at(-1)).toEqual(['SHIPPED', 'CURRENT'])
    const [ddt] = await admin(`SELECT "documentRefs", lines FROM "Ddt" WHERE id = $1`, [shipped.ddt.id])
    expect(ddt?.documentRefs).toEqual([{ kind: 'REPAIR_ORDER', number: repair.number }, { kind: 'DDT', number: 'SEED-C1-R-7', date: '2026-11-28' }])
    expect(ddt?.lines).toMatchObject([{ sourceLineId: repair.id, quantity: '1' }])
    expect((await events('ddt.source_issued', repair.id)).map((payload) => payload.ddtId)).toEqual([shipped.ddt.id])
    expect((await events('repair.stage_changed', repair.id)).at(-1)).toMatchObject({ from: 'REPAIRED', to: 'SHIPPED', ddtId: shipped.ddt.id, workOrderId })
    expect((await refused('warehouse', 'POST', `/sales/repairs/${repair.id}/ship`, { version: shipped.repair.version }, 409)).message).toBe('Repair SEED-REP-0001 is shipped back: it changes no more.')
  })
})

describe('the list, its tiles and the record’s thread', () => {
  it('lists repairs by view with their source, safety and work order; counts the tiles', async () => {
    const closed = (await ok('viewer', 'GET', '/sales/repairs?view=closed')).repairs as Json[]
    expect(closed.map((row) => [row.number, row.stage, row.source])).toEqual(expect.arrayContaining([['SEED-REP-0001', 'SHIPPED', 'RETURN']]))
    const open = (await ok('viewer', 'GET', '/sales/repairs')).repairs as Json[]
    expect(open.find((row) => row.id === fromRma.repair.id)).toMatchObject({ stage: 'RECEIVED', source: 'RETURN', returnNumber: fromRma.rma.number, safety: 'NOT_CHECKED', siteCode: 'A1', party: { id: P1 } })
    expect(((await ok('viewer', 'GET', `/sales/repairs?view=all&returnId=${fromRma.rma.id}`)).repairs as Json[]).map((row) => row.id)).toEqual([fromRma.repair.id])
    expect(((await ok('viewer', 'GET', '/sales/repairs?q=NO-SUCH-SERIAL&view=all')).repairs as Json[]).map((row) => row.stage).sort()).toEqual(['AWAITING_GOODS', 'CANCELLED'])
    expect((await refused('viewer', 'GET', '/sales/repairs?stage=NOPE', undefined, 400)).issues[0].path).toBe('querystring/stage')
    const { counts } = await ok('viewer', 'GET', '/sales/repairs/counts')
    expect(counts).toMatchObject({ awaiting: 1, received: 1, inRepair: 0, toCheck: 0, toShip: 0, open: 2 })
  })

  it('keeps notes on the repair’s own thread (its company, site and customer)', async () => {
    const posted = await call('sales', 'POST', `/threads/RepairOrder/${fromRma.repair.id}/notes`, { body: 'Customer asked to keep the old protector.' })
    expect(posted.status, JSON.stringify(posted.body)).toBe(201)
    const [thread] = await admin(`SELECT "companyId", "siteId", "partyId" FROM "Thread" WHERE "recordType" = 'RepairOrder' AND "recordId" = $1`, [fromRma.repair.id])
    expect(thread).toEqual({ companyId: companyA, siteId: siteA, partyId: P1 })
  })
})
