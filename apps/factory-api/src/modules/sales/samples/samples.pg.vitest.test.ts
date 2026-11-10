import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedSamples } from '../../../../../../packages/factory-db/seed/samples'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * Sample rounds (B-W2b-246; SAL-311, SAL-316, MES-018) through the app's real routes on a throwaway PostgreSQL 17 database from
 * the migrations (the runtime login: row-level security and B-W2b-212's …_changes_samples_w2b_guards are real), on the seeds up
 * to the samples (SEED-JKT-02 with its released revision 1 and SEED-SR-0003, its PRE_PRODUCTION round 1 for the brand P1;
 * SEED-JKT-01's draft revision 1; plant A1 with its number series) and, made up here, a confirmed order of P1 for the samples (a
 * copy of SEED-SO-0002 line 10: black 50/52/54) and two office people. Every word and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/samples`.
 */

vi.setConfig({ testTimeout: 90_000 })

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const NS = 'w2b246-samples'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const P1 = idOf('party:P1')
const companyA = idOf('company:A')

const PEOPLE = { manager: newId(), sales: newId() } as const
const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const office = (actorId: string, permissions: string[], parties: Grant['parties'] = 'all'): SessionContext => ({ audience: 'office', tenantId: T, actorId, grants: [grant(permissions as Permission[], parties)] })
const MANAGER = ['sales.samples.view', 'sales.samples.manage', 'workorders.view', 'workorders.manage', 'workorders.release', 'money.price', 'threads.read', 'threads.post']
const SESSIONS: Record<string, SessionContext> = {
  manager: office(PEOPLE.manager, MANAGER),
  // Sales keeps rounds and shipments; it makes no work order (no workorders.manage) and sees no price here.
  sales: office(PEOPLE.sales, ['sales.samples.view', 'sales.samples.manage', 'workorders.view']),
  viewer: office(newId(), ['sales.samples.view']),
  // A role limited to another customer: P1's rounds are not there for it.
  otherCustomer: office(newId(), ['sales.samples.view', 'sales.samples.manage'], [newId()]),
}

let h: Harness
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let serial = 0
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const one = async (sql: string, values: unknown[] = []): Promise<Json> => (await admin(sql, values))[0]!
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `s-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const refusal = (error: Json): string => String(error.issues?.[0]?.path ?? '')

let jacket1 = ''
let jacket2 = ''
let black2 = ''
let red2 = ''
let sampleLine = ''
let round = '' // the pre-production round 2 of SEED-JKT-02 for P1
let fit = '' // an internal fit round of SEED-JKT-01 (draft revision)

beforeAll(async () => {
  h = await startHarness('sales_samples')
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  await seedSamples({ db: h.database, namespace: NS })
  for (const [person, userId] of Object.entries(PEOPLE)) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [userId, T, `w2b246-${person}-${run}@example.test`, `Made-up ${person}`])
  }
  jacket1 = (await one('SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [T, 'SEED-JKT-01'])).id
  jacket2 = (await one('SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [T, 'SEED-JKT-02'])).id
  black2 = (await one('SELECT id FROM "Colourway" WHERE "styleId" = $1 AND code = $2', [jacket2, 'BLK'])).id
  red2 = (await one('SELECT id FROM "Colourway" WHERE "styleId" = $1 AND code = $2', [jacket2, 'RED'])).id
  // P1's order that charges the samples: a copy of SEED-SO-0002 line 10 (black 50:1, 52:2, 54:1), confirmed.
  const order = newId()
  sampleLine = newId()
  await admin(
    `INSERT INTO "SalesOrder" SELECT (jsonb_populate_record(NULL::"SalesOrder", to_jsonb(s) || jsonb_build_object('id', $2::uuid, 'number', 'W2B246-SO-1', 'version', 1))).* FROM "SalesOrder" s WHERE s."tenantId" = $1 AND s.number = 'SEED-SO-0002'`,
    [T, order],
  )
  await admin(
    `INSERT INTO "SalesOrderLine" SELECT (jsonb_populate_record(NULL::"SalesOrderLine", to_jsonb(l) || jsonb_build_object('id', $3::uuid, 'orderId', $2::uuid, 'version', 1))).* FROM "SalesOrderLine" l JOIN "SalesOrder" s ON s.id = l."orderId" WHERE s."tenantId" = $1 AND s.number = 'SEED-SO-0002' AND l.seq = 10`,
    [T, order, sampleLine],
  )
  await admin(
    `INSERT INTO "SalesOrderLineSize" SELECT (jsonb_populate_record(NULL::"SalesOrderLineSize", to_jsonb(z) || jsonb_build_object('id', gen_random_uuid(), 'lineId', $2::uuid, 'version', 1))).* FROM "SalesOrderLineSize" z JOIN "SalesOrderLine" l ON l.id = z."lineId" JOIN "SalesOrder" s ON s.id = l."orderId" WHERE s."tenantId" = $1 AND s.number = 'SEED-SO-0002' AND l.seq = 10`,
    [T, sampleLine],
  )
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('a sample round asked for (SAL-311)', () => {
  it('numbers it, pins the revision, takes the next round of its kind, and puts it on the board; the charge only with the price grain', async () => {
    const { round: made } = await ok(
      'manager',
      'POST',
      '/sales/samples/rounds',
      { styleId: jacket2, companyId: companyA, kind: 'PRE_PRODUCTION', partyId: P1, cells: [{ colourwayId: black2, size: '52', quantity: 2 }], dueDate: '2026-12-01', instructions: 'Made-up: stitch the brand label on the left.', chargeAmountMinor: 12000, chargeCurrency: 'EUR' },
      201,
    )
    round = made.id
    expect(made).toMatchObject({ number: expect.stringMatching(/^SR-2026-\d{4}$/), kind: 'PRE_PRODUCTION', roundNo: 2, label: 'Pre-production · round 2', stage: 'REQUESTED', revision: { revision: 1, status: 'RELEASED' }, party: { id: P1 }, pieces: 2, chargeAmountMinor: 12000, chargeCurrency: 'EUR', createdBy: { id: PEOPLE.manager } })
    expect(made.cells).toEqual([{ colourwayId: black2, colourwayCode: 'BLK', size: '52', quantity: 2 }])
    expect(made.moves.find((move: Json) => move.to === 'REQUESTED')).toMatchObject({ allowed: false, refusal: { code: 'SAME_STAGE' } })
    expect(made.actions).toMatchObject({ edit: { allowed: true }, changeRevision: { allowed: true }, makeWorkOrder: { allowed: true }, addShipment: { allowed: true } })
    // The price grain: the viewer reads the round without the charge; sales may not send one.
    const seen = (await ok('viewer', 'GET', `/sales/samples/rounds/${round}`)).round
    expect(seen.number).toBe(made.number)
    expect('chargeAmountMinor' in seen).toBe(false)
    await no('sales', 'POST', '/sales/samples/rounds', { styleId: jacket2, companyId: companyA, kind: 'FIT', partyId: P1, cells: [{ size: '52', quantity: 1 }], chargeAmountMinor: 100, chargeCurrency: 'EUR' }, 403)
    // The board: its lane and tiles; its maker follows it; the event.
    const list = await ok('manager', 'GET', `/sales/samples/rounds?styleId=${jacket2}`)
    expect(list.rows.map((row: Json) => row.id)).toContain(round)
    expect(list.lanes.find((lane: Json) => lane.stage === 'REQUESTED').count).toBeGreaterThanOrEqual(1)
    expect(list.counts.OPEN).toBeGreaterThanOrEqual(1)
    expect(list.counts.WAITING_DECISION).toBe(1) // SEED-SR-0003, under review with P1
    expect(await one('SELECT count(*)::int AS n FROM "RecordFollower" WHERE "recordType" = \'SampleRound\' AND "recordId" = $1 AND "userId" = $2', [round, PEOPLE.manager])).toMatchObject({ n: 1 })
    expect(await one('SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = \'sample_round.requested\' AND subject = $1', [round])).toMatchObject({ n: 1 })
    // A thread per round: an internal note on it.
    await ok('manager', 'POST', `/threads/SampleRound/${round}/notes`, { body: 'Made-up: the brand wants it by courier.' }, 201)
  })

  it('takes a draft revision by default for a proto or fit, and an internal round charges nobody', async () => {
    const { round: made } = await ok('manager', 'POST', '/sales/samples/rounds', { styleId: jacket1, companyId: companyA, kind: 'FIT', cells: [{ size: '52', quantity: 1 }] }, 201)
    fit = made.id
    // SEED-SR-0001 is SEED-JKT-01's fit round 1: this is round 2.
    expect(made).toMatchObject({ party: null, roundNo: 2, label: 'Fit · round 2', revision: { revision: 1, status: 'DRAFT' } })
    expect(refusal(await no('manager', 'POST', '/sales/samples/rounds', { styleId: jacket1, companyId: companyA, kind: 'FIT', cells: [{ size: '52', quantity: 1 }], chargeAmountMinor: 500, chargeCurrency: 'EUR' }, 409))).toBe('refusal/CHARGE_INTERNAL')
    expect(refusal(await no('manager', 'POST', '/sales/samples/rounds', { styleId: jacket1, companyId: companyA, kind: 'FIT', cells: [{ size: '52', quantity: 1 }], testZones: 'chest' }, 409))).toBe('refusal/CERTIFICATION_ONLY')
  })

  it('refuses cells, charges and parties in words before the database', async () => {
    const error = await no('manager', 'POST', '/sales/samples/rounds', { styleId: jacket2, companyId: companyA, kind: 'SALESMAN', partyId: P1, cells: [{ colourwayId: black2, size: '99', quantity: 1 }, { colourwayId: black2, size: '99', quantity: 2 }] }, 400)
    expect(error.issues.map((issue: Json) => issue.path)).toEqual(expect.arrayContaining(['body/cells/0/size', 'body/cells/1']))
    expect((await no('manager', 'POST', '/sales/samples/rounds', { styleId: jacket2, companyId: companyA, kind: 'SALESMAN', cells: [{ size: '52', quantity: 1 }], chargeAmountMinor: 100 }, 400)).message).toContain('both or neither')
    expect((await no('manager', 'POST', '/sales/samples/rounds', { styleId: jacket2, companyId: companyA, kind: 'SALESMAN', partyId: newId(), cells: [{ size: '52', quantity: 1 }] }, 400)).message).toContain('No such customer')
    // A role limited to another customer neither finds P1's round nor asks one for P1.
    await no('otherCustomer', 'GET', `/sales/samples/rounds/${round}`, undefined, 404)
    expect((await ok('otherCustomer', 'GET', `/sales/samples/rounds?styleId=${jacket2}`)).rows.map((row: Json) => row.id)).not.toContain(round)
    await no('viewer', 'POST', `/sales/samples/rounds/${round}/move`, { version: 1, to: 'IN_MAKING' }, 403)
  })

  it('changes the request while open, moves by hand in any order, never to DECIDED, and keeps the edit-conflict guard', async () => {
    const before = (await ok('manager', 'GET', `/sales/samples/rounds/${round}`)).round
    const changed = (await ok('manager', 'PATCH', `/sales/samples/rounds/${round}`, { version: before.version, cells: [{ colourwayId: black2, size: '52', quantity: 2 }, { colourwayId: red2, size: '52', quantity: 1 }], dueDate: '2026-12-03' })).round
    expect(changed).toMatchObject({ pieces: 3, dueDate: '2026-12-03', version: before.version + 1 })
    await no('manager', 'PATCH', `/sales/samples/rounds/${round}`, { version: before.version, instructions: 'stale' }, 409)
    await no('manager', 'POST', `/sales/samples/rounds/${round}/move`, { version: changed.version, to: 'DECIDED' }, 400)
    expect(refusal(await no('manager', 'POST', `/sales/samples/rounds/${round}/move`, { version: changed.version, to: 'REQUESTED' }, 409))).toBe('refusal/SAME_STAGE')
    const sent = (await ok('manager', 'POST', `/sales/samples/rounds/${round}/move`, { version: changed.version, to: 'SENT' })).round
    const back = (await ok('manager', 'POST', `/sales/samples/rounds/${round}/move`, { version: sent.version, to: 'REQUESTED' })).round
    expect(back.stage).toBe('REQUESTED')
    expect(await one('SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = \'sample_round.changed\' AND subject = $1 AND payload->>\'change\' = \'MOVED\'', [round])).toMatchObject({ n: 2 })
  })
})

describe('the sample work order (MES-018)', () => {
  let workOrder = ''

  it("is made by W1's create on the customer's order line, from the round's cells, and moves the round into making", async () => {
    const options = await ok('manager', 'GET', `/sales/samples/rounds/${round}/work-order-options`)
    expect(options.blockers).toEqual([])
    const line = options.lines.find((entry: Json) => entry.id === sampleLine)
    expect(line).toMatchObject({ orderNumber: 'W2B246-SO-1', colourwayCode: 'BLK', proposed: [{ size: '52', quantity: 2 }] })
    // Sales keeps the round but makes no work order (W1's workorders.manage).
    expect((await no('sales', 'POST', `/sales/samples/rounds/${round}/work-orders`, { lines: [{ salesOrderLineId: sampleLine }] }, 403)).message).toContain('workorders.manage')
    // The red cell has no line here: named alone, the black line takes the black cell only.
    const made = await ok('manager', 'POST', `/sales/samples/rounds/${round}/work-orders`, { lines: [{ salesOrderLineId: sampleLine }] }, 201)
    workOrder = made.workOrder.id
    expect(made.workOrder).toMatchObject({ number: expect.any(String), status: 'DRAFT' })
    expect(made.round).toMatchObject({ stage: 'IN_MAKING', workOrders: 1 })
    expect(made.round.workOrdersList).toEqual([expect.objectContaining({ id: workOrder, status: 'DRAFT', pieces: 2 })])
    const row = await one('SELECT kind::text AS kind, "sampleRoundId", "styleRevisionId", note FROM "WorkOrder" WHERE id = $1', [workOrder])
    expect(row).toMatchObject({ kind: 'SAMPLE', sampleRoundId: round })
    expect(row.note).toContain('Pre-production · round 2')
    expect(await one('SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = \'sample_round.changed\' AND subject = $1 AND payload->>\'change\' = \'WORK_ORDER\'', [round])).toMatchObject({ n: 1 })
    expect(await one('SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = \'workorder.created\' AND subject = $1', [workOrder])).toMatchObject({ n: 1 })
  })

  it("is a work order like any other: W1's list, record and release check; its revision and a split are refused in words", async () => {
    const list = await ok('manager', 'GET', '/production/work-orders?kind=SAMPLE')
    expect(list.workOrders.map((entry: Json) => entry.id)).toContain(workOrder)
    const { workOrder: record } = await ok('manager', 'GET', `/production/work-orders/${workOrder}`)
    expect(record).toMatchObject({ kind: 'SAMPLE', sampleRound: { id: round, kind: 'PRE_PRODUCTION', roundNo: 2 } })
    expect((await no('manager', 'PATCH', `/production/work-orders/${workOrder}`, { version: record.version, styleRevisionId: newId() }, 409)).message).toContain('sample round')
    const cell = record.cells[0].id
    expect((await no('manager', 'POST', `/production/work-orders/${workOrder}/split`, { version: record.version, cells: [{ cellId: cell, quantity: 1 }] }, 409)).message).toContain('sample round')
    // W1's own release check decides, as for any work order: here no certificate covers SEED-JKT-02 (this harness seeds none), so
    // the release is refused in W1's words, never a 500. The live check releases one on the full seeds (batch number given).
    const check = await ok('manager', 'GET', `/production/work-orders/${workOrder}/release-check`)
    expect(check.releasable).toBe(false)
    expect(check.blockers.map((blocker: Json) => blocker.message).join(' ')).toContain('No certificate covers style SEED-JKT-02')
    const released = await call('manager', 'POST', `/production/work-orders/${workOrder}/release`, { version: record.version })
    expect(released.statusCode, released.body).toBe(409)
    expect(released.json().error.message).toContain('certificate')
  })

  it('is refused for a closed round, and on a draft revision the dialog warns that the release waits', async () => {
    const options = await ok('manager', 'GET', `/sales/samples/rounds/${fit}/work-order-options`)
    expect(options.warnings.join(' ')).toContain('draft')
  })
})

describe('sample shipments (SAL-316)', () => {
  let shipment = ''

  it('adds one to the customer with courier and tracking; sent moves the round to SENT, received to UNDER_REVIEW', async () => {
    const added = await ok('sales', 'POST', `/sales/samples/rounds/${round}/shipments`, { carrierName: 'Made-up Express', trackingNumber: 'ME123456789IT', trackingUrl: 'https://tracking.example.test/ME123456789IT' }, 201)
    shipment = added.shipment.id
    expect(added.shipment).toMatchObject({ direction: 'OUTBOUND', party: { id: P1 }, sentAt: null, removable: true })
    expect(added.round.stage).toBe('IN_MAKING')
    const sent = await ok('sales', 'PATCH', `/sales/samples/shipments/${shipment}`, { version: added.shipment.version, sentAt: '2026-11-09T09:00:00.000Z' })
    expect(sent.shipment).toMatchObject({ sentAt: '2026-11-09T09:00:00.000Z', removable: false })
    expect(sent.round.stage).toBe('SENT')
    expect(refusal(await no('sales', 'PATCH', `/sales/samples/shipments/${shipment}`, { version: sent.shipment.version, sentAt: '2026-11-09T10:00:00.000Z' }, 409))).toBe('refusal/SENT_ONCE')
    expect(refusal(await no('sales', 'PATCH', `/sales/samples/shipments/${shipment}`, { version: sent.shipment.version, receivedAt: '2026-11-08T10:00:00.000Z' }, 409))).toBe('refusal/RECEIVED_BEFORE_SENT')
    const received = await ok('sales', 'PATCH', `/sales/samples/shipments/${shipment}`, { version: sent.shipment.version, receivedAt: '2026-11-09T17:00:00.000Z' })
    expect(received.round.stage).toBe('UNDER_REVIEW')
    expect(refusal(await no('sales', 'DELETE', `/sales/samples/shipments/${shipment}?version=${received.shipment.version}`, undefined, 409))).toBe('refusal/SHIPMENT_SENT')
    expect(await one('SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = \'sample_shipment.changed\' AND payload->>\'sampleShipmentId\' = $1', [shipment])).toMatchObject({ n: 3 })
  })

  it('refuses a plain http page, a future time, an address on a return; removes a shipment not sent; an internal round names the party', async () => {
    await no('sales', 'POST', `/sales/samples/rounds/${round}/shipments`, { trackingUrl: 'http://tracking.example.test/1' }, 400)
    expect((await no('sales', 'POST', `/sales/samples/rounds/${round}/shipments`, { sentAt: '2099-01-01T00:00:00.000Z' }, 400)).message).toContain('future')
    const address = (await one('SELECT id FROM "PartyAddress" WHERE "partyId" = $1 LIMIT 1', [P1])).id
    expect(refusal(await no('sales', 'POST', `/sales/samples/rounds/${round}/shipments`, { direction: 'RETURN', shipToAddressId: address }, 409))).toBe('refusal/RETURN_NO_ADDRESS')
    const back = await ok('sales', 'POST', `/sales/samples/rounds/${round}/shipments`, { direction: 'RETURN', note: 'Made-up: the brand sends it back with its comments.' }, 201)
    const { round: after } = await ok('sales', 'DELETE', `/sales/samples/shipments/${back.shipment.id}?version=${back.shipment.version}`)
    expect(after.shipmentsList.map((entry: Json) => entry.id)).not.toContain(back.shipment.id)
    expect((await no('sales', 'POST', `/sales/samples/rounds/${fit}/shipments`, {}, 400)).message).toContain('internal round')
  })
})

describe('cancelling a round', () => {
  it('needs why, is final, and every later write is refused in words', async () => {
    const current = (await ok('manager', 'GET', `/sales/samples/rounds/${fit}`)).round
    await no('manager', 'POST', `/sales/samples/rounds/${fit}/cancel`, { version: current.version }, 400)
    const cancelled = (await ok('manager', 'POST', `/sales/samples/rounds/${fit}/cancel`, { version: current.version, reason: 'Made-up: the brand dropped the style.' })).round
    expect(cancelled).toMatchObject({ stage: 'CANCELLED', cancelReason: 'Made-up: the brand dropped the style.', actions: { edit: { allowed: false }, cancel: { allowed: false } } })
    expect(refusal(await no('manager', 'POST', `/sales/samples/rounds/${fit}/move`, { version: cancelled.version, to: 'IN_MAKING' }, 409))).toBe('refusal/ROUND_CLOSED')
    expect(refusal(await no('manager', 'PATCH', `/sales/samples/rounds/${fit}`, { version: cancelled.version, dueDate: null }, 409))).toBe('refusal/ROUND_CLOSED')
    expect(refusal(await no('manager', 'POST', `/sales/samples/rounds/${fit}/shipments`, { partyId: P1 }, 409))).toBe('refusal/SHIPMENT_ROUND_CANCELLED')
    expect(refusal(await no('manager', 'POST', `/sales/samples/rounds/${fit}/work-orders`, { lines: [{ salesOrderLineId: sampleLine }] }, 409))).toBe('refusal/NO_WORK_ORDER')
    // The revision of a round past REQUESTED is pinned (its other fields still change); the same revision again is no change.
    const live = (await ok('manager', 'GET', `/sales/samples/rounds/${round}`)).round
    expect(live.actions.changeRevision).toMatchObject({ allowed: false, refusal: { code: 'REVISION_FROZEN' } })
    const renumbered = (await ok('manager', 'PATCH', `/sales/samples/rounds/${round}`, { version: live.version, revisionId: live.revision.id, roundNo: 3 })).round
    expect(renumbered).toMatchObject({ roundNo: 3, stage: 'UNDER_REVIEW' })
  })
})
