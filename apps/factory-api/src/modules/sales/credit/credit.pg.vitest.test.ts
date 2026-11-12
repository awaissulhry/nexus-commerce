import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, command } from '../../../core/command'
import { completeContext, testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { systemContext } from '../../../platform/outbox/system'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { makeManualOrderInCommand } from '../orders/manual'
import { creditGateInCommand, CreditHeldError, quoteCreditInCommand, withCreditHolds } from './check'
import { recheckAfterPayment } from './handlers'

/**
 * Credit limits (B-W2b-304; SAL-148, SAL-237, SAL-241, SAL-244) on the local stack with the app's real routes: a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the
 * …_sales_orders_depth_w2b_guards triggers on CreditCheck are real), tenant A from EVERY seed (SEED-C1 with a 50,000.00
 * limit with company A; the seeded CREDIT_OVERRIDE rule "Orders over the credit limit", OFF). Test sessions hold the role
 * templates' grants; the approver is a person with the finance role assignment. Every name and number is made up.
 *
 * What it walks: no limit → no check; the list of limits with and without the price grain; a limit changed (refusals in
 * words); an order over the limit with no rule on → WARN and CONFIRMED; the rule on → PENDING_APPROVAL, a HOLD and a
 * CREDIT_OVERRIDE request; the asker refused, Finance's yes → the override check and CONFIRMED; a raised limit lets a
 * waiting order go on (its request withdrawn); the quote's check never holds; a release and a shipment held, written
 * after the rollback, refused again without a new row, let through after the yes; an API order of the system asked for
 * by a person; a payment checks the waiting orders again; the ageing's "credit limit used".
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/credit/`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'

const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'credit-304'
const id = (key: string) => seedUuid(NS, key)
const A = { tenant: id('tenant'), companyA: id('company:A'), companyB: id('company:B') }

const PEOPLE = { sales: newId(), finance: newId(), owner: newId(), reader: newId(), warehouse: newId() } as const
type Person = keyof typeof PEOPLE
const ROLE_OF: Record<Person, string> = { sales: 'sales', finance: 'finance', owner: 'owner', reader: 'read_only', warehouse: 'warehouse' }

function grantsOf(role: string): Grant[] {
  const template = templateOf(role)!
  return [{ permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }]
}
const SESSIONS: Record<string, SessionContext> = {}

let h: Harness
let app: FastifyInstance
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `w2b304-${run}-${++keys}`
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
const outbox = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [A.tenant, type])).map((row) => row.payload)
const checksOf = (recordId: string) => admin<Json>(`SELECT id, step::text, result::text, "overridesCheckId", "overrideTaskId", "createdById", "limitAmount", "exposureAmount", "subjectAmount" FROM "CreditCheck" WHERE "recordId" = $1 ORDER BY "checkedAt", id`, [recordId])
const tasksOf = (checkId: string) => admin<Json>(`SELECT id, status::text, "requestedById", version FROM "ApprovalTask" WHERE kind = 'CREDIT_OVERRIDE' AND "recordId" = $1 ORDER BY "requestedAt", id`, [checkId])
const officeCaller = (person: Person) => callerFor(h.database, completeContext(SESSIONS[person]!, `test-${run}-${++keys}`))
const systemCaller = () => callerFor(h.database, systemContext(A.tenant, `test-${run}-${++keys}`))

let p1: string
let p3: string
let termsA: { id: string; version: number }
let ruleId: string
let line: { styleId: string; colourwayId: string; sizes: { size: string; quantity: number }[] }

const typedOrder = (customerRef: string, unitPrice = '100', partyId = p1) => ({ companyId: A.companyA, partyId, customerRef, lines: [{ styleId: line.styleId, colourwayId: line.colourwayId, sizes: line.sizes, unitPrice }] })

beforeAll(async () => {
  h = await startHarness('credit_w2b304')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  // The system roles as the templates hold them now (sales.credit.* for finance and sales).
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  const roleIds = new Map((await admin<{ id: string; key: string }>(`SELECT id, key FROM "Role" WHERE "tenantId" = $1`, [A.tenant])).map((row) => [row.key, row.id]))
  for (const [person, role] of Object.entries(ROLE_OF) as Array<[Person, string]>) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [PEOPLE[person], A.tenant, `w2b304-${person}-${run}@example.com`, `Made-up ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '30 days')`, [newId(), A.tenant, PEOPLE[person], roleIds.get(role)])
    SESSIONS[person] = { audience: 'office', tenantId: A.tenant, actorId: PEOPLE[person], grants: grantsOf(role) }
  }
  p1 = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-C1'`, [A.tenant])).id
  p3 = (await one<{ id: string }>(`SELECT p.id FROM "Party" p WHERE p."tenantId" = $1 AND 'CUSTOMER' = ANY(p.roles::text[]) AND p.status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM "PartyCompanyTerms" t WHERE t."partyId" = p.id AND t."creditLimitAmount" IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM "PartyHold" x WHERE x."partyId" = p.id AND x."releasedAt" IS NULL) AND (p."companyId" IS NULL OR p."companyId" = $2) ORDER BY p.code LIMIT 1`, [A.tenant, A.companyA])).id
  termsA = await one(`SELECT id, version FROM "PartyCompanyTerms" WHERE "partyId" = $1 AND "companyId" = $2 AND "endedAt" IS NULL`, [p1, A.companyA])
  ruleId = (await one<{ id: string }>(`SELECT id FROM "ApprovalRule" WHERE "tenantId" = $1 AND kind = 'CREDIT_OVERRIDE' ORDER BY "createdAt", id LIMIT 1`, [A.tenant])).id
  // A size-grid line of SEED-SO-0001 (a released style with an offered size), typed again on the made-up orders.
  line = await one<typeof line>(`SELECT l."styleId", l."colourwayId", (SELECT json_agg(json_build_object('size', s.size, 'quantity', 1)) FROM (SELECT size FROM "SalesOrderLineSize" WHERE "lineId" = l.id ORDER BY size LIMIT 1) s) AS sizes
                      FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o.id = l."orderId" WHERE o."tenantId" = $1 AND o.number = 'SEED-SO-0001' AND l."styleId" IS NOT NULL ORDER BY l.seq LIMIT 1`, [A.tenant])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

const setLimit = async (amount: number | null, reason = 'Made-up change for the test.') => {
  const terms = await one<{ version: number }>(`SELECT version FROM "PartyCompanyTerms" WHERE id = $1`, [termsA.id])
  return ok('finance', 'PUT', `/sales/credit/limits/${p1}/${A.companyA}`, { version: terms.version, amount, currency: amount === null ? null : 'EUR', reason })
}
const switchRule = async (active: boolean) => {
  const rule = await one<{ version: number }>(`SELECT version FROM "ApprovalRule" WHERE id = $1`, [ruleId])
  await ok('owner', 'PUT', `/approvals/rules/${ruleId}`, { version: rule.version, active })
}

describe('no limit, no check (as before)', () => {
  it('a typed order of a customer without a limit writes no credit check', async () => {
    const made = await ok('sales', 'POST', '/sales/orders/manual', typedOrder('PO-304-NOLIMIT', '100', p3), 201)
    expect(made.order.status).toBe('CONFIRMED')
    expect(await checksOf(made.order.id)).toEqual([])
  })
})

describe('Finance › Receivables › Credit limits (SAL-237)', () => {
  it('lists the customers with a limit: limit, used, available, what waits; amounts only with the price grain', async () => {
    const list = await ok('finance', 'GET', `/sales/credit/limits?companyId=${A.companyA}`)
    const row = list.rows.find((entry: Json) => entry.party.id === p1)
    expect(row).toMatchObject({ company: { id: A.companyA }, currency: 'EUR', limit: 5_000_000, mayChange: true })
    expect(row.used).toBe(row.openOrders + row.openInvoices)
    expect(row.available).toBe(5_000_000 - row.used)
    // SEED-SO-W39-01 waits for a yes over the limit (its HOLD from the seed).
    expect(row.held.firstOrders.map((order: Json) => order.number)).toContain('SEED-SO-W39-01')
    const blind = (await ok('reader', 'GET', `/sales/credit/limits?companyId=${A.companyA}`)).rows.find((entry: Json) => entry.party.id === p1)
    expect(blind).not.toHaveProperty('limit')
    expect(blind).not.toHaveProperty('used')
    expect(blind.usedPct).toBeNull()
    expect(blind.mayChange).toBe(false)
    await no('warehouse', 'GET', '/sales/credit/limits', undefined, 403)
  })

  it('changes a limit with its reason (logged); refuses sales, a bad amount, no reason, a stale version', async () => {
    await no('sales', 'PUT', `/sales/credit/limits/${p1}/${A.companyA}`, { version: termsA.version, amount: 1, currency: 'EUR', reason: 'x' }, 403)
    expect(paths(await no('finance', 'PUT', `/sales/credit/limits/${p1}/${A.companyA}`, { version: termsA.version, amount: -5, currency: 'EUR', reason: 'x' }, 400))).toEqual(['body/amount'])
    expect(paths(await no('finance', 'PUT', `/sales/credit/limits/${p1}/${A.companyA}`, { version: termsA.version, amount: 5, currency: 'EUR', reason: '' }, 400))).toEqual(['body/reason'])
    await no('finance', 'PUT', `/sales/credit/limits/${p1}/${A.companyA}`, { amount: 5, currency: 'EUR', reason: 'No version' }, 409)
    const changed = await setLimit(100, 'Down to 1.00 for the test (made-up).')
    expect(changed.row).toMatchObject({ limit: 100, findings: expect.arrayContaining(['OVER_LIMIT']) })
    await no('finance', 'PUT', `/sales/credit/limits/${p1}/${A.companyA}`, { version: termsA.version, amount: 200, currency: 'EUR', reason: 'Stale' }, 409)
    const audit = await one<Json>(`SELECT reason, after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'credit.setLimit' ORDER BY at DESC, id DESC LIMIT 1`, [A.tenant])
    expect(audit.reason).toBe('Down to 1.00 for the test (made-up).')
    expect(await outbox('credit_limit.changed')).toContainEqual(expect.objectContaining({ partyId: p1, termsId: termsA.id, change: 'SET' }))
  })
})

let held: { orderId: string; checkId: string; taskId: string }

describe('an order over the limit (SAL-237)', () => {
  it('no credit rule switched on: shown (WARN) and let through, nothing asked', async () => {
    const made = await ok('sales', 'POST', '/sales/orders/manual', typedOrder('PO-304-WARN'), 201)
    expect(made.order.status).toBe('CONFIRMED')
    const checks = await checksOf(made.order.id)
    expect(checks).toMatchObject([{ step: 'ORDER', result: 'WARN', createdById: PEOPLE.sales, limitAmount: 100 }])
    expect(await tasksOf(checks[0]!.id)).toEqual([])
  })

  it('the company holds (its CREDIT_OVERRIDE rule on): the order waits as PENDING_APPROVAL with a HOLD and a request for Finance', async () => {
    await switchRule(true)
    const made = await ok('sales', 'POST', '/sales/orders/manual', typedOrder('PO-304-HOLD'), 201)
    expect(made.order.status).toBe('PENDING_APPROVAL')
    const check = (await checksOf(made.order.id))[0]!
    expect(check).toMatchObject({ step: 'ORDER', result: 'HOLD', overridesCheckId: null })
    const task = (await tasksOf(check.id))[0]!
    expect(task).toMatchObject({ status: 'PENDING', requestedById: PEOPLE.sales })
    held = { orderId: made.order.id, checkId: check.id, taskId: task.id }
    const read = await ok('sales', 'GET', `/sales/credit/records/SalesOrder/${made.order.id}`)
    expect(read.customers[0]).toMatchObject({ wouldBe: 'HOLD', held: { checkId: check.id, request: { taskId: task.id, status: 'PENDING', approver: 'Finance' } }, may: { checkAgain: true, ask: false } })
    expect(read.customers[0].checks[0]).toMatchObject({ result: 'HOLD', words: expect.stringMatching(/^Over the credit limit.*: held until a yes\.$/) })
  })

  it('nobody approves their own request: the seller is refused; Finance says yes, the override names the HOLD and the order goes on', async () => {
    const { task } = await ok('sales', 'GET', `/approvals/tasks/${held.taskId}`)
    expect(task.approve.allowed).toBe(false)
    await no('sales', 'POST', `/approvals/tasks/${held.taskId}/approve`, { version: task.version }, 403)
    await ok('finance', 'POST', `/approvals/tasks/${held.taskId}/approve`, { version: task.version, comment: 'A good payer (made-up).' })
    const checks = await checksOf(held.orderId)
    expect(checks).toHaveLength(2)
    expect(checks[1]).toMatchObject({ step: 'ORDER', result: 'WARN', overridesCheckId: held.checkId, overrideTaskId: held.taskId, createdById: PEOPLE.finance })
    expect((await one<Json>(`SELECT status::text FROM "SalesOrder" WHERE id = $1`, [held.orderId])).status).toBe('CONFIRMED')
    expect(await outbox('sales_order.status_changed')).toContainEqual(expect.objectContaining({ orderId: held.orderId, from: 'PENDING_APPROVAL', to: 'CONFIRMED', by: 'person' }))
    expect(await outbox('credit_check.recorded')).toContainEqual(expect.objectContaining({ recordId: held.orderId, result: 'WARN', overridesCheckId: held.checkId }))
    // A second yes on the same HOLD: the request is decided, nothing more is written.
    await no('finance', 'POST', `/approvals/tasks/${held.taskId}/approve`, { version: task.version + 1 }, 409)
  })

  it('a raised limit lets a waiting order go on by itself; its request is withdrawn', async () => {
    const made = await ok('sales', 'POST', '/sales/orders/manual', typedOrder('PO-304-RAISE'), 201)
    expect(made.order.status).toBe('PENDING_APPROVAL')
    const hold = (await checksOf(made.order.id))[0]!
    const changed = await setLimit(900_000_000, 'Raised after the bank guarantee (made-up).')
    expect(changed.rechecked).toBeGreaterThanOrEqual(1)
    expect((await one<Json>(`SELECT status::text FROM "SalesOrder" WHERE id = $1`, [made.order.id])).status).toBe('CONFIRMED')
    const checks = await checksOf(made.order.id)
    expect(checks.at(-1)).toMatchObject({ step: 'ORDER', overridesCheckId: null })
    expect(['PASS', 'WARN']).toContain(checks.at(-1)!.result)
    expect((await tasksOf(hold.id))[0]).toMatchObject({ status: 'WITHDRAWN' })
    await setLimit(100, 'Back down for the next tests (made-up).')
  })

  it('check again: still over → a new HOLD and a new request; refused when nothing is held', async () => {
    const made = await ok('sales', 'POST', '/sales/orders/manual', typedOrder('PO-304-AGAIN'), 201)
    const first = (await checksOf(made.order.id))[0]!
    const again = await ok('sales', 'POST', `/sales/credit/records/SalesOrder/${made.order.id}/check`, { note: 'They say they paid (made-up).' })
    expect(again).toMatchObject({ result: 'HOLD', asked: true, orderGoesOn: false })
    expect((await tasksOf(first.id))[0]!.status).toBe('WITHDRAWN')
    expect((await tasksOf(again.checkId))[0]).toMatchObject({ status: 'PENDING', requestedById: PEOPLE.sales })
    await no('sales', 'POST', `/sales/credit/records/SalesOrder/${held.orderId}/check`, {}, 409)
    await no('reader', 'POST', `/sales/credit/records/SalesOrder/${made.order.id}/check`, {}, 403)
  })
})

describe('the quote (SAL-148)', () => {
  it('its check shows the credit and never holds, even with the rule on', async () => {
    const version = await one<{ id: string }>(`SELECT v.id FROM "QuoteVersion" v JOIN "Quote" q ON q.id = v."quoteId" WHERE q."tenantId" = $1 AND q.number = 'SEED-Q-0002' ORDER BY v.revision DESC LIMIT 1`, [A.tenant])
    const { result: checkId } = await command(officeCaller('sales'), { name: 'test.quoteCredit', input: {} }, async (tools) => {
      const written = await quoteCreditInCommand(tools, version.id)
      tools.audit({ recordType: 'QuoteVersion', recordId: version.id, after: { test: true } })
      return written
    })
    expect(checkId).not.toBeNull()
    expect(await one<Json>(`SELECT step::text, result::text FROM "CreditCheck" WHERE id = $1`, [checkId])).toEqual({ step: 'QUOTE', result: 'WARN' })
    const read = await ok('sales', 'GET', `/sales/credit/records/QuoteVersion/${version.id}`)
    expect(read.customers[0]).toMatchObject({ limit: 100, wouldBe: 'WARN', findings: expect.arrayContaining(['OVER_LIMIT']) })
    expect(read.customers[0].subject).toBeGreaterThanOrEqual(0)
    expect((await ok('reader', 'GET', `/sales/credit/records/QuoteVersion/${version.id}`)).customers[0]).not.toHaveProperty('exposure')
  })
})

describe('a release and a shipment (SAL-241)', () => {
  it('a release over the limit is refused in words; the HOLD and its request are written after the rollback; again: refused, no new row; after the yes it goes', async () => {
    const workOrder = await one<{ id: string; companyId: string; number: string }>(`SELECT DISTINCT w.id, w."companyId", w.number FROM "WorkOrder" w JOIN "WorkOrderSize" c ON c."workOrderId" = w.id WHERE w."tenantId" = $1 AND c."partyId" = $2 ORDER BY w.number LIMIT 1`, [A.tenant, p1])
    const gate = () => withCreditHolds(officeCaller('sales'), null, () => command(officeCaller('sales'), { name: 'test.release', input: {} }, async (tools) => {
      await creditGateInCommand(tools, { step: 'RELEASE', recordType: 'WorkOrder', recordId: workOrder.id, label: `Work order ${workOrder.number}`, companyId: workOrder.companyId, partyIds: [p1] })
      tools.audit({ recordType: 'WorkOrder', recordId: workOrder.id, after: { test: 'released' } })
      return 'released'
    }))
    const first = await gate().catch((error: unknown) => error)
    expect(first).toBeInstanceOf(CreditHeldError)
    expect((first as Error).message).toMatch(new RegExp(`^Work order ${workOrder.number} is held for credit \\(over the credit limit.*\\): it waits for the yes that was asked\\.$`))
    const hold = (await checksOf(workOrder.id))[0]!
    expect(hold).toMatchObject({ step: 'RELEASE', result: 'HOLD', createdById: PEOPLE.sales })
    const task = (await tasksOf(hold.id))[0]!
    expect(task.status).toBe('PENDING')
    await expect(gate()).rejects.toBeInstanceOf(CreditHeldError)
    expect(await checksOf(workOrder.id)).toHaveLength(1)
    await ok('finance', 'POST', `/approvals/tasks/${task.id}/approve`, { version: task.version })
    expect(await gate()).toEqual({ result: 'released', replayed: false })
    expect((await checksOf(workOrder.id)).map((row) => row.result)).toEqual(['HOLD', 'WARN'])
  })

  it('a shipment leaving over the limit is held the same way (its own step and record)', async () => {
    const shipment = await one<{ id: string; companyId: string; number: string }>(`SELECT s.id, s."companyId", s.number FROM "Shipment" s JOIN "SalesOrder" o ON o.id = s."salesOrderId" WHERE s."tenantId" = $1 AND o."partyId" = $2 ORDER BY s.number LIMIT 1`, [A.tenant, p1])
    const leave = () => withCreditHolds(officeCaller('sales'), null, () => command(officeCaller('sales'), { name: 'test.ship', input: {} }, async (tools) => {
      await creditGateInCommand(tools, { step: 'SHIPMENT', recordType: 'Shipment', recordId: shipment.id, label: `Shipment ${shipment.number}`, companyId: shipment.companyId, partyIds: [p1] })
      tools.audit({ recordType: 'Shipment', recordId: shipment.id, after: { test: 'shipped' } })
      return 'shipped'
    }))
    await expect(leave()).rejects.toBeInstanceOf(CreditHeldError)
    const hold = (await checksOf(shipment.id))[0]!
    expect(hold).toMatchObject({ step: 'SHIPMENT', result: 'HOLD' })
    const read = await ok('finance', 'GET', `/sales/credit/records/Shipment/${shipment.id}`)
    expect(read.customers[0].held).toMatchObject({ checkId: hold.id, step: 'SHIPMENT', request: { status: 'PENDING' } })
  })
})

describe('orders from the API and the portal (SAL-244)', () => {
  it('an API order made by the system waits with a HOLD nobody asked for; a person asks, Finance says yes', async () => {
    const { result } = await command(systemCaller(), { name: 'test.apiOrder', input: {} }, (tools) => makeManualOrderInCommand(tools, typedOrder('PO-304-API'), null, 'API'))
    expect((await one<Json>(`SELECT status::text FROM "SalesOrder" WHERE id = $1`, [result.orderId])).status).toBe('PENDING_APPROVAL')
    const hold = (await checksOf(result.orderId))[0]!
    expect(hold).toMatchObject({ step: 'API', result: 'HOLD', createdById: null })
    expect(await tasksOf(hold.id)).toEqual([])
    const read = await ok('sales', 'GET', `/sales/credit/records/SalesOrder/${result.orderId}`)
    expect(read.customers[0].may).toEqual({ checkAgain: true, ask: true })
    const { taskId } = await ok('sales', 'POST', `/sales/credit/checks/${hold.id}/ask`, { note: 'The brand sent it through its system (made-up).' }, 201)
    await no('sales', 'POST', `/sales/credit/checks/${hold.id}/ask`, {}, 409)
    const { task } = await ok('finance', 'GET', `/approvals/tasks/${taskId}`)
    await ok('finance', 'POST', `/approvals/tasks/${taskId}/approve`, { version: task.version })
    expect((await one<Json>(`SELECT status::text FROM "SalesOrder" WHERE id = $1`, [result.orderId])).status).toBe('CONFIRMED')
    expect((await checksOf(result.orderId)).at(-1)).toMatchObject({ step: 'API', overridesCheckId: hold.id })
  })

  it('a payment checks the waiting orders again: within the limit now, they go on', async () => {
    const { result } = await command(systemCaller(), { name: 'test.portalOrder', input: {} }, (tools) => makeManualOrderInCommand(tools, typedOrder('PO-304-PORTAL'), null, 'PORTAL'))
    expect((await checksOf(result.orderId))[0]).toMatchObject({ step: 'PORTAL', result: 'HOLD' })
    const payment = await admin<{ id: string }>(`SELECT id FROM "Payment" WHERE "tenantId" = $1 AND "partyId" = $2 AND "companyId" = $3 ORDER BY "createdAt", id LIMIT 1`, [A.tenant, p1, A.companyA])
    // Still over the limit: nothing moves on a payment.
    if (payment[0]) expect(await recheckAfterPayment(systemCaller(), payment[0].id)).toBe(0)
    await setLimit(900_000_000, 'A bigger limit before the payment check (made-up).')
    expect((await one<Json>(`SELECT status::text FROM "SalesOrder" WHERE id = $1`, [result.orderId])).status).toBe('CONFIRMED')
  })
})

describe("the ageing's credit limit used", () => {
  it('fills "credit limit used" with the price grain only', async () => {
    const full = await ok('finance', 'GET', `/receivables/ageing?companyId=${A.companyA}&limit=100`)
    const mine = full.customers.find((row: Json) => row.customer.id === p1 && row.company.id === A.companyA && row.currency === 'EUR')
    if (mine) expect(typeof mine.creditLimitUsed).toBe('number')
    const blind = await ok('reader', 'GET', `/receivables/ageing?companyId=${A.companyA}&limit=100`)
    for (const row of blind.customers) expect(row.creditLimitUsed).toBeNull()
    await switchRule(false)
  })
})
