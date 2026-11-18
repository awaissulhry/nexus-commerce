import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { callerFor } from '../../../core/command'
import { findMarkers, markersOf, type Marker } from '../../../modules/production/testing/two-brands'
import { urgencyWorld, type UrgencyWorld } from '../../../modules/production/testing/urgency-world'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { freshGuard } from '../../auth/portal/testing/portal'
import { systemContext } from '../../outbox/system'
import { partnerFanOut } from './fan-out'
import { unsubscribeKeyOf } from './mail'

/**
 * B-PR-31 (F-PR-15's ask; 06-tree §0.5 "Notifications: + gate passed or missed at + Gates & dates, + QC result at + Quality &
 * photos"; the Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the
 * production unit, should be able to see it all. And manage it all as well.") on the local stack through the real app
 * (modules/production/testing/urgency-world.ts): brand A = the seeds' P1, brand B = the threads' second brand, both portals on.
 * A's buyer (sees production) and A's finance person (orders, no production), B's Production person. The worker's fan-out runs
 * here by hand on planted events (`tell`, the envelope the relay hands it); the records they name are planted with the
 * database's rules off, as the brand-portal reads' own tests do.
 *
 *   gate      a gate of its own order passed, or its work started before the gate ("missed"): told only of its real gates, only
 *             while its level shares gates (+ Gates & dates or more), only while the gate still reads so; never our reason
 *   QC        a final inspection of a work order made for it ALONE: passed or not, only at + Quality & photos, one notice per act
 *             (its first order, "and N more"); a shared (mixed) work order's result reaches nobody
 *   PW-P07    an event that names another customer's order or work order tells that customer nothing it may not read, and the
 *             other customer nothing at all; B's notices hold nothing of A
 *   PW-15     no notice names a person, the override's reason, an inspection number, a lot or a work order; params hold its own
 *             numbers and the gate's kind only; actorId is null
 *
 * Every name, address and number is made up. Run with `env -u FACTORY_REDIS_URL node scripts/factory/run-pg-tests.mjs
 * platform/portal/notifications`.
 */

let world: UrgencyWorld
const NS = 'pr2o-gate-quality-notices'
type Json = Record<string, any>
type Portal = Awaited<ReturnType<UrgencyWorld['portalPerson']>>
type Office = Awaited<ReturnType<UrgencyWorld['officePerson']>>
let inspector: Office
let alphaBuyer: Portal
let alphaFinance: Portal
let betaProduction: Portal
const orders = {} as Record<'a1' | 'a2' | 'b1', string>
let aMarkers: Marker[] = []
let officeWords: string[] = []
const OVERRIDE_REASON = 'Made-up office reason: the lining supplier is late, we cut anyway.'
const INSPECTION_NOTE = 'Made-up inspector note: seam on the left sleeve.'

const admin = <R = Json>(sql: string, values: unknown[] = []) => world.admin<R>(sql, values)
const T = () => world.ids.tenantId
const system = () => callerFor(world.h.database, systemContext(T(), `test-${newId()}`))
const fanOutOptions = () => ({ clock: world.h.clock, unsubscribeKey: unsubscribeKeyOf(world.h.auth.secrets) })
const seqOf = async (orderId: string) => (await admin<{ seq: number | null }>('SELECT "customerSeq" AS seq FROM "SalesOrder" WHERE id = $1', [orderId]))[0]!.seq
const setLevel = (partyId: string, level: 'STATUS' | 'PROGRESS' | 'GATES' | 'QUALITY') =>
  admin(`UPDATE "PortalSettings" SET "productionLevel" = $2::"ProductionShareLevel", version = version + 1 WHERE "partyId" = $1`, [partyId, level]) // B-PR-40: the level alone

/** An event planted straight into the worker's fan-out. */
async function tell(type: string, payload: Json): Promise<void> {
  const eventId = newId()
  await partnerFanOut(
    system(),
    { eventId, type, version: 1, context: type.split('.')[0], tenantId: T(), companyId: world.w.companyId, siteId: null, subject: eventId, correlationId: `test-${eventId}`, causationId: null, source: 'test', occurredAt: new Date().toISOString(), payload } as never,
    fanOutOptions(),
  )
}

// ---- the records the events name -----------------------------------------------------------------------------------------------
/** A gate of an order (passed, or started before with our reason), the database's rules off. */
async function gate(salesOrderId: string, partyId: string, kind: string, state: { passed?: boolean; startedBefore?: boolean } = {}): Promise<string> {
  const id = newId()
  const at = new Date('2026-11-12T09:00:00.000Z')
  await world.replica([
    {
      sql: `INSERT INTO "OrderGate" (id, "tenantId", "companyId", "partyId", "salesOrderId", kind, label, "targetDate", "passedAt", "passedById", "overriddenAt", "overriddenById", "overrideReason", version, "createdAt", "updatedAt")
            VALUES ($1, $2, $3, $4, $5, $6::"GateKind", $7, '2026-11-20'::date, $8, $9, $10, $11, $12, 1, now(), now())`,
      values: [id, T(), world.w.companyId, partyId, salesOrderId, kind, kind === 'OTHER' ? 'Made-up office gate' : null, state.passed ? at : null, state.passed ? inspector.id : null, state.startedBefore ? at : null, state.startedBefore ? inspector.id : null, state.startedBefore ? OVERRIDE_REASON : null],
    },
  ])
  return id
}
const gateEvent = (gateId: string, salesOrderId: string, partyId: string, kind: string, change: 'PASSED' | 'STARTED_BEFORE' | 'EDITED', state: { passed: boolean; startedBefore: boolean }) => ({
  gateId,
  salesOrderId,
  number: 'T-GATE-0001',
  partyId,
  kind,
  change,
  via: change === 'PASSED' ? 'OFFICE' : null,
  passed: state.passed,
  startedBefore: state.startedBefore,
})

/** A final inspection of a work order, signed (or still open), the database's rules off. */
async function inspection(workOrderId: string, status: 'OPEN' | 'PASSED' | 'FAILED'): Promise<string> {
  const id = newId()
  await world.replica([
    {
      sql: `INSERT INTO "Inspection" (id, "tenantId", "companyId", "siteId", "workOrderId", number, "lotSize", "sampleSize", "inspectionLevel", "aqlMajor", "aqlMinor", "acceptMajor", "acceptMinor",
              status, "inspectorUserId", "decidedAt", "signatureSha256", "computedResult", note, version, "createdAt", "updatedAt")
            VALUES ($1, $2, $3, $4, $5, $6, 4, 3, 'II', 2.5, 4.0, 0, 1, $7::"InspectionStatus", $8, $9, $10, $11::"InspectionResult", $12, 1, now(), now())`,
      values: [id, T(), world.w.companyId, world.w.siteId, workOrderId, `T-INS-${id.slice(-6)}`, status, inspector.id, status === 'OPEN' ? null : new Date(), status === 'OPEN' ? null : 'a'.repeat(64), status === 'OPEN' ? null : status === 'PASSED' ? 'PASS' : 'FAIL', INSPECTION_NOTE],
    },
  ])
  return id
}
const decided = (inspectionId: string, workOrderId: string, status: 'PASSED' | 'FAILED', partyId: string | null) => ({
  inspectionId,
  workOrderId,
  number: 'T-WO-0001',
  partyId,
  status,
  computedResult: status === 'PASSED' ? 'PASS' : 'FAIL',
  overridden: false,
  postedBy: 'OFFICE',
})

// ---- what each person got ----------------------------------------------------------------------------------------------------
interface Notice {
  id: string
  userId: string
  partyId: string
  category: string
  eventType: string
  recordType: string
  recordId: string
  recordLabel: string
  messageKey: string
  params: Json
  actorId: string | null
}
const NOTICE_COLUMNS = `id::text AS id, "userId"::text AS "userId", "partyId"::text AS "partyId", category::text AS category, "eventType", "recordType", "recordId"::text AS "recordId", "recordLabel", "messageKey", params, "actorId"::text AS "actorId"`
const noticesOf = (userId: string) => admin<Notice>(`SELECT ${NOTICE_COLUMNS} FROM "Notification" WHERE "userId" = $1 ORDER BY "createdAt", id`, [userId])
const looked = new Map<string, number>()
async function fresh(person: Portal): Promise<Notice[]> {
  const all = await noticesOf(person.id)
  const from = looked.get(person.id) ?? 0
  looked.set(person.id, all.length)
  return all.slice(from)
}
const shortOf = (notice: Notice) => ({ messageKey: notice.messageKey, recordId: notice.recordId })

beforeAll(async () => {
  world = await urgencyWorld('pr2o_gate_quality_notices', NS)
  orders.a1 = (await world.addOrder(world.ids.a, 'G1', '2026-10-01')).orderId
  orders.a2 = (await world.addOrder(world.ids.a, 'G2', '2026-10-02')).orderId
  orders.b1 = (await world.addOrder(world.ids.b, 'G3', '2026-10-03')).orderId
  inspector = await world.officePerson('ines.inspector@pr2o-office.example.com', 'owner')
  alphaBuyer = await world.portalPerson('anna.buyer@pr2o-brand-alpha.example.com', world.ids.a, ['customer-buyer', 'partner-approve'])
  alphaFinance = await world.portalPerson('franca.finance@pr2o-brand-alpha.example.com', world.ids.a, ['customer-finance'])
  betaProduction = await world.portalPerson('bruno.production@pr2o-brand-beta.example.com', world.ids.b, ['customer-production'])
  // The portal reads roles on the harness clock, the worker's fan-out on the server clock: every person here is a reader to both.
  await world.replica([{ sql: `UPDATE "RoleAssignment" SET "validFrom" = now() - interval '1 day' WHERE "userId" = ANY($1::uuid[])`, values: [[alphaBuyer.id, alphaFinance.id, betaProduction.id]] }])
  aMarkers = [
    ...(await markersOf(world.h.db, world.ids.a)),
    { label: "A's work order", text: world.w.a.workOrderId },
    ...(['a1', 'a2'] as const).map((name) => ({ label: `A's order ${name}`, text: orders[name] })),
  ]
  officeWords = [OVERRIDE_REASON, INSPECTION_NOTE, ...(await admin<{ displayName: string; email: string; id: string }>('SELECT "displayName", email, id::text AS id FROM "User" WHERE id = $1', [inspector.id])).flatMap((row) => [row.displayName, row.email, row.id])]
  for (const person of [alphaBuyer, alphaFinance, betaProduction]) await fresh(person)
}, 600_000)

beforeEach(() => {
  freshGuard(world.h)
})

afterAll(async () => {
  await world?.close()
}, 60_000)

describe('B-PR-31 (F-PR-15): a gate and a final inspection, each at the level that shares it', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('a gate passed or started before: told from + Gates & dates, only its real gates, only while the gate still reads so', async () => {
    // + Progress (the world's level): a gate is not news for A — it does not read its gates.
    const pp = await gate(orders.a1, world.ids.a, 'PP_SAMPLE', { passed: true })
    await tell('order_gate.changed', gateEvent(pp, orders.a1, world.ids.a, 'PP_SAMPLE', 'PASSED', { passed: true, startedBefore: false }))
    expect(await fresh(alphaBuyer)).toEqual([])

    await setLevel(world.ids.a, 'GATES')
    await tell('order_gate.changed', gateEvent(pp, orders.a1, world.ids.a, 'PP_SAMPLE', 'PASSED', { passed: true, startedBefore: false }))
    const passed = await fresh(alphaBuyer)
    expect(passed.map(shortOf)).toEqual([{ messageKey: 'portal.production.gate_passed', recordId: orders.a1 }])
    expect(passed[0]).toMatchObject({ partyId: world.ids.a, category: 'FOLLOWING', recordType: 'SalesOrder', recordLabel: `#${await seqOf(orders.a1)}`, params: { yourKind: 'ORDER', yourSeq: await seqOf(orders.a1), gate: 'PP_SAMPLE' }, actorId: null })
    // The finance person sees no production: told nothing of it.
    expect(await fresh(alphaFinance)).toEqual([])

    // "Missed": its work started before the trims gate passed — the gate named, never our reason.
    const trims = await gate(orders.a2, world.ids.a, 'TRIMS_IN', { startedBefore: true })
    await tell('order_gate.changed', gateEvent(trims, orders.a2, world.ids.a, 'TRIMS_IN', 'STARTED_BEFORE', { passed: false, startedBefore: true }))
    const ahead = await fresh(alphaBuyer)
    expect(ahead.map(shortOf)).toEqual([{ messageKey: 'portal.production.gate_started_before', recordId: orders.a2 }])
    expect(JSON.stringify(ahead)).not.toContain('lining')

    // Nothing: a gate in our own words; a "passed" the gate no longer reads; an edit; a gate of another order than the event's.
    const other = await gate(orders.a1, world.ids.a, 'OTHER', { passed: true })
    await tell('order_gate.changed', gateEvent(other, orders.a1, world.ids.a, 'OTHER', 'PASSED', { passed: true, startedBefore: false }))
    const waiting = await gate(orders.a1, world.ids.a, 'LAB_PASSED')
    await tell('order_gate.changed', gateEvent(waiting, orders.a1, world.ids.a, 'LAB_PASSED', 'PASSED', { passed: true, startedBefore: false }))
    await tell('order_gate.changed', gateEvent(pp, orders.a1, world.ids.a, 'PP_SAMPLE', 'EDITED', { passed: true, startedBefore: false }))
    await tell('order_gate.changed', gateEvent(pp, orders.a2, world.ids.a, 'PP_SAMPLE', 'PASSED', { passed: true, startedBefore: false }))
    expect(await fresh(alphaBuyer)).toEqual([])

    // The bell says it in the customer's words, by its own number.
    const bell = await alphaBuyer.browser.send('GET', '/portal/notifications?limit=50')
    const item = ((bell.body as Json).items as Json[]).find((entry) => entry.group.ids.includes(passed[0]!.id))!
    expect(item.sentence.en).toBe(`A gate of your order ${await seqOf(orders.a1)} is passed: PP sample`)
    expect(item.sentence.it).toBe(`Una tappa per il vostro ordine ${await seqOf(orders.a1)} è superata: Campione di pre-produzione`)
  })

  it("PW-P07: a gate event naming another customer's order tells nothing; B's own gate tells B only, at its own level", async () => {
    const onB = await gate(orders.b1, world.ids.b, 'SIZE_SET', { passed: true })
    // B's order named under A: A is not told of it, neither is B (the event's customer is not the order's).
    await tell('order_gate.changed', gateEvent(onB, orders.b1, world.ids.a, 'SIZE_SET', 'PASSED', { passed: true, startedBefore: false }))
    expect(await fresh(alphaBuyer)).toEqual([])
    expect(await fresh(betaProduction)).toEqual([])
    // B at + Progress: still nothing; at + Quality & photos (which shares gates too): B is told, A is not.
    await tell('order_gate.changed', gateEvent(onB, orders.b1, world.ids.b, 'SIZE_SET', 'PASSED', { passed: true, startedBefore: false }))
    expect(await fresh(betaProduction)).toEqual([])
    await setLevel(world.ids.b, 'QUALITY')
    await tell('order_gate.changed', gateEvent(onB, orders.b1, world.ids.b, 'SIZE_SET', 'PASSED', { passed: true, startedBefore: false }))
    expect((await fresh(betaProduction)).map(shortOf)).toEqual([{ messageKey: 'portal.production.gate_passed', recordId: orders.b1 }])
    expect(await fresh(alphaBuyer)).toEqual([])
  })

  it('a final inspection: told of work made for the customer alone at + Quality & photos, passed or not; a mixed work order tells nobody', async () => {
    // B at + Quality & photos (the test before): its own work order's inspection passed, then another one failed.
    const passedB = await inspection(world.w.b.workOrderId, 'PASSED')
    await tell('quality.inspection_decided', decided(passedB, world.w.b.workOrderId, 'PASSED', world.ids.b))
    const failedB = await inspection(world.w.b.workOrderId, 'FAILED')
    await tell('quality.inspection_decided', decided(failedB, world.w.b.workOrderId, 'FAILED', world.ids.b))
    const toB = await fresh(betaProduction)
    expect(toB.map(shortOf)).toEqual([
      { messageKey: 'portal.production.qc_passed', recordId: world.w.b.salesOrderId },
      { messageKey: 'portal.production.qc_failed', recordId: world.w.b.salesOrderId },
    ])
    expect(toB[0]!.params).toEqual({ yourKind: 'ORDER', yourSeq: await seqOf(world.w.b.salesOrderId), more: 0 })
    // Never the inspection's number, its note, the lot or the work order.
    expect(JSON.stringify(toB)).not.toMatch(/T-INS-|seam|lotSize|workOrder/)
    expect(JSON.stringify(toB)).not.toContain(world.w.b.workOrderId)

    // The mixed work order (made before the one-customer rule): its result judges both customers' goods — nobody is told.
    await setLevel(world.ids.a, 'QUALITY')
    const mixed = await inspection(world.w.mixed.workOrderId, 'PASSED')
    await tell('quality.inspection_decided', decided(mixed, world.w.mixed.workOrderId, 'PASSED', null))
    expect(await fresh(alphaBuyer)).toEqual([])
    expect(await fresh(betaProduction)).toEqual([])

    // A at + Gates & dates: its own work order's result is not shared; at + Quality & photos it is.
    await setLevel(world.ids.a, 'GATES')
    const passedA = await inspection(world.w.a.workOrderId, 'PASSED')
    await tell('quality.inspection_decided', decided(passedA, world.w.a.workOrderId, 'PASSED', world.ids.a))
    expect(await fresh(alphaBuyer)).toEqual([])
    await setLevel(world.ids.a, 'QUALITY')
    await tell('quality.inspection_decided', decided(passedA, world.w.a.workOrderId, 'PASSED', world.ids.a))
    expect((await fresh(alphaBuyer)).map(shortOf)).toEqual([{ messageKey: 'portal.production.qc_passed', recordId: world.w.a.salesOrderId }])
    expect(await fresh(alphaFinance)).toEqual([])

    // Stale or wrong: an event that says passed of an inspection still open; an inspection named with another work order.
    const open = await inspection(world.w.a.workOrderId, 'OPEN')
    await tell('quality.inspection_decided', decided(open, world.w.a.workOrderId, 'PASSED', world.ids.a))
    await tell('quality.inspection_decided', decided(passedA, world.w.b.workOrderId, 'PASSED', world.ids.a))
    // B's work order's inspection named under A: the work order's own customer (B) is the only one it may concern — never A.
    await tell('quality.inspection_decided', decided(passedB, world.w.b.workOrderId, 'PASSED', world.ids.a))
    expect(await fresh(alphaBuyer)).toEqual([])
    expect((await fresh(betaProduction)).map((notice) => notice.recordId)).toEqual([world.w.b.salesOrderId])
  })

  it('PW-P07 / PW-15: every notice names its own customer only, by its own numbers; no person, no reason of ours, no office series; not mailed at once', async () => {
    const people = [
      { person: alphaBuyer, partyId: world.ids.a },
      { person: alphaFinance, partyId: world.ids.a },
      { person: betaProduction, partyId: world.ids.b },
    ]
    const all = (await Promise.all(people.map(async ({ person, partyId }) => (await noticesOf(person.id)).map((notice) => ({ ...notice, partyOfUser: partyId }))))).flat()
    expect(all.length).toBeGreaterThanOrEqual(6)
    const ALLOWED = new Set(['yourKind', 'yourSeq', 'more', 'gate'])
    for (const notice of all) {
      expect(notice.partyId, notice.messageKey).toBe(notice.partyOfUser)
      expect(notice.actorId, notice.messageKey).toBeNull()
      for (const name of Object.keys(notice.params ?? {})) expect(ALLOWED.has(name), `${notice.messageKey}.${name}`).toBe(true)
      expect(notice.recordLabel, notice.messageKey).not.toMatch(/SO-|T-URG-|WO-|INS-/)
      for (const word of officeWords) expect(JSON.stringify(notice), `${notice.messageKey} names ${word}`).not.toContain(word)
    }
    const ofB = all.filter((notice) => notice.userId === betaProduction.id)
    expect(ofB.length).toBeGreaterThan(0)
    expect(findMarkers(ofB, aMarkers)).toEqual([])
    const bellB = await betaProduction.browser.send('GET', '/portal/notifications?limit=50')
    expect(findMarkers(bellB.body, aMarkers)).toEqual([])
    for (const item of (bellB.body as Json).items as Json[]) expect(`${item.sentence.en} ${item.sentence.it}`).not.toMatch(/SO-|WO-|INS-|T-URG-/)
    // Topic PRODUCTION is a daily summary by default: none of these was mailed at once.
    const mailed = await admin<{ n: string }>(`SELECT count(*)::text AS n FROM "NotificationDelivery" WHERE "notificationId" = ANY($1::uuid[]) AND channel = 'EMAIL'`, [all.map((notice) => notice.id)])
    expect(mailed[0]!.n).toBe('0')
  })
})
