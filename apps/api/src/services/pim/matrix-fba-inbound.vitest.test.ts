/**
 * Step 4 (Send to FBA), Part D — the Matrix read carries "Inbound +N" (`MatrixRowRead.fbaInbound`) and the family's open
 * plans (`MatrixRead.fbaPlans`).
 *
 * The real Matrix read over a real PostgreSQL in-process (PGlite). Amazon's side is the FBA sweep's INBOUND rows
 * (`FbaInventoryDetail`, fulfilment centre 'ALL', `rawData = { working, shipped, receiving }`); Nexus's side is the open
 * Send-to-FBA plan lines (`FbaInboundPlanLine`, quantity − shippedQuantity; `sent` = shippedQuantity of plans still
 * SHIPPED). The FBA number (`fba`) stays Amazon's fulfillable units: inbound is shown next to it, never added to it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => undefined) }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { getMatrixRead } from './matrix.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const IT = 'APJ6JRA9NG5V4'
const DE = 'A1PA6795UKMFR9'
const T0 = new Date('2026-10-07T08:00:00.000Z')
const T1 = new Date('2026-10-07T10:00:00.000Z')
const T2 = new Date('2026-10-07T10:15:00.000Z')

async function inbound(sku: string, productId: string | null, at: Date, b: { working?: number; shipped?: number; receiving?: number }, where: { marketplaceId?: string; fc?: string } = {}) {
  const working = b.working ?? 0, shipped = b.shipped ?? 0, receiving = b.receiving ?? 0
  await prisma.fbaInventoryDetail.create({ data: {
    productId, sku, marketplaceId: where.marketplaceId ?? IT, fulfillmentCenterId: where.fc ?? 'ALL', condition: 'INBOUND',
    quantity: working + shipped + receiving, rawData: { working, shipped, receiving }, lastSyncedAt: at,
  } })
}
async function plan(id: string, status: string, createdAt: Date, lines: Array<[productId: string, quantity: number, shipped: number]>, extra: { name?: string | null; source?: string | null } = {}) {
  await prisma.fbaInboundPlanV2.create({ data: { id, name: extra.name === undefined ? `Nexus IT 2026-10-08 #${id.slice(-6)}` : extra.name, status, source: extra.source === undefined ? 'matrix' : extra.source, createdAt } })
  for (const [productId, quantity, shippedQuantity] of lines) {
    await prisma.fbaInboundPlanLine.create({ data: { planRowId: id, productId, msku: productId.toUpperCase(), quantity, shippedQuantity, prepOwner: 'SELLER', labelOwner: 'SELLER' } })
  }
}

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'eBay IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  await prisma.product.create({ data: { id: 'fi-parent', sku: 'TEST-SKU-FI-P', name: 'Inbound parent', basePrice: 10, isParent: true } })
  for (const [id, sku] of [['fi-red', 'TEST-SKU-FI-RED'], ['fi-blue', 'TEST-SKU-FI-BLUE'], ['fi-green', 'TEST-SKU-FI-GREEN']] as const) {
    await prisma.product.create({ data: { id, sku, name: sku, basePrice: 10, parentId: 'fi-parent' } })
  }
  await prisma.product.create({ data: { id: 'fi-solo', sku: 'TEST-SKU-FI-SOLO', name: 'Solo', basePrice: 10 } })
  await prisma.product.create({ data: { id: 'fi-none', sku: 'TEST-SKU-FI-NONE', name: 'Nothing inbound', basePrice: 10 } })
  await prisma.product.create({ data: { id: 'fi-other', sku: 'TEST-SKU-FI-OTHER', name: 'Another product', basePrice: 10 } })
  await prisma.product.create({ data: { id: 'fi-sent', sku: 'TEST-SKU-FI-SENT', name: 'Shipped, Amazon not read yet', basePrice: 10 } })
  await prisma.product.create({ data: { id: 'fi-arrived', sku: 'TEST-SKU-FI-ARRIVED', name: 'At Amazon', basePrice: 10 } })
  await prisma.product.create({ data: { id: 'fi-part', sku: 'TEST-SKU-FI-PART', name: 'One of two shipments marked', basePrice: 10 } })

  // Amazon's fulfillable FBA number for red: 92 (the FBA qty cell's value).
  const fba = await prisma.stockLocation.create({ data: { type: 'AMAZON_FBA', code: 'AMAZON-EU-FBA', name: 'Amazon FBA (test)' } })
  await prisma.stockLevel.create({ data: { productId: 'fi-red', locationId: fba.id, quantity: 92, reserved: 0, available: 92 } })

  // Red: two seller SKUs in IT (the master SKU and its own listing SKU) add up; an older DE read of the same pool is not
  // counted a second time; a per-fulfilment-centre row is not the sweep's.
  await inbound('TEST-SKU-FI-RED', 'fi-red', T1, { working: 12, shipped: 12 })
  await inbound('FI-RED-OWN', 'fi-red', T2, { receiving: 3 })
  await inbound('TEST-SKU-FI-RED', 'fi-red', T0, { working: 50 }, { marketplaceId: DE })
  await inbound('TEST-SKU-FI-RED', 'fi-red', T2, { shipped: 40 }, { fc: 'MXP6' })
  // Blue: a row the sweep could not attribute (no product), under the member's SKU → blue's.
  await inbound('TEST-SKU-FI-BLUE', null, T2, { working: 5 })
  // A row that names ANOTHER product is never green's, even under green's SKU.
  await inbound('TEST-SKU-FI-GREEN', 'fi-other', T2, { working: 77 })

  await plan('plan-older-a1b2c3', 'WAITING_FOR_CHOICE', T0, [['fi-red', 10, 0], ['fi-green', 6, 0]])
  await plan('plan-newer-d4e5f6', 'SHIPPED', T1, [['fi-red', 8, 8], ['fi-blue', 4, 1]], { name: null })
  await plan('plan-cancelled-111111', 'CANCELLED', T2, [['fi-red', 100, 0]])
  await plan('plan-closed-222222', 'CLOSED', T2, [['fi-blue', 30, 30]])
  await plan('plan-wizard-333333', 'DRAFT', T2, [['fi-green', 50, 0]], { source: null }) // an older wizard plan: not this vocabulary
  await plan('plan-solo-444444', 'READY_TO_SHIP', T2, [['fi-solo', 7, 0]])
  // "Mark shipped" (Owner 2026-10-07): a SHIPPED plan with no Amazon row yet → sent; an AT_AMAZON plan → Amazon's only.
  await plan('plan-sent-555555', 'SHIPPED', T2, [['fi-sent', 21, 21]])
  await plan('plan-arrived-666666', 'AT_AMAZON', T2, [['fi-arrived', 9, 9]])
  // Two shipments, one marked Shipped: the plan stays READY_TO_SHIP until the last one — its shipped units still count.
  await plan('plan-part-777777', 'READY_TO_SHIP', T2, [['fi-part', 10, 4]])
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

describe('the Matrix read carries "Inbound +N" and the open plans', () => {
  it('each variation: Amazon\'s inbound (working / shipped / receiving, one marketplace, ALL rows only) + units in open plans not shipped yet; the parent sums its variations; the FBA number is untouched', () => scoped(async () => {
    const read = await getMatrixRead({ productId: 'fi-red', canEditPrice: true })
    const row = (id: string) => read.rows.find((r) => r.id === id)!
    // `sent` = units marked Shipped in plans still SHIPPED (plan-newer: red 8, blue 1); the parent sums them (9).
    expect(row('fi-red').fbaInbound).toEqual({ units: 27, working: 12, shipped: 12, receiving: 3, readAt: T1.toISOString(), planned: 10, sent: 8 })
    expect(row('fi-blue').fbaInbound).toEqual({ units: 5, working: 5, shipped: 0, receiving: 0, readAt: T2.toISOString(), planned: 3, sent: 1 })
    expect(row('fi-green').fbaInbound).toEqual({ units: 0, working: 0, shipped: 0, receiving: 0, readAt: null, planned: 6, sent: 0 })
    expect(row('fi-parent').fbaInbound).toEqual({ units: 32, working: 17, shipped: 12, receiving: 3, readAt: T1.toISOString(), planned: 19, sent: 9 })
    // 🔴 The FBA number stays Amazon's fulfillable units: inbound is never added to it.
    expect(row('fi-red').fba).toMatchObject({ units: 92 })
    expect(row('fi-blue').fba).toBeNull()
    // Plain JSON on the wire.
    expect(JSON.parse(JSON.stringify(row('fi-parent').fbaInbound))).toEqual(row('fi-parent').fbaInbound)
  }))

  it('fbaPlans: the family\'s open plans, newest first, with this family\'s units; closed, cancelled, wizard-era and other families\' plans are not listed', () => scoped(async () => {
    const read = await getMatrixRead({ productId: 'fi-green', canEditPrice: true })
    expect(read.fbaPlans).toEqual([
      { id: 'plan-newer-d4e5f6', name: '#d4e5f6', status: 'SHIPPED', units: 12 },
      { id: 'plan-older-a1b2c3', name: 'Nexus IT 2026-10-08 #a1b2c3', status: 'WAITING_FOR_CHOICE', units: 16 },
    ])
  }))

  it('a standalone product reads its own; nothing inbound and nothing planned → null and no plans', () => scoped(async () => {
    const solo = await getMatrixRead({ productId: 'fi-solo', canEditPrice: true })
    expect(solo.rows[0]!.fbaInbound).toEqual({ units: 0, working: 0, shipped: 0, receiving: 0, readAt: null, planned: 7, sent: 0 })
    expect(solo.fbaPlans).toEqual([{ id: 'plan-solo-444444', name: 'Nexus IT 2026-10-08 #444444', status: 'READY_TO_SHIP', units: 7 }])
    const none = await getMatrixRead({ productId: 'fi-none', canEditPrice: true })
    expect(none.rows[0]!.fbaInbound).toBeNull()
    expect(none.fbaPlans).toEqual([])
  }))
})

describe('"Mark shipped" shows at once: `sent` (Owner 2026-10-07)', () => {
  it('a SHIPPED plan with no Amazon row yet: its shipped units are `sent` (not null, though nothing inbound or planned)', () => scoped(async () => {
    const read = await getMatrixRead({ productId: 'fi-sent', canEditPrice: true })
    expect(read.rows[0]!.fbaInbound).toEqual({ units: 0, working: 0, shipped: 0, receiving: 0, readAt: null, planned: 0, sent: 21 })
  }))

  it('a plan with one of two shipments marked (still READY_TO_SHIP): the marked units are `sent`, the rest planned', () => scoped(async () => {
    const read = await getMatrixRead({ productId: 'fi-part', canEditPrice: true })
    expect(read.rows[0]!.fbaInbound).toEqual({ units: 0, working: 0, shipped: 0, receiving: 0, readAt: null, planned: 6, sent: 4 })
  }))

  it('an AT_AMAZON plan counts no `sent` (Amazon is receiving: its number only); nothing left → null', () => scoped(async () => {
    const read = await getMatrixRead({ productId: 'fi-arrived', canEditPrice: true })
    expect(read.rows[0]!.fbaInbound).toBeNull()
    expect(read.fbaPlans).toEqual([{ id: 'plan-arrived-666666', name: 'Nexus IT 2026-10-08 #666666', status: 'AT_AMAZON', units: 9 }])
  }))
})
