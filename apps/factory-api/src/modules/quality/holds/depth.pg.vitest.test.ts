import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * Holds in depth (B-W2b-114; QHS-075 hold by genealogy, QHS-077 the hold board, QHS-078 the quarantine move) on the local
 * stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level
 * security and the …_quality_plant_w2a_guards / …_quality_problems_w2b_guards triggers are real), tenant A from EVERY seed
 * (SEED-LOT-LEA-01 with its two hides — SEED-HIDE-0002 held at the cutting table in the seeded hold group — issued to
 * SEED-WO-0001; SEED-LOT-LEA-09's remnant issued to the same work order; SEED-SH-0001 shipped, SEED-SH-0002 a draft; the
 * A1-QUA quarantine place). Test sessions; every name and number made up.
 *   - the tree a hold by genealogy ticks: what is holdable, held, gone, the site's quarantine place; refusals by right;
 *   - placing it: ONE group, a hold per kind and site with the group named, the shipped branch refused at picks/<key>,
 *     what is held already left as it is; extending a hold without a group makes a group naming it;
 *   - what a hold touches (Affected) and where Extend starts;
 *   - the board's lane: moved with the version, refused when stale or the same, filtered;
 *   - the quarantine move: asked, refused by right and by a wrong code, confirmed by the place's code with the stock
 *     transferred into the place in the same command.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/quality/holds`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'holds-depth'
const id = (key: string) => seedUuid(NS, key)
const A = {
  tenant: id('tenant'),
  companyA: id('company:A'),
  companyB: id('company:B'),
  siteA1: id('site:A1'),
  wo1: id('production:work-order:WO-0001'),
}

let h: Harness
let app: FastifyInstance
const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  placer: office([grant(['quality.holds.view', 'quality.holds.place', 'parties.view'])]),
  viewer: office([grant(['quality.holds.view'])]),
  warehouse: office([grant(['quality.holds.view', 'inventory.transfer', 'inventory.stock.view'])]),
  companyB: office([grant(['quality.holds.view', 'quality.holds.place'], { companies: [A.companyB] })]),
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `depth-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': freshKey() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [A.tenant, type])).map((row) => row.payload)
const lotId = async (code: string) => (await admin<{ id: string }>(`SELECT id FROM "Lot" WHERE "tenantId" = $1 AND code = $2`, [A.tenant, code]))[0]!.id
const keysOf = (tree: Json, hold: string) => (tree.nodes as Json[]).filter((node) => node.hold === hold).map((node) => node.key as string)
const node = (tree: Json, kind: string, code: string) => (tree.nodes as Json[]).find((entry) => entry.kind === kind && entry.code === code)

let lea01: string
let lea09: string
let lea09Hold: Json
let lea01LotHold: Json
let lea01Group: Json

beforeAll(async () => {
  h = await startHarness('quality_holds_depth')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  lea01 = await lotId('SEED-LOT-LEA-01')
  lea09 = await lotId('SEED-LOT-LEA-09')
}, 1_500_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
})

describe('hold by genealogy (QHS-075)', () => {
  it('reads the tree a person ticks: holdable, held, gone; the site with its one quarantine place', async () => {
    const tree = await ok('placer', 'GET', `/quality/holds/genealogy?type=Lot&id=${lea01}`)
    expect(tree.start).toMatchObject({ type: 'Lot', id: lea01, code: 'SEED-LOT-LEA-01' })
    expect(node(tree, 'LOT', 'SEED-LOT-LEA-01')).toMatchObject({ hold: 'HOLDABLE', holdKind: 'Lot', siteId: A.siteA1 })
    expect(node(tree, 'HIDE', 'SEED-HIDE-0002')).toMatchObject({ hold: 'HELD', holds: [expect.objectContaining({ reasonCode: expect.any(String) })] })
    expect(node(tree, 'HIDE', 'SEED-HIDE-0001')).toMatchObject({ hold: 'HOLDABLE' })
    expect(node(tree, 'WORK_ORDER', 'SEED-WO-0001')).toMatchObject({ hold: 'HOLDABLE', holdKind: 'WorkOrder' })
    expect((tree.nodes as Json[]).find((entry) => entry.kind === 'SHIPMENT' && entry.state === 'SHIPPED')).toMatchObject({ hold: 'LEFT', problem: expect.stringMatching(/PPE register/) })
    expect((tree.nodes as Json[]).some((entry) => entry.kind === 'CUSTOMER' && entry.received === true)).toBe(true)
    expect(tree.sites).toEqual([expect.objectContaining({ id: A.siteA1, mayPlace: true, quarantinePlaces: [expect.objectContaining({ code: 'A1-QUA' })] })])
    expect(tree.levels.map((level: Json) => level.kind)).toEqual(expect.arrayContaining(['LOT', 'HIDE', 'WORK_ORDER']))
    expect(JSON.stringify(tree)).not.toMatch(/"(cost|price|margin|value|amount)"/)
    // Refusals: a reader without holds.place; another company's staff (not found); an unknown lot.
    expect((await refused('viewer', 'GET', `/quality/holds/genealogy?type=Lot&id=${lea01}`, undefined, 403)).code).toBe('forbidden')
    expect((await refused('companyB', 'GET', `/quality/holds/genealogy?type=Lot&id=${lea01}`, undefined, 404)).code).toBe('not_found')
    await refused('placer', 'GET', `/quality/holds/genealogy?type=Lot&id=${newId()}`, undefined, 404)
  })

  it('extends a hold without a group: refuses a shipped branch at picks/<key>, then ONE group naming it and a hold per kind', async () => {
    lea09Hold = (await ok('placer', 'POST', '/quality/holds', { subjectType: 'Lot', subjectIds: [lea09], reasonCode: 'SUPPLIER_CHECK', reasonNote: 'Demo tannery warned of the dye batch' }, 201)).hold
    expect(lea09Hold.group).toBeNull()
    expect(lea09Hold.nextStep).toBe('NEW')
    const tree = await ok('placer', 'GET', `/quality/holds/genealogy?type=Lot&id=${lea09}&holdId=${lea09Hold.id}`)
    expect(tree.extending).toMatchObject({ holdId: lea09Hold.id, groupId: null })
    expect(node(tree, 'LOT', 'SEED-LOT-LEA-09')).toMatchObject({ hold: 'HELD' })
    // The remnant lot's own hide is what is left to hold.
    const holdable = keysOf(tree, 'HOLDABLE')
    expect(holdable).toEqual([expect.stringMatching(/^HIDE:/)])
    const body = { type: 'Lot', id: lea09, reasonCode: 'SUPPLIER_CHECK', reasonNote: 'Hold what was made from the suspect lot', askQuarantine: true, holdId: lea09Hold.id }
    expect(paths(await refused('placer', 'POST', '/quality/holds/genealogy', { ...body, picks: holdable, reasonCode: 'NO_SUCH_REASON' }, 400))).toEqual(['body/reasonCode'])
    const placed = await ok('placer', 'POST', '/quality/holds/genealogy', { ...body, picks: [...holdable, `LOT:${lea09}`, ...tree.nodes.filter((entry: Json) => entry.kind === 'CELL').map((entry: Json) => entry.key)] }, 201)
    expect(placed.alreadyHeld).toEqual([{ key: `LOT:${lea09}`, code: 'SEED-LOT-LEA-09' }])
    expect(placed.group).toMatchObject({ sourceType: 'Lot', sourceId: lea09, sourceCode: 'SEED-LOT-LEA-09', reasonCode: 'SUPPLIER_CHECK' })
    expect(placed.group.counts).toMatchObject({ Lot: 1, Hide: 1 })
    expect(placed.holds.map((hold: Json) => hold.subjectType)).toEqual(['Hide'])
    expect(placed.holds[0]).toMatchObject({ quarantine: 'ASKED', quarantineLocation: { code: 'A1-QUA' } })
    expect(placed.holds.every((hold: Json) => hold.group?.id === placed.group.id && /^HLD-/.test(hold.number))).toBe(true)
    expect(placed.group.holds.map((hold: Json) => hold.id)).toEqual(expect.arrayContaining([lea09Hold.id, ...placed.holds.map((hold: Json) => hold.id)]))
    const joined = await ok('placer', 'GET', `/quality/holds/${lea09Hold.id}`)
    expect(joined.hold.group).toMatchObject({ id: placed.group.id, sourceCode: 'SEED-LOT-LEA-09' })
    expect((await events('quality.hold_changed')).some((payload) => payload.holdId === lea09Hold.id && payload.fields.includes('groupId'))).toBe(true)
    const listed = await ok('placer', 'GET', `/quality/holds?groupId=${placed.group.id}`)
    expect(listed.holds.length).toBe(placed.group.holds.length)
    // Everything is held now: nothing left to hold is said.
    expect((await refused('placer', 'POST', '/quality/holds/genealogy', { ...body, picks: [`LOT:${lea09}`] }, 409)).message).toBe('Everything ticked is on hold already.')
  })

  it('holds the suspect lot\'s tree: a shipped branch refused at picks/<key>, the work order ON_HOLD, what is held already left', async () => {
    const tree = await ok('placer', 'GET', `/quality/holds/genealogy?type=Lot&id=${lea01}`)
    const body = { type: 'Lot', id: lea01, reasonCode: 'QUALITY_CHECK', askQuarantine: true }
    const picks = [...keysOf(tree, 'HOLDABLE'), ...keysOf(tree, 'HELD'), ...tree.nodes.filter((entry: Json) => entry.kind === 'CELL').map((entry: Json) => entry.key)]
    const left = keysOf(tree, 'LEFT')
    expect(left.length).toBeGreaterThan(0)
    expect(paths(await refused('placer', 'POST', '/quality/holds/genealogy', { ...body, picks: [...picks, ...left] }, 409))).toEqual(left.map((key) => `picks/${key}`))
    const placed = await ok('placer', 'POST', '/quality/holds/genealogy', { ...body, picks }, 201)
    lea01Group = placed.group
    lea01LotHold = placed.holds.find((hold: Json) => hold.subjectType === 'Lot')
    expect(lea01LotHold).toMatchObject({ subjects: [{ id: lea01 }], quarantine: 'ASKED', quarantineLocation: { code: 'A1-QUA' } })
    const kinds = placed.holds.map((hold: Json) => hold.subjectType)
    expect(kinds).toEqual(expect.arrayContaining(['Lot', 'Hide', 'WorkOrder']))
    expect(new Set(kinds).size).toBe(kinds.length)
    expect(placed.alreadyHeld.map((entry: Json) => entry.code)).toEqual(['SEED-HIDE-0002'])
    expect(placed.group.counts).toMatchObject({ Lot: 1, Hide: 1, WorkOrder: 1, customers: expect.any(Number) })
    expect((await admin<Json>(`SELECT status::text FROM "WorkOrder" WHERE id = $1`, [A.wo1]))[0]!.status).toBe('ON_HOLD')
    expect((await events('quality.hold_placed')).filter((payload) => placed.holds.some((hold: Json) => hold.id === payload.holdId)).length).toBe(placed.holds.length)
    expect(placed.quarantineNotAsked).toEqual([])
    expect(paths(await refused('placer', 'POST', '/quality/holds/genealogy', { type: 'Lot', id: lea01, picks: [], reasonCode: 'QUALITY_CHECK' }, 400))).toEqual(['body/picks'])
  })
})

describe('a hold from an incoming inspection (B-W2b-98\'s gap)', () => {
  it('takes IncomingInspection as its source: an unknown one refused at body/sourceId', async () => {
    const hide = (await admin<{ id: string }>(`SELECT id FROM "Hide" WHERE "tenantId" = $1 AND code = 'SEED-HIDE-0009'`, [A.tenant]))[0]!.id
    expect(paths(await refused('placer', 'POST', '/quality/holds', { subjectType: 'Hide', subjectIds: [hide], reasonCode: 'QUALITY_CHECK', sourceType: 'IncomingInspection', sourceId: newId() }, 400))).toEqual(['body/sourceId'])
    await refused('placer', 'POST', '/quality/holds', { subjectType: 'Hide', subjectIds: [hide], reasonCode: 'QUALITY_CHECK', sourceType: 'Email', sourceId: newId() }, 400)
  })
})

describe('what a hold touches (Hold › Affected)', () => {
  it('traces the hold\'s records forward, counts by state, names its group and where Extend starts', async () => {
    const affected = await ok('viewer', 'GET', `/quality/holds/${lea09Hold.id}/affected`)
    expect(affected).toMatchObject({ traced: 1, of: 1, traceable: true, starts: [{ kind: 'LOT', id: lea09, code: 'SEED-LOT-LEA-09' }] })
    expect(affected.states.garments).toEqual(expect.objectContaining({ inWork: expect.any(Number), shipped: expect.any(Number) }))
    expect(affected.group).toMatchObject({ sourceCode: 'SEED-LOT-LEA-09' })
    expect(affected.extend).toEqual({ start: null, held: 'NO_RIGHT' })
    const placer = await ok('placer', 'GET', `/quality/holds/${lea09Hold.id}/affected`)
    expect(placer.extend).toEqual({ start: { type: 'Lot', id: lea09, code: 'SEED-LOT-LEA-09' }, held: null })
    const woHold = lea01Group.holds.find((hold: Json) => hold.subjectType === 'WorkOrder')
    const ofWorkOrder = await ok('placer', 'GET', `/quality/holds/${woHold.id}/affected`)
    expect(ofWorkOrder).toMatchObject({ starts: [{ kind: 'WORK_ORDER' }], extend: { start: { type: 'Lot', id: lea01, code: 'SEED-LOT-LEA-01' }, held: null } })
    await refused('companyB', 'GET', `/quality/holds/${lea09Hold.id}/affected`, undefined, 404)
  })
})

describe('the hold board (QHS-077)', () => {
  it('moves a hold to another lane at the version read; refuses a stale version, the same lane and a reader', async () => {
    const moved = await ok('placer', 'POST', `/quality/holds/${lea09Hold.id}/next-step`, { version: (await ok('placer', 'GET', `/quality/holds/${lea09Hold.id}`)).hold.version, nextStep: 'INVESTIGATING' })
    expect(moved.hold.nextStep).toBe('INVESTIGATING')
    expect((await events('quality.hold_changed')).some((payload) => payload.holdId === lea09Hold.id && payload.fields.includes('nextStep'))).toBe(true)
    await refused('placer', 'POST', `/quality/holds/${lea09Hold.id}/next-step`, { version: moved.hold.version - 1, nextStep: 'WAITING_DECISION' }, 409)
    expect(paths(await refused('placer', 'POST', `/quality/holds/${lea09Hold.id}/next-step`, { version: moved.hold.version, nextStep: 'INVESTIGATING' }, 409))).toEqual(['body/nextStep'])
    await refused('viewer', 'POST', `/quality/holds/${lea09Hold.id}/next-step`, { version: moved.hold.version, nextStep: 'READY_TO_RELEASE' }, 403)
    const lane = await ok('viewer', 'GET', '/quality/holds?nextStep=INVESTIGATING')
    expect(lane.holds.map((hold: Json) => hold.id)).toEqual([lea09Hold.id])
  })
})

describe('the quarantine move (QHS-078)', () => {
  it('confirms by the place code: refused without inventory.transfer and for a wrong code, then the stock moves into the place', async () => {
    const detail = await ok('warehouse', 'GET', `/quality/holds/${lea01LotHold.id}`)
    expect(detail.stock.places.map((place: Json) => place.code)).toEqual(['A1-QUA'])
    expect(detail.stock.lying.some((entry: Json) => entry.moves === true)).toBe(true)
    const version = detail.hold.version
    expect((await refused('placer', 'POST', `/quality/holds/${lea01LotHold.id}/quarantine/confirm`, { version, placeCode: 'A1-QUA' }, 403)).code).toBe('forbidden')
    expect(paths(await refused('warehouse', 'POST', `/quality/holds/${lea01LotHold.id}/quarantine/confirm`, { version, placeCode: 'A1-STORE' }, 400))).toEqual(['body/placeCode'])
    const confirmed = await ok('warehouse', 'POST', `/quality/holds/${lea01LotHold.id}/quarantine/confirm`, { version, placeCode: ' a1 qua ' })
    expect(confirmed.hold).toMatchObject({ quarantine: 'MOVED', quarantineLocation: { code: 'A1-QUA' }, quarantineMovedAt: expect.any(String) })
    expect(confirmed.moved.length).toBeGreaterThan(0)
    expect(confirmed.stock.lying.filter((entry: Json) => entry.kind !== 'SUBCONTRACTOR').every((entry: Json) => entry.code === 'A1-QUA')).toBe(true)
    const transfers = await admin<Json>(`SELECT count(*)::int AS n FROM "StockMove" m JOIN "Location" l ON l.id = m."toLocationId" WHERE m."lotId" = $1 AND m.reason = 'TRANSFER' AND l.code = 'A1-QUA'`, [lea01])
    expect(transfers[0]!.n).toBe(confirmed.moved.length)
    expect((await events('quality.hold_changed')).some((payload) => payload.holdId === lea01LotHold.id && payload.fields.includes('quarantine'))).toBe(true)
    expect((await refused('warehouse', 'POST', `/quality/holds/${lea01LotHold.id}/quarantine/confirm`, { version: confirmed.hold.version, placeCode: 'A1-QUA' }, 409)).message).toMatch(/confirmed already/)
  })

  it('asks the move of a stock hold; never of a work order, never without the right', async () => {
    const current = (await ok('placer', 'GET', `/quality/holds/${lea09Hold.id}`)).hold
    expect(current.quarantine).toBe('NOT_NEEDED')
    await refused('viewer', 'POST', `/quality/holds/${lea09Hold.id}/quarantine/ask`, { version: current.version }, 403)
    const asked = await ok('placer', 'POST', `/quality/holds/${lea09Hold.id}/quarantine/ask`, { version: current.version })
    expect(asked.hold).toMatchObject({ quarantine: 'ASKED', quarantineLocation: { code: 'A1-QUA' } })
    const woHold = lea01Group.holds.find((hold: Json) => hold.subjectType === 'WorkOrder')
    const wo = (await ok('placer', 'GET', `/quality/holds/${woHold.id}`)).hold
    expect((await refused('placer', 'POST', `/quality/holds/${wo.id}/quarantine/ask`, { version: wo.version }, 409)).message).toMatch(/Only stock/)
  })
})
