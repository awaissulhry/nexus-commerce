import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { CLOSE_WAITS } from '@nexus/factory-domain/costing/close/rules'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAccounting, type AccountingSeed } from '../../../../../../packages/factory-db/seed/accounting'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { saveActualSettings } from '../ppv/settings'

/**
 * The work order close on the local stack (B-W2b-411; MES-012, MES-013, FIN-029, FIN-030, FIN-034) with the app's real
 * routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the
 * …_cost_actuals_w2b_guards are real), the factory-db seeds up to accounting. SEED-WO-0001 (7 jackets of SEED-JKT-02,
 * in progress): the hide H1 issued at 4.20 for 53.2 ft² (223.44), the standing sewing scan 2 × 96.5 minutes at 0.40 ÷ 0.80
 * (96.50), no garment at the final operation; no frozen standard for its garments, so it is compared with its estimate at
 * release (B-W2a-21); 122 standard minutes a garment. Company A's figures for the accountant start OFF (no row). Every
 * figure is made up and worked out by hand. Run with `node scripts/factory/run-pg-tests.mjs modules/costing/close`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seeded: AccountingSeed

const NS = 'costing-close'
const id = (key: string) => seedUuid(NS, key)
const tenant = id('tenant')
const companyA = id('company:A')
const companyB = id('company:B')
const leather = id('product:item:leather')
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `t-${run}-${++keys}`

const grain = (permissions: readonly string[], companies: Grant['companies'] = 'all'): Grant => ({ permissions: permissions as Permission[], companies, sites: 'all', parties: 'all' })
const office = (grants: Grant[]): SessionContext & { actorId: string } => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants })
const fromTemplate = (name: string): SessionContext & { actorId: string } => {
  const role = templateOf(name)!
  return office([grain([...role.permissions, ...role.grains.map((g) => `money.${g}`)])])
}
const DESK = ['workorders.view', 'workorders.manage', 'costing.view', 'money.cost']
const SESSIONS: Record<string, SessionContext & { actorId: string }> = {
  // A made-up production desk that sees costs: closes, undoes; another one like it.
  desk: office([grain(DESK)]),
  otherDesk: office([grain(DESK)]),
  manager: fromTemplate('production_manager'),
  planner: fromTemplate('planner'),
  finance: fromTemplate('finance'),
  companyB: office([grain([...DESK, 'workorders.reopen'], [companyB])]),
}
const callerOf = (session: string) => callerFor(database, { ...SESSIONS[session]!, requestId: newId() } as never)

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refusal(session: string, method: Method, url: string, payload: unknown, code: string): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(409)
  const error = response.json().error
  expect(error.issues?.[0]?.path, response.body).toBe(`refusal/${code}`)
  return error
}
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : []
const ledgerSum = async (workOrderId: string) => Number((await admin<{ sum: string }>('SELECT coalesce(sum(amount), 0)::text AS sum FROM "WorkOrderCostEntry" WHERE "workOrderId" = $1', [workOrderId]))[0]!.sum)
const statusOf = async (workOrderId: string) => (await admin<{ status: string; closedAt: Date | null }>('SELECT status::text, "closedAt" FROM "WorkOrder" WHERE id = $1', [workOrderId]))[0]!

let wo: string
let url: string

beforeAll(async () => {
  db = await migratedDatabase('costing_close')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 16 } })
  await seedCore({ db: database, namespace: NS })
  await seedNumbering({ db: database, namespace: NS })
  await seedPrivacy({ db: database, namespace: NS })
  seeded = await seedAccounting({ db: database, namespace: NS })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  wo = seeded.money.shipping.quality.production.workOrderId
  url = `/production/work-orders/${wo}`
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the close check and the close (MES-012)', () => {
  it('closes a COMPLETED work order only: in progress, the check and the close say so in words', async () => {
    const check = await ok('desk', 'GET', `${url}/close-check`)
    expect(check).toMatchObject({ closable: false, refusal: { code: 'NOT_COMPLETED' }, live: null })
    expect(check.refusal.message).toMatch(/^Work order SEED-WO-0001 is IN_PROGRESS: a work order is closed once it is COMPLETED\.$/)
    await refusal('desk', 'POST', `${url}/close`, { reasonCode: 'SHORT_PRODUCED' }, 'NOT_COMPLETED')
    expect((await ok('desk', 'POST', `${url}/complete`, {})).workOrder.status).toBe('COMPLETED')
  })

  it('shows planned against actual, which figures are beyond the tolerance, the reasons and the split it would write', async () => {
    const check = await ok('desk', 'GET', `${url}/close-check`)
    // 7 planned, none at the final operation; 223.44 of leather taken; 122 × 7 = 854 minutes planned, 193 earned.
    expect(check).toMatchObject({
      closable: true,
      refusal: null,
      figures: { plannedQuantity: 7, actualQuantity: 0, plannedScrapQuantity: 0, scrapQuantity: 0, actualMaterialCost: 22_344, plannedMinutes: '854', actualMinutes: '193', currency: 'EUR' },
      tolerancePct: '5',
      beyond: { quantity: true, material: true, minutes: true, scrap: false, any: true },
      reasonNeeded: true,
      beyondWords: 'Beyond the 5 % tolerance (garments made, material and minutes): give a reason.',
      settles: false,
      waits: CLOSE_WAITS,
      toPost: 0,
      waiting: [],
      undoSeconds: 60,
      live: null,
    })
    expect(check.reasons.map((reason: Json) => reason.code)).toContain('SHORT_PRODUCED')
    expect(check.reasons.find((reason: Json) => reason.code === 'OTHER')).toMatchObject({ noteNeeded: true })
    // The split against the estimate of the garments made (none): the leather's usage 223.44 and all labour 96.50.
    expect(check.split).toMatchObject({ basis: 'ESTIMATE', balance: 31_994, explained: 31_994, closing: 0 })
    expect(check.split.lines.map((line: Json) => [line.category, line.item?.id ?? null, line.amount])).toEqual([
      ['MATERIAL_USAGE', leather, 22_344],
      ['LABOUR_EFFICIENCY', null, 9_650],
    ])
    // The production manager closes without the cost grain: the same lines and words, never an amount.
    const blind = await ok('manager', 'GET', `${url}/close-check`)
    expect(blind.split.lines.map((line: Json) => [line.category, line.amount])).toEqual([
      ['MATERIAL_USAGE', undefined],
      ['LABOUR_EFFICIENCY', undefined],
    ])
    expect([blind.split.balance, blind.split.closing]).toEqual([undefined, undefined])
    expect(blind.figures.plannedMaterialCost).toBeUndefined()
    expect(blind.figures.actualMaterialCost).toBeUndefined()
    expect(blind).toMatchObject({ closable: true, beyond: { material: true }, reasonNeeded: true })
  })

  it('beyond the tolerance needs a reason (OTHER with words); while the figures are off the close is a status', async () => {
    await refusal('desk', 'POST', `${url}/close`, {}, 'REASON_NEEDED')
    await refusal('desk', 'POST', `${url}/close`, { reasonCode: 'OTHER' }, 'NOTE_NEEDED')
    expect((await call('desk', 'POST', `${url}/close`, { reasonCode: 'NOT_A_REASON' })).statusCode).toBe(400)
    const closed = await ok('desk', 'POST', `${url}/close`, { reasonCode: 'SHORT_PRODUCED', reasonNote: 'The other jackets moved to the next lot.' })
    expect(closed.workOrder).toMatchObject({ status: 'CLOSED', closedAt: expect.any(String) })
    expect(closed.close).toMatchObject({ reasonCode: 'SHORT_PRODUCED', reasonWords: 'Fewer garments made than planned.', live: true, settled: false, undoneAt: null, can: { undo: true, reopen: false } })
    expect(closed.close.closedBy.id).toBe(SESSIONS.desk!.actorId)
    expect(closed).toMatchObject({ split: null, waits: CLOSE_WAITS })
    expect(await admin('SELECT id FROM "WorkOrderVariance" WHERE "workOrderId" = $1', [wo])).toEqual([])
    expect(await admin(`SELECT id FROM "WorkOrderCostEntry" WHERE "workOrderId" = $1 AND kind IN ('VARIANCE', 'CLOSE')`, [wo])).toEqual([])
    // Closed again: refused (it is CLOSED).
    await refusal('desk', 'POST', `${url}/close`, { reasonCode: 'SHORT_PRODUCED' }, 'NOT_COMPLETED')
  })
})

describe('the Undo for a few seconds and the reopen with a reason (MES-013)', () => {
  it('only the person who closed it undoes it, without a reason; the work order is COMPLETED again', async () => {
    await refusal('otherDesk', 'POST', `${url}/close/undo`, {}, 'NOT_THE_CLOSER')
    const undone = await ok('desk', 'POST', `${url}/close/undo`, {})
    expect(undone.workOrder).toMatchObject({ status: 'COMPLETED', closedAt: null })
    expect(undone.close).toMatchObject({ live: false, undoneAt: expect.any(String), reopenReason: null, can: { undo: false, reopen: false } })
    expect(undone.close.undoneBy.id).toBe(SESSIONS.desk!.actorId)
    await refusal('desk', 'POST', `${url}/close/undo`, {}, 'NOT_CLOSED')
  })

  it('with the figures on, the close settles the cost: the split, its variance entries, the closing entry; the ledger adds up to 0', async () => {
    await saveActualSettings(callerOf('finance'), { companyId: companyA, postingsOn: true } as never)
    const check = await ok('desk', 'GET', `${url}/close-check`)
    expect(check).toMatchObject({ settles: true, waits: null })
    const closed = await ok('desk', 'POST', `${url}/close`, { reasonCode: 'SHORT_PRODUCED' })
    expect(closed).toMatchObject({ waits: null, close: { settled: true, live: true }, split: { basis: 'ESTIMATE', closing: 0 } })
    expect(closed.split.lines.map((line: Json) => [line.category, line.amount, typeof line.id])).toEqual([
      ['MATERIAL_USAGE', 22_344, 'string'],
      ['LABOUR_EFFICIENCY', 9_650, 'string'],
    ])
    const entries = await admin<{ kind: string; amount: number; sourceType: string }>(`SELECT kind::text, amount, "sourceType" FROM "WorkOrderCostEntry" WHERE "workOrderId" = $1 AND kind IN ('VARIANCE', 'CLOSE') ORDER BY kind, amount`, [wo])
    expect(entries).toEqual([
      { kind: 'CLOSE', amount: 0, sourceType: 'WorkOrderClose' },
      { kind: 'VARIANCE', amount: -22_344, sourceType: 'WorkOrderVariance' },
      { kind: 'VARIANCE', amount: -9_650, sourceType: 'WorkOrderVariance' },
    ])
    expect(await ledgerSum(wo)).toBe(0)
    // The cost read: nothing left on the work order.
    expect((await ok('finance', 'GET', `/costing/work-orders/${wo}`)).detail.actual.onWorkOrder).toBe(0)
    // A catch-up on the closed work order posts nothing.
    expect((await ok('finance', 'POST', `/costing/work-orders/${wo}/post`, {})).posted).toEqual([])
  })

  it('reopening later needs workorders.reopen and a reason; the entries are reversed and the ledger is as before', async () => {
    expect((await call('planner', 'POST', `${url}/reopen`, { reason: 'Count the jackets again' })).statusCode).toBe(403)
    expect((await call('manager', 'POST', `${url}/reopen`, { reason: ' ' })).statusCode).toBe(400)
    await refusal('otherDesk', 'POST', `${url}/close/undo`, {}, 'NOT_THE_CLOSER')
    const reopened = await ok('manager', 'POST', `${url}/reopen`, { reason: 'Two jackets were found finished in the store.' })
    expect(reopened.workOrder).toMatchObject({ status: 'COMPLETED', closedAt: null })
    expect(reopened.close).toMatchObject({ live: false, settled: false, reopenReason: 'Two jackets were found finished in the store.' })
    expect(reopened.close.undoneBy.id).toBe(SESSIONS.manager!.actorId)
    const reversals = await admin<{ kind: string; amount: number; reason: string }>(`SELECT kind::text, amount, reason FROM "WorkOrderCostEntry" WHERE "workOrderId" = $1 AND kind IN ('VARIANCE', 'CLOSE') AND "reversalOfId" IS NOT NULL ORDER BY kind, amount`, [wo])
    expect(reversals.map((row) => [row.kind, row.amount])).toEqual([
      ['CLOSE', 0],
      ['VARIANCE', 9_650],
      ['VARIANCE', 22_344],
    ])
    expect(reversals.every((row) => row.reason === 'Reopened: Two jackets were found finished in the store.')).toBe(true)
    expect(await ledgerSum(wo)).toBe(31_994)
    await refusal('manager', 'POST', `${url}/reopen`, { reason: 'Again, by mistake' }, 'NOT_CLOSED')
  })
})

describe('the closes, the variances and the scrap and rework cost (FIN-029, FIN-030, FIN-034)', () => {
  it('lists every close newest first with its lines and entries; an undone close keeps its split as history', async () => {
    const { closes, waits } = await ok('finance', 'GET', `/costing/work-orders/${wo}/close`)
    expect(waits).toBeNull()
    expect(closes.map((close: Json) => [close.live, close.settled, close.lines.length, close.entries.length, close.reopenReason !== null])).toEqual([
      [false, false, 2, 6, true],
      [false, false, 0, 0, false],
    ])
    expect(closes[0].closing).toBe(0)
    expect(closes[1].closing).toBeNull()
    const variances = await ok('finance', 'GET', `/costing/variances?workOrderId=${wo}&live=false`)
    expect(variances.rows.map((row: Json) => [row.category, row.amount, row.live]).sort()).toEqual([
      ['LABOUR_EFFICIENCY', 9_650, false],
      ['MATERIAL_USAGE', 22_344, false],
    ])
    expect(variances.totals).toEqual([
      { currency: 'EUR', category: 'MATERIAL_USAGE', lines: 1, amount: 22_344 },
      { currency: 'EUR', category: 'LABOUR_EFFICIENCY', lines: 1, amount: 9_650 },
    ])
    expect((await ok('finance', 'GET', `/costing/variances?workOrderId=${wo}`)).rows).toEqual([])
    // Another company's desk finds none of it.
    expect((await call('companyB', 'GET', `/costing/work-orders/${wo}/close`)).statusCode).toBe(404)
    expect((await ok('companyB', 'GET', `/costing/variances?workOrderId=${wo}&live=false`)).rows).toEqual([])
  })

  it('the scrap and rework cost per reason, never a person', async () => {
    const view = await ok('finance', 'GET', `/costing/work-orders/${wo}/scrap-rework`)
    expect(view).toMatchObject({ workOrder: { id: wo, number: 'SEED-WO-0001' }, currency: 'EUR' })
    expect(view.totals).toMatchObject({ reworkCost: expect.anything() })
    expect(keysOf(view).filter((name) => /worker|person|operator|user|by$/i.test(name))).toEqual([])
  })

  it('a work order closed before B-W2b-411 (no close record) is not reopened', async () => {
    await admin(`UPDATE "WorkOrder" SET status = 'CLOSED', "closedAt" = now() WHERE id = $1`, [wo])
    await refusal('manager', 'POST', `${url}/reopen`, { reason: 'It was closed by the old route' }, 'NO_CLOSE_RECORD')
    expect((await statusOf(wo)).status).toBe('CLOSED')
  })

  it('emits the close, its undo and its reopen, and the status changes', async () => {
    const changes = await admin<{ change: string; settled: boolean }>(`SELECT payload->>'change' AS change, (payload->>'settled')::boolean AS settled FROM "OutboxEvent" WHERE type = 'work_order_close.changed' AND subject = $1 ORDER BY "occurredAt", id`, [wo])
    expect(changes).toEqual([
      { change: 'closed', settled: false },
      { change: 'undone', settled: false },
      { change: 'closed', settled: true },
      { change: 'reopened', settled: false },
    ])
    const moves = await admin<{ to: string }>(`SELECT payload->>'to' AS "to" FROM "OutboxEvent" WHERE type = 'workorder.status_changed' AND subject = $1 ORDER BY "occurredAt", id`, [wo])
    expect(moves.map((row) => row.to)).toEqual(['COMPLETED', 'CLOSED', 'COMPLETED', 'CLOSED', 'COMPLETED'])
  })
})
