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
// B-OP-010: a request for a yes asked as the amendment asked it before office changes applied at once.
import { callerFor, command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { askApproval } from '../../../platform/approvals/engine'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import type { RequestRef } from '../../../platform/approvals-out/adapter'
import { REACCEPTANCE_ADAPTER } from '../orders/reacceptance'

/**
 * Order changes (B-W2b-309; SAL-190, SAL-218, SAL-219, SAL-221, SAL-248, SAL-306; SO2:01) on the local stack with the app's
 * real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and every guard
 * is real), tenant A from EVERY seed (company A's freeze rules: sizes a priced change from cutting and blocked from
 * finishing, prices a priced change from the release …; SEED-SO-W39-02 in production with P1's woven labels; the approvals
 * seed's rules OFF; the caparra penitenziale OFF). Test sessions hold the role templates' grants. Every name and number is
 * made up. B-CP-011 (the money wall): the sales role holds no price grain, so a typed price, a fee or a deposit is the Owner's
 * (a Sales body that sends one is refused 403); Sales still amends sizes, puts back and reads the changes without amounts.
 *
 * What it walks: the company's freeze rules (read, a new rule, one active per field and stage, a later stage never loosening
 * a block, switched off); an order in production (a work order released, one size cut) read field by field and size by size;
 * a plain amendment of a frozen size refused, of an open size taken; a priced change (its parts, fee, the extra deposit of
 * the growth, the customer asked again) and a blocked price refused even priced; the caparra penitenziale refused while off
 * and asked once switched on; B-OP-010: an office change applies at once — a SALES_ORDER_CHANGE rule is never made or switched on
 * and an old one never asks, while a request asked before still holds the next change (the asker may not decide it, a no, the
 * put-back, a yes); the customer's own labels (planned from the BOM, received as an owned lot never valued,
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
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
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
    // B-CP-011: the typed prices are the Owner's.
    order = (
      await ok('owner', 'POST', '/sales/orders/manual', {
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
    // B-OC-017 (order changes tab R13b): what comes next per size cell — the cut one is blocked from finishing, the open one needs a
    // priced change from cutting; the company's rules decide (not a customer's own).
    expect(first.sizes.find((size: Json) => size.size === cutSize)).toMatchObject({ next: { stage: 'FINISHED', action: 'BLOCKED' }, customerRule: false })
    expect(first.sizes.find((size: Json) => size.size === openSize)).toMatchObject({ next: { stage: 'CUT', action: 'CHANGE_REQUEST' }, customerRule: false })
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
    // B-OL-016 (none unless sent): `deposit: {}` asks the order's own percent of the growth.
    const body = { version: row.version, reason: 'Made-up: two more in the cut size, cut on their own.', lines: [{ id: line10.id, sizes: sizesOf(line10, { [cutSize]: 5 }) }, { id: line20.id }], labels: { [line10.id]: 'Two more jackets, cut on their own (made-up)' }, fee: '25.00', deposit: {} }
    // B-CP-011: the seller may not send the fee (refused, nothing written); the Owner prices the change and reads its parts.
    await no('sales', 'POST', `/sales/orders/${order.id}/priced-changes/preview`, body, 403)
    const preview = await ok('owner', 'POST', `/sales/orders/${order.id}/priced-changes/preview`, body)
    expect(preview).toMatchObject({ ok: true, problems: [], parts: [{ label: 'Two more jackets, cut on their own (made-up)', orderLineId: line10.id, amount: 20000 }], feeAmount: 2500, changeAmount: 22500, yes: 'APPLIES_AT_ONCE' /* B-OP-010 */, stage: { stage: 'CUT' } })
    expect(preview.deposit).toMatchObject({ basis: 'ORDER_PERCENT', pct: '30.0000', kind: 'ACCONTO' })
    const applied = await ok('owner', 'POST', `/sales/orders/${order.id}/priced-changes`, body, 201)
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
    // The customer's REVISED_ORDER page (B-W2b-184) shows the price of the change, the fee and the extra deposit.
    const content = await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: PEOPLE.sales }, (client) => REACCEPTANCE_ADAPTER.content(client as never, { recordId: applied.change.id } as RequestRef, 'en'))
    expect(content.facts).toEqual(expect.arrayContaining([{ label: 'Price of the change', value: 'Two more jackets, cut on their own (made-up): +€200.00' }, { label: 'Change fee', value: '€25.00' }, { label: 'Extra deposit', value: expect.stringMatching(/ · by /) }]))
    await refreshLines()
  })

  it('refuses a price the rules block even priced, and a reader; a priced change with no price is "no charge" (B-OL-016)', async () => {
    const row = await orderRow(order.id)
    // B-CP-011: a new price and a fee are the Owner's to send.
    const blocked = await no('owner', 'POST', `/sales/orders/${order.id}/priced-changes`, { version: row.version, reason: 'Made-up: a new price.', lines: [{ id: line10.id, unitPrice: '90' }, { id: line20.id }], fee: '10.00' }, 409)
    expect(blocked.message).toBe('Line 10: Cut leather is priced: no price change any more (made-up).')
    // B-OL-016 (order lines plan O8; 18 F25): Sales sends a priced change with no money field — taken as "no charge" (was a 409).
    const nothing = await ok('sales', 'POST', `/sales/orders/${order.id}/priced-changes`, { version: row.version, reason: 'Made-up: a note.', lines: [{ id: line10.id, note: 'Made-up note' }, { id: line20.id }] }, 201)
    expect(nothing.change).toMatchObject({ priced: false, diff: { lines: [expect.objectContaining({ lineId: line10.id, textChanged: true })] } })
    expect(nothing.change).not.toHaveProperty('feeAmount')
    expect(await one<Json>(`SELECT "priceDeltaLines", "feeAmount", "depositRequestId" FROM "SalesOrderAmendment" WHERE id = $1`, [nothing.change.id])).toEqual({ priceDeltaLines: null, feeAmount: null, depositRequestId: null })
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
    // B-CP-011: the fee and the deposit are the Owner's to send.
    expect(paths(await no('owner', 'POST', `/sales/orders/${order.id}/priced-changes`, body(row.version, 5), 409))).toEqual(['body/deposit/kind'])
    await admin(`UPDATE "SalesSettings" SET "caparraPenitenzialeEnabled" = true WHERE id = $1`, [A.tenant])
    try {
      const applied = await ok('owner', 'POST', `/sales/orders/${order.id}/priced-changes`, body(row.version, 5), 201)
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

// ---- B-OL-016 (order lines plan O8, O9; 18 F25): a priced change may cost nothing ------------------------------------------------

describe('a priced change may cost nothing — "no charge" (B-OL-016)', () => {
  const noChargeAudit = async () => (await one<Json>(`SELECT after FROM "AuditLog" WHERE action = 'orders.amend' AND "recordId" = $1 ORDER BY at DESC, id DESC LIMIT 1`, [order.id])).after
  /** One piece moved between the cut size and the open one at the line's one price: the net does not move. */
  const moved = (version: number, from: string, to: string) => {
    const sizes = line10.sizes as Record<string, number>
    return { version, lines: [{ id: line10.id, sizes: sizesOf(line10, { [from]: sizes[from]! - 1, [to]: sizes[to]! + 1 }) }, { id: line20.id }] }
  }

  it('the Owner: a cut size changed with the net unchanged passes the freeze rule priced, with no part, no fee and no deposit', async () => {
    await refreshLines()
    const body = moved((await orderRow(order.id)).version, cutSize, openSize)
    // A plain amendment of the cut size is still refused (a priced change then) …
    expect((await no('sales', 'POST', `/sales/orders/${order.id}/amendments`, body, 409)).message).toMatch(/send it as a priced change/)
    // … the priced change of 0 is taken (was a 409 "a priced change carries its price"): no problem, no part, no fee, no deposit.
    const preview = await ok('owner', 'POST', `/sales/orders/${order.id}/priced-changes/preview`, body)
    expect(preview).toMatchObject({ ok: true, problems: [], parts: [], feeAmount: null, changeAmount: 0, deposit: null })
    const applied = await ok('owner', 'POST', `/sales/orders/${order.id}/priced-changes`, body, 201)
    expect(applied.change).toMatchObject({ priced: false, feeAmount: null, changeAmount: 0, deposit: null })
    expect(await one<Json>(`SELECT "priceDeltaLines", "feeAmount", "depositRequestId" FROM "SalesOrderAmendment" WHERE id = $1`, [applied.change.id])).toEqual({ priceDeltaLines: null, feeAmount: null, depositRequestId: null })
    expect(await noChargeAudit()).toMatchObject({ amendmentId: applied.change.id, noCharge: true })
    expect(await outbox('sales_order.change_priced', order.id)).toEqual(expect.arrayContaining([expect.objectContaining({ amendmentId: applied.change.id, hasFee: false, depositRequestId: null })]))
    // B-OL-005 (order lines plan D3): nothing to pay, no tick — the customer is not asked (a priced change used to ask always).
    expect(preview).toMatchObject({ amountChanges: false, totalUp: false })
    expect((await one<Json>(`SELECT "reacceptanceNeeded" FROM "SalesOrderAmendment" WHERE id = $1`, [applied.change.id])).reacceptanceNeeded).toBe(false)
    await refreshLines()
  })

  it('Sales (no price grain): the same change with no money field is taken as no charge; a fee or a deposit from Sales is still refused (403)', async () => {
    // B-OL-005 + 18 F25: Sales saves it as "no charge, the customer is asked" — its one tick.
    const body = { ...moved((await orderRow(order.id)).version, openSize, cutSize), askCustomer: true }
    // The grain filter: a money field from a writer without the price grain is refused, nothing written.
    await no('sales', 'POST', `/sales/orders/${order.id}/priced-changes`, { ...body, fee: '10.00' }, 403)
    await no('sales', 'POST', `/sales/orders/${order.id}/priced-changes`, { ...body, deposit: null }, 403)
    const preview = await ok('sales', 'POST', `/sales/orders/${order.id}/priced-changes/preview`, body)
    expect(preview).toMatchObject({ ok: true, problems: [], yes: 'APPLIES_AT_ONCE' })
    for (const field of ['parts', 'feeAmount', 'changeAmount', 'deposit']) expect(preview).not.toHaveProperty(field)
    expect(preview).toMatchObject({ amountChanges: false })
    expect(preview).not.toHaveProperty('totalUp')
    const applied = await ok('sales', 'POST', `/sales/orders/${order.id}/priced-changes`, body, 201)
    // The ask itself is the web's next call (POST /approvals-out, REVISED_ORDER): until then the decision is "not asked yet".
    expect(applied.change).toMatchObject({ priced: false, customer: { decision: 'NOT_ASKED' } })
    expect(applied.change).not.toHaveProperty('changeAmount')
    expect((await orderRow(order.id)).reapprovalNeededAt).not.toBeNull()
    expect(await noChargeAudit()).toMatchObject({ amendmentId: applied.change.id, noCharge: true })
    // None unless sent (O9): no extra deposit for a change that sent none.
    expect((await one<Json>(`SELECT "depositRequestId" FROM "SalesOrderAmendment" WHERE id = $1`, [applied.change.id])).depositRequestId).toBeNull()
    await refreshLines()
  })
})

// ---- B-OP-010: an office change applies at once; an old request for a yes is still decided (SAL-190) and put back -------------

/**
 * B-OP-010 (order page plan N2, decision D2; review R-3, R-20): no office change asks the SALES_ORDER_CHANGE yes any more. The kind
 * stays registered: a request asked before (planted here through the engine, as the old amendment asked it) still holds the
 * order's next change, is decided in place (a no, then the put-back; a yes) and never by the one who asked it.
 */
describe('an office change applies at once; an old request for a yes is still decided (B-OP-010, SAL-190)', () => {
  const RETIRED = { en: 'Off: office changes apply at once', it: "Disattivata: le modifiche dell'ufficio si applicano subito" }
  const CONDITION = { combinator: 'and', rows: [{ id: 'r1', field: 'changeValue', operator: 'gt', value: '0' }] }
  let ruleId: string
  /** A request for a yes on the order's latest change, asked as the amendment asked it before B-OP-010 (the engine, a rule on). */
  const oldRequest = async (orderId: string) => {
    const caller = callerFor(h.database, { ...(SESSIONS.sales as Extract<SessionContext, { audience: 'office' }>), requestId: newId() })
    const { result } = await command(caller, { name: 'orders.amend', input: { orderId, oldRequest: true } }, (tools) => askApproval(tools, { kind: 'SALES_ORDER_CHANGE', recordId: orderId, requester: { userId: PEOPLE.sales } }))
    expect(result.asked).toBe(true)
  }

  it('a rule on: an office change still applies at once — the kind takes no new rule, the old rule never asks, the next change is taken', async () => {
    const kinds = await ok('owner', 'GET', '/approvals/kinds')
    expect(kinds.kinds.find((kind: Json) => kind.kind === 'SALES_ORDER_CHANGE')).toMatchObject({ recordType: 'SalesOrder', label: { en: 'Sales order change' }, askable: false, offered: false, retired: RETIRED })
    // No new rule of it, no test of one; nobody asks it from the generic route either.
    expect(paths(await no('owner', 'POST', '/approvals/rules', { kind: 'SALES_ORDER_CHANGE', companyId: A.companyA, name: 'Every order that grows (made-up)', condition: CONDITION, approver: { roleId: financeRoleId }, sequence: 3, dueHours: 24 }, 409))).toEqual(['refusal/RULE_RETIRED'])
    expect(paths(await no('owner', 'POST', '/approvals/rules/test', { kind: 'SALES_ORDER_CHANGE', companyId: A.companyA, condition: CONDITION }, 409))).toEqual(['refusal/RULE_RETIRED'])
    expect(paths(await no('owner', 'POST', '/approvals/requests', { kind: 'SALES_ORDER_CHANGE', recordId: order.id }, 409))).toEqual(['body/kind'])
    // A rule kept from before, switched on (written as the rules page wrote it then): it reads "Off" in words and never fires.
    ruleId = newId()
    await force(
      `INSERT INTO "ApprovalRule" (id, "tenantId", "companyId", kind, name, condition, "approverRoleId", sequence, "dueHours", active, "createdById", "updatedById") VALUES ($1, $2, $3, 'SALES_ORDER_CHANGE', 'Every order that grows (made-up)', $4::jsonb, $5, 3, 24, true, $6, $6)`,
      [ruleId, A.tenant, A.companyA, JSON.stringify(CONDITION), financeRoleId, PEOPLE.owner],
    )
    const kept = (await ok('owner', 'GET', '/approvals/rules?kind=SALES_ORDER_CHANGE')).rules.find((rule: Json) => rule.id === ruleId)
    expect(kept).toMatchObject({ active: true, registered: true, retired: RETIRED })
    expect(paths(await no('owner', 'PUT', `/approvals/rules/${ruleId}`, { version: kept.version, name: 'Renamed (made-up)' }, 409))).toEqual(['refusal/RULE_RETIRED'])
    // The preview says it applies at once; the change is taken with no request, and the next one right after it.
    const row = await orderRow(order.id)
    // B-CP-011: `deposit` is a money field (even null): the Owner's to send.
    const preview = await ok('owner', 'POST', `/sales/orders/${order.id}/priced-changes/preview`, { version: row.version, lines: [{ id: line10.id }, { id: line20.id, sizes: sizesOf(line20, { [redSize]: 3 }) }], deposit: null })
    expect(preview).toMatchObject({ ok: true, yes: 'APPLIES_AT_ONCE', deposit: null })
    const taken = await ok('sales', 'POST', `/sales/orders/${order.id}/amendments`, { version: row.version, reason: 'Made-up: one more on line 20.', lines: [{ id: line10.id }, { id: line20.id, sizes: sizesOf(line20, { [redSize]: 3 }) }] }, 201)
    expect(await changeTasks(order.id)).toEqual([])
    expect((await one<Json>(`SELECT "reapprovalTaskId" FROM "SalesOrderAmendment" WHERE id = $1`, [taken.amendment.id])).reapprovalTaskId).toBeNull()
    const list = await ok('reader', 'GET', `/sales/orders/${order.id}/changes`)
    expect(list.waitingForYes).toBeNull()
    expect(list.changes[0]).toMatchObject({ id: taken.amendment.id, yes: { state: 'NOT_ASKED' } })
    const next = await ok('sales', 'POST', `/sales/orders/${order.id}/amendments`, { version: (await orderRow(order.id)).version, reason: 'Made-up: and back to two.', lines: [{ id: line10.id }, { id: line20.id, sizes: sizesOf(line20) }] }, 201)
    expect(next.amendment.revision).toBe(taken.amendment.revision + 1)
    expect(await changeTasks(order.id)).toEqual([])
    // Once more one on line 20, the change an old request asks about below.
    await ok('sales', 'POST', `/sales/orders/${order.id}/amendments`, { version: (await orderRow(order.id)).version, reason: 'Made-up: one more on line 20 again.', lines: [{ id: line10.id }, { id: line20.id, sizes: sizesOf(line20, { [redSize]: 3 }) }] }, 201)
  })

  it('an old request still holds the next change; its asker never decides it; Finance\'s no, then put back as before (an earlier priced change still waits for the customer)', async () => {
    await oldRequest(order.id)
    const [task] = await changeTasks(order.id)
    expect(task).toMatchObject({ status: 'PENDING' })
    const list = await ok('reader', 'GET', `/sales/orders/${order.id}/changes`)
    expect(list.waitingForYes).toMatchObject({ taskId: task!.id })
    expect(list.changes[0]).toMatchObject({ yes: { state: 'WAITING', words: { en: 'Waiting for a yes' } }, putBack: { may: false } })
    const again = await no('sales', 'POST', `/sales/orders/${order.id}/amendments`, { version: (await orderRow(order.id)).version, reason: 'Made-up: and another.', lines: [{ id: line10.id }, { id: line20.id, sizes: sizesOf(line20, { [redSize]: 4 }) }] }, 409)
    expect(again.message).toMatch(/last change waits for its yes/)
    const own = await call('sales', 'POST', `/approvals/tasks/${task!.id}/approve`, { version: task!.version })
    expect([403, 409]).toContain(own.statusCode)
    await ok('finance', 'POST', `/approvals/tasks/${task!.id}/reject`, { version: task!.version, reasonCode: 'NEEDS_CHANGES', reason: 'Made-up: not this season.' })
    expect(await outbox('sales_order.change_decided', order.id)).toEqual([expect.objectContaining({ decision: 'REJECTED', taskId: task!.id })])
    const after = await ok('sales', 'GET', `/sales/orders/${order.id}/changes`)
    const turnedDown = after.changes[0]
    expect(turnedDown).toMatchObject({ yes: { state: 'TURNED_DOWN', reason: 'Made-up: not this season.' }, putBack: { may: true, why: null } })
    // B-OC-010 (order changes tab R6a): offered (the latest, our yes refused, a reader with orders.manage), who decided our yes and
    // when; an older change is not offered, held in words EN + IT; a reader without orders.manage is offered nothing.
    expect(turnedDown.putBack).toEqual({ offered: true, may: true, why: null })
    expect(turnedDown.yes).toMatchObject({ decidedBy: 'Made-up finance', decidedAt: expect.any(String) })
    expect(after.changes[1].putBack).toEqual({ offered: false, may: false, why: { en: 'Only the latest change can be restored as before.', it: "Si può ripristinare com'era solo l'ultima modifica." } })
    expect((await ok('reader', 'GET', `/sales/orders/${order.id}/changes`)).changes[0].putBack).toMatchObject({ offered: false, may: false })
    expect(turnedDown.reasonCode).toBeNull()
    const back = await ok('sales', 'POST', `/sales/orders/${order.id}/changes/${turnedDown.id}/put-back`, { version: (await orderRow(order.id)).version }, 201)
    expect(back.change).toMatchObject({ yes: { state: 'NOT_ASKED' }, customer: { decision: 'NOT_NEEDED' } })
    expect(back.change.reason).toMatch(/^Put back as before revision \d+: its yes was refused\.$/)
    // B-OC-010 / B-OC-012: the put-back pair names each other; its own reason is the server's PUT_BACK words.
    expect(back.change).toMatchObject({ restores: turnedDown.revision, restoredBy: null, reasonCode: 'PUT_BACK', changeRequestId: null })
    const restored = (await ok('sales', 'GET', `/sales/orders/${order.id}/changes`)).changes.find((entry: Json) => entry.id === turnedDown.id)
    expect(restored).toMatchObject({ restoredBy: back.change.revision, restores: null })
    const [, now20] = await linesOf(order.id)
    expect(now20!.sizes).toEqual(line20.sizes)
    expect(await changeTasks(order.id)).toHaveLength(1)
    expect((await orderRow(order.id)).reapprovalNeededAt).not.toBeNull()
    expect((await one<Json>(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'orders.putBackChange'`, [order.id])).after).toMatchObject({ amendmentId: turnedDown.id, depositCancelled: false, reacceptanceCleared: false })
    await no('sales', 'POST', `/sales/orders/${order.id}/changes/${turnedDown.id}/put-back`, { version: (await orderRow(order.id)).version }, 409)
  })

  it("an old request's yes is kept on the order; the old rule is switched off and never on again", async () => {
    const row = await orderRow(order.id)
    await ok('sales', 'POST', `/sales/orders/${order.id}/amendments`, { version: row.version, reason: 'Made-up: one more on line 20 after all.', lines: [{ id: line10.id }, { id: line20.id, sizes: sizesOf(line20, { [redSize]: 3 }) }] }, 201)
    // Applied at once: nothing asked it.
    expect((await changeTasks(order.id)).filter((task) => task.status === 'PENDING')).toEqual([])
    await oldRequest(order.id)
    const pending = (await changeTasks(order.id)).find((task) => task.status === 'PENDING')!
    await ok('finance', 'POST', `/approvals/tasks/${pending.id}/approve`, { version: pending.version })
    const list = await ok('reader', 'GET', `/sales/orders/${order.id}/changes`)
    expect(list.changes[0].yes).toMatchObject({ state: 'APPROVED' })
    expect(list.waitingForYes).toBeNull()
    expect(await outbox('sales_order.change_decided', order.id)).toEqual([expect.objectContaining({ decision: 'REJECTED' }), expect.objectContaining({ decision: 'APPROVED', taskId: pending.id })])
    const rule = await one<{ version: number }>(`SELECT version FROM "ApprovalRule" WHERE id = $1`, [ruleId])
    const off = (await ok('owner', 'PUT', `/approvals/rules/${ruleId}`, { version: rule.version, active: false })).rule
    expect(off).toMatchObject({ active: false, retired: RETIRED })
    expect(paths(await no('owner', 'PUT', `/approvals/rules/${ruleId}`, { version: off.version, active: true }, 409))).toEqual(['refusal/RULE_RETIRED'])
    await refreshLines()
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

// ---- B-PR-14: a customer's own freeze rules ---------------------------------------------------------------------------------

describe("a customer's own freeze rules beat the company's for that customer (B-PR-14)", () => {
  let p3: string
  let p2: string
  const field = (reading: Json, name: string): Json => {
    const entry = (reading.order.fields as Json[]).find((candidate) => candidate.field === name)
    if (!entry) throw new Error(`The freeze reading has no ${name} field.`)
    return entry
  }
  const limited = (role: string, actorId: string, parties: string[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId, grants: grantsOf(role).map((grant) => ({ ...grant, parties })) })

  beforeAll(async () => {
    p3 = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-C2'`, [A.tenant])).id
    p2 = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-S1'`, [A.tenant])).id
    // The production manager keeps a customer's limits (partners.production.manage), not the company's rules.
    SESSIONS['pm'] = { audience: 'office', tenantId: A.tenant, actorId: PEOPLE.planner, grants: grantsOf('production_manager') }
    // Sales people limited to one customer each (the wall).
    SESSIONS['sales.p1'] = limited('sales', PEOPLE.sales, [p1])
    SESSIONS['sales.p3'] = limited('sales', PEOPLE.sales, [p3])
  })

  it("a rule of P1's own decides that field on P1's order; the company's set decides the rest; P3's own never decides for P1", async () => {
    const before = await ok('reader', 'GET', `/sales/orders/${order.id}/freeze`)
    expect(field(before, 'DELIVERY_DATE')).toMatchObject({ state: expect.not.stringMatching(/^BLOCKED$/) })
    // The company keeps its rules; the production manager keeps P1's own (partners.production.manage), never the company's.
    await no('pm', 'POST', '/sales/order-freeze-rules', { companyId: A.companyA, field: 'DELIVERY_DATE', frozenFrom: 'RELEASED', action: 'BLOCKED' }, 403)
    const own = (await ok('pm', 'POST', '/sales/order-freeze-rules', { companyId: A.companyA, partyId: p1, field: 'DELIVERY_DATE', frozenFrom: 'RELEASED', action: 'BLOCKED', note: 'Ships on fixed dates only (made-up)' }, 201)).rule
    expect(own).toMatchObject({ partyId: p1, field: 'DELIVERY_DATE', frozenFrom: 'RELEASED', action: 'BLOCKED', active: true })
    expect(await outbox('order_freeze_rule.changed', own.id)).toEqual([expect.objectContaining({ partyId: p1, change: 'MADE' })])
    // P3's own rule of the sizes: it must never reach P1's order.
    const other = (await ok('pm', 'POST', '/sales/order-freeze-rules', { companyId: A.companyA, partyId: p3, field: 'SIZE_QUANTITY', frozenFrom: 'RELEASED', action: 'BLOCKED' }, 201)).rule
    expect(other.partyId).toBe(p3)

    const reading = await ok('reader', 'GET', `/sales/orders/${order.id}/freeze`)
    expect(field(reading, 'DELIVERY_DATE')).toMatchObject({ state: 'BLOCKED', ruleId: own.id })
    // B-OC-017: "Rule of {customer}" — P1's own set decides the date; blocked already, nothing comes next.
    expect(field(reading, 'DELIVERY_DATE')).toMatchObject({ customerRule: true, next: null })
    const first = reading.lines.find((entry: Json) => entry.lineId === line10.id)
    expect(first.sizes.find((size: Json) => size.size === cutSize)).toMatchObject({ state: 'CHANGE_REQUEST', words: { en: 'Cutting started: size frozen' } })
    expect(first.sizes.find((size: Json) => size.size === openSize)).toMatchObject({ locked: false, state: 'OPEN' })
    expect(JSON.stringify(reading)).not.toContain(other.id)
    // A date change of P1's order is now refused by P1's own rule.
    const row = await orderRow(order.id)
    const preview = await ok('sales', 'POST', `/sales/orders/${order.id}/amendments/preview`, { version: row.version, reason: 'Made-up: a later date.', requestedDate: '2027-03-01', lines: [{ id: line10.id }, { id: line20.id }] })
    expect(preview.ok).toBe(false)
    expect(preview.problems).toEqual(expect.arrayContaining([{ path: 'body/DELIVERY_DATE', message: 'The order: Ships on fixed dates only (made-up).' }]))
  })

  it('lists a customer\'s own rules beside the company\'s for whoever reaches it; without partyId the company\'s only', async () => {
    const company = await ok('reader', 'GET', `/sales/order-freeze-rules?companyId=${A.companyA}`)
    expect(company.partyId).toBeNull()
    expect((company.rules as Json[]).every((rule) => rule.partyId === null)).toBe(true)
    const ofP1 = await ok('reader', 'GET', `/sales/order-freeze-rules?companyId=${A.companyA}&partyId=${p1}`)
    expect(ofP1.partyId).toBe(p1)
    expect(new Set((ofP1.rules as Json[]).map((rule) => rule.partyId))).toEqual(new Set([null, p1]))
    expect((ofP1.fields as Json[]).find((entry) => entry.field === 'DELIVERY_DATE')).toMatchObject({ set: 'CUSTOMER' })
    expect((ofP1.fields as Json[]).find((entry) => entry.field === 'SIZE_QUANTITY')).toMatchObject({ set: 'COMPANY' })
    expect(ofP1.mayManage).toBe(false)
    expect((await ok('pm', 'GET', `/sales/order-freeze-rules?companyId=${A.companyA}&partyId=${p1}`)).mayManage).toBe(true)
  })

  it("wall: a person limited to P3 gets 404 on P1's rules (list, new, change) and never reads them; its own customer's rules answer", async () => {
    const p1Rule = await one<Json>(`SELECT id, version FROM "OrderFreezeRule" WHERE "companyId" = $1 AND "partyId" = $2 AND field = 'DELIVERY_DATE'`, [A.companyA, p1])
    for (const answer of [
      await no('sales.p3', 'GET', `/sales/order-freeze-rules?companyId=${A.companyA}&partyId=${p1}`, undefined, 404),
      await no('sales.p3', 'POST', '/sales/order-freeze-rules', { companyId: A.companyA, partyId: p1, field: 'SHIP_TO', frozenFrom: 'CUT', action: 'BLOCKED' }, 404),
      await no('sales.p3', 'PATCH', `/sales/order-freeze-rules/${p1Rule.id}`, { version: p1Rule.version, active: false }, 404),
    ]) {
      expect(JSON.stringify(answer)).not.toContain(p1)
      expect(answer.message).not.toMatch(/Brand|SEED-C1/)
    }
    const ofP3 = await ok('sales.p3', 'GET', `/sales/order-freeze-rules?companyId=${A.companyA}&partyId=${p3}`)
    expect((ofP3.rules as Json[]).some((rule) => rule.partyId === p1)).toBe(false)
    expect(ofP3.mayManage).toBe(true)
    // A sales person keeps its own customer's rules (partners.production.manage), never the company's.
    expect((await ok('sales.p3', 'POST', '/sales/order-freeze-rules', { companyId: A.companyA, partyId: p3, field: 'SHIP_TO', frozenFrom: 'CUT', action: 'BLOCKED' }, 201)).rule).toMatchObject({ partyId: p3 })
    await no('sales.p3', 'POST', '/sales/order-freeze-rules', { companyId: A.companyA, field: 'SHIP_TO', frozenFrom: 'SHIPPED', action: 'BLOCKED' }, 403)
    // The live event of P1's rule names P1 only (the office's live wall: people limited to P3 never receive it).
    expect(await outbox('order_freeze_rule.changed', p1Rule.id)).toEqual([expect.objectContaining({ partyId: p1 })])
  })

  it("refuses a second active rule of one field and stage in one set, a reader, a supplier; switched off, the company's rule decides again", async () => {
    expect((await no('pm', 'POST', '/sales/order-freeze-rules', { companyId: A.companyA, partyId: p1, field: 'DELIVERY_DATE', frozenFrom: 'RELEASED', action: 'BLOCKED' }, 409)).message).toMatch(/^This customer has an active rule for the delivery date from "released to production" already/)
    await no('reader', 'POST', '/sales/order-freeze-rules', { companyId: A.companyA, partyId: p1, field: 'OPTION', frozenFrom: 'CUT', action: 'BLOCKED' }, 403)
    await no('sales.p1', 'PATCH', `/sales/order-freeze-rules/${(await one<Json>(`SELECT id FROM "OrderFreezeRule" WHERE "partyId" = $1 LIMIT 1`, [p3])).id}`, { version: 1, active: false }, 404)
    expect((await no('pm', 'POST', '/sales/order-freeze-rules', { companyId: A.companyA, partyId: p2, field: 'OPTION', frozenFrom: 'CUT', action: 'BLOCKED' }, 409)).message).toBe("A customer's own freeze rules are for a customer or a brand.")
    const p1Rule = await one<Json>(`SELECT id, version FROM "OrderFreezeRule" WHERE "companyId" = $1 AND "partyId" = $2 AND field = 'DELIVERY_DATE'`, [A.companyA, p1])
    expect((await ok('pm', 'PATCH', `/sales/order-freeze-rules/${p1Rule.id}`, { version: p1Rule.version, active: false })).rule).toMatchObject({ partyId: p1, active: false })
    const reading = await ok('reader', 'GET', `/sales/orders/${order.id}/freeze`)
    expect(field(reading, 'DELIVERY_DATE').ruleId).not.toBe(p1Rule.id)
  })
})

// ── B-OC-010 / B-OC-011 (order changes tab R6a, R6b; 13-backend §4) ──
describe('B-OC-010 / B-OC-011: a change names the customer request it carried out, and how the customer answered its revision', () => {
  it('a revision a customer request carried names that request; answered by its link: who typed it and how — its words only with partners.approvals.view', async () => {
    const latest = await one<{ id: string; revision: number }>(`SELECT id, revision FROM "SalesOrderAmendment" WHERE "orderId" = $1 ORDER BY revision DESC LIMIT 1`, [order.id])
    const request = newId()
    const asked = newId()
    // Planted whole as the accept and the customer's link would leave them (only the read is under test).
    await force(
      `INSERT INTO "OrderChangeRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, status, "answeredAt", "answeredById", "amendmentId", version, "createdAt") VALUES ($1, $2, $3, $4, $5, 'CHANGE', 'ACCEPTED', now(), $6, $7, 2, now() - interval '1 day')`,
      [request, A.tenant, A.companyA, p1, order.id, PEOPLE.owner, latest.id],
    )
    await force(
      `INSERT INTO "ApprovalRequest" (id, "tenantId", "companyId", "recordType", "recordId", "partyId", kind, question, "dueAt", status, "answeredAt", "typedName", answer, "answeredViaLinkId", "createdAt") VALUES ($1, $2, $3, 'SalesOrderAmendment', $4, $5, 'REVISED_ORDER', 'Made-up: please confirm the order as revised.', now() + interval '5 days', 'APPROVED', now(), 'Made-up Buyer', 'Made-up: fine for us.', $6, now() - interval '1 hour')`,
      [asked, A.tenant, A.companyA, latest.id, p1, newId()],
    )
    const owner = (await ok('owner', 'GET', `/sales/orders/${order.id}/changes`)).changes.find((entry: Json) => entry.id === latest.id)
    expect(owner).toMatchObject({ changeRequestId: request, customer: { requestId: asked, by: 'Made-up Buyer', via: 'LINK', answer: 'Made-up: fine for us.' } })
    // The planner reads the changes (orders.view) but not the approvals list: who answered and how, never their words.
    const planner = (await ok('planner', 'GET', `/sales/orders/${order.id}/changes`)).changes.find((entry: Json) => entry.id === latest.id)
    expect(planner.customer).toMatchObject({ by: 'Made-up Buyer', via: 'LINK', answer: null })
    // An office change carried no request; a change never asked of the customer has no answer.
    const others = (await ok('owner', 'GET', `/sales/orders/${order.id}/changes`)).changes.filter((entry: Json) => entry.id !== latest.id)
    for (const entry of others) expect(entry.changeRequestId, String(entry.revision)).toBeNull()
    for (const entry of others.filter((change: Json) => change.customer.requestId === null)) expect(entry.customer).toMatchObject({ by: null, via: null, answer: null })
  })
})
// ── end B-OC-010 / B-OC-011 ──

// ── B-OC-013 (order changes tab R9; Owner D5 2026-11-22: silence is not a yes) ──
describe('B-OC-013: a change the customer did not answer in time may be restored as before; asked again, it waits again', () => {
  it('expired → offered and may, restored with the server’s words; asked again (open) → not offered', async () => {
    await refreshLines()
    const row = await orderRow(order.id)
    const changed = await ok('sales', 'POST', `/sales/orders/${order.id}/amendments`, { version: row.version, reason: 'Made-up: one more on line 20, the customer to confirm.', askCustomer: true, lines: [{ id: line10.id }, { id: line20.id, sizes: sizesOf(line20, { [redSize]: (line20.sizes as Record<string, number>)[redSize]! + 1 }) }] }, 201)
    expect(changed.amendment.reacceptance).toBe('NEEDED')
    const plant = (status: 'EXPIRED' | 'OPEN', ago: string) =>
      force(
        `INSERT INTO "ApprovalRequest" (id, "tenantId", "companyId", "recordType", "recordId", "partyId", kind, question, "dueAt", status, "createdAt") VALUES ($1, $2, $3, 'SalesOrderAmendment', $4, $5, 'REVISED_ORDER', 'Made-up: please confirm the order as revised.', now() + interval '1 day', $6, now() - interval '${ago}')`,
        [newId(), A.tenant, A.companyA, changed.amendment.id, p1, status],
      )
    await plant('EXPIRED', '3 days')
    const expired = (await ok('sales', 'GET', `/sales/orders/${order.id}/changes`)).changes[0]
    expect(expired).toMatchObject({ id: changed.amendment.id, customer: { decision: 'EXPIRED' }, putBack: { offered: true, may: true, why: null } })
    // A reader without orders.manage is offered nothing.
    expect((await ok('reader', 'GET', `/sales/orders/${order.id}/changes`)).changes[0].putBack).toMatchObject({ offered: false, may: false })
    // Asked again: the open ask is the newest — it waits for the customer again, nothing to restore.
    await plant('OPEN', '1 hour')
    const again = (await ok('sales', 'GET', `/sales/orders/${order.id}/changes`)).changes[0]
    expect(again).toMatchObject({ customer: { decision: 'WAITING' }, putBack: { offered: false, may: false } })
    expect(again.putBack.why.en).toMatch(/did not answer in time/)
    await no('sales', 'POST', `/sales/orders/${order.id}/changes/${changed.amendment.id}/put-back`, { version: (await orderRow(order.id)).version }, 409)
    // That one lapses too: restored as before, with the server's words; the next revision restores it.
    await force(`UPDATE "ApprovalRequest" SET status = 'EXPIRED' WHERE "recordId" = $1 AND status = 'OPEN'`, [changed.amendment.id])
    const back = await ok('sales', 'POST', `/sales/orders/${order.id}/changes/${changed.amendment.id}/put-back`, { version: (await orderRow(order.id)).version }, 201)
    expect(back.change).toMatchObject({ revision: changed.amendment.revision + 1, restores: changed.amendment.revision, reasonCode: 'PUT_BACK' })
    expect(back.change.reason).toBe(`Put back as before revision ${changed.amendment.revision}: the customer did not answer in time.`)
    const [, now20] = await linesOf(order.id)
    expect(now20!.sizes).toEqual(line20.sizes)
    await refreshLines()
  })
})
// ── end B-OC-013 ──
