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
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * Order changes (B-W2b-309; SAL-190, SAL-218, SAL-219, SAL-221, SAL-248, SAL-306; SO2:01) on the local stack with the app's
 * real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and every guard
 * is real), tenant A from EVERY seed (company A's freeze rules: sizes a priced change from cutting and blocked from
 * finishing, prices a priced change from the release …; SEED-SO-W39-02 in production with P1's woven labels; the approvals
 * seed's rules OFF; the caparra penitenziale OFF). Test sessions hold the role templates' grants. Every name and number is
 * made up.
 *
 * What it walks: the company's freeze rules (read, a new rule, one active per field and stage, a later stage never loosening
 * a block, switched off); an order in production (a work order released, one size cut) read field by field and size by size;
 * a plain amendment of a frozen size refused, of an open size taken; a priced change (its parts, fee, the extra deposit of
 * the growth, the customer asked again) and a blocked price refused even priced; the caparra penitenziale refused while off
 * and asked once switched on; a SALES_ORDER_CHANGE rule on (the change asks its yes, one change at a time, the asker may not
 * decide, a no, the put-back, a yes); the customer's own labels (planned from the BOM, received as an owned lot never valued,
 * shared among its orders, one sent back).
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/order-changes/`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'

const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'order-changes-309'
const sid = (key: string) => seedUuid(NS, key)
const A = { tenant: sid('tenant'), companyA: sid('company:A') }

const PEOPLE = { sales: newId(), finance: newId(), owner: newId(), reader: newId(), planner: newId(), warehouse: newId() } as const
type Person = keyof typeof PEOPLE
const ROLE_OF: Record<Person, string> = { sales: 'sales', finance: 'finance', owner: 'owner', reader: 'read_only', planner: 'planner', warehouse: 'warehouse' }

function grantsOf(role: string): Grant[] {
  const template = templateOf(role)!
  return [{ permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }]
}
const SESSIONS: Record<string, SessionContext> = {}

let h: Harness
let app: FastifyInstance
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
const freshKey = () => `w2b309-${run}-${++keys}`
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
const orderRow = (orderId: string) => one<Json>(`SELECT id, number, status::text AS status, version, "netAmount", "grossAmount", "reapprovalNeededAt" FROM "SalesOrder" WHERE id = $1`, [orderId])
const linesOf = (orderId: string) => admin<Json>(`SELECT l.id, l.seq, l."unitPrice"::text AS "unitPrice", (SELECT json_object_agg(s.size, s.quantity) FROM "SalesOrderLineSize" s WHERE s."lineId" = l.id) AS sizes FROM "SalesOrderLine" l WHERE l."orderId" = $1 ORDER BY l.seq`, [orderId])
const changeTasks = (orderId: string) => admin<Json>(`SELECT id, status::text AS status, version FROM "ApprovalTask" WHERE kind = 'SALES_ORDER_CHANGE' AND "recordId" = $1 ORDER BY "requestedAt", id`, [orderId])

let p1: string
let financeRoleId: string
let blk: { styleId: string; colourwayId: string; sizes: string[] }
let red: { styleId: string; colourwayId: string; sizes: string[] }
let redSize: string
let order: Json
let line10: Json
let line20: Json
let cutSize: string
let openSize: string

async function refreshLines(): Promise<void> {
  const lines = await linesOf(order.id)
  line10 = lines[0]!
  line20 = lines[1]!
}
const sizesOf = (line: Json, change: Record<string, number> = {}) => Object.entries(line.sizes as Record<string, number>).map(([size, quantity]) => ({ size, quantity: change[size] ?? quantity }))

beforeAll(async () => {
  h = await startHarness('order_changes_w2b309')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  const roleIds = new Map((await admin<{ id: string; key: string }>(`SELECT id, key FROM "Role" WHERE "tenantId" = $1`, [A.tenant])).map((row) => [row.key, row.id]))
  financeRoleId = roleIds.get('finance')!
  for (const [person, role] of Object.entries(ROLE_OF) as Array<[Person, string]>) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [PEOPLE[person], A.tenant, `w2b309-${person}-${run}@example.com`, `Made-up ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '30 days')`, [newId(), A.tenant, PEOPLE[person], roleIds.get(role)])
    SESSIONS[person] = { audience: 'office', tenantId: A.tenant, actorId: PEOPLE[person], grants: grantsOf(role) }
  }
  p1 = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-C1'`, [A.tenant])).id
  const seedLine = (code: string) =>
    one<{ styleId: string; colourwayId: string; sizes: string[] }>(
      `SELECT l."styleId", l."colourwayId", (SELECT array_agg(s.size ORDER BY s.size) FROM "SalesOrderLineSize" s WHERE s."lineId" = l.id) AS sizes
         FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o.id = l."orderId" JOIN "Colourway" c ON c.id = l."colourwayId" WHERE o."tenantId" = $1 AND o.number = 'SEED-SO-0001' AND c.code = $2 ORDER BY l.seq LIMIT 1`,
      [A.tenant, code],
    )
  blk = await seedLine('BLK')
  red = await seedLine('RED')
  redSize = red.sizes[0]!
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

// ---- the company's freeze rules (SAL-218) -----------------------------------------------------------------------------------

describe("the company's freeze rules (SAL-218)", () => {
  it('reads the seeded rules in words; finance keeps them, one active rule per field and stage, never loosening a block', async () => {
    const list = await ok('reader', 'GET', `/sales/order-freeze-rules?companyId=${A.companyA}`)
    expect(list.mayManage).toBe(false)
    const sizeCut = list.rules.find((rule: Json) => rule.field === 'SIZE_QUANTITY' && rule.frozenFrom === 'CUT')
    expect(sizeCut).toMatchObject({ action: 'CHANGE_REQUEST', active: true, words: { en: 'Cutting started: size frozen' } })
    expect(list.rules.find((rule: Json) => rule.field === 'SHIP_TO' && rule.frozenFrom === 'CUT')).toMatchObject({ active: false })
    await no('sales', 'POST', '/sales/order-freeze-rules', { companyId: A.companyA, field: 'PRICE', frozenFrom: 'CUT', action: 'BLOCKED' }, 403)
    expect((await no('finance', 'POST', '/sales/order-freeze-rules', { companyId: A.companyA, field: 'SIZE_QUANTITY', frozenFrom: 'CUT', action: 'BLOCKED' }, 409)).message).toMatch(/active rule for the sizes and quantities from "cutting started" already/)
    expect((await no('finance', 'POST', '/sales/order-freeze-rules', { companyId: A.companyA, field: 'SIZE_QUANTITY', frozenFrom: 'SHIPPED', action: 'CHANGE_REQUEST' }, 409)).message).toMatch(/cannot open them again/)
    const made = (await ok('finance', 'POST', '/sales/order-freeze-rules', { companyId: A.companyA, field: 'PRICE', frozenFrom: 'CUT', action: 'BLOCKED', note: 'Cut leather is priced: no price change any more (made-up)' }, 201)).rule
    expect(made).toMatchObject({ field: 'PRICE', frozenFrom: 'CUT', action: 'BLOCKED', active: true, updatedBy: 'Made-up finance' })
    expect(await outbox('order_freeze_rule.changed', made.id)).toEqual([expect.objectContaining({ change: 'MADE', action: 'BLOCKED', active: true })])
  })
})

// ---- an order in production read against the rules ---------------------------------------------------------------------------

describe('what is frozen on an order in production (SAL-218)', () => {
  it('reads the stage of each size and the verdict of each field, a cut size locked with its reason', async () => {
    order = (
      await ok('sales', 'POST', '/sales/orders/manual', {
        companyId: A.companyA,
        partyId: p1,
        customerRef: 'PO-309-A',
        depositPct: '30',
        lines: [
          { styleId: blk.styleId, colourwayId: blk.colourwayId, unitPrice: '100', sizes: blk.sizes.slice(0, 2).map((size) => ({ size, quantity: 3 })) },
          { styleId: red.styleId, colourwayId: red.colourwayId, unitPrice: '110', sizes: [{ size: redSize, quantity: 2 }] },
        ],
      }, 201)
    ).order
    await refreshLines()
    cutSize = blk.sizes[0]!
    openSize = blk.sizes[1]!
    // Before production: every field open.
    const before = await ok('reader', 'GET', `/sales/orders/${order.id}/freeze`)
    expect(before.order).toMatchObject({ stage: null, words: { en: 'Not in production yet' } })
    expect(before.lines[0].sizes.every((size: Json) => !size.locked)).toBe(true)
    // A work order of line 10, released; one bundle of the cut size (cutting started).
    const workOrder = await ok('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: line10.id }] }, 201)
    const workOrderId = (workOrder.workOrder ?? workOrder).id as string
    await force(`UPDATE "WorkOrder" SET status = 'RELEASED', "releasedAt" = now() WHERE id = $1`, [workOrderId])
    const cell = await one<Json>(`SELECT id, "siteId" FROM "WorkOrderSize" WHERE "workOrderId" = $1 AND size = $2`, [workOrderId, cutSize])
    await force(`INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity) VALUES ($1, $2, $3, $4, $5, $6, 3)`, [newId(), A.tenant, cell.siteId, workOrderId, cell.id, `B309-${run}`])
    const reading = await ok('reader', 'GET', `/sales/orders/${order.id}/freeze`)
    expect(reading.order.stage).toBe('CUT')
    const first = reading.lines.find((entry: Json) => entry.lineId === line10.id)
    expect(first).toMatchObject({ stage: 'CUT' })
    expect(first.sizes.find((size: Json) => size.size === cutSize)).toMatchObject({ stage: 'CUT', locked: true, state: 'CHANGE_REQUEST', words: { en: 'Cutting started: size frozen' } })
    expect(first.sizes.find((size: Json) => size.size === openSize)).toMatchObject({ stage: 'RELEASED', locked: false, state: 'OPEN' })
    expect(first.fields.find((field: Json) => field.field === 'PRICE')).toMatchObject({ state: 'BLOCKED', words: { en: 'Cut leather is priced: no price change any more (made-up)' } })
    expect(reading.lines.find((entry: Json) => entry.lineId === line20.id)).toMatchObject({ stage: null })
  })

  it('refuses a plain amendment of the cut size (a priced change then); takes one of an open size', async () => {
    const row = await orderRow(order.id)
    const frozen = { version: row.version, reason: 'Made-up: one more in the cut size.', lines: [{ id: line10.id, sizes: sizesOf(line10, { [cutSize]: 4 }) }, { id: line20.id }] }
    const preview = await ok('sales', 'POST', `/sales/orders/${order.id}/amendments/preview`, frozen)
    expect(preview).toMatchObject({ ok: false, problems: [expect.objectContaining({ path: 'body/lines/10/SIZE_QUANTITY' })] })
    const refused = await no('sales', 'POST', `/sales/orders/${order.id}/amendments`, frozen, 409)
    expect(refused.message).toMatch(/^Line 10, size \S+: Cutting started: size frozen — send it as a priced change/)
    const taken = await ok('sales', 'POST', `/sales/orders/${order.id}/amendments`, { ...frozen, reason: 'Made-up: one more in the open size.', lines: [{ id: line10.id, sizes: sizesOf(line10, { [openSize]: 4 }) }, { id: line20.id }] }, 201)
    expect(taken.amendment.revision).toBe(1)
    await refreshLines()
  })
})

// ---- a priced change after the start (SAL-219, SAL-221) ---------------------------------------------------------------------

describe('a priced change after the start, its extra deposit (SAL-219, SAL-221)', () => {
  it('previews the parts, the fee and the extra deposit of the growth (the order 30 %); writes them on the amendment; the customer is asked again', async () => {
    const row = await orderRow(order.id)
    const body = { version: row.version, reason: 'Made-up: two more in the cut size, cut on their own.', lines: [{ id: line10.id, sizes: sizesOf(line10, { [cutSize]: 5 }) }, { id: line20.id }], labels: { [line10.id]: 'Two more jackets, cut on their own (made-up)' }, fee: '25.00' }
    const preview = await ok('sales', 'POST', `/sales/orders/${order.id}/priced-changes/preview`, body)
    expect(preview).toMatchObject({ ok: true, problems: [], parts: [{ label: 'Two more jackets, cut on their own (made-up)', orderLineId: line10.id, amount: 20000 }], feeAmount: 2500, changeAmount: 22500, yes: 'NO_RULE', stage: { stage: 'CUT' } })
    expect(preview.deposit).toMatchObject({ basis: 'ORDER_PERCENT', pct: '30.0000', kind: 'ACCONTO' })
    const applied = await ok('sales', 'POST', `/sales/orders/${order.id}/priced-changes`, body, 201)
    expect(applied.change).toMatchObject({ revision: 2, priced: true, feeAmount: 2500, changeAmount: 22500, yes: { state: 'NOT_ASKED' }, customer: { decision: 'NOT_ASKED' }, putBack: { may: false } })
    expect(applied.change.deposit).toMatchObject({ kind: 'ACCONTO', status: 'OPEN', amount: preview.deposit.amount, pct: '30.0000' })
    const amendment = await one<Json>(`SELECT "priceDeltaLines", "feeAmount", "depositRequestId", "reapprovalTaskId", "reacceptanceNeeded", "grossAmountAfter" - "grossAmountBefore" AS growth FROM "SalesOrderAmendment" WHERE id = $1`, [applied.change.id])
    expect(amendment).toMatchObject({ feeAmount: 2500, reapprovalTaskId: null, reacceptanceNeeded: true })
    expect(amendment.priceDeltaLines).toEqual([{ label: 'Two more jackets, cut on their own (made-up)', orderLineId: line10.id, amount: 20000 }])
    const deposit = await one<Json>(`SELECT "orderId", amount, kind::text AS kind, status::text AS status FROM "DepositRequest" WHERE id = $1`, [amendment.depositRequestId])
    expect(deposit).toMatchObject({ orderId: order.id, kind: 'ACCONTO', status: 'OPEN', amount: Math.round(Number(amendment.growth) * 0.3) })
    expect((await orderRow(order.id)).reapprovalNeededAt).not.toBeNull()
    expect(await outbox('sales_order.change_priced', order.id)).toEqual([expect.objectContaining({ amendmentId: applied.change.id, revision: 2, hasFee: true, depositRequestId: amendment.depositRequestId, reapprovalTaskId: null })])
    expect(await outbox('deposit_request.created_for_order', amendment.depositRequestId)).toEqual([expect.objectContaining({ stepKind: 'DEPOSIT', orderId: order.id })])
    await refreshLines()
  })

  it('refuses a price the rules block even priced, a priced change with no price, and a reader', async () => {
    const row = await orderRow(order.id)
    const blocked = await no('sales', 'POST', `/sales/orders/${order.id}/priced-changes`, { version: row.version, reason: 'Made-up: a new price.', lines: [{ id: line10.id, unitPrice: '90' }, { id: line20.id }], fee: '10.00' }, 409)
    expect(blocked.message).toBe('Line 10: Cut leather is priced: no price change any more (made-up).')
    const nothing = await no('sales', 'POST', `/sales/orders/${order.id}/priced-changes`, { version: row.version, reason: 'Made-up: a note.', lines: [{ id: line10.id, note: 'Made-up note' }, { id: line20.id }] }, 409)
    expect(paths(nothing)).toEqual(['body/fee'])
    await no('reader', 'POST', `/sales/orders/${order.id}/priced-changes/preview`, { lines: [{ id: line10.id }] }, 403)
    // The rule switched off again (PATCH): prices are a priced change from the release only.
    const rule = await one<Json>(`SELECT id, version FROM "OrderFreezeRule" WHERE "companyId" = $1 AND field = 'PRICE' AND "frozenFrom" = 'CUT'`, [A.companyA])
    expect((await ok('finance', 'PATCH', `/sales/order-freeze-rules/${rule.id}`, { version: rule.version, active: false })).rule).toMatchObject({ active: false })
  })
})

// ---- the non-refundable deposit (SAL-248) --------------------------------------------------------------------------------------

describe('the non-refundable deposit, switched off (SAL-248)', () => {
  it('is not offered nor taken while off; once switched on it is asked as the extra deposit, its fiscal rule unconfirmed', async () => {
    const kinds = await ok('reader', 'GET', `/sales/deposit-kinds?companyId=${A.companyA}`)
    expect(kinds.caparraPenitenziale).toEqual({ on: false, source: 'TENANT' })
    expect(kinds.kinds.find((kind: Json) => kind.kind === 'CAPARRA_PENITENZIALE')).toMatchObject({ available: false, why: { en: expect.stringMatching(/switched off until the accountant's wording/) } })
    let row = await orderRow(order.id)
    const body = (version: number, quantity: number) => ({ version, reason: 'Made-up: one more in the open size.', lines: [{ id: line10.id, sizes: sizesOf(line10, { [openSize]: quantity }) }, { id: line20.id }], fee: '5.00', deposit: { pct: '20', kind: 'CAPARRA_PENITENZIALE' } })
    expect(paths(await no('sales', 'POST', `/sales/orders/${order.id}/priced-changes`, body(row.version, 5), 409))).toEqual(['body/deposit/kind'])
    await admin(`UPDATE "SalesSettings" SET "caparraPenitenzialeEnabled" = true WHERE id = $1`, [A.tenant])
    try {
      const applied = await ok('sales', 'POST', `/sales/orders/${order.id}/priced-changes`, body(row.version, 5), 201)
      expect(applied.change.deposit).toMatchObject({ kind: 'CAPARRA_PENITENZIALE', pct: '20.0000' })
      expect(await one<Json>(`SELECT "fiscalDocument"::text AS "fiscalDocument", "fiscalRule" FROM "DepositRequest" WHERE id = $1`, [applied.change.deposit.id])).toEqual({ fiscalDocument: 'NONE', fiscalRule: 'CAPARRA_PENITENZIALE_UNCONFIRMED' })
    } finally {
      await admin(`UPDATE "SalesSettings" SET "caparraPenitenzialeEnabled" = false WHERE id = $1`, [A.tenant])
    }
    row = await orderRow(order.id)
    await refreshLines()
    expect(row.status).toBe('CONFIRMED')
  })
})

// ---- the new yes after an edit (SAL-190) and the put-back --------------------------------------------------------------------

describe('a new yes after an edit of a confirmed order (SAL-190)', () => {
  let ruleId: string

  it('lists SALES_ORDER_CHANGE as a registered kind; a rule on: the change asks its yes, the amendment names it, one change at a time', async () => {
    const kinds = await ok('owner', 'GET', '/approvals/kinds')
    expect(kinds.kinds.find((kind: Json) => kind.kind === 'SALES_ORDER_CHANGE')).toMatchObject({ recordType: 'SalesOrder', label: { en: 'Sales order change' } })
    const rule = (await ok('owner', 'POST', '/approvals/rules', { kind: 'SALES_ORDER_CHANGE', companyId: A.companyA, name: 'Every order that grows (made-up)', condition: { combinator: 'and', rows: [{ id: 'r1', field: 'changeValue', operator: 'gt', value: '0' }] }, approver: { roleId: financeRoleId }, sequence: 3, dueHours: 24 }, 201)).rule
    ruleId = rule.id
    await ok('owner', 'PUT', `/approvals/rules/${rule.id}`, { version: rule.version, active: true })
    const row = await orderRow(order.id)
    const preview = await ok('sales', 'POST', `/sales/orders/${order.id}/priced-changes/preview`, { version: row.version, lines: [{ id: line10.id }, { id: line20.id, sizes: sizesOf(line20, { [redSize]: 3 }) }], deposit: null })
    expect(preview).toMatchObject({ ok: true, yes: 'WOULD_ASK', deposit: null })
    const taken = await ok('sales', 'POST', `/sales/orders/${order.id}/amendments`, { version: row.version, reason: 'Made-up: one more on line 20.', lines: [{ id: line10.id }, { id: line20.id, sizes: sizesOf(line20, { [redSize]: 3 }) }] }, 201)
    const tasks = await changeTasks(order.id)
    expect(tasks).toEqual([expect.objectContaining({ status: 'PENDING' })])
    expect((await one<Json>(`SELECT "reapprovalTaskId" FROM "SalesOrderAmendment" WHERE id = $1`, [taken.amendment.id])).reapprovalTaskId).toBe(tasks[0]!.id)
    const list = await ok('reader', 'GET', `/sales/orders/${order.id}/changes`)
    expect(list.waitingForYes).toMatchObject({ taskId: tasks[0]!.id })
    expect(list.changes[0]).toMatchObject({ id: taken.amendment.id, priced: false, yes: { state: 'WAITING', words: { en: 'Waiting for a yes' } }, putBack: { may: false } })
    const again = await no('sales', 'POST', `/sales/orders/${order.id}/amendments`, { version: (await orderRow(order.id)).version, reason: 'Made-up: and another.', lines: [{ id: line10.id }, { id: line20.id, sizes: sizesOf(line20, { [redSize]: 4 }) }] }, 409)
    expect(again.message).toMatch(/last change waits for its yes/)
    const own = await call('sales', 'POST', `/approvals/tasks/${tasks[0]!.id}/approve`, { version: tasks[0]!.version })
    expect([403, 409]).toContain(own.statusCode)
  })

  it("Finance's no: the change stays written and the order says so; put back, it is as before (an earlier priced change still waits for the customer)", async () => {
    const [task] = await changeTasks(order.id)
    await ok('finance', 'POST', `/approvals/tasks/${task!.id}/reject`, { version: task!.version, reasonCode: 'NEEDS_CHANGES', reason: 'Made-up: not this season.' })
    expect(await outbox('sales_order.change_decided', order.id)).toEqual([expect.objectContaining({ decision: 'REJECTED', taskId: task!.id })])
    const list = await ok('sales', 'GET', `/sales/orders/${order.id}/changes`)
    const turnedDown = list.changes[0]
    expect(turnedDown).toMatchObject({ yes: { state: 'TURNED_DOWN', reason: 'Made-up: not this season.' }, putBack: { may: true, why: null } })
    expect(list.changes[1].putBack).toMatchObject({ may: false, why: 'Only the latest change is put back.' })
    const back = await ok('sales', 'POST', `/sales/orders/${order.id}/changes/${turnedDown.id}/put-back`, { version: (await orderRow(order.id)).version }, 201)
    expect(back.change).toMatchObject({ yes: { state: 'NOT_ASKED' }, customer: { decision: 'NOT_NEEDED' } })
    expect(back.change.reason).toMatch(/^Put back as before revision \d+: its yes was refused\.$/)
    const [, now20] = await linesOf(order.id)
    expect(now20!.sizes).toEqual(line20.sizes)
    expect(await changeTasks(order.id)).toHaveLength(1)
    expect((await orderRow(order.id)).reapprovalNeededAt).not.toBeNull()
    expect((await one<Json>(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'orders.putBackChange'`, [order.id])).after).toMatchObject({ amendmentId: turnedDown.id, depositCancelled: false, reacceptanceCleared: false })
    await no('sales', 'POST', `/sales/orders/${order.id}/changes/${turnedDown.id}/put-back`, { version: (await orderRow(order.id)).version }, 409)
  })

  it("Finance's yes is kept on the order; the rule off again", async () => {
    const row = await orderRow(order.id)
    await ok('sales', 'POST', `/sales/orders/${order.id}/amendments`, { version: row.version, reason: 'Made-up: one more on line 20 after all.', lines: [{ id: line10.id }, { id: line20.id, sizes: sizesOf(line20, { [redSize]: 3 }) }] }, 201)
    const pending = (await changeTasks(order.id)).find((task) => task.status === 'PENDING')!
    await ok('finance', 'POST', `/approvals/tasks/${pending.id}/approve`, { version: pending.version })
    const list = await ok('reader', 'GET', `/sales/orders/${order.id}/changes`)
    expect(list.changes[0].yes).toMatchObject({ state: 'APPROVED' })
    expect(list.waitingForYes).toBeNull()
    expect(await outbox('sales_order.change_decided', order.id)).toEqual([expect.objectContaining({ decision: 'REJECTED' }), expect.objectContaining({ decision: 'APPROVED', taskId: pending.id })])
    const rule = await one<{ version: number }>(`SELECT version FROM "ApprovalRule" WHERE id = $1`, [ruleId])
    await ok('owner', 'PUT', `/approvals/rules/${ruleId}`, { version: rule.version, active: false })
  })
})

// ---- the customer's own materials (SAL-306; SO2:01) ----------------------------------------------------------------------------

describe("the customer's own materials (SAL-306)", () => {
  let w39: Json
  let label: Json
  let location: string
  let site: string
  let lotId: string

  it('reads the labels the brand sends, expected per size from the BOM; planning again changes nothing', async () => {
    w39 = await one(`SELECT id, number, "companyId" FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-W39-02'`, [A.tenant])
    const list = await ok('reader', 'GET', `/sales/orders/${w39.id}/customer-materials`)
    expect(list.rows).toHaveLength(1)
    label = list.rows[0].item
    expect(list.rows[0]).toMatchObject({ received: '0.0000', used: '0.0000', returned: '0.0000', left: '0.0000' })
    expect(Object.keys(list.rows[0].expectedBySize).length).toBeGreaterThan(0)
    const planned = await ok('sales', 'POST', `/sales/orders/${w39.id}/customer-materials/plan`)
    expect(planned.planned).toMatchObject({ made: 0, changed: 0, removed: 0 })
    expect(planned.rows[0].expected).toBe(list.rows[0].expected)
    await no('reader', 'POST', `/sales/orders/${w39.id}/customer-materials/plan`, {}, 403)
  })

  it('receives them from the customer as its own lot, never valued, shared among its orders; refuses goods of a supplier', async () => {
    // The brand's label kept by lot from now on (the seed's is untracked: B-W2b-281's note), with a standard cost the ledger would use.
    await force(`UPDATE "Item" SET tracking = 'LOT', "standardCost" = 1.5 WHERE id = $1`, [label.id])
    const seeded = await one<Json>(`SELECT m."toLocationId" AS location, m."siteId" AS site FROM "StockMove" m JOIN "Lot" l ON l.id = m."lotId" WHERE l.code = 'SEED-LOT-W39-01' AND l."tenantId" = $1`, [A.tenant])
    location = seeded.location
    site = seeded.site
    const supplier = (await one<Json>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND 'SUPPLIER' = ANY(roles) AND NOT ('CUSTOMER' = ANY(roles)) AND NOT ('BRAND' = ANY(roles)) LIMIT 1`, [A.tenant])).id
    expect(paths(await no('warehouse', 'POST', '/inventory/receipts/customer', { siteId: site, partyId: supplier, locationId: location, lines: [{ itemId: label.id, quantity: '10' }] }, 400))).toEqual(['body/partyId'])
    await no('sales', 'POST', '/inventory/receipts/customer', { siteId: site, partyId: p1, locationId: location, lines: [{ itemId: label.id, quantity: '10' }] }, 403)
    const received = await ok('warehouse', 'POST', '/inventory/receipts/customer', { siteId: site, partyId: p1, orderId: w39.id, locationId: location, supplierDdtNumber: 'DDT-P1-309', lines: [{ itemId: label.id, quantity: '10' }] }, 201)
    expect(received.receipt).toMatchObject({ kind: 'CUSTOMER_SUPPLIED', status: 'POSTED', partyId: p1, lines: [expect.objectContaining({ quantity: '10.0000', ownerPartyId: p1 })] })
    lotId = received.receipt.lines[0].lotId
    const move = await one<Json>(`SELECT id FROM "StockMove" WHERE "lotId" = $1 AND reason = 'RECEIPT'`, [lotId])
    expect((await one<Json>(`SELECT count(*)::int AS n FROM "StockValuation" WHERE "moveId" = $1`, [move.id])).n).toBe(0)
    expect(await outbox('inventory.receipt_posted', received.receipt.id)).toEqual([expect.objectContaining({ purchaseOrderId: null, lotIds: [lotId] })])
    const rows = await admin<Json>(`SELECT "orderId", "receivedQuantity"::text AS received FROM "CustomerMaterial" WHERE "partyId" = $1 AND "itemId" = $2`, [p1, label.id])
    expect(rows.reduce((sum, row) => sum + Number(row.received), 0)).toBe(10)
    const list = await ok('reader', 'GET', `/sales/orders/${w39.id}/customer-materials`)
    expect(list.lots.find((lot: Json) => lot.id === lotId)).toMatchObject({ onHand: '10.0000', receiptNumber: received.receipt.number })
  })

  it('sends two back to the customer, named after the order; refuses a lot it does not own', async () => {
    const other = (await one<Json>(`SELECT id FROM "Lot" WHERE "tenantId" = $1 AND "ownerPartyId" IS NULL AND "siteId" = $2 LIMIT 1`, [A.tenant, site])).id
    expect(paths(await no('warehouse', 'POST', '/inventory/receipts/customer/returns', { siteId: site, partyId: p1, lines: [{ lotId: other, fromLocationId: location, quantity: '1' }] }, 400))).toEqual(['body/lines/0/lotId'])
    await ok('warehouse', 'POST', '/inventory/receipts/customer/returns', { siteId: site, partyId: p1, orderId: w39.id, note: 'Made-up: two labels too many.', lines: [{ lotId, fromLocationId: location, quantity: '2' }] }, 201)
    const list = await ok('reader', 'GET', `/sales/orders/${w39.id}/customer-materials`)
    expect(list.rows[0].returned).toBe('2.0000')
    expect(list.lots.find((lot: Json) => lot.id === lotId)).toMatchObject({ onHand: '8.0000' })
    expect((await outbox('customer_material.changed', w39.id)).map((payload) => payload.change)).toEqual(expect.arrayContaining(['PLANNED', 'RECOUNTED']))
  })
})
