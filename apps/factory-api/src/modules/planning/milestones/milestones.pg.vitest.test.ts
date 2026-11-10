import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedQuality } from '../../../../../../packages/factory-db/seed/quality'
import { seed as seedSamples, type SamplesSeed } from '../../../../../../packages/factory-db/seed/samples'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../core/command'
import { SYSTEM_ACTOR_ID } from '../../../core/context'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../platform/outbox/system'
import { passGatesOfRound, passLeatherGatesOfLot } from './follow'

/**
 * Time & action (B-W2b-263; PLN-186; design planning.milestones) through the app's real routes and real sign-ins (the system
 * roles synced to their templates: the planner keeps gates, the production manager may also start before one), on a
 * throwaway PostgreSQL 17 database from the migrations (row-level security and B-W2b-212's OrderGate guard are real). Seeds:
 * the samples (SEED-SO-0002's four gates: Other "artwork" waiting, PP sample waiting for SEED-SR-0003, leather passed, trims
 * started before; SEED-SR-0002 an internal proto of SEED-JKT-01 approved with comments) on the production seed (SEED-SO-0001
 * JKT-01 with no work order, SEED-SO-0002 with SEED-WO-0001 started and SEED-WO-0002 a draft; the leather lot SEED-LOT-LEA-01
 * released, reserved for nothing here) and the quality seed (SEED-SO-0003 with SEED-WO-0003 released). Every name and number is made up. Run with
 * `env -u FACTORY_REDIS_URL node scripts/factory/run-pg-tests.mjs modules/planning/milestones`.
 */

vi.setConfig({ testTimeout: 90_000 })

type Json = Record<string, any>
const NS = 'w2b263-milestones'
const idOf = (key: string): string => seedUuid(NS, key)
const tenant = idOf('tenant')
const companyA = idOf('company:A')

let h: Harness
let samples: SamplesSeed
let planner: Browser
let manager: Browser
let readOnly: Browser
let managerId = ''
let counter = 0
const key = (label = 'k'): string => `w2b263-${label}-${++counter}-${newId()}`
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
const system = () => callerFor(h.database, systemContext(tenant, newId()))

type Method = 'GET' | 'POST' | 'PATCH'
async function as(browser: Browser, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await browser.send(method as never, url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': key() } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}
const issuesOf = (body: Json): string[] => (body.error?.issues ?? []).map((issue: Json) => String(issue.path))
const refusalOf = (body: Json): string => issuesOf(body).find((path) => path.startsWith('refusal/')) ?? ''
const eventsOf = async (subject: string) => admin<{ type: string; payload: Json }>('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])
const auditsOf = async (recordId: string) => admin<{ action: string; reason: string | null; after: Json }>('SELECT action, reason, after FROM "AuditLog" WHERE "recordId" = $1 ORDER BY "at", id', [recordId])

async function officeBrowser(seedTenant: TestTenant, email: string, role: string): Promise<{ browser: Browser; id: string }> {
  const user = await addUser(h, seedTenant, { email, role })
  const browser = new Browser(h.app)
  expect((await browser.signIn(NS, user.email, user.password)).status).toBe(200)
  await enrolTotp(h, browser)
  return { browser, id: user.id }
}

let orders: Record<string, string> = {}
let workOrders: Record<string, string> = {}
const read = async (browser: Browser = planner) => as(browser, 'GET', `/planning/milestones?companyId=${companyA}`)
const orderIn = (world: Json, number: string): Json => world.orders.find((order: Json) => order.number === number)
const gateIn = (world: Json, gateId: string): Json => world.orders.flatMap((order: Json) => order.gates).find((gate: Json) => gate.id === gateId)

beforeAll(async () => {
  h = await startHarness('planning_milestones')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  samples = await seedSamples({ db: h.database, namespace: NS })
  // SEED-SO-0003 with SEED-WO-0003 released (the serial style).
  await seedQuality({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  planner = (await officeBrowser(seedTenant, 'pina.planner@seed-a.example.com', 'planner')).browser
  const pm = await officeBrowser(seedTenant, 'piero.pm@seed-a.example.com', 'production_manager')
  manager = pm.browser
  managerId = pm.id
  readOnly = (await officeBrowser(seedTenant, 'rita.reader@seed-a.example.com', 'read_only')).browser
  orders = Object.fromEntries((await admin<{ id: string; number: string }>('SELECT id, number FROM "SalesOrder" WHERE "tenantId" = $1', [tenant])).map((row) => [row.number, row.id]))
  workOrders = Object.fromEntries((await admin<{ id: string; number: string }>('SELECT id, number FROM "WorkOrder" WHERE "tenantId" = $1', [tenant])).map((row) => [row.number, row.id]))
}, 900_000)

afterAll(async () => {
  await h?.close()
}, 60_000)

describe('Time & action: the gates and milestones of the open orders (PLN-186)', () => {
  it('reads every open order with its gates, milestones and the waiting tiles; actions say what may happen and why', async () => {
    const world = await read()
    expect(world.orders.map((order: Json) => order.number).sort()).toEqual(['SEED-SO-0001', 'SEED-SO-0002', 'SEED-SO-0003'])
    const so2 = orderIn(world, 'SEED-SO-0002')
    expect(so2.gates.map((gate: Json) => [gate.kind, gate.state])).toEqual([
      ['OTHER', 'WAITING'],
      ['PP_SAMPLE', 'WAITING'],
      ['LEATHER_APPROVED', 'PASSED'],
      ['TRIMS_IN', 'STARTED_BEFORE'],
    ])
    expect(so2.waiting.sort()).toEqual(['OTHER', 'PP_SAMPLE'])
    expect(so2.workOrders).toEqual({ count: 2, notStarted: 1 })
    const pp = gateIn(world, samples.gateIds.pp)
    expect(pp).toMatchObject({ sampleRound: { number: 'SEED-SR-0003', kind: 'PRE_PRODUCTION', decision: null }, holds: 1, leather: null })
    // The planner may keep gates but not start before one; the pre-production gate waits for its round.
    expect(pp.actions.pass).toMatchObject({ allowed: false, needs: null, refusal: { code: 'ROUND_NOT_APPROVED' } })
    expect(pp.actions.startBefore).toMatchObject({ allowed: false, needs: 'planning.milestones.override' })
    expect(gateIn(world, samples.gateIds.leather)).toMatchObject({ leather: 'NOT_RECEIVED', actions: { remove: { allowed: false, refusal: { code: 'KEPT' } } } })
    expect(gateIn(world, samples.gateIds.trims).startedBefore).toMatchObject({ reason: expect.any(String) })
    // Milestones: four gates, production start (SEED-WO-0001 started), ship (the promise date).
    expect(so2.milestones.filter((row: Json) => row.kind === 'GATE')).toHaveLength(4)
    expect(so2.milestones.filter((row: Json) => row.kind !== 'GATE').map((row: Json) => row.kind).sort()).toEqual(['SHIP', 'START'])
    expect(so2.milestones.find((row: Json) => row.kind === 'START')).toMatchObject({ state: 'DONE', actual: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })
    expect(so2.milestones.find((row: Json) => row.kind === 'SHIP')).toMatchObject({ target: '2026-12-04', state: 'TO_COME' })
    // SEED-SO-0001 has no work order: no production start milestone.
    expect(orderIn(world, 'SEED-SO-0001').milestones.map((row: Json) => row.kind)).toEqual(['SHIP'])
    expect(world.tiles).toEqual({ SAMPLE: 1, LEATHER_NOT_RECEIVED: 0, LEATHER_NOT_PASSED: 0, TRIMS: 0, OTHER: 1 })
    // Read-only reads it all and may do nothing.
    const reader = gateIn(await read(readOnly), samples.gateIds.other)
    expect(reader.actions.pass).toMatchObject({ allowed: false, needs: 'planning.milestones.manage' })
  })

  it('adds, changes and removes gates; refuses in words and codes what the rules and the database refuse', async () => {
    const so1 = orders['SEED-SO-0001']!
    // One per kind and order.
    expect(refusalOf(await as(planner, 'POST', '/planning/milestones/gates', { salesOrderId: orders['SEED-SO-0002'], kind: 'TRIMS_IN' }, 409))).toBe('refusal/GATE_EXISTS')
    // Other says what it is; a round only on a sample gate; the round must be one of the order's.
    expect(refusalOf(await as(planner, 'POST', '/planning/milestones/gates', { salesOrderId: so1, kind: 'OTHER', label: '   ' }, 409))).toBe('refusal/LABEL_NEEDED')
    expect(refusalOf(await as(planner, 'POST', '/planning/milestones/gates', { salesOrderId: so1, kind: 'LAB_PASSED', sampleRoundId: samples.roundIds.proto }, 409))).toBe('refusal/ROUND_ONLY_SAMPLE')
    expect(refusalOf(await as(planner, 'POST', '/planning/milestones/gates', { salesOrderId: so1, kind: 'PP_SAMPLE', sampleRoundId: samples.roundIds.pp }, 409))).toBe('refusal/ROUND_NOT_OF_ORDER')
    expect(refusalOf(await as(planner, 'POST', '/planning/milestones/gates', { salesOrderId: so1, kind: 'PP_SAMPLE', sampleRoundId: samples.roundIds.proto }, 409))).toBe('refusal/ROUND_KIND')
    // Read-only may not add.
    await as(readOnly, 'POST', '/planning/milestones/gates', { salesOrderId: so1, kind: 'LAB_PASSED' }, 403)

    // A sample gate naming an approved round passes at once, by its round.
    const sample = (await as(planner, 'POST', '/planning/milestones/gates', { salesOrderId: so1, kind: 'SAMPLE_APPROVED', sampleRoundId: samples.roundIds.proto, targetDate: '2026-11-20' }, 201)).gate
    expect(sample).toMatchObject({ state: 'PASSED', via: 'SAMPLE', passedBy: null, sampleRound: { number: 'SEED-SR-0002' } })
    expect((await one('SELECT "passedById" FROM "OrderGate" WHERE id = $1', [sample.id])).passedById).toBe(SYSTEM_ACTOR_ID)

    const lab = (await as(planner, 'POST', '/planning/milestones/gates', { salesOrderId: so1, kind: 'LAB_PASSED', targetDate: '2026-11-18' }, 201)).gate
    expect(lab).toMatchObject({ state: 'WAITING', targetDate: '2026-11-18', ownerId: null, actions: { edit: { allowed: true }, remove: { allowed: true } } })
    const moved = (await as(planner, 'PATCH', `/planning/milestones/gates/${lab.id}`, { version: lab.version, targetDate: '2026-11-21' })).gate
    expect(moved).toMatchObject({ targetDate: '2026-11-21', version: lab.version + 1 })
    // A stale version is a 409 that names the version now.
    await as(planner, 'PATCH', `/planning/milestones/gates/${lab.id}`, { version: lab.version, targetDate: '2026-11-22' }, 409)
    const extra = (await as(planner, 'POST', '/planning/milestones/gates', { salesOrderId: so1, kind: 'OTHER', label: 'Hang tag artwork (made-up)' }, 201)).gate
    expect(await as(planner, 'POST', `/planning/milestones/gates/${extra.id}/remove`, { version: extra.version })).toEqual({ removed: extra.id })
    // A passed gate is kept.
    expect(refusalOf(await as(planner, 'POST', `/planning/milestones/gates/${sample.id}/remove`, { version: sample.version }, 409))).toBe('refusal/KEPT')

    const audits = (await auditsOf(lab.id)).map((row) => row.action)
    expect(audits).toEqual(['planning.milestones.addGate', 'planning.milestones.editGate'])
    expect((await eventsOf(lab.id)).map((row) => [row.type, row.payload.change])).toEqual([
      ['order_gate.changed', 'ADDED'],
      ['order_gate.changed', 'EDITED'],
    ])
  })

  it('the planning board holds a drop while a gate waits; place all by due date skips the order with the code', async () => {
    const wo2 = workOrders['SEED-WO-0002']!
    const line = await one<{ id: string; siteId: string }>('SELECT id, "siteId" FROM "Line" WHERE "tenantId" = $1 ORDER BY code LIMIT 1', [tenant])
    const held = await as(planner, 'POST', '/planning/schedule/slots', { workOrderId: wo2, operationId: null, lane: { kind: 'LINE', id: line.id }, startAt: new Date(Date.now() + 86_400_000).toISOString() }, 409)
    expect(refusalOf(held)).toBe('refusal/GATE_NOT_PASSED')
    expect(issuesOf(held)).toEqual(expect.arrayContaining([`gate/${samples.gateIds.other}`, `gate/${samples.gateIds.pp}`]))
    expect(held.error.message).toMatch(/^SEED-WO-0002 waits on 2 gates not passed/)
    const preview = await as(planner, 'POST', '/planning/schedule/place-by-due-date', { siteId: line.siteId, apply: false })
    expect(preview.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ workOrderId: wo2, code: 'GATE_NOT_PASSED' })]))
  })

  it('starts before the gate only by someone other than its planner and maker, with a reason', async () => {
    const world = await read(manager)
    const pp = gateIn(world, samples.gateIds.pp)
    expect(pp.actions.startBefore).toMatchObject({ allowed: true })
    await as(planner, 'POST', `/planning/milestones/gates/${pp.id}/start-before`, { version: pp.version, reason: 'Made-up: the brand said go by phone.' }, 403)
    expect(issuesOf(await as(manager, 'POST', `/planning/milestones/gates/${pp.id}/start-before`, { version: pp.version, reason: 'ok' }, 400))).toContain('body/reason')
    const started = (await as(manager, 'POST', `/planning/milestones/gates/${pp.id}/start-before`, { version: pp.version, reason: 'Made-up: the brand approved by phone, the PP sample comes Friday.' })).gate
    expect(started).toMatchObject({ state: 'STARTED_BEFORE', startedBefore: { by: { id: managerId }, reason: 'Made-up: the brand approved by phone, the PP sample comes Friday.' } })
    expect(refusalOf(await as(manager, 'POST', `/planning/milestones/gates/${pp.id}/start-before`, { version: started.version, reason: 'Again (made-up).' }, 409))).toBe('refusal/STARTED_BEFORE')
    const audit = (await auditsOf(pp.id)).find((row) => row.action === 'planning.milestones.startBefore')!
    expect(audit.reason).toBe('Made-up: the brand approved by phone, the PP sample comes Friday.')

    // The manager's own gate: they may not start before it (neither its owner nor its maker); the database says the same.
    const own = (await as(manager, 'POST', '/planning/milestones/gates', { salesOrderId: orders['SEED-SO-0003'], kind: 'TRIMS_IN' }, 201)).gate
    expect(own.actions.startBefore).toMatchObject({ allowed: false, refusal: { code: 'OWN_GATE' } })
    expect(refusalOf(await as(manager, 'POST', `/planning/milestones/gates/${own.id}/start-before`, { version: own.version, reason: 'Made-up: my own gate.' }, 409))).toBe('refusal/OWN_GATE')
    await expect(admin('UPDATE "OrderGate" SET "overriddenAt" = now(), "overriddenById" = $2, "overrideReason" = $3 WHERE id = $1', [own.id, managerId, 'x'])).rejects.toThrow(/neither its owner nor its maker/)
  })

  it('passes a sample gate when its round is approved (the handler of sample_round.decided), even one started before', async () => {
    await admin(`UPDATE "SampleRound" SET stage = 'DECIDED', decision = 'APPROVED', "decidedAt" = now(), "decidedVia" = 'OFFICE', "decidedById" = $2 WHERE id = $1`, [samples.roundIds.pp, managerId])
    expect(await passGatesOfRound(system(), samples.roundIds.pp, 'REJECTED', { key: newId() })).toEqual([])
    expect(await passGatesOfRound(system(), samples.roundIds.pp, 'APPROVED', { key: newId() })).toEqual([samples.gateIds.pp])
    const gate = gateIn(await read(), samples.gateIds.pp)
    expect(gate).toMatchObject({ state: 'PASSED', via: 'SAMPLE', passedBy: null, startedBefore: { reason: expect.any(String) } })
    expect((await eventsOf(samples.gateIds.pp)).map((row) => [row.payload.change, row.payload.via])).toEqual([
      ['STARTED_BEFORE', null],
      ['PASSED', 'SAMPLE'],
    ])
    // A repeat finds nothing waiting.
    expect(await passGatesOfRound(system(), samples.roundIds.pp, 'APPROVED', { key: newId() })).toEqual([])
  })

  it('marks gates done in one command (never on a day to come); the board then takes the drop', async () => {
    const world = await read()
    const other = gateIn(world, samples.gateIds.other)
    expect(refusalOf(await as(planner, 'POST', '/planning/milestones/gates/pass', { gates: [{ id: other.id, version: other.version }], on: '2999-01-01' }, 409))).toBe('refusal/FUTURE_DAY')
    const lab = orderIn(world, 'SEED-SO-0001').gates.find((gate: Json) => gate.kind === 'LAB_PASSED')
    const done = await as(planner, 'POST', '/planning/milestones/gates/pass', { gates: [{ id: other.id, version: other.version }, { id: lab.id, version: lab.version }] })
    expect(done.passed).toEqual([
      { id: other.id, version: other.version + 1 },
      { id: lab.id, version: lab.version + 1 },
    ])
    const after = await read()
    expect(gateIn(after, other.id)).toMatchObject({ state: 'PASSED', via: 'OFFICE', passedBy: { name: expect.any(String) } })
    expect(orderIn(after, 'SEED-SO-0002').waiting).toEqual([])
    expect(after.tiles).toMatchObject({ SAMPLE: 0, OTHER: 0 })
    const preview = await as(planner, 'POST', '/planning/schedule/place-by-due-date', { siteId: (await one('SELECT "siteId" FROM "WorkOrder" WHERE id = $1', [workOrders['SEED-WO-0002']])).siteId, apply: false })
    expect(preview.skipped.filter((row: Json) => row.code === 'GATE_NOT_PASSED' && row.workOrderId === workOrders['SEED-WO-0002'])).toEqual([])
  })

  it("passes an order's leather gate when every leather lot reserved for it is released (the handler of lot.released)", async () => {
    const so3 = orders['SEED-SO-0003']!
    const gate = (await as(planner, 'POST', '/planning/milestones/gates', { salesOrderId: so3, kind: 'LEATHER_APPROVED', targetDate: '2026-11-19' }, 201)).gate
    expect(gate).toMatchObject({ state: 'WAITING', leather: 'NOT_RECEIVED' })
    expect((await read()).tiles.LEATHER_NOT_RECEIVED).toBe(1)
    const lot = await one<{ lotId: string; itemId: string }>(`SELECT id AS "lotId", "itemId" FROM "Lot" WHERE "tenantId" = $1 AND code = 'SEED-LOT-LEA-01'`, [tenant])
    // Nothing reserved for SEED-SO-0003 yet: the release of the lot passes nothing.
    expect(await passLeatherGatesOfLot(system(), lot.lotId, lot.itemId, { key: newId() })).toEqual([])
    // The lot (released) reserved for SEED-WO-0003 by area, in its own colour (as a planner's reserve writes it).
    await admin(
      `INSERT INTO "Reservation" (id, "tenantId", "companyId", "siteId", kind, "itemId", "itemColourId", "lotId", quantity, "workOrderId", status, "createdAt", "updatedAt")
       SELECT $1, l."tenantId", l."companyId", l."siteId", 'AREA', l."itemId", l."itemColourId", l.id, 1, $2, 'ACTIVE', now(), now() FROM "Lot" l WHERE l.id = $3`,
      [newId(), workOrders['SEED-WO-0003'], lot.lotId],
    )
    expect(gateIn(await read(), gate.id)).toMatchObject({ state: 'WAITING', leather: 'PASSED' })
    expect(await passLeatherGatesOfLot(system(), lot.lotId, lot.itemId, { key: newId() })).toEqual([gate.id])
    expect(gateIn(await read(), gate.id)).toMatchObject({ state: 'PASSED', via: 'LOT' })
    expect((await auditsOf(gate.id)).at(-1)).toMatchObject({ action: 'planning.milestones.passGate', after: { passedBy: 'LOT', lotId: lot.lotId } })
  })
})
