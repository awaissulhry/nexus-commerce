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
import { callerFor, command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { closeHoldInCommand } from './holds'

/**
 * Quality holds (B-W2a-26; QHS-074 place a hold, MES-008 hold and release a work order or a bundle) on the local stack
 * with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level
 * security and the …_quality_plant_w2a_guards / …_production_w2a_guards triggers are real), tenant A from EVERY seed
 * (SEED-WO-0001 in progress with its bundles, the hold of SEED-HIDE-0002 placed at the cutting table, the DRAFT shipment
 * of SEED-WO-0003, the HOLD reason list). Releasing is an e-signature: two quality inspectors signed in through the
 * harness's real sign-in with two-factor (step-up); the other calls use test sessions, the floor's the seeded cutting
 * tablet and operator. Every name and number is made up.
 *   - placing: the preview in words, a hold of several records of one kind and site, the reason of the HOLD list, the
 *     owner, the expected release, the move to quarantine asked; refusals in words;
 *   - what a hold blocks, refused in words before the database: an issue of a held lot or hide, a scan of a held bundle
 *     or work order, packing a held shipment or a held work order's garments; held stock counts as held;
 *   - a work order goes ON_HOLD and back to where it was when no ACTIVE hold names it any more;
 *   - releasing: never by who placed it, never by a maker of the held garments, only with a fresh step-up;
 *   - the list with its filters (any record's holds: Q3), the tiles, the record, changes while ACTIVE, the scope.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/quality/holds`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'holds-a'
const id = (key: string) => seedUuid(NS, key)
const A = {
  tenant: id('tenant'),
  companyA: id('company:A'),
  companyB: id('company:B'),
  siteA1: id('site:A1'),
  hideH2: id('inventory:hide:H2'),
  quarantine: id('inventory:location:A1-QUA'),
  wo1: id('production:work-order:WO-0001'),
  wo3: id('production:work-order:WO-0003'),
  device: id('device:A1:cutting'),
  operator: id('worker:A1:operator'),
}
const TENANT: TestTenant = { id: A.tenant, slug: NS, companies: [{ id: A.companyA, code: 'A' }, { id: A.companyB, code: 'B' }] }

let h: Harness
let app: FastifyInstance
const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  placer: office([grant(['quality.holds.view', 'quality.holds.place'])]),
  viewer: office([grant(['quality.holds.view'])]),
  companyB: office([grant(['quality.holds.view', 'quality.holds.place', 'quality.holds.release'], { companies: [A.companyB] })]),
  picker: office([grant(['inventory.issue', 'inventory.stock.view'])]),
  packer: office([grant(['shipping.pack', 'shipping.view'])]),
  floor: {
    audience: 'floor',
    tenantId: A.tenant,
    actorId: A.operator,
    siteId: A.siteA1,
    deviceId: A.device,
    grants: [grant(['floor.work', 'production.scan', 'inventory.issue', 'shipping.pack'], { companies: [A.companyA], sites: [A.siteA1] })],
  },
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `holds-${run}-${++keys}`
// A scan's key is its clientScanId (the scans' route refuses another header): none sent there.
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' && !url.startsWith('/production/scans') ? { 'idempotency-key': freshKey() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const release = async (person: Person, holdId: string, body: Json = {}, status = 200) => {
  await stepUp(h, person.browser, person.secret)
  const { hold } = await as(person, 'GET', `/quality/holds/${holdId}`)
  return as(person, 'POST', `/quality/holds/${holdId}/release`, { version: hold.version, ...body }, status)
}
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [A.tenant, type])).map((row) => row.payload)
const workOrder = async (workOrderId: string) => (await admin<Json>(`SELECT number, status::text, "heldFromStatus"::text AS "heldFromStatus", "holdReason", "holdRecordType", "holdRecordId" FROM "WorkOrder" WHERE id = $1`, [workOrderId]))[0]!

let qa1: Person
let qa2: Person
let lining: { id: string; code: string; itemId: string }
let wo1Status: string
let wo1Number: string

beforeAll(async () => {
  h = await startHarness('quality_holds')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  // The system roles as the templates hold them now (quality.holds.* for the quality inspector).
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  qa1 = await signedIn('qa.one@example.com', 'quality_inspector')
  qa2 = await signedIn('qa.two@example.com', 'quality_inspector')
  lining = (
    await admin<{ id: string; code: string; itemId: string }>(
      `SELECT l.id, l.code, l."itemId" FROM "Lot" l JOIN "Item" i ON i.id = l."itemId" JOIN "StockMove" m ON m."lotId" = l.id
        WHERE l."tenantId" = $1 AND l."siteId" = $2 AND l."qualityStatus" = 'RELEASED' AND i.tracking = 'LOT' AND m."toLocationId" IS NOT NULL ORDER BY l.code LIMIT 1`,
      [A.tenant, A.siteA1],
    )
  )[0]!
  const wo = await workOrder(A.wo1)
  wo1Status = wo.status
  wo1Number = wo.number
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
})

describe('placing a hold (QHS-074)', () => {
  it('previews what a hold of scanned codes would block, then places it with the move to quarantine asked', async () => {
    const preview = await ok('placer', 'POST', '/quality/holds/preview', { subjectType: 'Lot', codes: [lining.code, 'NO-SUCH-LOT'] })
    expect(preview.subjects.map((row: Json) => row.problem)).toEqual([null, 'Not found at a site you reach.'])
    expect(preview.words).toMatch(/^Blocks issuing and cutting of 1 lot \(.+\)\.$/)
    expect(preview.quarantinePlaces.map((place: Json) => place.code)).toEqual(['A1-QUA'])
    const placed = await ok('placer', 'POST', '/quality/holds', { subjectType: 'Lot', subjectIds: [lining.id], reasonCode: 'SUPPLIER_CHECK', reasonNote: 'The supplier warned of a bad dye batch', ownerId: qa1.id, expectedReleaseOn: '2099-12-31', askQuarantine: true }, 201)
    expect(placed.hold).toMatchObject({ status: 'ACTIVE', subjectType: 'Lot', subjects: [{ id: lining.id, label: lining.code }], reason: 'Supplier check', quarantine: 'ASKED', quarantineLocation: { code: 'A1-QUA' }, placedBy: { kind: 'USER' }, ownerId: qa1.id, expectedReleaseOn: '2099-12-31', overdue: false })
    expect(placed.workOrdersHeld).toEqual([])
    expect((await events('quality.hold_placed')).find((payload) => payload.holdId === placed.hold.id)).toMatchObject({ subjectType: 'Lot', subjectIds: [lining.id], reasonCode: 'SUPPLIER_CHECK', placedBy: 'USER', quarantine: 'ASKED', workOrdersHeld: [] })
  })

  it('refuses in words: a reason not on the hold list, quarantine for a work order, a release date gone, a site out of reach', async () => {
    expect(paths(await refused('placer', 'POST', '/quality/holds', { subjectType: 'Lot', subjectIds: [lining.id], reasonCode: 'NO_SUCH_REASON' }, 400))).toEqual(['body/reasonCode'])
    expect(paths(await refused('placer', 'POST', '/quality/holds', { subjectType: 'WorkOrder', subjectIds: [A.wo1], reasonCode: 'QUALITY_CHECK', askQuarantine: true, expectedReleaseOn: '2020-01-01' }, 400))).toEqual(['body/expectedReleaseOn', 'body/askQuarantine'])
    expect(paths(await refused('placer', 'POST', '/quality/holds', { subjectType: 'Bundle', subjectIds: [newId()], reasonCode: 'QUALITY_CHECK' }, 400))).toEqual(['body/subjectIds/0'])
    expect((await refused('companyB', 'POST', '/quality/holds', { subjectType: 'Lot', subjectIds: [lining.id], reasonCode: 'QUALITY_CHECK' }, 403)).message).toBe('You place holds only at the sites your role reaches.')
    expect((await refused('viewer', 'POST', '/quality/holds', { subjectType: 'Lot', subjectIds: [lining.id], reasonCode: 'QUALITY_CHECK' }, 403)).code).toBe('forbidden')
  })
})

describe('what a hold blocks, in words', () => {
  it('counts held stock as held, and refuses issuing a held lot or hide', async () => {
    const stock = await ok('picker', 'GET', `/inventory/stock?lotId=${lining.id}`)
    expect(stock.rows.length).toBeGreaterThan(0)
    for (const row of stock.rows as Json[]) expect(row.held).toBe(row.onHand)
    const lot = await refused('picker', 'POST', `/inventory/picking/work-orders/${A.wo1}/issue`, { lotId: lining.id, quantity: '0.5000' }, 409)
    expect(lot.message).toMatch(new RegExp(`^Lot ${lining.code} is on hold \\(Supplier check, since \\d+ \\w+ \\d{4}\\): its stock is not issued until quality releases the hold\\.$`))
    expect(paths(lot)).toEqual(['refusal/QUALITY_HOLD'])
    const hide = await refused('floor', 'POST', `/inventory/picking/work-orders/${A.wo1}/issue`, { hideId: A.hideH2 }, 409)
    expect(hide.message).toBe('Hide SEED-HIDE-0002 is on hold (Quality check, since 21 Nov 2026): it is not issued until quality releases the hold.')
  })
})

describe('a work order on hold (MES-008)', () => {
  let first: Json
  let second: Json
  let bundle: { id: string; code: string }

  it('goes ON_HOLD from where it was, with the reason; the floor\'s scans and the issue are refused with it', async () => {
    bundle = (await admin<{ id: string; code: string }>(`SELECT id, code FROM "Bundle" WHERE "workOrderId" = $1 AND status = 'ACTIVE' ORDER BY code LIMIT 1`, [A.wo1]))[0]!
    expect(['DRAFT', 'RELEASED', 'IN_PROGRESS']).toContain(wo1Status)
    first = await as(qa1, 'POST', '/quality/holds', { subjectType: 'WorkOrder', subjectIds: [A.wo1], reasonCode: 'CUSTOMER_REQUEST', reasonNote: 'Wrong leather colour reported' }, 201)
    expect(first.workOrdersHeld).toEqual([{ id: A.wo1, number: wo1Number, from: wo1Status }])
    expect(await workOrder(A.wo1)).toMatchObject({ status: 'ON_HOLD', heldFromStatus: wo1Status, holdReason: 'Customer request: Wrong leather colour reported', holdRecordType: 'QualityHold', holdRecordId: first.hold.id })
    expect((await events('workorder.status_changed')).filter((payload) => payload.workOrderId === A.wo1).at(-1)).toMatchObject({ from: wo1Status, to: 'ON_HOLD' })
    const scan = await refused('floor', 'POST', '/production/scans', { clientScanId: `scan-${run}-1`, bundleId: bundle.id, good: 1 }, 409)
    expect(paths(scan)).toContain('refusal/ON_HOLD')
    expect(scan.message).toMatch(new RegExp(`^Work order ${wo1Number} is on hold \\(Customer request, since .+\\): its bundles are not scanned until quality releases the hold\\.$`))
    expect((await refused('picker', 'POST', `/inventory/picking/work-orders/${A.wo1}/issue`, { lotId: lining.id, quantity: '0.5000' }, 409)).message).toMatch(/^Lot .* is on hold/)
  })

  it('a second hold of it keeps it ON_HOLD; the placer may not release their own hold', async () => {
    second = await ok('placer', 'POST', '/quality/holds', { subjectType: 'WorkOrder', subjectIds: [A.wo1], reasonCode: 'QUALITY_CHECK' }, 201)
    expect(second.workOrdersHeld).toEqual([])
    const record = await as(qa1, 'GET', `/quality/holds/${first.hold.id}`)
    expect(record.workOrders).toEqual([expect.objectContaining({ id: A.wo1, status: 'ON_HOLD', heldFromStatus: wo1Status, heldByThis: true })])
    // B-W2a-67: the work order's batch (the evidence trail) and the hold's site in words.
    expect(record.workOrders[0]).toHaveProperty('batchNumber')
    expect(record.hold.site).toMatchObject({ id: A.siteA1, code: expect.any(String) })
    expect(record.release.checks.find((check: Json) => check.key === 'NOT_PLACER')).toEqual({ key: 'NOT_PLACER', ok: false, words: 'You placed this hold - another person must release it.' })
    expect(record.release.releasable).toBe(false)
    const own = await release(qa1, first.hold.id, {}, 409)
    expect(own.error.issues.map((issue: Json) => issue.path)).toEqual(['release/NOT_PLACER'])
  })

  it('a release needs a fresh step-up', async () => {
    h.clock.advance(10 * 60_000)
    const { hold } = await as(qa2, 'GET', `/quality/holds/${first.hold.id}`)
    const answer = await as(qa2, 'POST', `/quality/holds/${first.hold.id}/release`, { version: hold.version }, 403)
    expect(answer.error.issues.map((issue: Json) => issue.path)).toContain('stepUp')
  })

  it('releasing one hold leaves it ON_HOLD under the other; releasing the last lifts it back', async () => {
    const one = await release(qa2, first.hold.id, { note: 'Colour checked against the master: right' })
    expect(one.hold).toMatchObject({ status: 'RELEASED', releasedBy: { kind: 'USER', userId: qa2.id }, releaseNote: 'Colour checked against the master: right' })
    expect(one.workOrdersLifted).toEqual([])
    expect(await workOrder(A.wo1)).toMatchObject({ status: 'ON_HOLD', holdRecordId: second.hold.id, holdReason: 'Quality check' })
    const [signature] = await admin<{ releaseSignatureSha256: string }>(`SELECT "releaseSignatureSha256" FROM "QualityHold" WHERE id = $1`, [first.hold.id])
    expect(signature!.releaseSignatureSha256).toMatch(/^[0-9a-f]{64}$/)
    const two = await release(qa2, second.hold.id)
    expect(two.workOrdersLifted).toEqual([{ id: A.wo1, number: wo1Number, to: wo1Status }])
    expect(await workOrder(A.wo1)).toMatchObject({ status: wo1Status, heldFromStatus: null, holdReason: null, holdRecordType: null, holdRecordId: null })
    expect((await events('quality.hold_released')).map((payload) => payload.holdId)).toEqual([first.hold.id, second.hold.id])
    // Released: it never changes.
    expect((await refused('placer', 'PATCH', `/quality/holds/${second.hold.id}`, { version: two.hold.version, note: 'late' }, 409)).code).toBe('invalid_state')
  })

  it('holds a single bundle: its scans wait; a maker of the garments may not release it', async () => {
    const placed = await ok('placer', 'POST', '/quality/holds', { subjectType: 'Bundle', subjectIds: [bundle.id], reasonCode: 'QUALITY_CHECK', reasonNote: 'Stitch length out' }, 201)
    expect(placed.workOrdersHeld).toEqual([])
    expect((await workOrder(A.wo1)).status).toBe(wo1Status)
    const scan = await refused('floor', 'POST', '/production/scans', { clientScanId: `scan-${run}-2`, bundleId: bundle.id, good: 1 }, 409)
    expect(scan.message).toMatch(new RegExp(`^Bundle ${bundle.code} is on hold \\(Quality check, since .+\\): it is not scanned until quality releases the hold\\.$`))
    // qa2 is the operator who made the garments (the worker's linked office user).
    await admin('UPDATE "Worker" SET "userId" = $2 WHERE id = $1', [A.operator, qa2.id])
    const maker = await release(qa2, placed.hold.id, {}, 409)
    expect(maker.error.issues.map((issue: Json) => issue.path)).toContain('release/NOT_MAKER')
    await admin('UPDATE "Worker" SET "userId" = NULL WHERE id = $1', [A.operator])
    expect((await release(qa1, placed.hold.id)).hold.status).toBe('RELEASED')
  })
})

describe('packing waits for a hold', () => {
  it('refuses packing a held shipment, and the garments of a held work order', async () => {
    const [shipment] = await admin<{ id: string; number: string }>(`SELECT id, number FROM "Shipment" WHERE "tenantId" = $1 AND status = 'DRAFT' ORDER BY number LIMIT 1`, [A.tenant])
    const { shipment: packing } = await ok('packer', 'GET', `/shipping/packing/${shipment!.id}`)
    const placed = await ok('placer', 'POST', '/quality/holds', { subjectType: 'Shipment', subjectIds: [shipment!.id], reasonCode: 'CUSTOMER_REQUEST' }, 201)
    expect((await refused('packer', 'POST', `/shipping/packing/${shipment!.id}/pack`, { version: packing.version }, 409)).message).toMatch(new RegExp(`^Shipment ${shipment!.number} is on hold \\(Customer request, since .+\\): it is neither packed nor shipped until quality releases the hold\\.$`))
    await release(qa1, placed.hold.id)
    const order = (await admin<{ workOrderId: string; status: string }>(`SELECT l."workOrderId", w.status::text FROM "ShipmentLine" l JOIN "WorkOrder" w ON w.id = l."workOrderId" WHERE l."shipmentId" = $1 LIMIT 1`, [shipment!.id]))[0]!
    const held = await ok('placer', 'POST', '/quality/holds', { subjectType: 'WorkOrder', subjectIds: [order.workOrderId], reasonCode: 'QUALITY_CHECK' }, 201)
    // A completed work order keeps its status: its garments are held.
    if (order.status === 'COMPLETED') expect(held.workOrdersHeld).toEqual([])
    const again = await ok('packer', 'GET', `/shipping/packing/${shipment!.id}`)
    expect((await refused('floor', 'POST', `/shipping/packing/${shipment!.id}/pack`, { version: again.shipment.version }, 409)).message).toMatch(/^Work order .* is on hold \(Quality check, since .+\): its garments are not packed until quality releases the hold\.$/)
    await release(qa1, held.hold.id)
  })
})

describe('the list, the tiles and the record', () => {
  it('lists the holds of a record (Q3), by kind, placed by the system or the floor, waiting for the move; the tiles count them', async () => {
    const active = (await ok('viewer', 'GET', '/quality/holds')).holds as Json[]
    expect(active.every((hold) => hold.status === 'ACTIVE')).toBe(true)
    const hide = (await ok('viewer', 'GET', `/quality/holds?subjectId=${A.hideH2}`)).holds as Json[]
    expect(hide).toEqual([expect.objectContaining({ subjectType: 'Hide', subjects: [expect.objectContaining({ id: A.hideH2, label: 'SEED-HIDE-0002' })], placedBy: { kind: 'WORKER', userId: null }, reason: 'Quality check', quarantine: 'ASKED' })])
    expect(((await ok('viewer', 'GET', '/quality/holds?status=ALL&subjectType=WorkOrder')).holds as Json[]).length).toBeGreaterThanOrEqual(3)
    expect(((await ok('viewer', 'GET', '/quality/holds?quarantine=ASKED')).holds as Json[]).map((hold) => hold.subjectType).sort()).toEqual(['Hide', 'Lot'])
    const counts = (await ok('viewer', 'GET', '/quality/holds/counts')).counts
    expect(counts).toMatchObject({ open: active.length, waitingQuarantine: 2, overdue: 0 })
    expect((await as(qa1, 'GET', '/quality/holds/counts')).counts.mine).toBe(1)
    expect(((await ok('companyB', 'GET', '/quality/holds')).holds as Json[])).toEqual([])
    expect((await refused('companyB', 'GET', `/quality/holds/${hide[0]!.id}`, undefined, 404)).code).toBe('not_found')
  })

  it('changes the owner, the expected release and the notes while ACTIVE', async () => {
    const [lot] = (await ok('viewer', 'GET', `/quality/holds?subjectId=${lining.id}`)).holds as Json[]
    expect(paths(await refused('placer', 'PATCH', `/quality/holds/${lot!.id}`, { version: lot!.version, expectedReleaseOn: '2020-01-01' }, 400))).toEqual(['body/expectedReleaseOn'])
    const { hold } = await ok('placer', 'PATCH', `/quality/holds/${lot!.id}`, { version: lot!.version, ownerId: qa2.id, note: 'Waiting for the supplier\'s report' })
    expect(hold).toMatchObject({ ownerId: qa2.id, owner: { id: qa2.id }, note: 'Waiting for the supplier\'s report', version: lot!.version + 1 })
    // B-W2a-67: the owner by name (an office user), as the Holds list shows it.
    const [named] = await admin<{ displayName: string }>('SELECT "displayName" FROM "User" WHERE id = $1', [qa2.id])
    expect(hold.owner.name).toBe(named!.displayName)
    expect((await events('quality.hold_changed')).at(-1)).toEqual({ holdId: lot!.id, fields: ['ownerId', 'note'] })
    expect((await refused('placer', 'PATCH', `/quality/holds/${lot!.id}`, { version: lot!.version, note: 'stale' }, 409)).code).toBe('conflict')
  })
})

describe('the owner picker (B-W2a-67)', () => {
  it('lists the active office people who see holds at the site, me first; only for whoever places holds there', async () => {
    const answer = await as(qa1, 'GET', `/quality/holds/people?siteId=${A.siteA1}`)
    expect(answer.people[0]).toMatchObject({ id: qa1.id, me: true })
    expect(answer.people).toEqual(expect.arrayContaining([expect.objectContaining({ id: qa2.id, me: false })]))
    expect(answer.people.every((person: Json) => typeof person.name === 'string' && person.name.length > 0)).toBe(true)
    // Reading holds alone does not pick an owner; another company's site or an unknown one is not found.
    expect((await refused('viewer', 'GET', `/quality/holds/people?siteId=${A.siteA1}`, undefined, 403)).code).toBe('forbidden')
    expect((await refused('companyB', 'GET', `/quality/holds/people?siteId=${A.siteA1}`, undefined, 404)).code).toBe('not_found')
    expect((await refused('placer', 'GET', `/quality/holds/people?siteId=${newId()}`, undefined, 404)).code).toBe('not_found')
  })
})

describe('closing a hold in its NCR (the NCR\'s disposition, B-W2a-47)', () => {
  it('closes an ACTIVE hold with its NCR and why, once', async () => {
    const ncrId = id('holds:ncr:NCR-0002')
    const [hold] = (await ok('viewer', 'GET', `/quality/holds?subjectId=${A.hideH2}`)).holds as Json[]
    const caller = () => callerFor(h.database, { audience: 'office', tenantId: A.tenant, actorId: qa1.id, grants: [grant(['quality.holds.view'])], requestId: newId() })
    const close = () => command(caller(), { name: 'quality.testCloseHold', input: { holdId: hold!.id } }, async (tools) => {
      const closed = await closeHoldInCommand(tools, { holdId: hold!.id, ncrId, note: 'Decided in the NCR: 12 ft² scrapped, the rest regraded', closedById: qa1.id })
      return { status: closed.hold.status, ncrId: closed.hold.ncrId, lifted: closed.workOrdersLifted.length }
    })
    expect((await close()).result).toEqual({ status: 'CLOSED', ncrId, lifted: 0 })
    expect((await ok('viewer', 'GET', `/quality/holds/${hold!.id}`)).hold).toMatchObject({ status: 'CLOSED', ncrId, closeNote: 'Decided in the NCR: 12 ft² scrapped, the rest regraded' })
    await expect(close()).rejects.toMatchObject({ code: 'invalid_state' })
  })
})
