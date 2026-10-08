/**
 * Step 4 Send to FBA (Part B) — the job that runs a plan's Amazon steps, against the FAKE Amazon (Amazon's own example
 * answers, EU values; `fake-amazon.ts`). Nothing leaves the machine: `fetch` is never called.
 *
 *   happy path   QUEUED → CREATING → PACKING → BOXES → PLACING → QUOTING → WAITING_FOR_CHOICE in one run: the real
 *                request bodies (checked against the model's required fields by the fake), the boxes (sealed cases as
 *                identical boxes, loose units in a mixed box), two placement options with own carrier and delivery
 *                windows, `fba.plan_changed` per status, and NO confirm of placement / transport / delivery window.
 *   no person    a plan found CONFIRMING without a person's click goes back to WAITING_FOR_CHOICE; nothing is sent.
 *   confirm      with a person's choice: placement, delivery windows and carriers confirmed once each; FBAShipment rows by
 *                FBA15… id with their items and numbered boxes (case / mixed); READY_TO_SHIP; a second run sends nothing.
 *   crash        an answer lost after Amazon accepted: the create is found again by its unique name (never a second
 *                plan); a confirm is read from Amazon's state (never sent twice).
 *   polling      2, 3, 5, 8, 13, 20, 30 s, then the run hands over (`nextCheckAt` = now + 60 s); the next run polls the
 *                same operation id and never sends the call again.
 *   failures     an operation FAILED → plan FAILED with Amazon's problems verbatim; "Try again" re-runs the step.
 *                Writes switched off / Amazon's 429 → HELD, which resumes by itself.
 *   claim        a lease held elsewhere, an older wizard plan → not claimed.
 *   cancel       CANCELLING → cancelInboundPlan → CANCELLED; a cancel asked mid-step is seen before the next call;
 *                a plan Amazon never saw is CANCELLED with no call.
 *   tracking     a shipment marked Shipped → updateShipmentTrackingDetails with one tracking id per box.
 *
 * Real SQL (PGlite with the production schema and row-level security).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FBA_SEND_COPY, MIXED_BOX_DEFAULT, type FbaPackingSnapshot, type FbaPlanOptions, type FbaPlanStepEntry, type FbaShipmentBox } from '@nexus/shared/fba-send'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property) }) }
})
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    publicationBatchQueue: queue, agentPlanQueue: queue, fbaInboundQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'disabled' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})

import { runFbaPlanWith } from './runner.js'
import { FakeAmazon } from './fake-amazon.js'
import { setInboundTransportForTests, type InboundTransport } from '../../clients/amazon-fba-inbound-v2.client.js'
import { FBA_LEASE_MS, FBA_RECHECK_MS } from './contract.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client
const fetchSpy = vi.spyOn(globalThis, 'fetch')

const AMAZON_IT = 'APJ6JRA9NG5V4'
const ADDRESS = { name: 'Test Sender', companyName: 'Test Company', addressLine1: 'Via Prova 1', city: 'Testville', postalCode: '00000', countryCode: 'IT', phoneNumber: '+390000000000', email: 'ship@example.test' }
const ids = { a: '', b: '' }

const clock = { t: 0, now: () => new Date(clock.t), advance: (ms: number) => { clock.t += ms } }
let sleeps: number[] = []
const syncInventory = vi.fn(async (_mskus: string[], _marketplaceId: string) => {})
const deps = { now: clock.now, sleep: async (ms: number) => { sleeps.push(ms); clock.advance(ms) }, syncInventory }
let fake: FakeAmazon
const run = (planRowId: string) => inside(() => runFbaPlanWith(planRowId, deps))

async function newPlan(over: Record<string, unknown> = {}): Promise<string> {
  return inside(async () => {
    const plan = await db().fbaInboundPlanV2.create({
      data: {
        source: 'matrix', status: 'QUEUED', currentStep: 'CREATE', channelConnectionId: 'conn-amazon-1', marketplaceId: AMAZON_IT,
        sourceLocationId: 'loc-it-main', sourceAddress: ADDRESS, readyToShipOn: new Date('2026-10-09T00:00:00.000Z'), mixedBox: { ...MIXED_BOX_DEFAULT },
        createdBy: 'owner@example.test', ...over,
      } as never,
    })
    await db().fbaInboundPlanLine.create({ data: { planRowId: plan.id, productId: ids.a, msku: 'TEST-FBA-A-IT', quantity: 12, caseCounts: [{ unitsPerCase: 6, cases: 2 }], looseUnits: 0, prepOwner: 'SELLER', labelOwner: 'SELLER' } })
    await db().fbaInboundPlanLine.create({ data: { planRowId: plan.id, productId: ids.b, msku: 'TEST-FBA-B-IT', quantity: 5, caseCounts: [], looseUnits: 5, prepOwner: 'AMAZON', labelOwner: 'AMAZON' } })
    return plan.id
  })
}
const planOf = (id: string) => inside(() => db().fbaInboundPlanV2.findFirstOrThrow({ where: { id } }))
const setPlan = (id: string, data: Record<string, unknown>) => inside(() => db().fbaInboundPlanV2.update({ where: { id }, data: data as never }))
const stepsOf = async (id: string) => ((await planOf(id)).steps ?? []) as unknown as FbaPlanStepEntry[]
const events = (id: string) => inside(async () => (await db().eventOutbox.findMany({ where: { type: 'fba.plan_changed', subject: id }, orderBy: { occurredAt: 'asc' } })).map(e => e.payload as { status: string; step: string | null; productIds: string[] }))
const amazonPlanOf = async (id: string) => fake.plans.get((await planOf(id)).planId!)!

/** Part C's confirmChoice, as it writes the plan: the person's pick, WAITING_FOR_CHOICE → CONFIRMING. */
async function choose(id: string, placementIndex = 1): Promise<void> {
  const options = (await planOf(id)).options as unknown as FbaPlanOptions
  const placement = options.placements[placementIndex]
  const choice = {
    placementOptionId: placement.placementOptionId,
    shipments: placement.shipments.map(s => ({ shipmentId: s.shipmentId, transportationOptionId: s.transport[0].transportationOptionId, deliveryWindowOptionId: s.deliveryWindows[0].deliveryWindowOptionId })),
  }
  await setPlan(id, { choice, confirmedBy: 'u-owner', confirmedAt: clock.now(), status: 'CONFIRMING', currentStep: 'CONFIRM', nextCheckAt: null })
}
async function readyToShip(): Promise<string> {
  const id = await newPlan()
  expect((await run(id)).status).toBe('WAITING_FOR_CHOICE')
  await choose(id)
  expect(await run(id)).toMatchObject({ claimed: true, status: 'READY_TO_SHIP', step: 'TRACKING', nextCheckAt: null })
  return id
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    ids.a = (await db().product.create({ data: { sku: 'TEST-FBA-A', name: 'Test jacket A', basePrice: '100.00', totalStock: 40, weightValue: '0.5', weightUnit: 'kg', dimLength: '20', dimWidth: '15', dimHeight: '10', dimUnit: 'cm' } as never })).id
    ids.b = (await db().product.create({ data: { sku: 'TEST-FBA-B', name: 'Test gloves B', basePrice: '30.00', totalStock: 20, weightValue: '800', weightUnit: 'g', dimLength: '30', dimWidth: '20', dimHeight: '10', dimUnit: 'cm' } as never })).id
    await db().productPackage.create({ data: { productId: ids.a, fbaPrepOwner: 'SELLER', fbaLabelOwner: 'SELLER' } as never })
    await db().productCaseSize.create({ data: { productId: ids.a, unitsPerCase: 6, caseLengthCm: '40', caseWidthCm: '30', caseHeightCm: '25', caseWeightKg: '4.2' } as never })
    // A second size the plan did not send: its boxes never appear.
    await db().productCaseSize.create({ data: { productId: ids.a, unitsPerCase: 12, caseLengthCm: '50', caseWidthCm: '40', caseHeightCm: '25', caseWeightKg: '8' } as never })
  })
})
afterAll(async () => {
  setInboundTransportForTests(null)
  delete process.env.NEXUS_ENABLE_FBA_INBOUND_SEND
  expect(fetchSpy).not.toHaveBeenCalled()
  await database?.close()
})
beforeEach(() => {
  clock.t = Date.parse('2026-10-08T07:00:00.000Z')
  sleeps = []
  syncInventory.mockClear()
  fake = new FakeAmazon({ now: clock.now })
  setInboundTransportForTests(fake.transport)
  process.env.NEXUS_ENABLE_FBA_INBOUND_SEND = '1'
})

describe('the happy path to the Owner\'s choice', () => {
  it('runs every step to WAITING_FOR_CHOICE in one run, with real bodies, and confirms nothing final', async () => {
    const id = await newPlan()
    const outcome = await run(id)
    expect(outcome).toEqual({ claimed: true, status: 'WAITING_FOR_CHOICE', step: 'CONFIRM', nextCheckAt: null })
    expect(fake.invalid).toEqual([])

    // createInboundPlan: one marketplace, the address, the frozen unique name, owners per item.
    const [create] = fake.calls('createInboundPlan')
    expect(create.accountId).toBe('conn-amazon-1')
    expect(create.body).toEqual({
      destinationMarketplaces: [AMAZON_IT],
      sourceAddress: ADDRESS,
      // The frozen name: the market, the plan's day (Europe/Rome), the row id's last 6.
      name: `Nexus IT ${new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format((await planOf(id)).createdAt)} #${id.slice(-6)}`,
      items: [
        { msku: 'TEST-FBA-A-IT', quantity: 12, prepOwner: 'SELLER', labelOwner: 'SELLER' },
        { msku: 'TEST-FBA-B-IT', quantity: 5, prepOwner: 'AMAZON', labelOwner: 'AMAZON' },
      ],
    })
    // The cheapest packing option with the fewest groups is the one confirmed (not final at Amazon).
    const plan = await planOf(id)
    const amazon = fake.plans.get(plan.planId!)!
    const best = amazon.packingOptions.find(o => o.packingGroups.length === 1)
    expect(fake.calls('confirmPackingOption').map(r => r.path)).toEqual([expect.stringContaining(`/packingOptions/${best.packingOptionId}/confirmation`)])
    // setPackingInformation: two sealed cases as identical boxes, the loose units in one mixed box (0.8 kg × 5 + 1.2 kg).
    const [packing] = fake.calls('setPackingInformation')
    expect(packing.body).toEqual({
      packageGroupings: [{
        packingGroupId: best.packingGroups[0],
        boxes: [
          { contentInformationSource: 'BOX_CONTENT_PROVIDED', dimensions: { unitOfMeasurement: 'CM', length: 40, width: 30, height: 25 }, weight: { unit: 'KG', value: 4.2 }, quantity: 2,
            items: [{ msku: 'TEST-FBA-A-IT', quantity: 6, prepOwner: 'SELLER', labelOwner: 'SELLER' }] },
          { contentInformationSource: 'BOX_CONTENT_PROVIDED', dimensions: { unitOfMeasurement: 'CM', length: 60, width: 40, height: 40 }, weight: { unit: 'KG', value: 5.2 }, quantity: 1,
            items: [{ msku: 'TEST-FBA-B-IT', quantity: 5, prepOwner: 'AMAZON', labelOwner: 'AMAZON' }] },
        ],
      }],
    })
    const snapshot = plan.packing as unknown as FbaPackingSnapshot
    expect(snapshot).toMatchObject({ packingOptionId: best.packingOptionId, sentAt: expect.any(String), groups: [{ packingGroupId: best.packingGroups[0], items: [{ msku: 'TEST-FBA-A-IT', quantity: 12 }, { msku: 'TEST-FBA-B-IT', quantity: 5 }] }] })
    expect(snapshot.groups[0].boxes.map(b => [b.kind, b.quantity])).toEqual([['case', 2], ['mixed', 1]])

    // Two placement options with their FCs, own carrier and delivery windows; the transport request names the ready day.
    const options = plan.options as unknown as FbaPlanOptions
    expect(options.placements.map(p => p.shipments.map(s => s.destinationFc))).toEqual([['MXP5'], ['MXP5', 'FCO1']])
    for (const placement of options.placements) {
      for (const shipment of placement.shipments) {
        expect(shipment.transport).toEqual([expect.objectContaining({ shippingSolution: 'USE_YOUR_OWN_CARRIER', shippingMode: 'GROUND_SMALL_PARCEL', carrierName: 'UPS', quote: null })])
        expect(shipment.deliveryWindows).toHaveLength(2)
      }
    }
    expect(options.expiresAt).toBe(options.placements.map(p => p.expiresAt!).sort()[0])
    expect(fake.calls('generateTransportationOptions').map(r => (r.body as any).shipmentTransportationConfigurations[0])).toEqual([
      expect.objectContaining({ readyToShipWindow: { start: '2026-10-09T00:00Z' }, contactInformation: { name: 'Test Sender', phoneNumber: '+390000000000', email: 'ship@example.test' } }),
      expect.objectContaining({ readyToShipWindow: { start: '2026-10-09T00:00Z' } }),
    ])
    expect(fake.calls('generateDeliveryWindowOptions')).toHaveLength(3)

    // Nothing final was sent: the placement, the carriers and the windows wait for a person.
    for (const op of ['confirmPlacementOption', 'confirmTransportationOptions', 'confirmDeliveryWindowOptions']) expect(fake.calls(op), op).toEqual([])

    // The step log: every operation id written, every one settled.
    const steps = await stepsOf(id)
    expect(steps.map(s => [s.step, s.call, s.result])).toEqual([
      ['CREATE', 'createInboundPlan', 'SUCCESS'], ['PACK', 'generatePackingOptions', 'SUCCESS'], ['PACK', 'confirmPackingOption', 'SUCCESS'],
      ['BOXES', 'setPackingInformation', 'SUCCESS'], ['PLACE', 'generatePlacementOptions', 'SUCCESS'],
      ['QUOTE', 'generateTransportationOptions', 'SUCCESS'], ['QUOTE', 'generateDeliveryWindowOptions', 'SUCCESS'],
      ['QUOTE', 'generateTransportationOptions', 'SUCCESS'], ['QUOTE', 'generateDeliveryWindowOptions', 'SUCCESS'], ['QUOTE', 'generateDeliveryWindowOptions', 'SUCCESS'],
    ])
    expect(steps.every(s => !!s.operationId && !!s.finishedAt)).toBe(true)
    // fba.plan_changed with every status, in the transaction that moved the plan.
    expect((await events(id)).map(e => e.status)).toEqual(['CREATING', 'PACKING', 'BOXES', 'PLACING', 'QUOTING', 'WAITING_FOR_CHOICE'])
    expect((await events(id))[0].productIds.sort()).toEqual([ids.a, ids.b].sort())
    // Amazon's FBA numbers are re-read once the plan exists ("+N" early).
    expect(syncInventory).toHaveBeenCalledWith(['TEST-FBA-A-IT', 'TEST-FBA-B-IT'], AMAZON_IT)

    // A second run does nothing: the plan waits for a person.
    const before = fake.requests.length
    expect(await run(id)).toEqual({ claimed: false, status: null, step: null, nextCheckAt: null })
    expect(fake.requests.length).toBe(before)
  })

  it('never confirms on its own: CONFIRMING without a person\'s click goes back to the choice', async () => {
    const id = await newPlan()
    await run(id)
    const options = (await planOf(id)).options as unknown as FbaPlanOptions
    // A choice written without a person (confirmedBy empty) — what no route may do.
    await setPlan(id, { status: 'CONFIRMING', currentStep: 'CONFIRM', choice: { placementOptionId: options.placements[0].placementOptionId, shipments: [] }, confirmedBy: null })
    const outcome = await run(id)
    expect(outcome).toMatchObject({ claimed: true, status: 'WAITING_FOR_CHOICE', step: 'CONFIRM', nextCheckAt: null })
    expect((await planOf(id)).lastError).toMatch(/needs a person's click/)
    for (const op of ['confirmPlacementOption', 'confirmTransportationOptions', 'confirmDeliveryWindowOptions']) expect(fake.calls(op), op).toEqual([])
  })
})

describe('a person\'s choice → READY_TO_SHIP', () => {
  it('confirms placement, windows and carriers once each, records the shipments and their numbered boxes', async () => {
    const id = await readyToShip()
    expect(fake.invalid).toEqual([])
    expect(fake.calls('confirmPlacementOption')).toHaveLength(1)
    expect(fake.calls('confirmDeliveryWindowOptions')).toHaveLength(2)
    expect(fake.calls('confirmTransportationOptions')).toHaveLength(1)
    const plan = await planOf(id)
    const choice = plan.choice as unknown as { placementOptionId: string; shipments: Array<{ shipmentId: string; transportationOptionId: string }> }
    expect(fake.calls('confirmTransportationOptions')[0].body).toEqual({
      transportationSelections: choice.shipments.map(s => ({ shipmentId: s.shipmentId, transportationOptionId: s.transportationOptionId, contactInformation: { name: 'Test Sender', phoneNumber: '+390000000000', email: 'ship@example.test' } })),
    })

    const shipments = await inside(() => db().fBAShipment.findMany({ where: { planRowId: id }, include: { items: true }, orderBy: { destinationFC: 'desc' } }))
    expect(shipments.map(s => [s.destinationFC, s.status, s.sourceLocationId])).toEqual([['MXP5', 'WORKING', 'loc-it-main'], ['FCO1', 'WORKING', 'loc-it-main']])
    for (const s of shipments) {
      expect(s.shipmentId).toMatch(/^FBA15[0-9A-F]{3}\d{4}$/)
      expect(s.amazonShipmentId).toMatch(/^sh/)
      expect(s.transport).toMatchObject({ shippingSolution: 'USE_YOUR_OWN_CARRIER', carrierName: 'UPS', deliveryWindow: { deliveryWindowOptionId: expect.stringMatching(/^dw/) } })
    }
    const units = (s: (typeof shipments)[number]) => Object.fromEntries(s.items.map(i => [i.productId === ids.a ? 'A' : 'B', i.quantitySent]))
    expect(units(shipments[0])).toEqual({ A: 6, B: 5 })
    expect(units(shipments[1])).toEqual({ A: 6 })
    const boxes = (s: (typeof shipments)[number]) => (s.boxes as unknown as FbaShipmentBox[])
    expect(boxes(shipments[0]).map(b => [b.kind, b.lengthCm, b.weightKg, b.items])).toEqual([
      ['case', 40, 4.2, [{ msku: 'TEST-FBA-A-IT', quantity: 6 }]],
      ['mixed', 60, 5.2, [{ msku: 'TEST-FBA-B-IT', quantity: 5 }]],
    ])
    expect(boxes(shipments[0]).every(b => b.boxId.startsWith(shipments[0].shipmentId))).toBe(true)
    expect((await events(id)).map(e => e.status).slice(-2)).toEqual(['LABELS', 'READY_TO_SHIP'])
    // LABELS calls no Amazon operation, yet it leaves one SUCCESS entry with its time (the drawer's "Labels" step).
    const boxTotal = shipments.reduce((n, s) => n + boxes(s).length, 0)
    expect((await stepsOf(id)).filter(s => s.step === 'LABELS')).toEqual([expect.objectContaining({
      call: null, operationId: null, result: 'SUCCESS', finishedAt: expect.any(String), note: `${boxTotal} boxes numbered`,
    })])

    // A second run (the plan waits for the Shipped click) sends nothing.
    const before = fake.requests.length
    expect(await run(id)).toMatchObject({ claimed: true, status: 'READY_TO_SHIP' })
    expect(fake.requests.length).toBe(before)
    expect((await planOf(id)).nextCheckAt).toBeNull()
  })

  it('a shipment marked Shipped: its tracking goes to Amazon, one id per box', async () => {
    const id = await readyToShip()
    const [shipment] = await inside(() => db().fBAShipment.findMany({ where: { planRowId: id }, orderBy: { destinationFC: 'desc' } }))
    const tracking = (shipment.boxes as unknown as FbaShipmentBox[]).map((b, i) => ({ boxId: b.boxId, trackingId: `1ZTEST${i}` }))
    // Part C's markShipped, as it writes the rows.
    await inside(() => db().fBAShipment.update({ where: { id: shipment.id }, data: { shippedAt: clock.now(), shippedBy: 'owner@example.test', tracking: { boxes: tracking, sentAt: null } } }))
    await setPlan(id, { nextCheckAt: clock.now() })
    syncInventory.mockClear()
    expect(await run(id)).toMatchObject({ claimed: true, status: 'READY_TO_SHIP', nextCheckAt: null })
    const [sent] = fake.calls('updateShipmentTrackingDetails')
    expect(sent.method).toBe('PUT')
    expect(sent.path).toContain(`/shipments/${shipment.amazonShipmentId}/trackingDetails`)
    expect(sent.body).toEqual({ trackingDetails: { spdTrackingDetail: { spdTrackingItems: tracking } } })
    const after = await inside(() => db().fBAShipment.findUniqueOrThrow({ where: { id: shipment.id } }))
    expect(after.tracking).toMatchObject({ boxes: tracking, sentAt: expect.any(String) })
    expect(syncInventory).toHaveBeenCalledTimes(1)
    // Sent once: a later run has nothing to send.
    await setPlan(id, { nextCheckAt: clock.now() })
    await run(id)
    expect(fake.calls('updateShipmentTrackingDetails')).toHaveLength(1)
  })
})

describe('resume after a crash', () => {
  it('a create whose answer was lost is found by its unique name: one plan at Amazon, never two', async () => {
    const id = await newPlan()
    fake.script.crashAfter = ['createInboundPlan']
    const first = await run(id)
    expect(first).toMatchObject({ claimed: true, status: 'CREATING', step: 'CREATE' })
    expect(first.nextCheckAt?.getTime()).toBe(clock.t + FBA_RECHECK_MS)
    expect((await planOf(id)).planId).toBeNull()
    expect((await stepsOf(id)).map(s => [s.call, s.operationId, s.result])).toEqual([['createInboundPlan', null, null]])
    expect(fake.plans.size).toBe(1) // Amazon has it

    clock.advance(FBA_RECHECK_MS + 1_000)
    const second = await run(id)
    expect(second.status).toBe('WAITING_FOR_CHOICE')
    expect(fake.calls('createInboundPlan')).toHaveLength(1)
    expect(fake.calls('listInboundPlans')[0].query).toMatchObject({ status: 'ACTIVE', sortBy: 'CREATION_TIME', sortOrder: 'DESC' })
    expect(fake.plans.size).toBe(1)
    const plan = await planOf(id)
    expect(plan.planId).toBe([...fake.plans.keys()][0])
    expect((await stepsOf(id))[0]).toMatchObject({ call: 'createInboundPlan', result: 'SUCCESS', note: `adopted plan ${plan.planId} found by name` })
  })

  it('a confirm whose answer was lost is read from Amazon\'s state, never sent twice', async () => {
    const id = await newPlan()
    await run(id)
    await choose(id)
    fake.script.crashAfter = ['confirmPlacementOption']
    const first = await run(id)
    expect(first).toMatchObject({ status: 'CONFIRMING', nextCheckAt: new Date(clock.t + FBA_RECHECK_MS) })
    clock.advance(FBA_RECHECK_MS + 1_000)
    expect((await run(id)).status).toBe('READY_TO_SHIP')
    expect(fake.calls('confirmPlacementOption')).toHaveLength(1)
    const confirm = (await stepsOf(id)).filter(s => s.call === 'confirmPlacementOption')
    expect(confirm).toEqual([expect.objectContaining({ result: 'SUCCESS', operationId: null, note: expect.stringContaining('already done at Amazon') })])
  })
})

describe('polling an operation', () => {
  it('backs off 2, 3, 5, 8, 13, 20, 30 s, then hands over (~80 s); the next run polls the same operation, never re-sends', async () => {
    const id = await newPlan()
    fake.script.inProgressPolls = 0
    fake.script.pollsByOperation = { generatePlacementOptions: 100 }
    const outcome = await run(id)
    expect(outcome).toMatchObject({ claimed: true, status: 'PLACING', step: 'PLACE' })
    expect(outcome.nextCheckAt?.getTime()).toBe(clock.t + FBA_RECHECK_MS)
    const backoff = sleeps.slice(-7)
    expect(backoff).toEqual([2_000, 3_000, 5_000, 8_000, 13_000, 20_000, 30_000])
    expect(backoff.reduce((a, b) => a + b, 0)).toBe(81_000)
    const entry = (await stepsOf(id)).find(s => s.call === 'generatePlacementOptions')!
    expect(entry).toMatchObject({ result: 'IN_PROGRESS', operationId: expect.any(String) })

    // Before the hand-over time nobody may claim it.
    expect((await run(id)).claimed).toBe(false)
    fake.finishOperations()
    clock.advance(FBA_RECHECK_MS)
    expect((await run(id)).status).toBe('WAITING_FOR_CHOICE')
    expect(fake.calls('generatePlacementOptions')).toHaveLength(1)
    const polled = fake.calls('getInboundOperationStatus').filter(r => r.path.endsWith(entry.operationId!))
    expect(polled).toHaveLength(8) // 7 in the first run, then at once in the next
  })
})

describe('failures and holds', () => {
  it('an operation FAILED: plan FAILED with Amazon\'s problems verbatim; "Try again" re-runs the step', async () => {
    const id = await newPlan()
    fake.script.fail = { generatePlacementOptions: [] }
    expect(await run(id)).toMatchObject({ claimed: true, status: 'FAILED', step: 'PLACE', nextCheckAt: null })
    const plan = await planOf(id)
    expect(plan.lastError).toBe('The dimension does not match what is expected.')
    expect((await stepsOf(id)).at(-1)).toMatchObject({ step: 'PLACE', call: 'generatePlacementOptions', result: 'FAILED', problems: [{ code: 'DimensionMismatch', message: 'The dimension does not match what is expected.', severity: 'ERROR' }] })
    expect((await events(id)).at(-1)).toMatchObject({ status: 'FAILED', step: 'PLACE' })
    // Part C's retryPlan: FAILED → the failed step's status.
    await setPlan(id, { status: 'PLACING', currentStep: 'PLACE', lastError: null, nextCheckAt: null })
    expect((await run(id)).status).toBe('WAITING_FOR_CHOICE')
    expect(fake.calls('generatePlacementOptions')).toHaveLength(2)
  })

  it('Amazon refuses a call (400): FAILED with Amazon\'s sentence', async () => {
    const id = await newPlan()
    fake.script.reject = { setPackingInformation: 'Box weight exceeds the limit for this marketplace.' }
    expect(await run(id)).toMatchObject({ status: 'FAILED', step: 'BOXES' })
    expect((await planOf(id)).lastError).toBe('Box weight exceeds the limit for this marketplace.')
  })

  it('Amazon writes switched off: HELD (nothing sent), and it resumes by itself once they are on', async () => {
    delete process.env.NEXUS_ENABLE_FBA_INBOUND_SEND
    const id = await newPlan()
    const held = await run(id)
    expect(held).toMatchObject({ claimed: true, status: 'HELD', step: 'CREATE' })
    expect(held.nextCheckAt?.getTime()).toBe(clock.t + 15 * 60_000)
    expect((await planOf(id)).lastError).toBe(FBA_SEND_COPY.held.writesOff)
    expect(fake.requests).toEqual([])
    expect(await stepsOf(id)).toEqual([])

    process.env.NEXUS_ENABLE_FBA_INBOUND_SEND = '1'
    expect((await run(id)).claimed).toBe(false) // not before its time
    clock.advance(15 * 60_000)
    expect((await run(id)).status).toBe('WAITING_FOR_CHOICE')
    expect((await events(id)).map(e => e.status).slice(0, 3)).toEqual(['CREATING', 'HELD', 'CREATING'])
  })

  it('Amazon asks to slow down (429): HELD for a minute, then the same call again', async () => {
    const id = await newPlan()
    fake.script.throttle = { generatePackingOptions: 1 }
    const held = await run(id)
    expect(held).toMatchObject({ status: 'HELD', step: 'PACK' })
    expect((await planOf(id)).lastError).toBe(FBA_SEND_COPY.held.rate)
    clock.advance(FBA_RECHECK_MS)
    expect((await run(id)).status).toBe('WAITING_FOR_CHOICE')
    expect(fake.calls('generatePackingOptions')).toHaveLength(2)
  })
})

describe('the claim', () => {
  it('a lease held by another run, an older wizard plan, or a DRAFT (Owner 2026-10-08: nothing at Amazon until "Send to Amazon") is not claimed', async () => {
    const leased = await newPlan({ nextCheckAt: new Date(Date.parse('2026-10-08T07:00:00.000Z') + FBA_LEASE_MS) })
    expect(await run(leased)).toEqual({ claimed: false, status: null, step: null, nextCheckAt: null })
    const wizard = await newPlan({ source: null, status: 'CREATING' })
    expect((await run(wizard)).claimed).toBe(false)
    const draft = await newPlan({ status: 'DRAFT' })
    expect(await run(draft)).toEqual({ claimed: false, status: null, step: null, nextCheckAt: null })
    expect((await planOf(draft)).status).toBe('DRAFT')
    expect(fake.requests).toEqual([])
  })
})

describe('cancel', () => {
  it('CANCELLING with a plan at Amazon → cancelInboundPlan → CANCELLED', async () => {
    const id = await newPlan()
    await run(id)
    // Part C's cancelPlan (holds released there): status CANCELLING.
    await setPlan(id, { status: 'CANCELLING', currentStep: 'CANCEL', cancelledAt: clock.now(), nextCheckAt: null })
    expect(await run(id)).toMatchObject({ claimed: true, status: 'CANCELLED', step: 'CANCEL', nextCheckAt: null })
    expect(fake.calls('cancelInboundPlan')).toHaveLength(1)
    expect((await amazonPlanOf(id)).status).toBe('VOIDED')
  })

  it('a cancel asked while a step runs is seen before the next Amazon call', async () => {
    const id = await newPlan()
    const watching: InboundTransport = {
      kind: 'fake',
      async send(request) {
        const answer = await fake.send(request)
        if (request.path.endsWith('/packingOptions') && request.method === 'POST') {
          await inside(() => db().fbaInboundPlanV2.update({ where: { id }, data: { status: 'CANCELLING', currentStep: 'CANCEL', cancelledAt: new Date() } }))
        }
        return answer
      },
    }
    setInboundTransportForTests(watching)
    expect((await run(id)).status).toBe('CANCELLED')
    expect(fake.calls('confirmPackingOption')).toEqual([])
    expect(fake.calls('setPackingInformation')).toEqual([])
    expect(fake.calls('cancelInboundPlan')).toHaveLength(1)
  })

  it('a plan Amazon never saw is CANCELLED with no call', async () => {
    const id = await newPlan({ status: 'CANCELLING', currentStep: 'CANCEL' })
    expect((await run(id)).status).toBe('CANCELLED')
    expect(fake.requests).toEqual([])
  })
})
