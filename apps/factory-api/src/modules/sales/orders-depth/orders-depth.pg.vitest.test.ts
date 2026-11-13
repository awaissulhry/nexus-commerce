import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { SHEET_TYPES } from '@nexus/factory-domain/imports/job'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { callerFor, type CommandCaller } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { applyPlan, planImport } from '../../../platform/imports/worker'
import { systemContext } from '../../../platform/outbox/system'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'

/**
 * Orders in depth (B-W2b-303; SAL-201, SAL-205, SAL-207, SAL-208, SAL-215, SAL-277; SO1:01, SO1:02) on the local stack with the
 * app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and every
 * guard is real), tenant A from EVERY seed (SEED-C1 with company A: PO number required, a credit limit with the credit rule OFF;
 * the seasons FW27, SS28 and FW26 closed; the approvals seed's SALES_ORDER rule OFF). Test sessions hold the role templates'
 * grants; the approver is a person with the finance role assignment. A FAKE file store and the seeded FAKE mail account.
 * Every name and number is made up.
 *
 * What it walks: seasons (list for a style picker, make, refusals, change, close and reopen; a quote's draft and an order name
 * one; a closed one refused; a copy keeps it); priority (urgent with its reason, refusals, a selection); an order waiting for a
 * yes (a SALES_ORDER rule on → PENDING_APPROVAL with its request; the asker refused; Finance's yes → CONFIRMED and
 * sales_order.status_changed; a no → CANCELLED with the reason; asked again after a withdrawal); the office's order of an
 * accepted quote (the season carried; a size outside the released scope refused, SO1:02; an amendment refused likewise);
 * several orders from one (a whole line with its delivery address, sizes of another; the order keeps the rest without a
 * re-acceptance; refusals); the confirmation (made once per contents, out of date after a printed change, sent on the
 * thread, refused while waiting); the sheet import (dry run, an error row in words, the apply, an order imported twice refused).
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/orders-depth/`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'

const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'orders-depth-303'
const sid = (key: string) => seedUuid(NS, key)
const A = { tenant: sid('tenant'), companyA: sid('company:A'), companyB: sid('company:B') }

const PEOPLE = { sales: newId(), sales2: newId(), finance: newId(), owner: newId(), reader: newId() } as const
type Person = keyof typeof PEOPLE
const ROLE_OF: Record<Person, string> = { sales: 'sales', sales2: 'sales', finance: 'finance', owner: 'owner', reader: 'read_only' }

function grantsOf(role: string): Grant[] {
  const template = templateOf(role)!
  return [{ permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }]
}
const SESSIONS: Record<string, SessionContext> = {}

let h: Harness
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `w2b303-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': freshKey() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const outbox = async (type: string, subject?: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ${subject ? 'AND subject = $3' : ''} ORDER BY "occurredAt", id`, subject ? [A.tenant, type, subject] : [A.tenant, type])).map((row) => row.payload)
const system = (): CommandCaller => callerFor(h.database, systemContext(A.tenant, `test-${run}-${++keys}`))
const orderRow = (orderId: string) => one<Json>(`SELECT id, number, status::text AS status, version, "quoteVersionId", "seasonId", "priorityLevel"::text AS "priorityLevel", "urgentReason", "cancelReason", "netAmount", "grossAmount", "confirmationVersion", "confirmationSentAt", "shipTo", "customerRef" FROM "SalesOrder" WHERE id = $1`, [orderId])
const tasksOf = (orderId: string) => admin<Json>(`SELECT id, status::text AS status, "requestedById", version FROM "ApprovalTask" WHERE kind = 'SALES_ORDER' AND "recordId" = $1 ORDER BY "requestedAt", id`, [orderId])

let p1: string
let financeRoleId: string
const S = { fw27: '', ss28: '', fw26: '' }
let blk: { styleId: string; colourwayId: string; sizes: string[]; revisionId: string | null }
let red: { styleId: string; colourwayId: string; sizes: string[] }
let jkt02: { styleId: string; colourwayId: string; sizes: string[] }

const typed = (customerRef: string, extra: Json = {}) => ({
  companyId: A.companyA,
  partyId: p1,
  customerRef,
  lines: [
    { styleId: blk.styleId, colourwayId: blk.colourwayId, unitPrice: '100', sizes: blk.sizes.slice(0, 2).map((size) => ({ size, quantity: 3 })) },
    { styleId: red.styleId, colourwayId: red.colourwayId, unitPrice: '110', sizes: red.sizes.slice(0, 1).map((size) => ({ size, quantity: 2 })) },
  ],
  ...extra,
})

beforeAll(async () => {
  h = await startHarness('orders_depth_w2b303')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  const roleIds = new Map((await admin<{ id: string; key: string }>(`SELECT id, key FROM "Role" WHERE "tenantId" = $1`, [A.tenant])).map((row) => [row.key, row.id]))
  financeRoleId = roleIds.get('finance')!
  for (const [person, role] of Object.entries(ROLE_OF) as Array<[Person, string]>) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [PEOPLE[person], A.tenant, `w2b303-${person}-${run}@example.com`, `Made-up ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '30 days')`, [newId(), A.tenant, PEOPLE[person], roleIds.get(role)])
    SESSIONS[person] = { audience: 'office', tenantId: A.tenant, actorId: PEOPLE[person], grants: grantsOf(role) }
  }
  p1 = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-C1'`, [A.tenant])).id
  // Company A's letterhead (c.c. art. 2250: the confirmation PDF prints it; made-up numbers).
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [A.companyA])
  // SEED-JKT-02 (P1's own label, its revision RELEASED) in BLK: the quote of the released-scope test.
  jkt02 = await one(`SELECT s.id AS "styleId", c.id AS "colourwayId", (SELECT array_agg(v.size ORDER BY v.size) FROM "Variant" v WHERE v."colourwayId" = c.id AND v.status = 'ACTIVE') AS sizes FROM "Style" s JOIN "Colourway" c ON c."styleId" = s.id WHERE s."tenantId" = $1 AND s.code = 'SEED-JKT-02' AND c.code = 'BLK'`, [A.tenant])
  for (const code of ['FW27', 'SS28', 'FW26'] as const) S[code.toLowerCase() as keyof typeof S] = (await one<{ id: string }>(`SELECT id FROM "Season" WHERE "tenantId" = $1 AND "companyId" = $2 AND code = $3`, [A.tenant, A.companyA, code])).id
  // SEED-SO-0001's two size-grid lines (the jacket in BLK and RED, sizes offered), typed again on made-up orders.
  const lines = await admin<{ styleId: string; colourwayId: string; code: string; revisionId: string | null; sizes: string[] }>(
    `SELECT l."styleId", l."colourwayId", c.code, l."styleRevisionId" AS "revisionId", (SELECT array_agg(s.size ORDER BY s.size) FROM "SalesOrderLineSize" s WHERE s."lineId" = l.id) AS sizes
       FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o.id = l."orderId" JOIN "Colourway" c ON c.id = l."colourwayId" WHERE o."tenantId" = $1 AND o.number = 'SEED-SO-0001' ORDER BY l.seq`,
    [A.tenant],
  )
  blk = lines.find((line) => line.code === 'BLK')!
  red = lines.find((line) => line.code === 'RED')!
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-orders-depth-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await h?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

// ---- seasons (SAL-277; SO1:01) --------------------------------------------------------------------------------------------

describe('seasons per company (SAL-277)', () => {
  let made: Json

  it('lists the seasons with their state and the styles that carry the code (the style picker reads it); finance keeps them', async () => {
    const list = await ok('sales', 'GET', `/sales/seasons?companyId=${A.companyA}`)
    expect(list.seasons.map((row: Json) => [row.code, row.status])).toEqual(expect.arrayContaining([['FW27', 'OPEN'], ['SS28', 'OPEN'], ['FW26', 'CLOSED']]))
    expect(list.seasons.find((row: Json) => row.code === 'FW27').styles).toBeGreaterThan(0)
    expect(list.mayManage).toBe(false)
    expect((await ok('finance', 'GET', `/sales/seasons?companyId=${A.companyA}&status=OPEN`)).seasons.every((row: Json) => row.status === 'OPEN')).toBe(true)
  })

  it('makes a season (code unique per company); refuses bad dates, a twin code and a writer without sales settings', async () => {
    made = (await ok('finance', 'POST', '/sales/seasons', { companyId: A.companyA, code: 'SS29', name: 'Spring-Summer 2029 (made-up)', startsOn: '2029-03-01', endsOn: '2029-08-31', orderBookClosesOn: '2028-10-31' }, 201)).season
    expect(made).toMatchObject({ code: 'SS29', status: 'OPEN', state: 'OPEN', mayManage: true, styles: 0, orders: 0 })
    expect(paths(await no('finance', 'POST', '/sales/seasons', { companyId: A.companyA, code: 'SS30', name: 'X', startsOn: '2030-03-01', endsOn: '2030-01-01' }, 400))).toEqual(['body/endsOn'])
    expect((await no('finance', 'POST', '/sales/seasons', { companyId: A.companyA, code: 'ss29', name: 'Twin', startsOn: '2029-03-01', endsOn: '2029-08-31' }, 409)).message).toMatch(/has a season ss29 already|has a season SS29 already/i)
    await no('sales', 'POST', '/sales/seasons', { companyId: A.companyA, code: 'SS31', name: 'No', startsOn: '2031-03-01', endsOn: '2031-08-31' }, 403)
    expect(await outbox('season.changed', made.id)).toEqual([expect.objectContaining({ code: 'SS29', change: 'MADE' })])
  })

  it('changes it at its version (the code stays), closes and reopens it', async () => {
    const changed = (await ok('finance', 'PATCH', `/sales/seasons/${made.id}`, { version: made.version, name: 'SS29 (made-up, renamed)' })).season
    expect(changed).toMatchObject({ code: 'SS29', name: 'SS29 (made-up, renamed)', version: made.version + 1 })
    await no('finance', 'PATCH', `/sales/seasons/${made.id}`, { version: made.version, name: 'Stale' }, 409)
    const closed = (await ok('finance', 'POST', `/sales/seasons/${made.id}/close`, { version: changed.version })).season
    expect(closed).toMatchObject({ status: 'CLOSED', state: 'CLOSED', closedBy: 'Made-up finance' })
    const reopened = (await ok('finance', 'POST', `/sales/seasons/${made.id}/reopen`, { version: closed.version })).season
    expect(reopened).toMatchObject({ status: 'OPEN', closedAt: null })
    expect((await outbox('season.changed', made.id)).map((row) => row.change)).toEqual(['MADE', 'CHANGED', 'CLOSED', 'REOPENED'])
  })

  it("a quote's draft names an open season; a closed one is refused in words; a copy keeps it", async () => {
    const q2 = await one<Json>(`SELECT q.id, q.version FROM "Quote" q WHERE q."tenantId" = $1 AND q.number = 'SEED-Q-0002'`, [A.tenant])
    const set = await ok('sales', 'PUT', `/sales/quotes/${q2.id}/season`, { version: q2.version, seasonId: S.ss28 })
    expect(set.season).toMatchObject({ quoteId: q2.id, seasonId: S.ss28, code: 'SS28' })
    const closed = await no('sales', 'PUT', `/sales/quotes/${q2.id}/season`, { version: q2.version + 1, seasonId: S.fw26 }, 409)
    expect(closed.message).toBe('Season FW26 is closed: name an open season, or reopen it first.')
    expect(paths(await no('sales', 'PUT', `/sales/quotes/${q2.id}/season`, { version: q2.version + 1, seasonId: sid('intake:season:B:FW27') }, 400))).toEqual(['body/seasonId'])
    const copy = await ok('sales', 'POST', `/sales/quotes/${q2.id}/duplicate`, {}, 201)
    const copied = await one<Json>(`SELECT v."seasonId" FROM "QuoteVersion" v JOIN "Quote" q ON q.id = v."quoteId" WHERE q.id = $1`, [copy.quote.id])
    expect(copied.seasonId).toBe(S.ss28)
    expect(await outbox('quote.season_changed', q2.id)).toEqual([expect.objectContaining({ seasonId: S.ss28, code: 'SS28' })])
  })
})

// ---- priority (SAL-207) ---------------------------------------------------------------------------------------------------

let orderA: Json
let orderB: Json

describe('priority and the urgent flag (SAL-207)', () => {
  it('a typed order names its season and priority; urgent needs its reason', async () => {
    expect(paths(await no('sales', 'POST', '/sales/orders/manual', typed('PO-303-A', { priorityLevel: 'URGENT' }), 400))).toEqual(['body/urgentReason'])
    expect((await no('sales', 'POST', '/sales/orders/manual', typed('PO-303-A', { seasonId: S.fw26 }), 409)).message).toBe('Season FW26 is closed: name an open season, or reopen it first.')
    orderA = (await ok('sales', 'POST', '/sales/orders/manual', typed('PO-303-A', { seasonId: S.fw27, priorityLevel: 'HIGH' }), 201)).order
    expect(await orderRow(orderA.id)).toMatchObject({ status: 'CONFIRMED', seasonId: S.fw27, priorityLevel: 'HIGH', urgentReason: null })
    orderB = (await ok('sales', 'POST', '/sales/orders/manual', typed('PO-303-B'), 201)).order
  })

  it('sets the level at the version read, the reason with URGENT only; the record and the list read it', async () => {
    const row = await orderRow(orderA.id)
    expect(paths(await no('sales', 'PUT', `/sales/orders/${orderA.id}/priority`, { version: row.version, priorityLevel: 'LOW', urgentReason: 'Not with LOW' }, 400))).toEqual(['body/urgentReason'])
    const set = await ok('sales', 'PUT', `/sales/orders/${orderA.id}/priority`, { version: row.version, priorityLevel: 'URGENT', urgentReason: 'Made-up race on Sunday', priority: 5 })
    expect(set.priority).toMatchObject({ changed: true, priorityLevel: 'URGENT', urgentReason: 'Made-up race on Sunday', priority: 5, version: row.version + 1 })
    await no('sales', 'PUT', `/sales/orders/${orderA.id}/priority`, { version: row.version, priorityLevel: 'LOW' }, 409)
    await no('reader', 'PUT', `/sales/orders/${orderA.id}/priority`, { version: row.version + 1, priorityLevel: 'LOW' }, 403)
    expect(await outbox('sales_order.priority_changed', orderA.id)).toEqual([expect.objectContaining({ from: 'HIGH', to: 'URGENT', priority: 5, urgent: true })])
    const depth = await ok('reader', 'GET', `/sales/orders/${orderA.id}/depth`)
    expect(depth).toMatchObject({ priority: { level: 'URGENT', urgentReason: 'Made-up race on Sunday', number: 5 }, season: { code: 'FW27' }, waiting: null })
    const rows = await ok('reader', 'GET', `/sales/orders/depth?orderIds=${orderA.id},${orderB.id}`)
    expect(rows.orders.map((entry: Json) => [entry.number, entry.priority.level, entry.season?.code ?? null])).toEqual([
      [orderA.number, 'URGENT', 'FW27'],
      [orderB.number, 'NORMAL', null],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
  })

  it('"Set priority" on a selection: one command, a closed order named with why', async () => {
    const result = await ok('sales', 'POST', '/sales/orders/priority', { orderIds: [orderA.id, orderB.id], priorityLevel: 'HIGH' })
    expect(result).toMatchObject({ priorityLevel: 'HIGH', changed: expect.arrayContaining([orderA.id, orderB.id]), skipped: [], unknown: 0 })
    expect((await orderRow(orderA.id)).urgentReason).toBeNull()
    expect(paths(await no('sales', 'POST', '/sales/orders/priority', { orderIds: [orderA.id], priorityLevel: 'URGENT' }, 400))).toEqual(['body/urgentReason'])
  })
})

// ---- the confirmation (SAL-208) ---------------------------------------------------------------------------------------------

describe('the order confirmation (SAL-208)', () => {
  it('keeps version 1; the same contents give it back; a printed change makes it out of date', async () => {
    const first = await ok('sales', 'POST', `/sales/orders/${orderA.id}/confirmation`, {}, 201)
    expect(first).toMatchObject({ made: true, version: 1, confirmation: { upToDate: true, sentAt: null, versions: [expect.objectContaining({ version: 1, number: `${orderA.number} v1`, sent: false })] } })
    const file = await one<Json>(`SELECT "recordType", "recordId", "contentType", visibility::text[] AS visibility FROM "StoredFile" WHERE id = $1`, [first.fileId])
    expect(file).toMatchObject({ recordType: 'SalesOrder', recordId: orderA.id, contentType: 'application/pdf' })
    expect(file.visibility).toEqual(expect.arrayContaining(['OFFICE', 'PARTNER']))
    const again = await ok('sales', 'POST', `/sales/orders/${orderA.id}/confirmation`, {}, 201)
    expect(again).toMatchObject({ made: false, version: 1, fileId: first.fileId })
    const row = await orderRow(orderA.id)
    await ok('sales', 'PUT', `/sales/orders/${orderA.id}/season`, { version: row.version, seasonId: S.ss28 })
    expect((await ok('reader', 'GET', `/sales/orders/${orderA.id}/confirmation`)).confirmation.upToDate).toBe(false)
    expect(await outbox('sales_order.confirmation_made', orderA.id)).toEqual([expect.objectContaining({ version: 1, fileId: first.fileId })])
  })

  it('sends a new version on the order thread (the FAKE mail account), then sentAt and the version together', async () => {
    const sent = await ok('sales', 'POST', `/sales/orders/${orderA.id}/confirmation/send`, { to: ['buyer.p1@example.com'] }, 201)
    expect(sent).toMatchObject({ version: 2, made: true, confirmation: { sentVersion: 2, upToDate: true } })
    expect(sent.confirmation.sentAt).not.toBeNull()
    const outbound = await one<Json>(`SELECT subject, "recordType", "recordId", "to" FROM "EmailOutbound" WHERE id = $1`, [sent.outboundId])
    expect(outbound).toMatchObject({ recordType: 'SalesOrder', recordId: orderA.id, to: ['buyer.p1@example.com'] })
    expect(outbound.subject).toContain(`${orderA.number} v2`)
    expect(await orderRow(orderA.id)).toMatchObject({ confirmationVersion: 2 })
    expect(await outbox('sales_order.confirmation_sent', orderA.id)).toEqual([expect.objectContaining({ version: 2, outboundId: sent.outboundId })])
    await no('reader', 'POST', `/sales/orders/${orderA.id}/confirmation`, {}, 403)
  })
})

// ---- an order waiting for a yes (SAL-205) -----------------------------------------------------------------------------------

let ruleId: string

describe('orders waiting for a yes (SAL-205)', () => {
  let waiting: Json

  it('lists SALES_ORDER as a registered kind; with no rule on an order goes on as today', async () => {
    const kinds = await ok('owner', 'GET', '/approvals/kinds')
    expect(kinds.kinds.find((kind: Json) => kind.kind === 'SALES_ORDER')).toMatchObject({ recordType: 'SalesOrder', label: { en: 'Sales order' } })
    expect(kinds.notRegistered).not.toContain('SALES_ORDER')
    expect((await orderRow(orderB.id)).status).toBe('CONFIRMED')
  })

  it('a rule on: a typed order is made PENDING_APPROVAL with its request; its confirmation waits; the asker may not decide', async () => {
    const rule = (await ok('owner', 'POST', '/approvals/rules', { kind: 'SALES_ORDER', companyId: A.companyA, name: 'Every order over 1 (made-up)', condition: { combinator: 'and', rows: [{ id: 'r1', field: 'orderValue', operator: 'gt', value: '1' }] }, approver: { roleId: financeRoleId }, sequence: 3, dueHours: 24 }, 201)).rule
    ruleId = rule.id
    await ok('owner', 'PUT', `/approvals/rules/${rule.id}`, { version: rule.version, active: true })
    waiting = (await ok('sales', 'POST', '/sales/orders/manual', typed('PO-303-W1'), 201)).order
    expect(waiting.status).toBe('PENDING_APPROVAL')
    const tasks = await tasksOf(waiting.id)
    expect(tasks).toEqual([expect.objectContaining({ status: 'PENDING', requestedById: PEOPLE.sales })])
    const state = await ok('sales', 'GET', `/sales/orders/${waiting.id}/approval`)
    expect(state).toMatchObject({ waiting: true, reasons: [expect.objectContaining({ reason: 'REQUEST_PENDING' })], creditHold: null, may: { ask: false, withdraw: true } })
    expect(state.requests[0]).toMatchObject({ status: 'PENDING', approver: 'Finance', mine: true })
    expect((await no('sales', 'POST', `/sales/orders/${waiting.id}/confirmation`, {}, 409)).message).toMatch(/waits for a yes/)
    const own = await call('sales', 'POST', `/approvals/tasks/${tasks[0]!.id}/approve`, { version: tasks[0]!.version })
    expect([403, 409]).toContain(own.statusCode)
  })

  it("Finance's yes: CONFIRMED and sales_order.status_changed {PENDING_APPROVAL → CONFIRMED}", async () => {
    const [task] = await tasksOf(waiting.id)
    await ok('finance', 'POST', `/approvals/tasks/${task!.id}/approve`, { version: task!.version })
    expect((await orderRow(waiting.id)).status).toBe('CONFIRMED')
    expect(await outbox('sales_order.status_changed', waiting.id)).toEqual([expect.objectContaining({ from: 'PENDING_APPROVAL', to: 'CONFIRMED', by: 'person' })])
  })

  it('a no cancels the waiting order with the reason; a withdrawn request is asked again by another person', async () => {
    const second = (await ok('sales', 'POST', '/sales/orders/manual', typed('PO-303-W2'), 201)).order
    const [task] = await tasksOf(second.id)
    await ok('finance', 'POST', `/approvals/tasks/${task!.id}/reject`, { version: task!.version, reasonCode: 'NEEDS_CHANGES', reason: 'Made-up: the customer wants other sizes.' })
    expect(await orderRow(second.id)).toMatchObject({ status: 'CANCELLED', cancelReason: 'Turned down (sales order request): Made-up: the customer wants other sizes.' })
    const third = (await ok('sales', 'POST', '/sales/orders/manual', typed('PO-303-W3'), 201)).order
    await no('sales2', 'POST', `/sales/orders/${third.id}/approval/withdraw`, {}, 403)
    expect((await ok('sales', 'POST', `/sales/orders/${third.id}/approval/withdraw`, { words: 'Made-up: asked too early.' })).withdrawn).toBe(1)
    const state = await ok('sales2', 'GET', `/sales/orders/${third.id}/approval`)
    expect(state).toMatchObject({ waiting: true, reasons: [expect.objectContaining({ reason: 'NO_REQUEST' })], may: { ask: true } })
    const asked = await ok('sales2', 'POST', `/sales/orders/${third.id}/approval`, { note: 'Made-up: sizes checked.' }, 201)
    expect((await tasksOf(third.id)).map((row) => row.status)).toEqual(['WITHDRAWN', 'PENDING'])
    expect((await no('sales2', 'POST', `/sales/orders/${third.id}/approval`, {}, 409)).message).toBe('A yes is asked on this order already.')
    // Cancelled while waiting (W1's cancel): its request can no longer be approved (the order is not waiting any more).
    await ok('sales', 'POST', `/sales/orders/${third.id}/cancel`, { version: (await orderRow(third.id)).version, reason: 'Made-up: the customer withdrew.' })
    const pending = (await tasksOf(third.id)).find((row) => row.id === asked.taskId)!
    const late = await call('finance', 'POST', `/approvals/tasks/${pending.id}/approve`, { version: pending.version })
    expect(late.statusCode).toBe(409)
    // The rule off again for what follows.
    const rule = await one<{ version: number }>(`SELECT version FROM "ApprovalRule" WHERE id = $1`, [ruleId])
    await ok('owner', 'PUT', `/approvals/rules/${ruleId}`, { version: rule.version, active: false })
  })
})

// ---- the office's order of an accepted quote (SO1:02, SAL-277) -----------------------------------------------------------------

let fromQuote: Json

describe("the office's order of an accepted quote: the season goes with it, a cell outside the released scope is refused (SO1:02)", () => {
  let versionId: string

  it('refuses a size the released revision does not cover, in the rule\'s words; makes it once the scope covers it, with the season', async () => {
    let quote = (await ok('sales', 'POST', '/sales/quotes', { companyId: A.companyA, partyId: p1, customerRef: 'PO-303-Q' }, 201)).quote
    quote = (await ok('sales', 'POST', `/sales/quotes/${quote.id}/lines`, { version: quote.version, styleId: jkt02.styleId, colourwayId: jkt02.colourwayId, unitPrice: '100', sizes: jkt02.sizes.slice(0, 2).map((size) => ({ size, quantity: 2 })) }, 201)).quote
    quote = (await ok('sales', 'POST', `/sales/quotes/${quote.id}/lines`, { version: quote.version, styleId: red.styleId, colourwayId: red.colourwayId, unitPrice: '110', sizes: red.sizes.slice(0, 2).map((size) => ({ size, quantity: 1 })) }, 201)).quote
    await ok('sales', 'PUT', `/sales/quotes/${quote.id}/season`, { version: quote.version, seasonId: S.fw27 })
    versionId = quote.current.id
    const accepted = await one<Json>(`SELECT v."billTo", v."shipTo" FROM "QuoteVersion" v JOIN "Quote" q ON q.id = v."quoteId" WHERE q."tenantId" = $1 AND q.number = 'SEED-Q-0001'`, [A.tenant])
    await force(`UPDATE "QuoteVersion" SET status = 'ACCEPTED', "billTo" = $2, "shipTo" = $3 WHERE id = $1`, [versionId, accepted.billTo, accepted.shipTo])
    await force(`UPDATE "Quote" SET status = 'ACCEPTED' WHERE id = $1`, [quote.id])
    const line = await one<{ revisionId: string | null; scope: string[] }>(`SELECT l."styleRevisionId" AS "revisionId", r."releasedSizes" AS scope FROM "QuoteLine" l LEFT JOIN "StyleRevision" r ON r.id = l."styleRevisionId" WHERE l."versionId" = $1 ORDER BY l.seq LIMIT 1`, [versionId])
    expect(line.revisionId).not.toBeNull()
    // The released revision covers only the first size now (made-up narrowing; put back below).
    await force(`UPDATE "StyleRevision" SET "releasedSizes" = $2 WHERE id = $1`, [line.revisionId, [jkt02.sizes[0]]])
    const refused = await no('sales', 'POST', '/sales/orders', { quoteVersionId: versionId }, 409)
    expect(paths(refused)).toContain('line-rule/OUTSIDE_RELEASED_SCOPE')
    expect(await admin(`SELECT id FROM "SalesOrder" WHERE "quoteVersionId" = $1`, [versionId])).toEqual([])
    await force(`UPDATE "StyleRevision" SET "releasedSizes" = $2 WHERE id = $1`, [line.revisionId, line.scope])
    fromQuote = (await ok('sales', 'POST', '/sales/orders', { quoteVersionId: versionId }, 201)).order
    expect(await orderRow(fromQuote.id)).toMatchObject({ status: 'CONFIRMED', quoteVersionId: versionId, seasonId: S.fw27, customerRef: 'PO-303-Q' })
  })

  it('an amendment that adds a size outside the released scope is refused too', async () => {
    const line = await one<{ revisionId: string; scope: string[] }>(`SELECT l."styleRevisionId" AS "revisionId", r."releasedSizes" AS scope FROM "SalesOrderLine" l JOIN "StyleRevision" r ON r.id = l."styleRevisionId" WHERE l."orderId" = $1 ORDER BY l.seq LIMIT 1`, [fromQuote.id])
    const lines = await admin<Json>(`SELECT id, seq FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq`, [fromQuote.id])
    await force(`UPDATE "StyleRevision" SET "releasedSizes" = $2 WHERE id = $1`, [line.revisionId, [jkt02.sizes[0]]])
    const row = await orderRow(fromQuote.id)
    const refused = await no('sales', 'POST', `/sales/orders/${fromQuote.id}/amendments`, { version: row.version, reason: 'Made-up: one more in the second size.', lines: [{ id: lines[0]!.id, sizes: jkt02.sizes.slice(0, 2).map((size) => ({ size, quantity: 3 })) }, { id: lines[1]!.id }] }, 400)
    expect(refused.issues.map((issue: Json) => issue.message).join(' ')).toMatch(/released/i)
    await force(`UPDATE "StyleRevision" SET "releasedSizes" = $2 WHERE id = $1`, [line.revisionId, line.scope])
  })
})

// ---- several orders from one (SAL-201) ----------------------------------------------------------------------------------------

describe('several orders from one quote (SAL-201)', () => {
  it('splits a whole line (to another delivery address) and some sizes of another into two orders; the order keeps the rest', async () => {
    const before = await orderRow(fromQuote.id)
    const lines = await admin<Json>(`SELECT id, seq, "colourwayId" FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq`, [fromQuote.id])
    const address = await one<{ id: string }>(`SELECT id FROM "PartyAddress" WHERE "partyId" = $1 AND status = 'ACTIVE' AND ("approvalStatus" IS NULL OR "approvalStatus" = 'APPROVED') ORDER BY "createdAt", id LIMIT 1`, [p1])
    const split = await ok(
      'sales',
      'POST',
      `/sales/orders/${fromQuote.id}/split`,
      { version: before.version, parts: [{ lines: [{ lineId: lines[1]!.id }], shipToAddressId: address.id, customerRef: 'PO-303-Q-2' }, { lines: [{ lineId: lines[0]!.id, sizes: [{ size: jkt02.sizes[1], quantity: 1 }] }], promiseDate: '2099-01-15' }] },
      201,
    )
    expect(split.orders).toHaveLength(2)
    expect(split.amendment.revision).toBe(1)
    const [second, third] = await Promise.all(split.orders.map((entry: Json) => orderRow(entry.id)))
    expect(second).toMatchObject({ status: 'CONFIRMED', quoteVersionId: fromQuote.quoteVersionId ?? before.quoteVersionId, seasonId: S.fw27, customerRef: 'PO-303-Q-2' })
    expect(third).toMatchObject({ status: 'CONFIRMED', quoteVersionId: before.quoteVersionId, customerRef: 'PO-303-Q' })
    const after = await orderRow(fromQuote.id)
    expect(after.netAmount + second!.netAmount + third!.netAmount).toBe(before.netAmount)
    const kept = await admin<Json>(`SELECT l.seq, s.size, s.quantity FROM "SalesOrderLineSize" s JOIN "SalesOrderLine" l ON l.id = s."lineId" WHERE l."orderId" = $1 ORDER BY l.seq, s.size`, [fromQuote.id])
    expect(kept.map((row) => [row.seq, row.size, row.quantity])).toEqual([[10, jkt02.sizes[0], 2], [10, jkt02.sizes[1], 1]])
    const amendment = await one<Json>(`SELECT revision, "reacceptanceNeeded", reason FROM "SalesOrderAmendment" WHERE "orderId" = $1`, [fromQuote.id])
    expect(amendment).toMatchObject({ revision: 1, reacceptanceNeeded: false })
    expect(amendment.reason).toContain(split.orders[0].number)
    expect(await outbox('sales_order.split', fromQuote.id)).toEqual([expect.objectContaining({ newOrderIds: split.orders.map((entry: Json) => entry.id), revision: 1 })])
    const depth = await ok('reader', 'GET', `/sales/orders/${fromQuote.id}/depth`)
    expect(depth.sameQuote.map((entry: Json) => entry.id).sort()).toEqual(split.orders.map((entry: Json) => entry.id).sort())
  })

  it('refuses in words: everything moved, more than the order has, a stale version', async () => {
    const row = await orderRow(fromQuote.id)
    const lines = await admin<Json>(`SELECT id FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq`, [fromQuote.id])
    expect((await no('sales', 'POST', `/sales/orders/${fromQuote.id}/split`, { version: row.version, parts: [{ lines: [{ lineId: lines[0]!.id }] }] }, 400)).message).toBe('The order keeps at least one line: move less, or change the order itself.')
    expect(paths(await no('sales', 'POST', `/sales/orders/${fromQuote.id}/split`, { version: row.version, parts: [{ lines: [{ lineId: lines[0]!.id, sizes: [{ size: jkt02.sizes[0], quantity: 9 }] }] }] }, 400))).toEqual(['body/parts/0/lines/0/sizes/0/quantity'])
    await no('sales', 'POST', `/sales/orders/${fromQuote.id}/split`, { version: row.version - 1, parts: [{ lines: [{ lineId: lines[0]!.id, sizes: [{ size: jkt02.sizes[0], quantity: 1 }] }] }] }, 409)
    await no('reader', 'POST', `/sales/orders/${fromQuote.id}/split`, { version: row.version, parts: [{ lines: [{ lineId: lines[0]!.id, sizes: [{ size: jkt02.sizes[0], quantity: 1 }] }] }] }, 403)
  })
})

// ---- import orders from a sheet (SAL-215) -------------------------------------------------------------------------------------

const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
async function upload(session: string, body: Buffer): Promise<Json> {
  const started = await call(session, 'POST', '/imports', { importerKey: 'sales.orders', companyId: A.companyA, file: { originalName: 'orders.csv', contentType: SHEET_TYPES.csv, sizeBytes: body.length, sha256: sha256(body) } })
  expect(started.statusCode, started.body).toBe(201)
  const { job, upload: presigned } = started.json() as { job: Json; upload: { url: string; headers: Record<string, string> } }
  const sent = await app.inject({ method: 'PUT', url: presigned.url, headers: presigned.headers, payload: body })
  expect(sent.statusCode, sent.body).toBe(200)
  expect((await call(session, 'POST', `/files/${job.fileId}/complete`)).statusCode).toBe(200)
  await planImport(system(), job.id, { lastAttempt: true })
  return (await call(session, 'GET', `/imports/${job.id}`)).json().job
}
const rowsOf = async (session: string, jobId: string): Promise<Json[]> => (await call(session, 'GET', `/imports/${jobId}/rows`)).json().rows

describe('import orders from a sheet (SAL-215)', () => {
  const sheet = () =>
    Buffer.from(
      [
        'Ordine;Cliente;Modello;Colore;Taglia;Quantità;PO cliente;Stagione',
        `1;SEED-C1;${'?'};BLK;${blk.sizes[0]};2;PO-303-IMP;FW27`,
        `1;SEED-C1;${'?'};BLK;${blk.sizes[1]};3;PO-303-IMP;FW27`,
        `2;SEED-C1;${'?'};RED;${red.sizes[0]};1;PO-303-IMP-2;FW26`,
      ].join('\r\n'),
      'utf8',
    )
  let body: Buffer

  it('the dry run plans one order per reference and names a closed season in words', async () => {
    const style = await one<{ code: string }>(`SELECT code FROM "Style" WHERE id = $1`, [blk.styleId])
    body = Buffer.from(sheet().toString('utf8').replaceAll('?', style.code), 'utf8')
    const job = await upload('sales', body)
    expect(job).toMatchObject({ status: 'PLANNED', rowCount: 3, createCount: 2, errorCount: 1 })
    const rows = await rowsOf('sales', job.id)
    expect(rows[2]!.errors[0].message).toBe('Season FW26 is closed: name an open season.')
    const applied = await call('sales', 'POST', `/imports/${job.id}/apply`, { version: job.version })
    expect(applied.statusCode, applied.body).toBe(200)
    await applyPlan(system(), job.id, { lastAttempt: true })
    const order = await one<Json>(`SELECT id, status::text AS status, "seasonId", "internalNote" FROM "SalesOrder" WHERE "tenantId" = $1 AND "customerRef" = 'PO-303-IMP'`, [A.tenant])
    expect(order).toMatchObject({ status: 'CONFIRMED', seasonId: S.fw27 })
    const sizes = await admin<Json>(`SELECT s.size, s.quantity FROM "SalesOrderLineSize" s JOIN "SalesOrderLine" l ON l.id = s."lineId" WHERE l."orderId" = $1 ORDER BY s.size`, [order.id])
    expect(sizes.map((row) => [row.size, row.quantity])).toEqual([[blk.sizes[0], 2], [blk.sizes[1], 3]])
    expect(await admin(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND "customerRef" = 'PO-303-IMP-2'`, [A.tenant])).toEqual([])
  })

  it('the same sheet again: the order imported before is refused by its PO number', async () => {
    const job = await upload('sales', body)
    const rows = await rowsOf('sales', job.id)
    expect(rows[0]!.action).toBe('ERROR')
    expect(rows[0]!.errors[0].message).toMatch(/PO-303-IMP is SO-|is .* already/)
  })
})
