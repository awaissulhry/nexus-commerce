import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPlanning, type PlanningSeed } from '../../../../../../packages/factory-db/seed/planning'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { callerFor, command } from '../../../core/command'
import { testAuthenticator, type RequestContext, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { pdfFlatText } from '../../../platform/documents/testing/pdf-text'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { postMoves } from '../ledger/post-moves'
import { useCountsClock } from './counts'

/**
 * Stock counts and the year-end inventory on the local stack (B-W2a-15; SCM-224, SCM-230, SCM-229, SCM-293), through
 * the app's real routes on the seeds (seed/planning.ts: plant A1's store holds the grey lining lot SEED-LOT-LIN-01 and
 * the black hide SEED-HIDE-0002 in A1-STORE-01, and SEED-CNT-0001 is COUNTING them):
 *   - a cycle count: one stock key in one open count, the snapshot's lines, the count sheets, counts, a line found,
 *     recounts, submit refusals in words, the value over the limit, the counter never approving their own variance,
 *     the apply as COUNT moves dated at the snapshot, valued, the lines history, an idempotent repeat;
 *   - a send-back for a recount and an apply under the limit that approves itself;
 *   - the year-end inventory: 31 December only, not before the day, the snapshot at the end of the day (a later move
 *     left out), its own year's number, the valued list's preview, the sign-off (number typed, cost grain) storing the
 *     PDF in the fiscal archive and the sheet beside it;
 *   - the walls: permissions, another company, values only with the cost grain, names only in the record.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/inventory/counts`.
 */

type Json = Record<string, any>
const NS = 'counts-a'
const key = (name: string) => seedUuid(NS, name)
const ids = {
  tenant: key('tenant'),
  companyA: key('company:A'),
  companyB: key('company:B'),
  siteA: key('site:A1'),
  store: key('inventory:location:A1-STORE'),
  bin: key('inventory:location:A1-STORE-01'),
  lining: key('product:item:lining'),
  liningGrey: key('product:item-colour:lining:GRY'),
  liningLot: key('inventory:lot:LIN-01'),
  leather: key('product:item:leather'),
  leatherLot: key('inventory:lot:LEA-01'),
  hide1: key('inventory:hide:H1'),
  hide2: key('inventory:hide:H2'),
  counter: newId(),
  approver: newId(),
  finance: newId(),
  other: newId(),
}

const grant = (permissions: readonly Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (actorId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: ids.tenant, actorId, grants })
const SESSIONS: Record<string, SessionContext> = {
  /** Counts, may approve (but not their own variance) and apply; no cost grain (the warehouse role). */
  counter: office(ids.counter, [grant(['inventory.counts.view', 'inventory.counts.manage', 'inventory.counts.approve', 'inventory.adjust', 'inventory.stock.view'])]),
  /** Another person who approves and applies, with the cost grain. */
  approver: office(ids.approver, [grant(['inventory.counts.view', 'inventory.counts.approve', 'inventory.adjust', 'inventory.stock.view', 'money.cost'])]),
  /** Signs off the year-end inventory (the finance role). */
  finance: office(ids.finance, [grant(['inventory.counts.view', 'inventory.counts.signoff', 'money.cost'])]),
  /** May sign off but holds no cost grain. */
  'signer-no-cost': office(ids.other, [grant(['inventory.counts.view', 'inventory.counts.signoff'])]),
  viewer: office(ids.other, [grant(['inventory.counts.view'])]),
  /** Company B only. */
  'company-b': office(ids.other, [grant(['inventory.counts.view', 'inventory.counts.manage'], [ids.companyB])]),
}

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let localRoot: string
let seeded: PlanningSeed
let serial = 0
const clock = { at: new Date('2026-12-01T09:00:00.000Z') }
const idem = () => `counts-${Date.now()}-${++serial}-${newId().slice(-8)}`

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, idempotencyKey: string | null = idem()): Promise<LightMyRequestResponse> =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' && idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
const ok = async (response: Promise<LightMyRequestResponse>, status = 200): Promise<Json> => {
  const answer = await response
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.json() as Json
}
const onHand = async (locationId: string, itemId: string, extra: { lotId?: string; hideId?: string } = {}): Promise<string> =>
  (
    await admin<{ q: string }>(
      `SELECT coalesce(sum(CASE WHEN "toLocationId" = $1 THEN "baseQuantity" ELSE -"baseQuantity" END), 0)::numeric(18,4)::text AS q
         FROM "StockMove" WHERE ("toLocationId" = $1 OR "fromLocationId" = $1) AND "itemId" = $2
          AND ($3::uuid IS NULL OR "lotId" = $3::uuid) AND "hideId" IS NOT DISTINCT FROM $4::uuid`,
      [locationId, itemId, extra.lotId ?? null, extra.hideId ?? null],
    )
  )[0]!.q
const events = async (type: string, subject: string) => (await admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2 ORDER BY id', [type, subject])).map((row) => row.payload)
const lines = async (countId: string, session = 'counter', query = '') => (await ok(call(session, 'GET', `/inventory/stock-counts/${countId}/lines${query}`))).lines as Json[]

beforeAll(async () => {
  db = await migratedDatabase('counts')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedNumbering({ db: database, namespace: NS })
  await seedReasons({ db: database, namespace: NS })
  await seedFiles({ db: database, namespace: NS })
  seeded = await seedPlanning({ db: database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [ids.tenant])
  for (const [id, name] of [
    [ids.counter, 'Carla Conti'],
    [ids.approver, 'Aldo Bianchi'],
    [ids.finance, 'Fiona Neri'],
  ] as const) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [id, ids.tenant, `${id.slice(-6)}@example.com`, name])
  }
  useCountsClock({ now: () => clock.at })
  redis = testRedis()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-counts-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: redis.connect(), prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
      logger: false,
    },
  )
}, 180_000)

afterAll(async () => {
  useCountsClock(undefined)
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

let cycle: Json

describe('a cycle count (SCM-224)', () => {
  it('a stock key is in one open count at a time: the seeded count holds the store until it is cancelled', async () => {
    const before = (await admin<{ n: number }>('SELECT count(*)::int AS n FROM "StockCount"'))[0]!.n
    const refused = await call('counter', 'POST', '/inventory/stock-counts', { siteId: ids.siteA, kind: 'CYCLE', locationId: ids.store, start: true })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.issues).toEqual([{ path: 'problem/HELD_BY_OTHER_COUNT', message: expect.stringContaining('SEED-CNT-0001') }])
    // One command: nothing was made, no number taken.
    expect((await admin<{ n: number }>('SELECT count(*)::int AS n FROM "StockCount"'))[0]!.n).toBe(before)
    expect((await call('viewer', 'POST', `/inventory/stock-counts/${seeded.countId}/cancel`, { version: 1, reason: 'Replaced by a full count.' })).statusCode).toBe(403)
    const cancelled = await ok(call('counter', 'POST', `/inventory/stock-counts/${seeded.countId}/cancel`, { version: 1, reason: 'Replaced by a full count.' }))
    expect(cancelled.count).toMatchObject({ status: 'CANCELLED', cancelReason: 'Replaced by a full count.' })
  })

  it('made as a DRAFT with its number, then started: the snapshot freezes one line per stock key in walking order', async () => {
    const made = await ok(call('counter', 'POST', '/inventory/stock-counts', { siteId: ids.siteA, kind: 'CYCLE', locationId: ids.store, countTeam: 'Squadra magazzino' }), 201)
    expect(made.count).toMatchObject({ number: 'CNT-2026-0001', status: 'DRAFT', scope: { location: { id: ids.store, code: 'A1-STORE' } }, lines: { all: 0 } })
    expect(made.count.actions.start).toEqual({ allowed: true, reason: null })
    const started = await ok(call('counter', 'POST', `/inventory/stock-counts/${made.count.id}/start`, { version: made.count.version }))
    cycle = started.count
    expect(cycle).toMatchObject({ status: 'COUNTING', snapshotAt: clock.at.toISOString(), lines: { all: 2, counted: 0 } })
    const rows = await lines(cycle.id)
    expect(rows.map((row) => [row.seq, row.location.code, row.item.code, row.lot?.code, row.hide?.code ?? null, row.expected, row.status])).toEqual([
      [10, 'A1-STORE-01', 'SEED-LEA-100', 'SEED-LOT-LEA-01', 'SEED-HIDE-0002', '51.8000', 'UNCOUNTED'],
      [20, 'A1-STORE-01', 'SEED-LIN-200', 'SEED-LOT-LIN-01', null, '120.0000', 'UNCOUNTED'],
    ])
    expect(await events('inventory.count_changed', cycle.id)).toEqual([
      expect.objectContaining({ change: 'CREATED', status: 'DRAFT', lines: 0 }),
      expect.objectContaining({ change: 'STARTED', status: 'COUNTING', previousStatus: 'DRAFT', lines: 2 }),
    ])
  })

  it('prints the count sheets with the expected quantities, or blind', async () => {
    const sheet = await call('counter', 'GET', `/inventory/stock-counts/${cycle.id}/sheets?language=en`)
    expect(sheet.statusCode).toBe(200)
    expect(sheet.headers['content-type']).toBe('application/pdf')
    const text = pdfFlatText(sheet.rawPayload)
    expect(text).toContain('Count sheet')
    expect(text).toContain('SEED-HIDE-0002')
    expect(text).toContain('51.8')
    const blind = pdfFlatText((await call('counter', 'GET', `/inventory/stock-counts/${cycle.id}/sheets?expected=false`)).rawPayload)
    expect(blind).toContain('Foglio cieco')
    expect(blind).not.toContain('51,8')
  })

  it('types counts and reasons, adds a line found, asks a recount; submit says what is missing', async () => {
    const [hide, lining] = await lines(cycle.id)
    const typed = await ok(
      call('counter', 'POST', `/inventory/stock-counts/${cycle.id}/lines/record`, {
        lines: [
          { lineId: hide!.id, version: hide!.version, counted: '0' },
          { lineId: lining!.id, version: lining!.version, counted: '18.5', reasonCode: 'COUNT_ERROR', reasonNote: 'A roll was booked twice.' },
        ],
      }),
    )
    expect(typed).toMatchObject({ counted: 2, all: 2 })
    expect(typed.lines.map((row: Json) => [row.seq, row.final, row.difference, row.percent, row.move, row.countedByYou])).toEqual([
      [10, '0.0000', '-51.8000', '-100.0', { id: null, direction: 'OUT', baseQuantity: '51.8000' }, true],
      [20, '18.5000', '-101.5000', '-84.6', { id: null, direction: 'OUT', baseQuantity: '101.5000' }, true],
    ])
    // A stale version is refused for that line; an unknown reason in words; a hide never above its area.
    const stale = await call('counter', 'POST', `/inventory/stock-counts/${cycle.id}/lines/record`, { lines: [{ lineId: hide!.id, version: hide!.version, counted: '1' }] })
    expect(stale.statusCode).toBe(409)
    const wrong = await call('counter', 'POST', `/inventory/stock-counts/${cycle.id}/lines/record`, { lines: [{ lineId: hide!.id, version: hide!.version + 1, counted: '60', reasonCode: 'NOPE' }] })
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json().error.issues.map((issue: Json) => issue.path)).toEqual(['body/lines/0/counted', 'body/lines/0/reasonCode'])

    // Found while counting: 5 m of the same lot on the store's own shelf (an ADDED line, expected 0).
    const added = await ok(call('counter', 'POST', `/inventory/stock-counts/${cycle.id}/lines`, { locationId: ids.store, itemId: ids.lining, lotId: ids.liningLot, counted: '5', reasonCode: 'FOUND' }), 201)
    expect(added.line).toMatchObject({ seq: 30, origin: 'ADDED', expected: '0.0000', counted: '5.0000', colour: { id: ids.liningGrey }, move: { direction: 'IN', baseQuantity: '5.0000' } })
    const twice = await call('counter', 'POST', `/inventory/stock-counts/${cycle.id}/lines`, { locationId: ids.store, itemId: ids.lining, lotId: ids.liningLot, counted: '5' })
    expect(twice.json().error.issues).toEqual([{ path: 'problem/ALREADY_COUNTED', message: 'Line 30 counts it: type its count there.' }])
    const outside = await call('counter', 'POST', `/inventory/stock-counts/${cycle.id}/lines`, { locationId: key('inventory:location:A1-RCV'), itemId: ids.lining, lotId: ids.liningLot, counted: '1' })
    expect(outside.json().error.issues).toEqual([{ path: 'body/locationId', message: "The location is outside the count's scope." }])

    const recount = await ok(call('counter', 'POST', `/inventory/stock-counts/${cycle.id}/recounts`, { lineIds: [hide!.id] }))
    expect(recount.lines[0]).toMatchObject({ status: 'RECOUNT_DUE', recount: { quantity: null } })
    const record = await ok(call('counter', 'GET', `/inventory/stock-counts/${cycle.id}`))
    // The hide waits for its recount: its reason is asked once it is recounted.
    expect(record.count.summary).toMatchObject({ lines: 3, counted: 3, recountsDue: 1, differing: 3, unreasoned: 0, recountSuggested: 3 })
    expect(record.count.actions.submit.allowed).toBe(false)
    const refused = await call('counter', 'POST', `/inventory/stock-counts/${cycle.id}/submit`, { version: record.count.version })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.issues.map((issue: Json) => issue.path)).toEqual(['problem/RECOUNT_DUE'])
  })

  it('submits once recounted and reasoned: the differences are valued and, over the limit, need a second person', async () => {
    const [hide] = await lines(cycle.id, 'counter', '?filter=recount')
    await ok(call('counter', 'POST', `/inventory/stock-counts/${cycle.id}/lines/record`, { lines: [{ lineId: hide!.id, version: hide!.version, recount: '0', reasonCode: 'DAMAGED', reasonNote: 'Not found; probably cut by mistake.' }] }))
    const record = await ok(call('counter', 'GET', `/inventory/stock-counts/${cycle.id}`))
    const submitted = await ok(call('counter', 'POST', `/inventory/stock-counts/${cycle.id}/submit`, { version: record.count.version }))
    // 51.8 ft² × 4.20 (the lot's cost) + 101.5 m × 3.10 + 5 m × 3.10 = 217.56 + 314.65 + 15.50 = 547.71 > 500.00.
    expect(submitted.count).toMatchObject({ status: 'SUBMITTED', approvalRequired: true, people: { submittedBy: 'Carla Conti' } })
    expect(submitted.count.differenceAmount).toBeUndefined()
    const withCost = await ok(call('approver', 'GET', `/inventory/stock-counts/${cycle.id}`))
    expect(withCost.count).toMatchObject({ differenceAmount: 54_771, summary: { differenceAmount: 54_771 }, approval: { required: true, limitAmount: 50_000, mayApprove: true } })
    const valued = await lines(cycle.id, 'approver')
    expect(valued.map((row) => [row.seq, row.unitCost, row.differenceAmount])).toEqual([
      [10, '4.200000', -21_756],
      [20, '3.100000', -31_465],
      [30, '3.100000', 1_550],
    ])
    expect((await lines(cycle.id, 'counter'))[0]!.unitCost).toBeUndefined()
    // From SUBMITTED on the lines are history.
    const [line] = await lines(cycle.id)
    const late = await call('counter', 'POST', `/inventory/stock-counts/${cycle.id}/lines/record`, { lines: [{ lineId: line!.id, version: line!.version, reasonNote: 'x' }] })
    expect(late.json().error.issues).toEqual([{ path: 'problem/NOT_COUNTING', message: expect.stringContaining('history') }])
  })

  it('the counter never approves their own variance (SCM-229), the apply waits for the approval, another person approves', async () => {
    const record = await ok(call('counter', 'GET', `/inventory/stock-counts/${cycle.id}`))
    expect(record.count.approval).toMatchObject({ mayApprove: false, held: 'OWN_VARIANCE' })
    const own = await call('counter', 'POST', `/inventory/stock-counts/${cycle.id}/approve`, { version: record.count.version })
    expect(own.statusCode).toBe(409)
    expect(own.json().error.issues).toEqual([{ path: 'problem/OWN_VARIANCE', message: expect.stringContaining('(10, 20, 30)') }])
    const early = await call('counter', 'POST', `/inventory/stock-counts/${cycle.id}/apply`, { version: record.count.version })
    expect(early.json().error.issues[0].path).toBe('problem/NOT_APPROVED')
    expect((await call('finance', 'POST', `/inventory/stock-counts/${cycle.id}/approve`, { version: record.count.version })).statusCode).toBe(403)
    const approved = await ok(call('approver', 'POST', `/inventory/stock-counts/${cycle.id}/approve`, { version: record.count.version, note: 'Checked the bin with the team.' }))
    expect(approved.count).toMatchObject({ status: 'APPROVED', approvalNote: 'Checked the bin with the team.', people: { approvedBy: 'Aldo Bianchi' } })
    cycle = approved.count
  })

  it('applies the differences as COUNT moves dated at the snapshot, valued, each line naming its move; a repeat changes nothing', async () => {
    const idempotencyKey = idem()
    const applied = await ok(call('approver', 'POST', `/inventory/stock-counts/${cycle.id}/apply`, { version: cycle.version }, idempotencyKey))
    expect(applied.count).toMatchObject({ status: 'APPLIED', people: { appliedBy: 'Aldo Bianchi' } })
    expect(applied.moves.map((move: Json) => [move.seq, move.direction, move.baseQuantity])).toEqual([
      [10, 'OUT', '51.8000'],
      [20, 'OUT', '101.5000'],
      [30, 'IN', '5.0000'],
    ])
    const moves = await admin<Json>(
      `SELECT m.id, m.reason, m.note, m.reference, m."occurredAt", m."hideId", v.method, v."valueAmount" FROM "StockMove" m JOIN "StockValuation" v ON v."moveId" = m.id WHERE m.id = ANY($1::uuid[]) ORDER BY m."idempotencyKey"`,
      [applied.moves.map((move: Json) => move.id)],
    )
    expect(moves.map((move) => [move.reason, move.reference, (move.occurredAt as Date).toISOString(), move.method, move.valueAmount])).toEqual([
      ['COUNT', 'CNT-2026-0001', cycle.snapshotAt, 'LOT_COST', -21_756],
      ['COUNT', 'CNT-2026-0001', cycle.snapshotAt, 'LOT_COST', -31_465],
      ['COUNT', 'CNT-2026-0001', cycle.snapshotAt, 'LOT_COST', 1_550],
    ])
    expect(moves[0]!.note).toBe('Count CNT-2026-0001 line 10: DAMAGED — Not found; probably cut by mistake.')
    expect(await onHand(ids.bin, ids.leather, { lotId: ids.leatherLot, hideId: ids.hide2 })).toBe('0.0000')
    expect(await onHand(ids.bin, ids.lining, { lotId: ids.liningLot })).toBe('18.5000')
    expect(await onHand(ids.store, ids.lining, { lotId: ids.liningLot })).toBe('5.0000')
    expect((await lines(cycle.id)).map((row) => row.move.id)).toEqual(applied.moves.map((move: Json) => move.id))
    expect(await events('inventory.count_applied', cycle.id)).toEqual([expect.objectContaining({ approvedWithApply: false, differences: 3, snapshotAt: cycle.snapshotAt })])

    const again = await ok(call('approver', 'POST', `/inventory/stock-counts/${cycle.id}/apply`, { version: cycle.version }, idempotencyKey))
    expect(again.moves).toEqual(applied.moves)
    expect((await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "StockMove" WHERE reference = 'CNT-2026-0001'`))[0]!.n).toBe(3)
    const twice = await call('approver', 'POST', `/inventory/stock-counts/${cycle.id}/apply`, { version: applied.count.version })
    expect(twice.statusCode).toBe(409)
    expect((await call('counter', 'POST', `/inventory/stock-counts/${cycle.id}/cancel`, { version: applied.count.version, reason: 'Too late.' })).json().error.issues[0].path).toBe('problem/NOT_CANCELLABLE')
    const audit = await admin<{ action: string; n: number }>(`SELECT action, count(*)::int AS n FROM "AuditLog" WHERE "recordId" = $1 GROUP BY action ORDER BY action`, [cycle.id])
    expect(audit.map((row) => row.action)).toEqual(expect.arrayContaining(['inventory.counts.apply', 'inventory.counts.approve', 'inventory.counts.create', 'inventory.counts.start', 'inventory.counts.submit', 'inventory.counts.snapshot']))
  })
})

describe('sent back for a recount, then applied under the limit', () => {
  it('the approver sends it back with the reason and a recount; under the limit the apply approves itself', async () => {
    const made = await ok(call('counter', 'POST', '/inventory/stock-counts', { siteId: ids.siteA, kind: 'CYCLE', itemId: ids.lining, lotId: ids.liningLot, start: true }), 201)
    const count = made.count
    expect(count).toMatchObject({ number: 'CNT-2026-0002', status: 'COUNTING', scope: { item: { code: 'SEED-LIN-200' }, lot: { code: 'SEED-LOT-LIN-01' } }, lines: { all: 2 } })
    const [shelf, bin] = await lines(count.id)
    expect([shelf!.location.code, shelf!.expected, bin!.location.code, bin!.expected]).toEqual(['A1-STORE', '5.0000', 'A1-STORE-01', '18.5000'])
    await ok(call('counter', 'POST', `/inventory/stock-counts/${count.id}/lines/record`, { lines: [{ lineId: shelf!.id, version: shelf!.version, counted: '4', reasonCode: 'COUNT_ERROR' }, { lineId: bin!.id, version: bin!.version, counted: '18.5' }] }))
    const submitted = await ok(call('counter', 'POST', `/inventory/stock-counts/${count.id}/submit`, { version: count.version }))
    expect(submitted.count.approvalRequired).toBe(false)
    const back = await ok(call('approver', 'POST', `/inventory/stock-counts/${count.id}/send-back`, { version: submitted.count.version, reason: 'Count the shelf again.', recountLineIds: [shelf!.id] }))
    expect(back.count).toMatchObject({ status: 'COUNTING', submittedAt: null, approvalRequired: null, rejectReason: 'Count the shelf again.', people: { rejectedBy: 'Aldo Bianchi' } })
    const [asked] = await lines(count.id, 'counter', '?filter=recount')
    expect(asked).toMatchObject({ seq: 10, status: 'RECOUNT_DUE' })
    await ok(call('counter', 'POST', `/inventory/stock-counts/${count.id}/lines/record`, { lines: [{ lineId: asked!.id, version: asked!.version, recount: '5' }] }))
    const again = await ok(call('counter', 'POST', `/inventory/stock-counts/${count.id}/submit`, { version: back.count.version }))
    expect(again.count).toMatchObject({ approvalRequired: false, lines: { differing: 0 } })
    const applied = await ok(call('counter', 'POST', `/inventory/stock-counts/${count.id}/apply`, { version: again.count.version }))
    expect(applied).toMatchObject({ count: { status: 'APPLIED', people: { approvedBy: 'Carla Conti', appliedBy: 'Carla Conti' } }, moves: [] })
    expect(await events('inventory.count_applied', count.id)).toEqual([expect.objectContaining({ approvedWithApply: true, differences: 0, moveIds: [] })])
  })
})

describe('the year-end physical inventory (SCM-230, c.c. art. 2217)', () => {
  let inventory: Json

  it('is taken as of 31 December, never starts before the day, and numbers in its own year', async () => {
    const wrongDay = await call('counter', 'POST', '/inventory/stock-counts', { siteId: ids.siteA, kind: 'YEAR_END', inventoryDate: '2026-12-30' })
    expect(wrongDay.json().error.issues).toEqual([{ path: 'body/inventoryDate', message: 'The year-end inventory is taken as of the last day of the fiscal year, 31 December.' }])
    clock.at = new Date('2026-12-30T16:00:00.000Z')
    const early = await call('counter', 'POST', '/inventory/stock-counts', { siteId: ids.siteA, kind: 'YEAR_END', inventoryDate: '2026-12-31', start: true })
    expect(early.json().error.issues).toEqual([{ path: 'problem/TOO_EARLY', message: 'A year-end inventory starts on its inventory date (2026-12-31) or after it.' }])

    // A move on 2 January is not in the stock as of 31 December.
    const system = callerFor(database, { ...SESSIONS.approver!, requestId: newId() } as RequestContext)
    await command(system, { name: 'test.lateMove', input: {} }, (tools) =>
      postMoves(tools, [{ siteId: ids.siteA, reason: 'ADJUSTMENT', itemId: ids.lining, lotId: ids.liningLot, toLocationId: ids.bin, quantity: '7', note: 'Booked in January.', occurredAt: new Date('2027-01-02T09:00:00.000Z') }]),
    )
    clock.at = new Date('2027-01-04T08:00:00.000Z')
    const made = await ok(call('counter', 'POST', '/inventory/stock-counts', { siteId: ids.siteA, kind: 'YEAR_END', inventoryDate: '2026-12-31', countTeam: 'Tutto il magazzino', start: true }), 201)
    inventory = made.count
    expect(inventory).toMatchObject({ number: 'CNT-2026-0003', kind: 'YEAR_END', inventoryDate: '2026-12-31', snapshotAt: '2026-12-31T22:59:59.999Z', scope: { location: null, item: null } })
    const rows = await lines(inventory.id)
    expect(rows.map((row) => [row.location.code, row.item.code, row.expected])).toEqual([
      ['A1-STORE', 'SEED-LIN-200', '5.0000'],
      ['A1-STORE-01', 'SEED-LIN-200', '18.5000'],
    ])
    expect(await onHand(ids.bin, ids.lining, { lotId: ids.liningLot })).toBe('25.5000')
  })

  it('submitted, previewed as a valued list, applied under the limit, dated at the end of the inventory date', async () => {
    const [store, bin] = await lines(inventory.id)
    await ok(call('counter', 'POST', `/inventory/stock-counts/${inventory.id}/lines/record`, { lines: [{ lineId: store!.id, version: store!.version, counted: '4', reasonCode: 'COUNT_ERROR' }, { lineId: bin!.id, version: bin!.version, counted: '18.5' }] }))
    expect((await call('approver', 'GET', `/inventory/stock-counts/${inventory.id}/valued-list`)).json().error.issues[0].path).toBe('problem/NOT_SUBMITTED')
    const submitted = await ok(call('counter', 'POST', `/inventory/stock-counts/${inventory.id}/submit`, { version: inventory.version }))
    expect((await call('counter', 'GET', `/inventory/stock-counts/${inventory.id}/valued-list`)).statusCode).toBe(403)
    const preview = await call('approver', 'GET', `/inventory/stock-counts/${inventory.id}/valued-list`)
    expect(preview.statusCode).toBe(200)
    const text = pdfFlatText(preview.rawPayload)
    expect(text).toContain('ANTEPRIMA')
    // 22.5 m of the grey lining at the lot's cost as of 31 December: 3.10 → 69.75.
    expect(text).toContain('69,75')
    const sheet = await call('approver', 'GET', `/inventory/stock-counts/${inventory.id}/valued-list?format=xlsx`)
    expect(sheet.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    const applied = await ok(call('approver', 'POST', `/inventory/stock-counts/${inventory.id}/apply`, { version: submitted.count.version }))
    expect(applied.moves).toEqual([expect.objectContaining({ seq: 10, direction: 'OUT', baseQuantity: '1.0000' })])
    const [move] = await admin<{ occurredAt: Date }>('SELECT "occurredAt" FROM "StockMove" WHERE id = $1', [applied.moves[0].id])
    expect(move!.occurredAt.toISOString()).toBe('2026-12-31T22:59:59.999Z')
    inventory = applied.count
  })

  it('signed off with its number typed and the cost grain: the valued list frozen as files of the count', async () => {
    expect((await call('counter', 'POST', `/inventory/stock-counts/${inventory.id}/sign-off`, { version: inventory.version, phrase: inventory.number })).statusCode).toBe(403)
    expect((await call('signer-no-cost', 'POST', `/inventory/stock-counts/${inventory.id}/sign-off`, { version: inventory.version, phrase: inventory.number })).statusCode).toBe(403)
    const typo = await call('finance', 'POST', `/inventory/stock-counts/${inventory.id}/sign-off`, { version: inventory.version, phrase: 'CNT-2026-3' })
    expect(typo.json().error.issues).toEqual([{ path: 'body/phrase', message: "Type the inventory's number, CNT-2026-0003, to sign it off." }])
    const idempotencyKey = idem()
    const signed = await ok(call('finance', 'POST', `/inventory/stock-counts/${inventory.id}/sign-off`, { version: inventory.version, phrase: 'CNT-2026-0003' }, idempotencyKey))
    expect(signed.count).toMatchObject({ status: 'SIGNED_OFF', people: { signedOffBy: 'Fiona Neri' }, valuedList: { pdfFileId: expect.any(String), sheetFileId: expect.any(String) } })
    const files = await admin<Json>(`SELECT id, kind, "contentType", "recordType", "recordId", status, "retainUntil" FROM "StoredFile" WHERE "recordId" = $1 ORDER BY kind`, [inventory.id])
    expect(files.map((file) => [file.kind, file.contentType, file.recordType, file.status])).toEqual([
      ['DOCUMENT', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'StockCount', 'AVAILABLE'],
      ['FISCAL_ARCHIVE', 'application/pdf', 'StockCount', 'AVAILABLE'],
    ])
    expect(files[1]!.id).toBe(signed.count.valuedList.pdfFileId)
    expect((files[1]!.retainUntil as Date).getUTCFullYear()).toBeGreaterThanOrEqual(2036)
    expect(await events('inventory.count_signed_off', inventory.id)).toEqual([expect.objectContaining({ number: 'CNT-2026-0003', inventoryDate: '2026-12-31', valuedListFileId: files[1]!.id, rows: 1 })])
    const replay = await ok(call('finance', 'POST', `/inventory/stock-counts/${inventory.id}/sign-off`, { version: inventory.version, phrase: 'CNT-2026-0003' }, idempotencyKey))
    expect(replay.count.status).toBe('SIGNED_OFF')
    const again = await call('finance', 'POST', `/inventory/stock-counts/${inventory.id}/sign-off`, { version: signed.count.version, phrase: 'CNT-2026-0003' })
    expect(again.json().error.issues).toEqual([{ path: 'problem/SIGNED_OFF', message: expect.stringContaining('frozen') }])
    expect((await call('approver', 'GET', `/inventory/stock-counts/${inventory.id}/valued-list`)).json().error.issues[0].path).toBe('problem/SIGNED_OFF')
    // The database holds the history too: a signed-off count changes no more.
    await expect(admin(`UPDATE "StockCount" SET note = 'x' WHERE id = $1`, [inventory.id])).rejects.toThrow(/changes no more/)
  })
})

describe('the walls', () => {
  it('lists and tiles by permission and company; values only with the cost grain', async () => {
    const listed = await ok(call('viewer', 'GET', '/inventory/stock-counts?kind=CYCLE'))
    expect(listed.counts.map((count: Json) => count.number)).toEqual(expect.arrayContaining(['CNT-2026-0001', 'CNT-2026-0002', 'SEED-CNT-0001']))
    expect(listed.counts.find((count: Json) => count.number === 'CNT-2026-0001')).toMatchObject({ lines: { all: 3, counted: 3, differing: 3 } })
    expect(listed.counts[0].differenceAmount).toBeUndefined()
    // Names only inside one count's record, never in the list (Owner answer W1).
    expect(listed.counts[0].people).toBeUndefined()
    expect((await ok(call('approver', 'GET', '/inventory/stock-counts?kind=CYCLE&status=APPLIED'))).counts.find((count: Json) => count.number === 'CNT-2026-0001').differenceAmount).toBe(54_771)
    expect(await ok(call('viewer', 'GET', '/inventory/stock-counts/counts'))).toEqual({ drafts: 0, counting: 0, waitingApproval: 0, toApply: 0, yearEnd: 0 })
    expect((await ok(call('company-b', 'GET', '/inventory/stock-counts'))).counts).toEqual([])
    expect((await call('company-b', 'GET', `/inventory/stock-counts/${cycle.id}`)).statusCode).toBe(404)
    expect((await call('viewer', 'POST', '/inventory/stock-counts', { siteId: ids.siteA, kind: 'CYCLE' })).statusCode).toBe(403)
    expect((await call('company-b', 'POST', '/inventory/stock-counts', { siteId: ids.siteA, kind: 'CYCLE' })).statusCode).toBe(403)
    const reasons = await ok(call('viewer', 'GET', '/inventory/stock-counts/reasons'))
    expect(reasons.reasons.map((reason: Json) => reason.code)).toEqual(expect.arrayContaining(['COUNT_ERROR', 'FOUND', 'DAMAGED', 'OTHER']))
  })
})
