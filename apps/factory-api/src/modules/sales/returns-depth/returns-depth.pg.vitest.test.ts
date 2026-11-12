import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedApprovals } from '../../../../../../packages/factory-db/seed/approvals'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedSchedule } from '../../../../../../packages/factory-db/seed/schedule'
import { seed as seedService, type ServiceSeed } from '../../../../../../packages/factory-db/seed/service'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * Returns in depth (B-W2b-341; SAL-336, SAL-337, SAL-338, SAL-342, SAL-343, SAL-346) on the local stack: a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security, the floor's column grants and the
 * …_service_safety_w2b_guards triggers are real), the real app with test sessions. One made-up tenant from the factory-db
 * seeds up to service (company A's policies: a retired and a live one for business customers, one for consumers at a
 * distance; its fee rules: "Change of mind" 10 % for the OTHER reason, "Wrong size ordered" 15.00 EUR for business
 * customers, one switched off) and approvals (every rule OFF). P1 (an organisation) was shipped one RED 52 of SEED-JKT-02
 * (400.00, batch SEED-BT-0001) and invoiced sample jackets on FT-2026-00001 (made six pieces at 250.00 here, a seed fact).
 * Made-up office people with live role assignments (the approval's deciders read them). Every name and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/returns-depth`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

let h: Harness
let app: FastifyInstance
let seeded: ServiceSeed

const NS = 'w2b341-returns-depth'
const idIn = (key: string) => seedUuid(NS, key)
const T = idIn('tenant')
const companyA = idIn('company:A')
const siteA = idIn('site:A1')
const P1 = idIn('party:P1')
const RED_LINE = idIn('production:sales-order:SO-0002:20')
const SAMPLE_LINE = idIn('money:line:FT-2026-00001:1')
const TODAY = businessDate(new Date())
const run = randomBytes(4).toString('hex')

const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
/** A write past the database's guards (the seed's facts only: never what the test then proves). */
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
let counter = 0
const key = (label = 'k'): string => `w2b341-${run}-${label}-${++counter}`

const PEOPLE = { owner: newId(), sales: newId(), finance: newId() } as const
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
function templateGrants(role: string): Grant[] {
  const template = templateOf(role)!
  return [{ permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }]
}
const SALES: Permission[] = ['sales.returns.view', 'sales.returns.manage', 'sales.returns.decide', 'sales.returns.receive', 'sales.returns.inspect', 'orders.view', 'approvals.view', 'approvals.request', 'approvals.decide', 'money.price']
const office = (permissions: Permission[], actorId = newId()): SessionContext => ({ audience: 'office', tenantId: T, actorId, grants: [grant(permissions)] })
const SESSIONS: Record<string, SessionContext> = {}

async function call(session: string, method: Method, url: string, body?: unknown, idempotencyKey = key(session)) {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': idempotencyKey }) }, ...(body === undefined ? {} : { payload: body as object }) })
  return { status: response.statusCode, body: response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : ({ raw: response.rawPayload, type: response.headers['content-type'] } as Json) }
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
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const events = (type: string, subject: string) => admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2 ORDER BY "occurredAt", id`, [type, subject])
const depthOf = async (returnId: string, session = 'sales') => (await ok(session, 'GET', `/sales/returns/${returnId}/depth`)).return
const lineRow = (lineId: string) => one<Json>(`SELECT disposition::text AS disposition, "creditAmount", "feeAmount", "feeRuleId", "creditWithoutReturn", "decidedById", "garmentSerial", "garmentBatch" FROM "ReturnLine" WHERE id = $1`, [lineId])

/** A new AUTHORISED return of P1 (W2a's route), its one line. */
async function newReturn(line: Json, reasonCode = 'OTHER'): Promise<Json> {
  const made = await ok('sales', 'POST', '/sales/returns', { companyId: companyA, partyId: P1, siteId: siteA, lines: [{ ...line, quantity: 1, reasonCode, ...(reasonCode === 'OTHER' ? { reasonNote: 'Made-up: the customer changed their mind.' } : {}) }] }, 201)
  return made.return
}

let livePolicy: Json
let redRma: Json
let sampleRma: Json

beforeAll(async () => {
  h = await startHarness('returns_depth_w2b341')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  seeded = await seedService({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  await seedSchedule({ db: h.database, namespace: NS })
  await seedApprovals({ db: h.database, namespace: NS })
  // A seed fact: P1 was invoiced six sample jackets at 250.00 (pieces for the returns below).
  await force(`UPDATE "InvoiceLine" SET quantity = 6, "netAmount" = 150000 WHERE id = $1`, [SAMPLE_LINE])
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE provider = 'R2'`)
  // The system roles as the templates hold them now (approvals.* for every office template), and the people with them.
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  const roleIds = new Map((await admin<{ id: string; key: string }>(`SELECT id, key FROM "Role" WHERE "tenantId" = $1`, [T])).map((row) => [row.key, row.id]))
  for (const [person, role] of [['owner', 'owner'], ['sales', 'sales'], ['finance', 'finance']] as const) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [PEOPLE[person], T, `w2b341-${person}-${run}@example.com`, `Made-up ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '30 days')`, [newId(), T, PEOPLE[person], roleIds.get(role)])
  }
  SESSIONS.owner = { audience: 'office', tenantId: T, actorId: PEOPLE.owner, grants: templateGrants('owner') }
  SESSIONS.finance = { audience: 'office', tenantId: T, actorId: PEOPLE.finance, grants: templateGrants('finance') }
  SESSIONS.sales = office(SALES, PEOPLE.sales)
  SESSIONS.noPrice = office(SALES.filter((permission) => permission !== 'money.price'))
  SESSIONS.viewer = office(['sales.returns.view'])
  SESSIONS.settings = office(['sales.returns.view', 'sales.settings.manage', 'money.price'])
  SESSIONS.settingsNoPrice = office(['sales.returns.view', 'sales.settings.manage'])
  SESSIONS.dock = { audience: 'floor', tenantId: T, actorId: newId(), siteId: siteA, deviceId: newId(), grants: [{ permissions: ['floor.work' as Permission, 'sales.returns.receive', 'sales.returns.inspect'], companies: [companyA], sites: [siteA], parties: 'all' }] } as SessionContext
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the return policy per channel (SAL-338)', () => {
  it('lists company A’s policies, the live ones first, and who may change them', async () => {
    const list = await ok('viewer', 'GET', `/sales/returns/policies?companyId=${companyA}`)
    expect(list.canManage).toBe(false)
    expect(list.policies.map((policy: Json) => [policy.channel, policy.live])).toEqual(expect.arrayContaining([['B2B', true], ['CONSUMER_DISTANCE', true], ['B2B', false]]))
    expect(list.policies.slice(0, 2).every((policy: Json) => policy.live)).toBe(true)
    const b2b = list.policies.find((policy: Json) => policy.id === seeded.policyIds.b2b)
    expect(b2b).toMatchObject({ windowDays: 30, goodsDueDays: 15, freightPaidBy: 'BY_CAUSE', usedBy: 1 })
  })

  it('keeps the terms of a policy an RMA names; its name may change; refuses what the law or the guard refuses', async () => {
    const b2b = (await ok('settings', 'GET', `/sales/returns/policies?companyId=${companyA}&channel=B2B&live=true`)).policies[0]
    expect((await refused('settings', 'PATCH', `/sales/returns/policies/${b2b.id}`, { version: b2b.version, windowDays: 45 }, 409)).issues).toEqual([{ path: 'body/windowDays', message: 'Named by returns: make a new policy.' }])
    const renamed = await ok('settings', 'PATCH', `/sales/returns/policies/${b2b.id}`, { version: b2b.version, name: 'Brands and dealers (made-up)' })
    expect(renamed.policy).toMatchObject({ name: 'Brands and dealers (made-up)', version: b2b.version + 1 })
    const consumer = { companyId: companyA, channel: 'CONSUMER_DISTANCE', name: 'Web shop (made-up)', windowDays: 10, goodsDueDays: 14, freightPaidBy: 'CUSTOMER' }
    expect(paths(await refused('settings', 'POST', '/sales/returns/policies', consumer, 400))).toEqual(['body/windowDays'])
    expect(paths(await refused('settings', 'POST', '/sales/returns/policies', { ...consumer, channel: 'B2B', withdrawalWords: 'Made-up words.' }, 400))).toEqual(['body/withdrawalWords'])
    expect((await refused('sales', 'POST', '/sales/returns/policies', consumer, 403)).code).toBe('forbidden')
  })

  it('a new policy for business customers retires the live one in the same command', async () => {
    const made = await ok('settings', 'POST', '/sales/returns/policies', { companyId: companyA, channel: 'B2B', name: 'Brands, autumn (made-up)', windowDays: 10, goodsDueDays: 10, freightPaidBy: 'BY_CAUSE', conditions: 'Made-up: unused, in the original bag.' }, 201)
    livePolicy = made.policy
    expect(made.retired).toMatchObject({ id: seeded.policyIds.b2b })
    expect(livePolicy).toMatchObject({ channel: 'B2B', live: true, windowDays: 10, goodsDueDays: 10, effectiveFrom: TODAY, usedBy: 0 })
    expect(await admin(`SELECT id FROM "ReturnPolicy" WHERE "companyId" = $1 AND channel = 'B2B' AND "retiredAt" IS NULL`, [companyA])).toEqual([{ id: livePolicy.id }])
    expect((await events('return_policy.saved', livePolicy.id))[0]?.payload).toEqual({ policyId: livePolicy.id, companyId: companyA, channel: 'B2B', change: 'CREATED', replacedId: seeded.policyIds.b2b, fields: [] })
    expect((await events('return_policy.saved', seeded.policyIds.b2b)).at(-1)?.payload).toMatchObject({ change: 'RETIRED' })
  })
})

describe('restocking and handling fee rules (SAL-343)', () => {
  it('lists the rules in their order; a fixed amount only with the price grain', async () => {
    const list = await ok('settings', 'GET', `/sales/returns/fee-rules?companyId=${companyA}`)
    expect(list.rules.map((rule: Json) => rule.name)).toEqual(['Change of mind', 'Wrong size ordered', 'Old flat fee'])
    expect(list.rules[1]).toMatchObject({ kind: 'AMOUNT', amount: 1500, currency: 'EUR', channel: 'B2B', terms: 'a fixed amount per line' })
    expect((await ok('settingsNoPrice', 'GET', `/sales/returns/fee-rules?companyId=${companyA}`)).rules[1]).not.toHaveProperty('amount')
  })

  it('makes a rule of the return list’s reasons; refuses an unknown reason and an amount sent without the grain', async () => {
    const made = await ok('settings', 'POST', '/sales/returns/fee-rules', { companyId: companyA, channel: 'B2B', name: 'Wrong item (made-up)', reasonCodes: ['WRONG_ITEM'], kind: 'PERCENT', percent: '5', sequence: 30 }, 201)
    expect(made.rule).toMatchObject({ terms: '5 % of the credit', active: true, usedBy: 0, reasons: [{ code: 'WRONG_ITEM', labelEn: 'Wrong item' }] })
    expect(paths(await refused('settings', 'POST', '/sales/returns/fee-rules', { companyId: companyA, name: 'Bad (made-up)', reasonCodes: ['NOT_A_REASON'], kind: 'PERCENT', percent: '5' }, 400))).toEqual(['body/reasonCodes/0'])
    const blind = await call('settingsNoPrice', 'POST', '/sales/returns/fee-rules', { companyId: companyA, name: 'Flat (made-up)', kind: 'AMOUNT', amount: 500, currency: 'EUR' })
    expect(blind.status).not.toBe(201)
    const off = await ok('settings', 'PATCH', `/sales/returns/fee-rules/${made.rule.id}`, { version: made.rule.version, active: false })
    expect(off.rule.active).toBe(false)
    expect((await events('return_fee_rule.changed', made.rule.id)).map((row) => row.payload.change)).toEqual(['CREATED', 'SWITCHED_OFF'])
  })
})

describe('the policy check of a return and its deadline (SAL-338, SAL-337)', () => {
  it('checks a return being made: the channel from the customer, each line’s window, no withdrawal for a business', async () => {
    const check = (await ok('sales', 'POST', '/sales/returns/policy-check', { companyId: companyA, partyId: P1, lines: [{ invoiceLineId: SAMPLE_LINE }] })).check
    expect(check).toMatchObject({ channel: 'B2B', channelFrom: 'CUSTOMER', policy: { id: livePolicy.id }, goodsDueBy: addDays(TODAY, 10), outsideWindow: true, ok: true })
    expect(check.lines[0].window).toMatchObject({ deliveredOn: '2026-10-28', lastDay: '2026-11-07', inWindow: false })
    const withdrawal = (await ok('sales', 'POST', '/sales/returns/policy-check', { companyId: companyA, partyId: P1, withdrawal: true, lines: [{ invoiceLineId: SAMPLE_LINE }] })).check
    expect(withdrawal.ok).toBe(false)
    expect(withdrawal.withdrawal.why[0]).toMatch(/^The right of withdrawal is a consumer's who bought at a distance/)
  })

  it('binds an authorised return to its policy: a line outside the window only with the reason; the deadline from the authorisation', async () => {
    sampleRma = await newReturn({ invoiceLineId: SAMPLE_LINE })
    expect((await refused('sales', 'POST', `/sales/returns/${sampleRma.id}/policy`, { version: sampleRma.version }, 400)).issues).toEqual([{ path: 'body/reason', message: expect.stringMatching(/^Line 10 was delivered on 2026-10-28: .*Say why it is taken back anyway\.$/) }])
    expect((await refused('sales', 'POST', `/sales/returns/${sampleRma.id}/policy`, { version: sampleRma.version, withdrawal: true, reason: 'Made-up courtesy.' }, 409)).code).toBe('conflict')
    const bound = await ok('sales', 'POST', `/sales/returns/${sampleRma.id}/policy`, { version: sampleRma.version, reason: 'Made-up: a good customer, a courtesy.' })
    expect(bound).toMatchObject({ goodsDueBy: addDays(TODAY, 10), return: { policy: { named: { id: livePolicy.id }, current: true, withdrawal: false, followsSalesSettings: false }, deadline: { goodsDueBy: addDays(TODAY, 10), arrival: { state: 'WAITING' } }, feesApply: true } })
    const row = await one<Json>(`SELECT "policyId", withdrawal, "goodsDueBy"::text AS "goodsDueBy" FROM "ReturnAuthorisation" WHERE id = $1`, [sampleRma.id])
    expect(row).toEqual({ policyId: livePolicy.id, withdrawal: false, goodsDueBy: addDays(TODAY, 10) })
    expect((await events('return.policy_checked', sampleRma.id))[0]?.payload).toEqual({ returnId: sampleRma.id, number: sampleRma.number, policyId: livePolicy.id, channel: 'B2B', withdrawal: false, goodsDueBy: addDays(TODAY, 10), outsideWindow: true })
    const [audit] = await admin<Json>(`SELECT reason FROM "AuditLog" WHERE "recordId" = $1 AND action = 'returnsDepth.checkPolicy'`, [sampleRma.id])
    expect(audit?.reason).toBe('Made-up: a good customer, a courtesy.')
    // Now that an RMA names it, its terms stay.
    expect((await refused('settings', 'PATCH', `/sales/returns/policies/${livePolicy.id}`, { version: livePolicy.version, goodsDueDays: 20 }, 409)).code).toBe('conflict')
    sampleRma = (await ok('sales', 'GET', `/sales/returns/${sampleRma.id}`)).return
  })
})

let redLine: Json
let serial: string

describe('serial, size and lot on every return line, from the shipment (SAL-336)', () => {
  it('lists what shipped on the line, names the lot and the serial, refuses a garment that did not ship on it', async () => {
    redRma = await newReturn({ salesOrderLineId: RED_LINE, size: '52' })
    redLine = redRma.lines[0]
    await ok('sales', 'POST', `/sales/returns/${redRma.id}/policy`, { version: redRma.version, reason: 'Made-up: taken back whatever the window says.' })
    // A seed fact: the RED 52 that shipped carries serial W2B341-SN-<run> (the shipment line's cell and work order).
    const shipped = await one<Json>(`SELECT id, "siteId", "workOrderId", "workOrderSizeId" FROM "ShipmentLine" WHERE "salesOrderLineId" = $1 AND size = '52'`, [RED_LINE])
    serial = `W2B341-SN-${run}`.toUpperCase()
    await force(`INSERT INTO "GarmentSerial" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", serial, status, "shipmentLineId") VALUES ($1, $2, $3, $4, $5, $6, 'SHIPPED', $7)`, [newId(), T, shipped.siteId, shipped.workOrderId, shipped.workOrderSizeId, serial, shipped.id])
    const garments = await ok('viewer', 'GET', `/sales/returns/${redRma.id}/lines/${redLine.id}/garments`)
    expect(garments.shipped.batches).toEqual([{ batchNumber: 'SEED-BT-0001', workOrderId: shipped.workOrderId, pieces: 1 }])
    expect(garments.shipped.serials).toEqual([{ serial, batchNumber: 'SEED-BT-0001', status: 'SHIPPED' }])
    expect(garments.suggested).toEqual({ garmentBatch: 'SEED-BT-0001', garmentSerial: serial })
    let current = await depthOf(redRma.id)
    expect(paths(await refused('sales', 'PUT', `/sales/returns/${redRma.id}/lines/${redLine.id}/garment`, { version: current.version, garmentSerial: 'SEED-SN-0001' }, 400))).toEqual(['body/garmentSerial'])
    expect(paths(await refused('sales', 'PUT', `/sales/returns/${redRma.id}/lines/${redLine.id}/garment`, { version: current.version, garmentBatch: 'SEED-BT-0003' }, 400))).toEqual(['body/garmentBatch'])
    const filled = await ok('sales', 'POST', `/sales/returns/${redRma.id}/garments/fill`, { version: current.version })
    expect(filled.filled).toEqual([{ lineId: redLine.id, seq: 10, garmentBatch: 'SEED-BT-0001', garmentSerial: serial }])
    expect(await lineRow(redLine.id)).toMatchObject({ garmentSerial: serial, garmentBatch: 'SEED-BT-0001' })
    current = filled.return
    const cleared = await ok('sales', 'PUT', `/sales/returns/${redRma.id}/lines/${redLine.id}/garment`, { version: current.version, garmentSerial: null, garmentBatch: null })
    expect(cleared.changed).toBe(true)
    expect((await events('return.garment_named', redRma.id)).map((row) => row.payload.via)).toEqual(['OFFICE', 'OFFICE'])
  })

  it('the dock scans the garment’s serial label: its line gets the serial and the lot (no price in the answer)', async () => {
    const current = await depthOf(redRma.id)
    expect((await refused('dock', 'POST', `/sales/returns/${redRma.id}/garments/scan`, { version: current.version, code: 'NOT-A-SERIAL' }, 404)).message).toBe('Serial NOT-A-SERIAL is not a garment of this return: put it aside and tell customer service.')
    const scanned = await ok('dock', 'POST', `/sales/returns/${redRma.id}/garments/scan`, { version: current.version, code: serial })
    expect(scanned).toEqual({ line: { id: redLine.id, seq: 10, garmentSerial: serial, garmentBatch: 'SEED-BT-0001' }, named: 'SERIAL_AND_LOT', words: `Line 10: serial ${serial}, batch SEED-BT-0001.`, changed: true, version: current.version + 1 })
    expect((await events('return.garment_named', redRma.id)).at(-1)?.payload).toMatchObject({ via: 'DOCK', lineIds: [redLine.id] })
  })
})

describe('a scan code on the RMA papers that the dock reads (SAL-346)', () => {
  it('gives the return its code once, prints the papers with it, and the dock opens the return by it', async () => {
    let current = await depthOf(redRma.id)
    expect((await refused('sales', 'GET', `/sales/returns/${redRma.id}/papers`, undefined, 409)).message).toMatch(/has no scan code yet/)
    const coded = await ok('sales', 'POST', `/sales/returns/${redRma.id}/scan-code`, { version: current.version })
    expect(coded).toMatchObject({ scanCode: redRma.number, created: true, return: { scanCode: redRma.number, papers: { printable: true } } })
    current = coded.return
    expect(await ok('sales', 'POST', `/sales/returns/${redRma.id}/scan-code`, { version: current.version })).toMatchObject({ scanCode: redRma.number, created: false })
    expect((await events('return.scan_code_set', redRma.id))[0]?.payload).toEqual({ returnId: redRma.id, number: redRma.number, scanCode: redRma.number })
    const papers = await call('sales', 'GET', `/sales/returns/${redRma.id}/papers?language=en`)
    expect(papers.status).toBe(200)
    expect(String(papers.body.type)).toBe('application/pdf')
    expect((papers.body.raw as Buffer).subarray(0, 5).toString()).toBe('%PDF-')
    // The dock: SEED-RMA-0002's code is not its number; the scan opens it (W2a's find).
    const code = (await one<{ scanCode: string; number: string }>(`SELECT "scanCode", number FROM "ReturnAuthorisation" WHERE id = $1`, [seeded.returns.inspectedReturnId]))
    expect(code.scanCode).not.toBe(code.number)
    const found = await ok('dock', 'GET', `/sales/returns/dock?code=${encodeURIComponent(code.scanCode.toLowerCase())}`)
    expect(found.return).toMatchObject({ id: seeded.returns.inspectedReturnId, number: 'SEED-RMA-0002' })
    expect((await refused('dock', 'GET', '/sales/returns/dock?code=NO-SUCH-CODE', undefined, 404)).message).toBe('No open return with this code. Put the parcel aside and tell customer service.')
  })
})

describe('the deadline flags a late arrival; a fee by rule is withheld from the credit (SAL-337, SAL-343)', () => {
  it('goods that arrive after the deadline are flagged on the return and in the tile', async () => {
    // A seed fact: the RED return's goods were due two days ago.
    await force(`UPDATE "ReturnAuthorisation" SET "goodsDueBy" = $2::date WHERE id = $1`, [redRma.id, addDays(TODAY, -2)])
    const dock = (await ok('dock', 'GET', `/sales/returns/${redRma.id}/dock`)).return
    await ok('dock', 'POST', `/sales/returns/${redRma.id}/receipts`, { version: dock.version, parcels: 1, parcelCondition: 'INTACT', lines: [{ lineId: redLine.id, quantity: 1 }] }, 201)
    const depth = await depthOf(redRma.id)
    expect(depth.deadline).toEqual({ goodsDueBy: addDays(TODAY, -2), receivedOn: TODAY, arrival: { state: 'LATE', daysLate: 2, words: `Arrived after the deadline: on ${TODAY}, 2 days after ${addDays(TODAY, -2)}.` } })
    const late = await ok('viewer', 'GET', `/sales/returns/arrived-late?companyId=${companyA}`)
    expect(late.rows).toContainEqual(expect.objectContaining({ id: redRma.id, number: redRma.number, daysLate: 2, party: expect.objectContaining({ id: P1 }) }))
    expect(late.rows.find((row: Json) => row.id === sampleRma.id)).toBeUndefined()
  })

  it('the decision withholds the first matching rule’s fee (OTHER: 10 %), the credit after it on the line', async () => {
    const dock = (await ok('dock', 'GET', `/sales/returns/${redRma.id}/dock`)).return
    await ok('dock', 'POST', `/sales/returns/${redRma.id}/grades`, { version: dock.version, lines: [{ lineId: redLine.id, grade: 'GOOD', cause: 'NO_FAULT' }] })
    const preview = await ok('sales', 'POST', `/sales/returns/${redRma.id}/fees/preview`, { lines: [{ lineId: redLine.id, disposition: 'CREDIT_ONLY' }] })
    expect(preview).toMatchObject({ policyNamed: true, channel: 'B2B', noFees: null, lines: [{ creditBefore: 40_000, creditAfter: 36_000, fee: { ruleId: seeded.feeRuleIds.changeOfMind, amount: 4000, dropped: null, words: 'Change of mind: 10 % of the credit', wordsWithAmount: 'Change of mind: 10 % of the credit = 40.00 EUR' } }] })
    expect((await ok('noPrice', 'POST', `/sales/returns/${redRma.id}/fees/preview`, { lines: [{ lineId: redLine.id, disposition: 'CREDIT_ONLY' }] })).lines[0].fee).not.toHaveProperty('amount')
    const record = (await ok('sales', 'GET', `/sales/returns/${redRma.id}`)).return
    const w2aPreview = await ok('sales', 'POST', `/sales/returns/${redRma.id}/decisions/preview`, { lines: [{ lineId: redLine.id, disposition: 'CREDIT_ONLY', goodsOutcome: 'QUARANTINE' }] })
    expect(w2aPreview.lines[0].creditAmount).toBe(36_000)
    const decided = await ok('sales', 'POST', `/sales/returns/${redRma.id}/decisions`, { version: record.version, lines: [{ lineId: redLine.id, disposition: 'CREDIT_ONLY', goodsOutcome: 'QUARANTINE' }] })
    expect(decided.return.lines[0]).toMatchObject({ disposition: 'CREDIT_ONLY', creditAmount: 36_000 })
    expect(await lineRow(redLine.id)).toMatchObject({ creditAmount: 36_000, feeAmount: 4000, feeRuleId: seeded.feeRuleIds.changeOfMind })
    expect((await depthOf(redRma.id)).lines[0].fee).toMatchObject({ ruleName: 'Change of mind', amount: 4000, dropped: null, wordsWithAmount: 'Change of mind: 10 % of the credit = 40.00 EUR' })
    // The rule gave a fee: its terms stay.
    const rule = (await ok('settings', 'GET', `/sales/returns/fee-rules?companyId=${companyA}`)).rules.find((entry: Json) => entry.id === seeded.feeRuleIds.changeOfMind)
    expect(rule.usedBy).toBe(1)
    expect((await refused('settings', 'PATCH', `/sales/returns/fee-rules/${rule.id}`, { version: rule.version, percent: '12' }, 409)).issues).toEqual([{ path: 'body/percent', message: 'Used on return lines: make another rule.' }])
  })

  it('drops the fee when the cause is ours: the rule named, nothing withheld', async () => {
    const current = (await ok('sales', 'GET', `/sales/returns/${sampleRma.id}`)).return
    const dock = (await ok('sales', 'POST', `/sales/returns/${sampleRma.id}/receipts`, { version: current.version, parcels: 1, parcelCondition: 'INTACT', lines: [{ lineId: current.lines[0].id, quantity: 1 }] }, 201)).return
    await ok('sales', 'POST', `/sales/returns/${sampleRma.id}/grades`, { version: dock.version, lines: [{ lineId: current.lines[0].id, grade: 'DAMAGED', cause: 'OUR_DEFECT' }] })
    const record = (await ok('sales', 'GET', `/sales/returns/${sampleRma.id}`)).return
    await ok('sales', 'POST', `/sales/returns/${sampleRma.id}/decisions`, { version: record.version, lines: [{ lineId: current.lines[0].id, disposition: 'CREDIT_ONLY', goodsOutcome: 'SCRAP' }] })
    expect(await lineRow(current.lines[0].id)).toMatchObject({ creditAmount: 25_000, feeAmount: 0, feeRuleId: seeded.feeRuleIds.changeOfMind })
    expect((await depthOf(sampleRma.id)).lines[0].fee).toMatchObject({ amount: 0, dropped: 'OUR_CAUSE', words: 'Change of mind: 10 % of the credit, dropped: the cause is ours (our defect).' })
  })

  it('a return never checked against a policy has no fee (as W2a)', async () => {
    const plain = await newReturn({ invoiceLineId: SAMPLE_LINE })
    const preview = await ok('sales', 'POST', `/sales/returns/${plain.id}/fees/preview`, { lines: [{ lineId: plain.lines[0].id, disposition: 'CREDIT_ONLY', creditAmount: 1000 }] })
    expect(preview).toMatchObject({ policyNamed: false, noFees: expect.stringMatching(/^This return was not checked/), lines: [{ fee: null, creditAfter: 1000 }] })
    await ok('sales', 'POST', `/sales/returns/${plain.id}/cancel`, { version: plain.version, reason: 'Made-up: test over.' })
  })
})

describe('credit without a return, within the approval limit (SAL-342)', () => {
  it('without an approval rule switched on, the line is credited at once and the dock takes none of its pieces', async () => {
    const rma = await newReturn({ invoiceLineId: SAMPLE_LINE })
    const line = rma.lines[0]
    const preview = await ok('sales', 'POST', `/sales/returns/${rma.id}/lines/${line.id}/credit-without-return/preview`, { creditAmount: 7000 })
    expect(preview).toMatchObject({ ok: true, value: 25_000, creditAmount: 7000, approval: { needed: false }, effect: 'A credit; the goods stay with the customer (credited without a return); a credit note to make (Finance)' })
    expect(paths(await refused('sales', 'POST', `/sales/returns/${rma.id}/lines/${line.id}/credit-without-return`, { version: rma.version, creditAmount: 30_000 }, 400))).toEqual(['body/creditAmount'])
    const credited = await ok('sales', 'POST', `/sales/returns/${rma.id}/lines/${line.id}/credit-without-return`, { version: rma.version, creditAmount: 7000, note: 'Made-up: a small mark, the customer keeps it.' })
    expect(credited).toMatchObject({ credited: true, waiting: null, return: { lines: [{ creditAmount: 7000, creditWithoutReturn: { credited: true, waiting: null } }] } })
    expect(await lineRow(line.id)).toMatchObject({ disposition: 'CREDIT_ONLY', creditAmount: 7000, creditWithoutReturn: true, decidedById: PEOPLE.sales, feeAmount: null })
    expect((await events('return.credited_without_return', rma.id))[0]?.payload).toEqual({ returnId: rma.id, number: rma.number, partyId: P1, lineIds: [line.id], approvalTaskId: null })
    expect((await events('return.credit_due', rma.id))[0]?.payload).toMatchObject({ lineIds: [line.id] })
    // W2a's record says it; the dock refuses its pieces in words (the guard would refuse the same).
    const record = (await ok('sales', 'GET', `/sales/returns/${rma.id}`)).return
    expect(record.lines[0].effect).toBe('A credit; the goods stay with the customer (credited without a return); a credit note to make (Finance)')
    expect(record.actions.find((action: Json) => action.action === 'receive')).toMatchObject({ allowed: false })
    expect((await refused('dock', 'POST', `/sales/returns/${rma.id}/receipts`, { version: record.version, parcels: 1, parcelCondition: 'INTACT', lines: [{ lineId: line.id, quantity: 1 }] }, 400)).message).toBe('Line 10 was credited without the goods coming back: put the parcel aside and tell customer service.')
    expect((await refused('sales', 'POST', `/sales/returns/${rma.id}/lines/${line.id}/credit-without-return`, { version: record.version }, 409)).message).toBe('Line 10 is decided already.')
    // The RMA closes with nothing received.
    expect((await ok('sales', 'POST', `/sales/returns/${rma.id}/close`, { version: record.version, reason: 'Made-up: credited without the goods.' })).return.status).toBe('CLOSED')
  })

  it('with a rule switched on, the credit waits for another person’s yes; the person who asked never approves it', async () => {
    const financeRoleId = (await one<{ id: string }>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'finance'`, [T])).id
    const rule = (await ok('owner', 'POST', '/approvals/rules', { kind: 'CREDIT_WITHOUT_RETURN', companyId: companyA, name: 'Credits without the goods over 50 (made-up)', condition: { combinator: 'and', rows: [{ id: 'r1', field: 'creditValue', operator: 'gt', value: '50' }] }, approver: { roleId: financeRoleId }, sequence: 10 }, 201)).rule
    await ok('owner', 'PUT', `/approvals/rules/${rule.id}`, { version: rule.version, active: true })
    const rma = await newReturn({ invoiceLineId: SAMPLE_LINE })
    const line = rma.lines[0]
    const preview = await ok('sales', 'POST', `/sales/returns/${rma.id}/lines/${line.id}/credit-without-return/preview`, { creditAmount: 12_000 })
    expect(preview.approval).toEqual({ needed: true, approverRoleId: financeRoleId, approverUserId: null, nobodyElse: false })
    // Below the limit: no yes needed (40.00 ≤ 50).
    expect((await ok('sales', 'POST', `/sales/returns/${rma.id}/lines/${line.id}/credit-without-return/preview`, { creditAmount: 4000 })).approval.needed).toBe(false)
    const asked = await ok('sales', 'POST', `/sales/returns/${rma.id}/lines/${line.id}/credit-without-return`, { version: rma.version, creditAmount: 12_000, note: 'Made-up: the customer keeps a marked jacket.' }, 202)
    expect(asked).toMatchObject({ credited: false, waiting: { approverRoleId: financeRoleId }, return: { lines: [{ creditWithoutReturn: { credited: false, waiting: { taskId: asked.waiting.taskId }, allowed: false } }] } })
    expect(await lineRow(line.id)).toMatchObject({ disposition: null, creditWithoutReturn: false })
    const task = (await ok('finance', 'GET', `/approvals/tasks/${asked.waiting.taskId}`)).task
    expect(task).toMatchObject({ kind: 'CREDIT_WITHOUT_RETURN', recordType: 'ReturnLine', recordId: line.id, recheck: 'CURRENT', approve: { allowed: true } })
    expect(task.changes).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'creditAmount', to: 12_000 })]))
    // The person who asked holds approvals.decide too: refused, the Owner's rule.
    expect(paths(await refused('sales', 'POST', `/approvals/tasks/${asked.waiting.taskId}/approve`, { version: task.version }, 403))).toEqual(['refusal/OWN_REQUEST'])
    expect((await refused('sales', 'POST', `/sales/returns/${rma.id}/lines/${line.id}/credit-without-return`, { version: rma.version }, 409)).message).toBe('A credit of line 10 without the goods waits for a yes already.')
    await ok('finance', 'POST', `/approvals/tasks/${asked.waiting.taskId}/approve`, { version: task.version, comment: 'Made-up: fine.' })
    expect(await lineRow(line.id)).toMatchObject({ disposition: 'CREDIT_ONLY', creditAmount: 12_000, creditWithoutReturn: true, decidedById: PEOPLE.sales })
    expect((await events('return.credited_without_return', rma.id))[0]?.payload).toMatchObject({ lineIds: [line.id], approvalTaskId: asked.waiting.taskId })
    await ok('owner', 'PUT', `/approvals/rules/${rule.id}`, { version: rule.version + 1, active: false })
  })
})
