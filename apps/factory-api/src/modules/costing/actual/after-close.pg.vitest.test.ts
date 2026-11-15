import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAccounting, type AccountingSeed } from '../../../../../../packages/factory-db/seed/accounting'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { SYSTEM_ACTOR_ID, testAuthenticator, type SessionContext } from '../../../core/context'
import type { Log } from '../../../core/queue'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { saveActualSettings } from '../ppv/settings'
import { isClosedWorkOrderRefusal } from './after-close'
import { runCostCatchUp } from './catch-up'
import { costingHandlers } from './handlers'
import { postWorkOrderCosts } from './post'

/**
 * B-W2b-F46 on the local stack: a cost that arrives after a work order's close waits, in words, for a reopen — the worker's
 * handler and the nightly catch-up never fail on it, the database's guard stays as it is. A throwaway PostgreSQL 17 database
 * from the migrations (the runtime login: row-level security and the …_cost_actuals_w2b_guards are real), the factory-db
 * seeds up to accounting. SEED-WO-0001 (7 jackets, in progress) takes 2 m of the lining lot at 3.10 (6.20) through the worker,
 * is completed and closed with company A's figures for the accountant ON (settled: its ledger adds up to 0). Then 0.5 m comes
 * back to the bin (a return of 1.55 off the work order): the late source event. Every figure is made up and worked out by
 * hand. Run with `node scripts/factory/run-pg-tests.mjs modules/costing/actual/after-close`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seeded: AccountingSeed

const NS = 'costing-after-close'
const id = (key: string) => seedUuid(NS, key)
const tenant = id('tenant')
const companyA = id('company:A')
const lining = id('product:item:lining')
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `t-${run}-${++keys}`

const grain = (permissions: readonly string[]): Grant => ({ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties: 'all' })
const office = (grants: Grant[]): SessionContext & { actorId: string } => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants })
const fromTemplate = (name: string): SessionContext & { actorId: string } => {
  const role = templateOf(name)!
  return office([grain([...role.permissions, ...role.grains.map((g) => `money.${g}`)])])
}
const SESSIONS: Record<string, SessionContext & { actorId: string }> = {
  // A made-up production desk that sees costs: completes and closes.
  desk: office([grain(['workorders.view', 'workorders.manage', 'costing.view', 'money.cost'])]),
  // The production manager reopens; no cost grain.
  manager: fromTemplate('production_manager'),
  finance: fromTemplate('finance'),
  // A made-up stores person: issues to and takes back from the work order.
  stores: office([grain(['workorders.view', 'inventory.issue', 'inventory.stock.view'])]),
}
const callerOf = (session: string) => callerFor(database, { ...SESSIONS[session]!, requestId: newId() } as never)
const system = () => callerFor(database, { audience: 'system', tenantId: tenant, actorId: SYSTEM_ACTOR_ID, grants: [], requestId: newId() })

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
const ledgerSum = async (workOrderId: string) => Number((await admin<{ sum: string }>('SELECT coalesce(sum(amount), 0)::text AS sum FROM "WorkOrderCostEntry" WHERE "workOrderId" = $1', [workOrderId]))[0]!.sum)
const entryCount = async (workOrderId: string) => (await admin<{ n: number }>('SELECT count(*)::int AS n FROM "WorkOrderCostEntry" WHERE "workOrderId" = $1', [workOrderId]))[0]!.n

/** A log that keeps its lines (the handler's and the catch-up's). */
function keptLog() {
  const lines: { level: string; fields: Record<string, unknown>; message: string }[] = []
  const log: Log = {
    info: (fields, message) => void lines.push({ level: 'info', fields, message }),
    warn: (fields, message) => void lines.push({ level: 'warn', fields, message }),
    error: (fields, message) => void lines.push({ level: 'error', fields, message }),
  }
  return { log, lines }
}

/** The worker's handler on the outbox's own event of a move, with a log. */
async function handleMove(moveId: string, log?: Log) {
  const rows = await admin<{ id: string; type: string; version: number; payload: Json; occurredAt: Date }>(`SELECT id, type, version, payload, "occurredAt" FROM "OutboxEvent" WHERE type = 'inventory.moved' ORDER BY "occurredAt" DESC, id DESC`)
  const row = rows.find((event) => event.payload.moveId === moveId)
  expect(row, `no inventory.moved event of ${moveId}`).toBeDefined()
  const envelope = { eventId: row!.id, type: row!.type, version: row!.version, tenantId: tenant, payload: row!.payload, occurredAt: row!.occurredAt.toISOString() } as unknown as EventEnvelope
  await costingHandlers()[0]!.handle(envelope, { caller: system(), attempt: 1, ...(log ? { log } : {}) })
}

let wo: string
let url: string
let returnId: string
const lot = () => seeded.money.shipping.quality.production.inventory.liningLotId
const bin = () => seeded.money.shipping.quality.production.inventory.locations.bin
const NIGHT = (day: number) => new Date(`2026-11-${day}T02:20:00.000Z`)

beforeAll(async () => {
  db = await migratedDatabase('costing_after_close')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 16 } })
  await seedCore({ db: database, namespace: NS })
  await seedNumbering({ db: database, namespace: NS })
  await seedPrivacy({ db: database, namespace: NS })
  seeded = await seedAccounting({ db: database, namespace: NS })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
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

describe('a cost that arrives after the close waits for a reopen (B-W2b-F46)', () => {
  let baseline: number

  it('closes SEED-WO-0001 settled: 2 m of lining through the worker, completed, the figures for the accountant on', async () => {
    baseline = (await runCostCatchUp({ database, log: keptLog().log }, NIGHT(16))).afterClose
    const issued = await ok('stores', 'POST', `/inventory/picking/work-orders/${wo}/issue`, { lotId: lot(), quantity: '2' }, 201)
    await handleMove(issued.issue.moves[0].id)
    expect(await admin(`SELECT amount FROM "WorkOrderCostEntry" WHERE "stockMoveId" = $1`, [issued.issue.moves[0].id])).toEqual([{ amount: 620 }])
    expect((await ok('desk', 'POST', `${url}/complete`, {})).workOrder.status).toBe('COMPLETED')
    await saveActualSettings(callerOf('finance'), { companyId: companyA, postingsOn: true } as never)
    const closed = await ok('desk', 'POST', `${url}/close`, { reasonCode: 'SHORT_PRODUCED' })
    expect(closed).toMatchObject({ workOrder: { status: 'CLOSED' }, close: { settled: true, live: true } })
    expect(await ledgerSum(wo)).toBe(0)
    // Nothing arrived yet: an empty list, in words.
    expect((await ok('desk', 'GET', `${url}/close-check`)).afterClose).toEqual({ count: 0, lines: [], words: 'Nothing arrived after the close.' })
  })

  it('a return after the close: the handler ends OK, writes nothing, and says so in one info line', async () => {
    const back = await ok('stores', 'POST', `/inventory/picking/work-orders/${wo}/return`, { lotId: lot(), quantity: '0.5', toLocationId: bin() }, 201)
    returnId = back.return.move.id
    const before = await entryCount(wo)
    const { log, lines } = keptLog()
    await expect(handleMove(returnId, log)).resolves.toBeUndefined()
    expect(await entryCount(wo)).toBe(before)
    expect(await ledgerSum(wo)).toBe(0)
    expect(lines).toEqual([
      {
        level: 'info',
        fields: expect.objectContaining({ tenantId: tenant, workOrderId: wo, number: 'SEED-WO-0001', entries: 1, eventType: 'inventory.moved', waitsFor: 'reopen' }),
        message: 'a cost arrived after its work order was closed: it waits for a reopen (the close freezes the actual)',
      },
    ])
    // The same event again (a retried job): OK again, still nothing written.
    await handleMove(returnId, log)
    expect(await entryCount(wo)).toBe(before)
  })

  it('the database still refuses the entry (the guard is not weakened); the handler reads that refusal as "after the close"', async () => {
    const refused = await postWorkOrderCosts(system(), wo, { idempotencyKey: `raced-${run}` }).then(
      () => null,
      (error: unknown) => error,
    )
    expect(refused).not.toBeNull()
    expect(isClosedWorkOrderRefusal(refused)).toBe(true)
    // The person's catch-up route still answers in words.
    const response = await call('finance', 'POST', `/costing/work-orders/${wo}/post`, {})
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json().error.issues[0].path).toBe('costing/WORK_ORDER_CLOSED')
    expect(await ledgerSum(wo)).toBe(0)
  })

  it('the nightly catch-up skips it: afterClose 1, failed 0, said at info', async () => {
    const { log, lines } = keptLog()
    const night = await runCostCatchUp({ database, log }, NIGHT(17))
    expect(night).toMatchObject({ failed: 0, afterClose: baseline + 1 })
    expect(lines.filter((line) => line.level === 'error')).toEqual([])
    expect(lines.find((line) => line.message === 'cost catch-up')?.fields).toMatchObject({ failed: 0, afterClose: baseline + 1 })
    // And the next night the same, never a failure.
    expect(await runCostCatchUp({ database, log }, NIGHT(18))).toMatchObject({ failed: 0, afterClose: baseline + 1 })
    expect(await ledgerSum(wo)).toBe(0)
  })

  it('the close check and the cost read list it in words; amounts only with the cost grain', async () => {
    const words = 'Returned to stock (RETURN · SEED-WO-0001'
    const check = await ok('desk', 'GET', `${url}/close-check`)
    expect(check.afterClose).toMatchObject({ count: 1, words: '1 cost arrived after the close — reopen the work order to post it.' })
    expect(check.afterClose.lines).toEqual([
      expect.objectContaining({ sourceType: 'StockMove', sourceId: returnId, event: 'RETURN', quantity: '-0.5', entries: 1, amount: -155, item: expect.objectContaining({ id: lining }) }),
    ])
    expect(check.afterClose.lines[0].words).toMatch(new RegExp(`^${words.replace(/[()]/g, '\\$&')}`))
    expect(check.afterClose.lines[0].words).toMatch(/: 0\.5 M of \S+, on \d{4}-\d{2}-\d{2}\.$/)
    expect(check.words).toMatch(/1 cost arrived after the close — reopen the work order to post it\.$/)
    // The production manager (no cost grain): the same line and words, never the amount.
    const blind = await ok('manager', 'GET', `${url}/close-check`)
    expect(blind.afterClose.count).toBe(1)
    expect(blind.afterClose.lines[0].amount).toBeUndefined()
    expect(blind.afterClose.lines[0].words).toBe(check.afterClose.lines[0].words)
    expect(blind.live.can.reopen).toBe(true)
    // The cost read of the work order: the same.
    const detail = (await ok('finance', 'GET', `/costing/work-orders/${wo}`)).detail
    expect(detail.afterClose).toMatchObject({ count: 1, lines: [expect.objectContaining({ sourceId: returnId, amount: -155 })] })
  })

  it('reopen + close: the close posts it first; then nothing waits and the catch-up counts none', async () => {
    const reopened = await ok('manager', 'POST', `${url}/reopen`, { reason: 'Lining came back after the close.' })
    expect(reopened.workOrder.status).toBe('COMPLETED')
    const open = await ok('desk', 'GET', `${url}/close-check`)
    expect(open).toMatchObject({ afterClose: null, toPost: 1, waiting: [] })
    const closed = await ok('desk', 'POST', `${url}/close`, { reasonCode: 'SHORT_PRODUCED' })
    expect(closed).toMatchObject({ workOrder: { status: 'CLOSED' }, close: { settled: true, live: true } })
    expect(await admin(`SELECT kind::text, amount, "reversalOfId" FROM "WorkOrderCostEntry" WHERE "stockMoveId" = $1`, [returnId])).toEqual([{ kind: 'MATERIAL', amount: -155, reversalOfId: null }])
    expect(await ledgerSum(wo)).toBe(0)
    expect((await ok('desk', 'GET', `${url}/close-check`)).afterClose).toEqual({ count: 0, lines: [], words: 'Nothing arrived after the close.' })
    expect((await ok('finance', 'GET', `/costing/work-orders/${wo}`)).detail.afterClose).toMatchObject({ count: 0 })
    expect(await runCostCatchUp({ database, log: keptLog().log }, NIGHT(19))).toMatchObject({ failed: 0, afterClose: baseline })
  })
})
