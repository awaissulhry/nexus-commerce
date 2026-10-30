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
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * Nonconformances (B-W2a-47; QHS-080 from anywhere, QHS-081 content, QHS-082 containment, QHS-083 disposition by
 * quantity, QHS-089 board, QHS-090 closure rules, QHS-091 rework order) on the local stack with the app's real routes: a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the
 * …_quality_plant_w2a_guards triggers are real), tenant A from EVERY seed (the lining lot SEED-LOT-LIN-01 120 M at
 * A1-STORE-01, the hide SEED-HIDE-0002 on hold decided in SEED-NCR-0002 (CONTAINED, its SCRAP of 12 FT2 not carried
 * out), SEED-WO-0001 in progress with its bundles, the open inspection SEED-INS-0002 of the PPE style SEED-JKT-02, the
 * standard disposition codes). Closing is an e-signature: a quality inspector signed in through the harness's real
 * sign-in with two-factor (step-up); the other calls use test sessions. Every name and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/quality/ncr`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'ncr-a'
const id = (key: string) => seedUuid(NS, key)
const firstId = (key: string) => `00000000${id(key).slice(8)}`
const A = {
  tenant: id('tenant'),
  companyA: id('company:A'),
  companyB: id('company:B'),
  siteA1: id('site:A1'),
  hideH2: id('inventory:hide:H2'),
  leatherLot: id('inventory:lot:LEA-01'),
  wo1: id('production:work-order:WO-0001'),
  wo3: `ffffffff${id('quality:work-order:WO-0003').slice(8)}`,
  seedNcr2: id('holds:ncr:NCR-0002'),
  seedHold: firstId('holds:hold:HIDE-0002'),
}
const TENANT: TestTenant = { id: A.tenant, slug: NS, companies: [{ id: A.companyA, code: 'A' }, { id: A.companyB, code: 'B' }] }

let h: Harness
let app: FastifyInstance
const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const QUALITY: Permission[] = ['quality.ncr.view', 'quality.ncr.raise', 'quality.ncr.manage', 'quality.ncr.approve', 'quality.holds.view', 'quality.holds.place', 'inventory.scrap', 'inventory.transfer', 'inventory.stock.view', 'production.rework', 'production.scrap.view']
const SESSIONS: Record<string, SessionContext> = {
  qa: office([grant(QUALITY)]),
  qa2: office([grant(QUALITY)]),
  buyer: office([grant([...QUALITY, 'purchasing.view', 'purchasing.claims.manage'])]),
  raiser: office([grant(['quality.ncr.view', 'quality.ncr.raise'])]),
  viewer: office([grant(['quality.ncr.view'])]),
  companyB: office([grant(QUALITY, { companies: [A.companyB] })]),
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `ncr-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, key = freshKey()) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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

interface Person {
  readonly id: string
  readonly browser: Browser
  readonly secret: string
}
const signedIn = async (email: string, role: string): Promise<Person> => {
  const user = await addUser(h, TENANT, { email, role })
  const browser = new Browser(h.app)
  const answer = await browser.signIn(TENANT.slug, user.email, user.password)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in ${email}: ${answer.status} ${JSON.stringify(answer.body)}`)
  return { id: user.id, browser, secret: await enrolTotp(h, browser) }
}
async function as(person: Person, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await person.browser.send(method as 'POST', url, body, { headers: { 'idempotency-key': freshKey() } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}
const close = async (person: Person, ncrId: string, note: string, status = 200) => {
  await stepUp(h, person.browser, person.secret)
  const { record } = await as(person, 'GET', `/quality/ncr/${ncrId}`)
  return as(person, 'POST', `/quality/ncr/${ncrId}/close`, { version: record.ncr.version, note }, status)
}

let qa1: Person
const codes: Record<string, string> = {}
const places: Record<string, string> = {}
let lining: { id: string; itemId: string; code: string }
let bundle: { id: string; code: string }
let sewOp: string
let openInspection: string

beforeAll(async () => {
  h = await startHarness('quality_ncr')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  // The system roles as the templates hold them now (quality.ncr.* for the quality inspector).
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  qa1 = await signedIn('qa.one@example.com', 'quality_inspector')
  for (const row of await admin<{ id: string; code: string }>(`SELECT id, code FROM "DispositionCode" WHERE "tenantId" = $1`, [A.tenant])) codes[row.code] = row.id
  for (const row of await admin<{ id: string; code: string }>(`SELECT id, code FROM "Location" WHERE "tenantId" = $1 AND "siteId" = $2`, [A.tenant, A.siteA1])) places[row.code] = row.id
  lining = (await admin<{ id: string; itemId: string; code: string }>(`SELECT id, "itemId", code FROM "Lot" WHERE "tenantId" = $1 AND code = 'SEED-LOT-LIN-01'`, [A.tenant]))[0]!
  bundle = (await admin<{ id: string; code: string }>(`SELECT id, code FROM "Bundle" WHERE "workOrderId" = $1 AND code = 'SEED-BN-0001'`, [A.wo1]))[0]!
  sewOp = (await admin<{ id: string }>(`SELECT id FROM "WorkOrderOperation" WHERE "workOrderId" = $1 AND seq = 20`, [A.wo1]))[0]!.id
  openInspection = (await admin<{ id: string }>(`SELECT id FROM "Inspection" WHERE "workOrderId" = $1 AND status = 'OPEN' ORDER BY id LIMIT 1`, [A.wo1]))[0]!.id
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
})

describe('raising an NCR from anywhere (QHS-080, QHS-081)', () => {
  it('prefills from a lot and raises it numbered from the NCR series, linked to its source', async () => {
    const { prefill } = await ok('qa', 'GET', `/quality/ncr/prefill?recordType=Lot&recordId=${lining.id}`)
    expect(prefill).toMatchObject({ fromType: 'Lot', label: 'Lot SEED-LOT-LIN-01', siteId: A.siteA1, companyId: A.companyA, source: 'SUPPLIER', foundAt: 'STOCK', quantityAffected: '120.0000', uom: 'M', itemId: lining.itemId, lotId: lining.id, problem: null })
    const { record } = await ok('qa', 'POST', '/quality/ncr', { from: { recordType: 'Lot', recordId: lining.id }, title: 'Shading across the lining roll', quantityAffected: '20', severity: 'MAJOR' }, 201)
    expect(record.ncr).toMatchObject({ number: expect.stringMatching(/^NCR-\d{4}-\d{4}$/), stage: 'OPEN', source: 'SUPPLIER', sourceType: 'Lot', sourceId: lining.id, quantityAffected: '20', uom: 'M', lot: { code: 'SEED-LOT-LIN-01' }, decided: { words: '0 of 20 M decided · 20 left' } })
    expect(record.ncr.containmentDueAt).not.toBeNull()
    expect(record.links.map((link: Json) => [link.recordType, link.label])).toEqual([['Lot', 'Lot SEED-LOT-LIN-01']])
    expect(record.next).toMatchObject({ stage: 'CONTAINED', ready: false })
    expect(record.may).toEqual({ manage: true, approve: true, close: false, raise: true })
    const created = (await events('ncr.created')).find((payload) => payload.ncrId === record.ncr.id)
    expect(created).toMatchObject({ number: record.ncr.number, source: 'SUPPLIER', sourceType: 'Lot', severity: 'MAJOR', lotId: lining.id, holdIds: [], registerEntryId: null })
  })

  it('refuses in words: no site, a zone off the map, a hold decided elsewhere, a site out of reach, no right', async () => {
    expect(paths(await refused('qa', 'POST', '/quality/ncr', { title: 'Loose thread', quantityAffected: '1', severity: 'MINOR' }, 400))).toEqual(['body/siteId'])
    expect(paths(await refused('qa', 'POST', '/quality/ncr', { siteId: A.siteA1, title: 'Loose thread', quantityAffected: '1', severity: 'MINOR', zone: 'ELBOW' }, 400))).toEqual(['body/zone'])
    expect((await refused('qa', 'POST', '/quality/ncr', { from: { recordType: 'QualityHold', recordId: A.seedHold } }, 409)).message).toBe('This hold is decided in SEED-NCR-0002: follow it up there.')
    expect((await refused('companyB', 'POST', '/quality/ncr', { siteId: A.siteA1, title: 'x', quantityAffected: '1', severity: 'MINOR' }, 403)).message).toBe('You raise NCRs only at the sites your role reaches.')
    expect((await refused('viewer', 'POST', '/quality/ncr', { siteId: A.siteA1, title: 'x', quantityAffected: '1', severity: 'MINOR' }, 403)).code).toBe('forbidden')
  })

  it('a PPE nonconformity that may present a risk opens its PPE register entry (critical, from the inspection)', async () => {
    const { record } = await ok('qa', 'POST', '/quality/ncr', { from: { recordType: 'Inspection', recordId: openInspection }, title: 'Shoulder protector pocket missing', quantityAffected: '1', severity: 'CRITICAL' }, 201)
    expect(record.ncr).toMatchObject({ source: 'INSPECTION', foundAt: 'FINAL', workOrder: { number: 'SEED-WO-0001' }, style: { ppe: true } })
    expect(record.register).toMatchObject({ reference: expect.any(String), status: 'OPEN' })
    expect(record.links.map((link: Json) => link.recordType).sort()).toEqual(['Inspection', 'PpeRegisterEntry', 'WorkOrder'])
    const [entry] = await admin<Json>(`SELECT "sourceType", "sourceId", kind::text FROM "PpeRegisterEntry" WHERE id = $1`, [record.register.id])
    expect(entry).toEqual({ sourceType: 'Nonconformance', sourceId: record.ncr.id, kind: 'NON_CONFORMITY' })
  })
})

describe('containment, decisions by quantity, carrying out and closing (QHS-082, QHS-083, QHS-090)', () => {
  let ncr: Json
  const url = () => `/quality/ncr/${ncr.ncr.id}`

  it('contains once every action is done or cancelled and one is done; holding stock places the hold the NCR decides', async () => {
    ;({ record: ncr } = await ok('qa', 'POST', '/quality/ncr', { from: { recordType: 'Lot', recordId: lining.id }, title: 'Lining shrinks at pressing', quantityAffected: '20', severity: 'CRITICAL' }, 201))
    ;({ record: ncr } = await ok('qa', 'POST', `${url()}/containment`, { version: ncr.ncr.version, kind: 'CHECK_WIP', description: 'Check the linings cut this week', dueAt: '2099-01-01T10:00:00.000Z' }, 201))
    const check = ncr.containment[0]
    expect(check).toMatchObject({ seq: 1, kind: 'CHECK_WIP', status: 'OPEN', overdue: false })
    const early = await refused('qa', 'POST', `${url()}/stage`, { version: ncr.ncr.version, to: 'CONTAINED' }, 409)
    expect(paths(early)).toEqual(['stage/ACTION_DONE', 'stage/NO_OPEN_ACTION'])
    expect(paths(await refused('qa', 'POST', `${url()}/containment/${check.id}/done`, { version: check.version }, 400))).toEqual(['body/evidenceNote'])
    ;({ record: ncr } = await ok('qa', 'POST', `${url()}/containment`, { version: ncr.ncr.version, kind: 'HOLD_STOCK', hold: { subjectType: 'Lot', subjectIds: [lining.id], reasonCode: 'QUALITY_CHECK' } }, 201))
    const held = ncr.containment[1]
    expect(held).toMatchObject({ kind: 'HOLD_STOCK', status: 'DONE', record: { type: 'QualityHold' }, hold: { status: 'ACTIVE', subjectType: 'Lot', count: 1 } })
    const [hold] = await admin<Json>(`SELECT "ncrId", "sourceType", "sourceId", status::text FROM "QualityHold" WHERE id = $1`, [held.hold.id])
    expect(hold).toEqual({ ncrId: ncr.ncr.id, sourceType: 'Nonconformance', sourceId: ncr.ncr.id, status: 'ACTIVE' })
    ;({ record: ncr } = await ok('qa', 'POST', `${url()}/containment/${check.id}/done`, { version: check.version, evidenceNote: 'Checked: 12 linings cut, none shrunk.' }))
    ;({ record: ncr } = await ok('qa', 'POST', `${url()}/stage`, { version: ncr.ncr.version, to: 'CONTAINED' }))
    expect(ncr.ncr).toMatchObject({ stage: 'CONTAINED', containedAt: expect.any(String) })
    expect(ncr.next).toMatchObject({ stage: 'DECIDED', ready: false })
  })

  it('splits the quantity across dispositions: never more than is left, never "use as is" on a critical NCR', async () => {
    expect(paths(await refused('qa', 'POST', `${url()}/decisions`, { version: ncr.ncr.version, dispositionCodeId: codes.USE_AS_IS, quantity: '1' }, 400))).toEqual(['body/dispositionCodeId'])
    const over = await refused('qa', 'POST', `${url()}/decisions`, { version: ncr.ncr.version, dispositionCodeId: codes.SCRAP, quantity: '25' }, 400)
    expect(over.message).toBe('Only 20 M are left to decide.')
    ;({ record: ncr } = await ok('qa', 'POST', `${url()}/decisions`, { version: ncr.ncr.version, dispositionCodeId: codes.SCRAP, quantity: '5', note: 'The shrunk end of the roll' }, 201))
    const decided = await refused('qa', 'POST', `${url()}/stage`, { version: ncr.ncr.version, to: 'DECIDED' }, 409)
    expect(decided.message).toBe('5 of 20 M decided · 15 left: decide the rest first.')
    ;({ record: ncr } = await ok('qa', 'POST', `${url()}/decisions`, { version: ncr.ncr.version, dispositionCodeId: codes.REGRADE, quantity: '15' }, 201))
    expect(ncr.decisions.map((row: Json) => [row.seq, row.disposition.code, row.quantity, row.state])).toEqual([
      [1, 'SCRAP', '5', expect.any(String)],
      [2, 'REGRADE', '15', expect.any(String)],
    ])
    expect((await events('ncr.decision_changed')).filter((payload) => payload.ncrId === ncr.ncr.id).map((payload) => payload.change)).toEqual(['ADDED', 'ADDED'])
  })

  it('a decision that needs approval waits for another person (four eyes), then the NCR is decided', async () => {
    // SCRAP asks for approval on a critical NCR; REGRADE's value rule (500.00) is not met by 15 M of the lining's cost.
    expect(ncr.decisions.map((decision: Json) => [decision.disposition.code, decision.approvalRequired, decision.state])).toEqual([
      ['SCRAP', true, 'WAITING_APPROVAL'],
      ['REGRADE', false, 'TO_CARRY_OUT'],
    ])
    expect((await refused('qa2', 'POST', `${url()}/decisions/${ncr.decisions[1].id}/approve`, { version: ncr.decisions[1].version }, 409)).message).toBe('This decision needs no approval.')
    const own = await refused('qa', 'POST', `${url()}/decisions/${ncr.decisions[0].id}/approve`, { version: ncr.decisions[0].version }, 409)
    expect(own.message).toBe('You decided this: another person approves it (four eyes).')
    const waiting = await refused('qa', 'POST', `${url()}/decisions/${ncr.decisions[0].id}/carry-out`, { version: ncr.decisions[0].version }, 409)
    expect(waiting.message).toBe("This decision waits for another person's approval.")
    ;({ record: ncr } = await ok('qa2', 'POST', `${url()}/decisions/${ncr.decisions[0].id}/approve`, { version: ncr.decisions[0].version }))
    expect(ncr.decisions[0]).toMatchObject({ state: 'TO_CARRY_OUT', approvedById: (SESSIONS.qa2 as { actorId: string }).actorId })
    ;({ record: ncr } = await ok('qa', 'POST', `${url()}/stage`, { version: ncr.ncr.version, to: 'DECIDED' }))
    expect(ncr.ncr).toMatchObject({ stage: 'DECIDED', decided: { words: 'All 20 M decided' } })
    expect((await refused('qa', 'PATCH', url(), { version: ncr.ncr.version, title: 'Another title' }, 409)).message).toBe('The NCR is decided: its problem is read-only now (only its owner and containment due time change).')
  })

  it('carries a decision out with its stock move: the moves add up to the decision; then closes with the e-signature', async () => {
    const scrap = ncr.decisions[0]
    const short = await refused('qa', 'POST', `${url()}/decisions/${scrap.id}/carry-out`, { version: scrap.version, stock: { lines: [{ lotId: lining.id, itemId: lining.itemId, fromLocationId: places['A1-STORE-01'], quantity: '4' }] } }, 400)
    expect(short.message).toBe('The moves take 4.0000 M; the decision is 5.0000 M: move exactly that, or change the decision first.')
    let answer = await ok('qa', 'POST', `${url()}/decisions/${scrap.id}/carry-out`, { version: scrap.version, stock: { lines: [{ lotId: lining.id, itemId: lining.itemId, fromLocationId: places['A1-STORE-01'], quantity: '5' }] } })
    expect(answer.stockMoveIds).toHaveLength(1)
    const [move] = await admin<Json>(`SELECT reason::text, quantity::text, reference FROM "StockMove" WHERE id = $1`, [answer.stockMoveIds[0]])
    expect(move).toEqual({ reason: 'SCRAP', quantity: '5.0000', reference: ncr.ncr.number })
    ncr = answer.record
    expect(ncr.decisions[0]).toMatchObject({ state: 'DONE', stockMove: { reason: 'SCRAP', from: 'A1-STORE-01' } })
    expect(ncr.closing).toMatchObject({ ready: false })
    // A close is an e-signature: without the office's step-up (a test session has none) it is refused.
    expect((await refused('qa', 'POST', `${url()}/close`, { version: ncr.ncr.version, note: 'All done' }, 403)).code).toBe('forbidden')
    const early = await close(qa1, ncr.ncr.id, 'All done', 409)
    expect(early.error.issues.map((issue: Json) => issue.path)).toEqual(['stage/CARRIED_OUT'])
    const regrade = ncr.decisions[1]
    answer = await ok('qa', 'POST', `${url()}/decisions/${regrade.id}/carry-out`, { version: regrade.version, stock: { lines: [{ lotId: lining.id, itemId: lining.itemId, fromLocationId: places['A1-STORE-01'], quantity: '15' }], toLocationId: places['A1-QUA'] } })
    ncr = answer.record
    expect(ncr.closing).toMatchObject({ ready: true })
    const holdId = ncr.containment[1].hold.id
    const closed = await close(qa1, ncr.ncr.id, 'Scrapped the shrunk end, the rest is second quality.')
    expect(closed.record.ncr).toMatchObject({ stage: 'CLOSED', closedById: qa1.id, closeNote: 'Scrapped the shrunk end, the rest is second quality.', closeSignatureSha256: closed.signature })
    expect(closed.signature).toMatch(/^[0-9a-f]{64}$/)
    expect(closed.holdsClosed).toEqual([holdId])
    const [hold] = await admin<Json>(`SELECT status::text, "ncrId", "closeNote" FROM "QualityHold" WHERE id = $1`, [holdId])
    expect(hold).toEqual({ status: 'CLOSED', ncrId: ncr.ncr.id, closeNote: `Decided in ${ncr.ncr.number}: Scrapped the shrunk end, the rest is second quality.` })
    expect((await events('ncr.stage_changed')).filter((payload) => payload.ncrId === ncr.ncr.id).map((payload) => payload.to)).toEqual(['CONTAINED', 'DECIDED', 'CLOSED'])
    expect((await refused('qa', 'PATCH', url(), { version: closed.record.ncr.version, ownerId: null }, 409)).message).toBe('The NCR is closed: it never changes.')
  })
})

describe('from a hold, a rework order from the NCR (QHS-091), the board (QHS-089)', () => {
  let ncr: Json
  const url = () => `/quality/ncr/${ncr.ncr.id}`

  it('raised from a hold, the NCR decides it: its first containment action is the hold, done', async () => {
    const placed = await ok('qa', 'POST', '/quality/holds', { subjectType: 'Bundle', subjectIds: [bundle.id], reasonCode: 'QUALITY_CHECK' }, 201)
    const { prefill } = await ok('qa', 'GET', `/quality/ncr/prefill?recordType=QualityHold&recordId=${placed.hold.id}`)
    expect(prefill).toMatchObject({ source: 'OTHER', foundAt: 'IN_LINE', workOrderId: A.wo1, quantityAffected: '1.0000', uom: 'PCS', holdIds: [placed.hold.id] })
    ;({ record: ncr } = await ok('qa', 'POST', '/quality/ncr', { from: { recordType: 'QualityHold', recordId: placed.hold.id }, title: 'Skipped stitches on the collar', severity: 'MINOR', source: 'BUNDLE' }, 201))
    expect(ncr.containment).toMatchObject([{ seq: 1, kind: 'HOLD_STOCK', status: 'DONE', hold: { id: placed.hold.id, status: 'ACTIVE' } }])
    expect(ncr.holds).toMatchObject([{ id: placed.hold.id, decidedHere: true }])
    expect(ncr.register).toBeNull()
    ;({ record: ncr } = await ok('qa', 'POST', `${url()}/stage`, { version: ncr.ncr.version, to: 'CONTAINED' }))
    ;({ record: ncr } = await ok('qa', 'POST', `${url()}/decisions`, { version: ncr.ncr.version, dispositionCodeId: codes.REWORK, quantity: '1' }, 201))
    ;({ record: ncr } = await ok('qa', 'POST', `${url()}/stage`, { version: ncr.ncr.version, to: 'DECIDED' }))
  })

  it('the board shows each lane with what its cards still need; the list finds a record\'s NCRs', async () => {
    const { lanes } = await ok('viewer', 'GET', '/quality/ncr/board')
    expect(lanes.map((lane: Json) => lane.stage)).toEqual(['OPEN', 'CONTAINED', 'DECIDED', 'CLOSED'])
    const card = lanes[2].cards.find((row: Json) => row.id === ncr.ncr.id)
    expect(card.next).toEqual({ stage: 'CLOSED', ready: false, words: '1 decision waits for its stock move or follow-up record: carry it out first.' })
    expect(lanes[3].cards.length).toBeGreaterThan(0)
    const seeded = lanes[1].cards.find((row: Json) => row.number === 'SEED-NCR-0002')
    expect(seeded.next.words).toBe('12 of 51.8 FT2 decided · 39.8 left: decide the rest first.')
    const { items } = await ok('viewer', 'GET', `/quality/ncr?recordType=Lot&recordId=${lining.id}&open=false`)
    expect(items.length).toBe(2)
    const { counts } = await ok('viewer', 'GET', '/quality/ncr/counts')
    expect(counts.open).toBeGreaterThanOrEqual(4)
    expect(counts.closedThisMonth).toBeGreaterThanOrEqual(0)
    expect((await ok('viewer', 'GET', '/quality/ncr?waiting=true')).items.map((row: Json) => row.number)).toContain('SEED-NCR-0002')
    expect((await call('companyB', 'GET', url())).statusCode).toBe(404)
  })

  it('carries the rework out with a rework order made from the NCR, then closes; the hold is closed with it', async () => {
    const decision = ncr.decisions[0]
    expect(paths(await refused('qa', 'POST', `${url()}/decisions/${decision.id}/carry-out`, { version: decision.version }, 400))).toEqual(['body/followUp'])
    const made = await ok('qa', 'POST', `${url()}/decisions/${decision.id}/rework`, { version: decision.version, reworkAtOperationId: sewOp, bundleId: bundle.id, reasonCode: 'RESTITCH' })
    const [rework] = await admin<Json>(`SELECT "recordType", "recordId", quantity, status::text, "workOrderId" FROM "ReworkOrder" WHERE id = $1`, [made.reworkId])
    expect(rework).toEqual({ recordType: 'Nonconformance', recordId: ncr.ncr.id, quantity: 1, status: 'OPEN', workOrderId: A.wo1 })
    ncr = made.record
    expect(ncr.decisions[0]).toMatchObject({ state: 'DONE', followUp: { type: 'ReworkOrder', id: made.reworkId, state: 'OPEN' } })
    expect(ncr.links.map((link: Json) => link.recordType)).toContain('ReworkOrder')
    const closed = await close(qa1, ncr.ncr.id, 'Sent back to sewing.')
    expect(closed.record.ncr.stage).toBe('CLOSED')
    expect(closed.holdsClosed).toHaveLength(1)
  })
})

describe('a supplier claim from the decision, links, change and cancel', () => {
  it('opens the supplier claim of a RETURN TO SUPPLIER decision (purchasing.claims.manage), named in its note', async () => {
    const { record: before } = await ok('qa', 'GET', `/quality/ncr/${A.seedNcr2}`)
    let { record } = await ok('qa', 'POST', `/quality/ncr/${A.seedNcr2}/decisions`, { version: before.ncr.version, dispositionCodeId: codes.RETURN_TO_SUPPLIER, quantity: '39.8' }, 201)
    const decision = record.decisions.find((row: Json) => row.disposition.code === 'RETURN_TO_SUPPLIER')
    const body = { version: decision.version, claim: { kind: 'CLAIM', reasonCode: 'QUALITY', reasonNote: 'Grain crack across the butt' } }
    expect((await refused('qa', 'POST', `/quality/ncr/${A.seedNcr2}/decisions/${decision.id}/carry-out`, body, 403)).message).toBe("Opening the supplier claim needs purchasing.claims.manage at the NCR's site.")
    const answer = await ok('buyer', 'POST', `/quality/ncr/${A.seedNcr2}/decisions/${decision.id}/carry-out`, body)
    expect(answer.followUp).toMatchObject({ type: 'SupplierClaim' })
    const [claim] = await admin<Json>(`SELECT status::text, "internalNote" FROM "SupplierClaim" WHERE id = $1`, [answer.followUp.id])
    expect(claim).toEqual({ status: 'DRAFT', internalNote: 'NCR SEED-NCR-0002: Grain crack on hide SEED-HIDE-0002' })
    record = answer.record
    // The seeded SCRAP of 12 FT2 of the hide, cut out of it; then decided and closed: the hide's hold is closed with it.
    const scrap = record.decisions.find((row: Json) => row.disposition.code === 'SCRAP')
    ;({ record } = await ok('qa', 'POST', `/quality/ncr/${A.seedNcr2}/decisions/${scrap.id}/carry-out`, { version: scrap.version, stock: { lines: [{ hideId: A.hideH2, fromLocationId: places['A1-STORE-01'], quantity: '12' }] } }))
    ;({ record } = await ok('qa', 'POST', `/quality/ncr/${A.seedNcr2}/stage`, { version: record.ncr.version, to: 'DECIDED' }))
    const closed = await close(qa1, A.seedNcr2, 'Cracked area scrapped, the rest claimed.')
    expect(closed.holdsClosed).toEqual([A.seedHold])
  })

  it('closes from CONTAINED in one signature when everything is decided and carried out ("use as is" on a minor NCR)', async () => {
    let { record } = await ok('qa', 'POST', '/quality/ncr', { siteId: A.siteA1, title: 'Thread end left on the hem', quantityAffected: '2', severity: 'MINOR', zone: 'WAIST' }, 201)
    ;({ record } = await ok('qa', 'POST', `/quality/ncr/${record.ncr.id}/containment`, { version: record.ncr.version, kind: 'OTHER', description: 'Trim the thread ends of the batch' }, 201))
    ;({ record } = await ok('qa', 'POST', `/quality/ncr/${record.ncr.id}/containment/${record.containment[0].id}/done`, { version: record.containment[0].version, evidenceNote: 'Trimmed.' }))
    ;({ record } = await ok('qa', 'POST', `/quality/ncr/${record.ncr.id}/stage`, { version: record.ncr.version, to: 'CONTAINED' }))
    ;({ record } = await ok('qa', 'POST', `/quality/ncr/${record.ncr.id}/decisions`, { version: record.ncr.version, dispositionCodeId: codes.USE_AS_IS, quantity: '2' }, 201))
    expect(paths(await refused('qa', 'POST', `/quality/ncr/${record.ncr.id}/decisions/${record.decisions[0].id}/carry-out`, { version: record.decisions[0].version, stock: { lines: [{ lotId: lining.id, fromLocationId: places['A1-STORE-01'], quantity: '1' }] } }, 400))).toEqual(['body/stock'])
    ;({ record } = await ok('qa', 'POST', `/quality/ncr/${record.ncr.id}/decisions/${record.decisions[0].id}/carry-out`, { version: record.decisions[0].version }))
    expect(record.closing).toMatchObject({ ready: true })
    expect(record.closing.checks.map((check: Json) => check.key)).toEqual(['ALL_DECIDED', 'APPROVED', 'CARRIED_OUT', 'HOLDS'])
    const closed = await close(qa1, record.ncr.id, 'Used as is after trimming.')
    expect(closed.record.ncr).toMatchObject({ stage: 'CLOSED', decidedAt: expect.any(String) })
    expect((await events('ncr.stage_changed')).filter((payload) => payload.ncrId === record.ncr.id).map((payload) => [payload.from, payload.to])).toEqual([['OPEN', 'CONTAINED'], ['CONTAINED', 'CLOSED']])
  })

  it('links and unlinks records; the source stays linked', async () => {
    let { record } = await ok('raiser', 'POST', '/quality/ncr', { siteId: A.siteA1, title: 'Label print smudged', quantityAffected: '3', severity: 'MINOR', foundAt: 'PACKING' }, 201)
    expect(record.ncr).toMatchObject({ source: 'OTHER', foundAt: 'PACKING', foundBy: { kind: 'USER' } })
    ;({ record } = await ok('raiser', 'POST', `/quality/ncr/${record.ncr.id}/links`, { version: record.ncr.version, recordType: 'WorkOrder', recordId: A.wo3 }, 201))
    expect(record.links.map((link: Json) => link.label)).toEqual(['Work order SEED-WO-0003'])
    expect((await refused('raiser', 'POST', `/quality/ncr/${record.ncr.id}/links`, { version: record.ncr.version, recordType: 'WorkOrder', recordId: A.wo3 }, 409)).message).toBe('Work order SEED-WO-0003 is linked already.')
    expect((await call('raiser', 'DELETE', `/quality/ncr/${record.ncr.id}/links/${record.links[0].id}?version=${record.ncr.version}`)).statusCode).toBe(403)
    ;({ record } = await ok('qa', 'DELETE', `/quality/ncr/${record.ncr.id}/links/${record.links[0].id}?version=${record.ncr.version}`))
    expect(record.links).toEqual([])
    ;({ record } = await ok('qa', 'PATCH', `/quality/ncr/${record.ncr.id}`, { version: record.ncr.version, title: 'Label print smudged on 3 garments', zone: 'LABEL', quantitySuspect: '10' }))
    expect(record.ncr).toMatchObject({ title: 'Label print smudged on 3 garments', zone: 'LABEL', quantitySuspect: '10' })
    expect((await events('ncr.changed')).filter((payload) => payload.ncrId === record.ncr.id).map((payload) => payload.fields)).toEqual([['links'], ['links'], ['title', 'quantitySuspect', 'zone']])
    const stale = await call('qa', 'PATCH', `/quality/ncr/${record.ncr.id}`, { version: 1, title: 'Old' })
    expect(stale.statusCode).toBe(409)
    ;({ record } = await ok('qa', 'POST', `/quality/ncr/${record.ncr.id}/cancel`, { version: record.ncr.version, reason: 'Raised twice by mistake' }))
    expect(record.ncr).toMatchObject({ stage: 'CANCELLED', cancelReason: 'Raised twice by mistake' })
  })
})
