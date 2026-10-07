/**
 * Step 4 Send to FBA — the 15-minute FBA shipment status poll rolls a Send-to-FBA plan up (the poll had no test).
 *
 *   - Amazon's status lands on the shipment, as before; a shipment of a plan also publishes `fba.plan_changed` in the
 *     same transaction (the Matrix drawer follows Amazon);
 *   - SHIPPED → AT_AMAZON once every shipment is at Amazon (RECEIVING / CLOSED); → CLOSED once every one is CLOSED;
 *   - a plan a person still acts on (READY_TO_SHIP) keeps its status; a shipment of no plan publishes nothing;
 *   - `planStatusFromShipments`, the pure rule.
 *
 * Real SQL (PGlite with the production schema and row-level security); Amazon's getShipments (v0) is a stub.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property) }) }
})
const amazon = vi.hoisted(() => ({ statuses: {} as Record<string, string>, asked: [] as string[][] }))
vi.mock('../services/fba-inbound.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/fba-inbound.service.js')>()),
  isFbaInboundConfigured: vi.fn(async () => true),
  getInboundShipmentsBatch: vi.fn(async ({ shipmentIdList }: { shipmentIdList: string[] }) => {
    amazon.asked.push(shipmentIdList)
    return { shipments: shipmentIdList.filter(id => amazon.statuses[id]).map(id => ({ ShipmentId: id, ShipmentStatus: amazon.statuses[id] })) }
  }),
}))

import { planStatusFromShipments, runFbaStatusPoll } from './fba-status-poll.job.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client
const ids = { a: '', b: '', shipped: '', ready: '', s1: '', s2: '', s3: '', loose: '' }

const planStatus = (id: string) => inside(async () => (await db().fbaInboundPlanV2.findFirstOrThrow({ where: { id } })).status)
const events = (id: string) => inside(async () => (await db().eventOutbox.findMany({ where: { type: 'fba.plan_changed', subject: id }, orderBy: { occurredAt: 'asc' } })).map(e => e.payload as { planId: string; status: string; step: string | null; productIds: string[] }))
const shipmentStatus = (id: string) => inside(async () => (await db().fBAShipment.findUniqueOrThrow({ where: { id } })).status)

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    ids.a = (await db().product.create({ data: { sku: 'TEST-POLL-A', name: 'Test A', basePrice: '10.00', totalStock: 0 } })).id
    ids.b = (await db().product.create({ data: { sku: 'TEST-POLL-B', name: 'Test B', basePrice: '10.00', totalStock: 0 } })).id
    ids.shipped = (await db().fbaInboundPlanV2.create({ data: { source: 'matrix', status: 'SHIPPED', currentStep: 'TRACKING', planId: 'wf-test-shipped' } as never })).id
    ids.ready = (await db().fbaInboundPlanV2.create({ data: { source: 'matrix', status: 'READY_TO_SHIP', currentStep: 'TRACKING', planId: 'wf-test-ready' } as never })).id
    for (const [plan, product] of [[ids.shipped, ids.a], [ids.shipped, ids.b], [ids.ready, ids.a]]) {
      await db().fbaInboundPlanLine.create({ data: { planRowId: plan, productId: product, msku: `M-${product}`, quantity: 6, looseUnits: 6, prepOwner: 'SELLER', labelOwner: 'SELLER' } })
    }
    const shipment = (shipmentId: string, planRowId: string | null) =>
      db().fBAShipment.create({ data: { shipmentId, destinationFC: 'MXP5', status: shipmentId === 'FBA15READY01' ? 'WORKING' : 'SHIPPED', planRowId } as never })
    ids.s1 = (await shipment('FBA15TEST001', ids.shipped)).id
    ids.s2 = (await shipment('FBA15TEST002', ids.shipped)).id
    ids.s3 = (await shipment('FBA15READY01', ids.ready)).id
    ids.loose = (await shipment('FBA15LOOSE01', null)).id
  })
})
afterAll(async () => { await database?.close() })

describe('planStatusFromShipments', () => {
  it('moves only the states Amazon moves', () => {
    expect(planStatusFromShipments('SHIPPED', ['RECEIVING', 'IN_TRANSIT'])).toBe('SHIPPED')
    expect(planStatusFromShipments('SHIPPED', ['RECEIVING', 'CLOSED'])).toBe('AT_AMAZON')
    expect(planStatusFromShipments('AT_AMAZON', ['CLOSED', 'CLOSED'])).toBe('CLOSED')
    expect(planStatusFromShipments('SHIPPED', ['CLOSED'])).toBe('CLOSED')
    expect(planStatusFromShipments('AT_AMAZON', ['RECEIVING', 'IN_TRANSIT'])).toBe('AT_AMAZON')
    expect(planStatusFromShipments('READY_TO_SHIP', ['CLOSED'])).toBe('READY_TO_SHIP')
    expect(planStatusFromShipments('SHIPPED', [])).toBe('SHIPPED')
  })
})

describe('runFbaStatusPoll with Send-to-FBA plans', () => {
  it('one shipment at Amazon, one in transit: the shipment moves, the plan stays SHIPPED, the drawer hears of it', async () => {
    amazon.statuses = { FBA15TEST001: 'RECEIVING', FBA15TEST002: 'IN_TRANSIT', FBA15READY01: 'SHIPPED', FBA15LOOSE01: 'IN_TRANSIT' }
    const result = await inside(() => runFbaStatusPoll())
    expect(result).toMatchObject({ scanned: 4, updated: 4, errors: 0 })
    expect(await shipmentStatus(ids.s1)).toBe('RECEIVING')
    expect(await shipmentStatus(ids.s2)).toBe('IN_TRANSIT')
    expect(await shipmentStatus(ids.loose)).toBe('IN_TRANSIT')
    expect(await planStatus(ids.shipped)).toBe('SHIPPED')
    const shippedEvents = await events(ids.shipped)
    expect(shippedEvents).toHaveLength(2)
    expect(shippedEvents[0]).toEqual({ planId: ids.shipped, status: 'SHIPPED', step: 'TRACKING', productIds: [ids.a, ids.b] })
    // Amazon shows the READY_TO_SHIP plan's shipment shipped (not marked in Nexus): the plan keeps its status.
    expect(await shipmentStatus(ids.s3)).toBe('SHIPPED')
    expect(await planStatus(ids.ready)).toBe('READY_TO_SHIP')
    expect((await events(ids.ready)).map(e => e.status)).toEqual(['READY_TO_SHIP'])
  })

  it('every shipment at Amazon → AT_AMAZON; every one closed → CLOSED, each with its event', async () => {
    amazon.statuses = { ...amazon.statuses, FBA15TEST002: 'CHECKED_IN' }
    await inside(() => runFbaStatusPoll())
    expect(await planStatus(ids.shipped)).toBe('AT_AMAZON')
    expect((await events(ids.shipped)).at(-1)).toMatchObject({ status: 'AT_AMAZON' })

    amazon.statuses = { ...amazon.statuses, FBA15TEST001: 'CLOSED', FBA15TEST002: 'CLOSED' }
    await inside(() => runFbaStatusPoll())
    expect(await planStatus(ids.shipped)).toBe('CLOSED')
    expect((await events(ids.shipped)).map(e => e.status)).toEqual(['SHIPPED', 'SHIPPED', 'AT_AMAZON', 'AT_AMAZON', 'CLOSED'])
    // CLOSED shipments are not asked again.
    amazon.asked = []
    await inside(() => runFbaStatusPoll())
    expect(amazon.asked.flat()).not.toContain('FBA15TEST001')
  })

  it('a shipment of no plan publishes nothing', async () => {
    // Every fba.plan_changed belongs to one of the two plans: the loose shipment's moves published none.
    const all = await inside(() => db().eventOutbox.findMany({ where: { type: 'fba.plan_changed' } }))
    expect(new Set(all.map(e => e.subject))).toEqual(new Set([ids.shipped, ids.ready]))
    expect(all).toHaveLength((await events(ids.shipped)).length + (await events(ids.ready)).length)
    expect(await shipmentStatus(ids.loose)).toBe('IN_TRANSIT')
  })
})
