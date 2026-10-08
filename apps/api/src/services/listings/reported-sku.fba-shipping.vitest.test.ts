/**
 * S7 — the FBA paths that NAME an item to Amazon use the seller SKU Amazon knows it by in that market (the product's
 * main Amazon listing's own SKU, else the product SKU): plan-fba-shipment (the plan's msku), the FNSKU label lookup,
 * and Multi-Channel Fulfilment (never the source order line's eBay/Shopify SKU as such). Real SQL (PGlite with the
 * production schema and row-level security); Amazon (the FBA Inbound client, the FBA inventory read, the MCF adapter)
 * and the FBA holds are stubbed — nothing leaves the machine and no quantity is computed differently.
 *
 *   · parity: a product whose listing has no SKU of its own sends its product SKU, exactly as before; a product with NO
 *     Amazon listing in the plan's market is refused (Step 4: a Send to FBA plan never names an item Amazon does not list);
 *   · an own SKU in the market is sent; another account's listing is never used; no single SKU is refused, not guessed;
 *   · MCF with no Amazon listing in the fulfilling market sends the product's master SKU (never the source line's SKU);
 *     it is refused only when the SKU cannot be told (no single seller SKU, an unknown market).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property) }) }
})
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'disabled' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
const s = vi.hoisted(() => ({
  account: null as string | null,
  fnskuAsked: [] as string[][],
  fnsku: { PLAIN: 'X0PLAIN', 'OWNP-IT': 'X0OWNPIT', OWNP: 'X0OWNPMASTER', NOLIST: 'X0NOLIST' } as Record<string, string>,
  reserved: [] as Array<{ productId: string; quantity: number }>,
  released: 0,
  mcfItems: [] as any[],
}))
vi.mock('../../lib/amazon-sp-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/amazon-sp-client.js')>()),
  amazonAccount: vi.fn(async () => { if (!s.account) throw new Error('no Amazon account'); return { id: s.account } }),
}))
// Step 4 — plan-fba-shipment runs on the Send to FBA services (through their contract); the job that would reach
// Amazon (Part B's dispatchFbaPlan) is a spy.
vi.mock('../fba-inbound/contract.js', () => {
  class FbaSendError extends Error {
    constructor(readonly code: string, message: string, readonly problems: unknown[] = []) { super(message); this.name = 'FbaSendError' }
    get httpStatus() { return 400 }
  }
  const sendFn = (name: string) => async (...args: unknown[]) => ((await import('../fba-inbound/send.service.js')) as any)[name](...args)
  const readFn = (name: string) => async (...args: unknown[]) => ((await import('../fba-inbound/read.service.js')) as any)[name](...args)
  const draftFn = (name: string) => async (...args: unknown[]) => ((await import('../fba-inbound/draft.service.js')) as any)[name](...args)
  return {
    FbaSendError, dispatchFbaPlan: vi.fn(async () => 'inline'), readSendDraft: sendFn('readSendDraft'), createSendPlan: sendFn('createSendPlan'), readPlan: readFn('readPlan'), readPlans: readFn('readPlans'),
    addToDraft: draftFn('addToDraft'), sendDraft: draftFn('sendDraft'),
  }
})
vi.mock('../stock-movement.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stock-movement.service.js')>()),
  recascadeProduct: vi.fn(async () => ({ ok: true })),
}))
vi.mock('../fba-inbound.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fba-inbound.service.js')>()),
  isFbaInboundConfigured: async () => true,
  getInventoryFnskus: vi.fn(async (skus: string[]) => { s.fnskuAsked.push(skus); return Object.fromEntries(skus.filter(k => s.fnsku[k]).map(k => [k, s.fnsku[k]])) }),
}))
vi.mock('../stock-level.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stock-level.service.js')>()),
  resolveLocationByCode: async () => 'fba-location',
  reserveOpenOrder: vi.fn(async (input: { productId: string; quantity: number }) => { s.reserved.push({ productId: input.productId, quantity: input.quantity }); return { id: `hold-${s.reserved.length}` } }),
  releaseOpenOrder: vi.fn(async () => { s.released++ }),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const acc = { a: '', b: '' }
const pid: Record<string, string> = {}
const ADDRESS = { name: 'Test Sender', addressLine1: 'Via Test 1', city: 'Testville', stateOrProvinceCode: 'TS', postalCode: '00000', countryCode: 'IT' }
const DRAFT = { listingStatus: 'DRAFT', isPublished: false, externalListingId: null }

type Tool = import('../agents/tool-types.js').AgentTool
let planTool: Tool
const person = { userId: 'u-approver', can: () => true, via: 'claude' as const }
const plan = (lines: Array<{ productId: string; quantity: number }>, mode: 'handler' | 'execute' = 'handler') => {
  const args = planTool.input.parse({ marketplace: 'IT', lines, sourceAddress: ADDRESS, name: 'TEST plan' }) as Record<string, unknown>
  return inside(() => (mode === 'handler' ? planTool.handler(args, person) : planTool.execute!(args, person)))
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    const connection = (label: string) => db.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: label, externalAccountId: label, isActive: true } as never }).then(c => c.id)
    acc.a = await connection('s7-ship-a')
    acc.b = await connection('s7-ship-b')
    await db.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'TEST-MKT-IT' } as never })
    const product = async (sku: string, data: Record<string, unknown> = {}) => { pid[sku] = (await db.product.create({ data: { sku, name: sku, basePrice: '10.00', totalStock: 3, ...data } as never })).id }
    const listing = async (sku: string, data: Record<string, unknown> = {}, offers: string[] = []) => {
      const row = await db.channelListing.create({ data: { productId: pid[sku], channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT',
        channelConnectionId: acc.a, aliasKey: '', listingStatus: 'ACTIVE', isPublished: true, fulfillmentMethod: 'FBA', ...data } as never })
      for (const [i, sku] of offers.entries()) await db.offer.create({ data: { channelListingId: row.id, sku, fulfillmentMethod: i ? 'FBM' : 'FBA', isActive: true } })
    }
    await product('PLAIN'); await listing('PLAIN')
    await product('OWNP', { fnsku: 'X0OWNPMASTER' }); await listing('OWNP', { liveChannelSku: 'OWNP-IT' })
    await listing('OWNP', { aliasKey: 'extra-1', liveChannelSku: 'OWNP-EXTRA' })
    await product('DRAFTP'); await listing('DRAFTP', { ...DRAFT, channelSku: 'DRAFTP-NEW' })
    await product('TWO-OFF'); await listing('TWO-OFF', {}, ['TWO-A', 'TWO-B'])
    await product('MIXED'); await listing('MIXED'); await listing('MIXED', { channelConnectionId: acc.b, liveChannelSku: 'MIXED-ON-B' })
    await product('NOLIST')
  })
  const { getTool } = await import('../agents/tool-registry.js')
  planTool = getTool('plan-fba-shipment')!
}, 180_000)
afterAll(async () => { await database?.close() })

describe('plan-fba-shipment — the msku is the listing\'s seller SKU in the plan\'s market', () => {
  const planLines = (planId: string) => inside(() => database.client.fbaInboundPlanLine.findMany({ where: { planRowId: planId }, orderBy: { createdAt: 'asc' }, select: { msku: true, quantity: true } }))
  const plans = () => inside(() => database.client.fbaInboundPlanV2.count({ where: { source: 'claude', status: { not: 'DRAFT' } } }))
  /** A person's "Send to Amazon" on the draft Claude filled (the FBA shipments page). */
  const send = async (planId: string) => {
    const { sendDraft } = await import('../fba-inbound/draft.service.js')
    return inside(() => sendDraft(planId, {}, { actor: 'owner@example.test', userId: 'u-owner' }))
  }
  beforeAll(async () => {
    vi.stubEnv('NEXUS_ISSUER_NAME', '')
    vi.stubEnv('NEXUS_ISSUER_PHONE', '')
    // What a plan needs besides the SKU: a warehouse with an address, the company's name and phone, free units, owners, a unit weight.
    await inside(async () => {
      const db = database.client
      const warehouse = (await db.warehouse.create({ data: { code: 'S7-MAIN', name: 'Main', addressLine1: 'Via Test 1', city: 'Testville', postalCode: '00000', country: 'IT', isDefault: true } })).id
      const location = (await db.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'S7-MAIN', name: 'Main', warehouseId: warehouse } })).id
      await db.brandSettings.create({ data: { companyName: 'Test Company', contactPhone: '+39 000 000' } })
      for (const sku of ['PLAIN', 'OWNP', 'DRAFTP', 'TWO-OFF', 'MIXED', 'NOLIST']) {
        await db.product.update({ where: { id: pid[sku] }, data: { weightValue: '1', weightUnit: 'kg' } as never })
        await db.stockLevel.create({ data: { productId: pid[sku], locationId: location, quantity: 3, reserved: 0, available: 3 } })
        await db.productPackage.create({ data: { productId: pid[sku], fbaPrepOwner: 'SELLER', fbaLabelOwner: 'SELLER' } })
      }
    })
  })
  afterAll(() => { vi.unstubAllEnvs() })

  it('parity: a listing without its own SKU sends the product SKU, as before; no Amazon listing in the market is named before sending', async () => {
    s.account = acc.a
    const dry = await plan([{ productId: pid.PLAIN, quantity: 2 }])
    expect(dry, dry.error).toMatchObject({ ok: true, preview: { lines: [{ sku: 'PLAIN', quantity: 2, freeNow: 3 }] } })
    expect((dry.preview as any).lines[0]).not.toHaveProperty('productSku')
    expect(await plan([{ productId: pid.NOLIST, quantity: 1 }])).toMatchObject({ ok: true, preview: { beforeSending: ['NOLIST: no Amazon listing in IT.'] } })
  })

  it('an own SKU in the market is the msku, and the preview names the Nexus SKU beside it; a draft sends the SKU it will be published as', async () => {
    s.account = acc.a
    const dry = await plan([{ productId: pid.OWNP, quantity: 2 }, { productId: pid.DRAFTP, quantity: 1 }])
    expect(dry, dry.error).toMatchObject({ ok: true, preview: { lines: [{ sku: 'OWNP-IT', productSku: 'OWNP', quantity: 2 }, { sku: 'DRAFTP-NEW', productSku: 'DRAFTP', quantity: 1 }] } })
    const ran = await plan([{ productId: pid.OWNP, quantity: 2 }, { productId: pid.PLAIN, quantity: 2 }], 'execute')
    expect(ran, ran.error).toMatchObject({ ok: true, data: { planId: expect.any(String), draft: true } })
    const planId = (ran.data as { planId: string }).planId
    // A draft keeps no seller SKU: "Send to Amazon" reads it then.
    expect(await planLines(planId)).toEqual([{ msku: null, quantity: 2 }, { msku: null, quantity: 2 }])
    expect(await send(planId)).toEqual({ planId })
    expect(await planLines(planId)).toEqual([{ msku: 'OWNP-IT', quantity: 2 }, { msku: 'PLAIN', quantity: 2 }])
  })

  it('🔴 no single seller SKU: named with its sentence, and "Send to Amazon" is refused (nothing held, nothing sent); another account\'s listing is never used', async () => {
    s.account = acc.a
    const before = await plans()
    const dry = await plan([{ productId: pid['TWO-OFF'], quantity: 1 }])
    expect((dry.preview as any).beforeSending).toEqual(['TWO-OFF: its Amazon IT listing has more than one seller SKU on record (TWO-A, TWO-B). Nexus did not pick one: set the listing\'s own SKU first.'])
    const ran = await plan([{ productId: pid['TWO-OFF'], quantity: 1 }], 'execute')
    expect(ran, ran.error).toMatchObject({ ok: true, data: { draft: true } })
    await expect(send((ran.data as { planId: string }).planId)).rejects.toMatchObject({ code: 'REFUSED' })
    expect(await plans()).toBe(before)
    expect((await plan([{ productId: pid.MIXED, quantity: 1 }])).preview).toMatchObject({ lines: [{ sku: 'MIXED' }] })
    s.account = acc.b
    expect((await plan([{ productId: pid.MIXED, quantity: 1 }])).preview).toMatchObject({ lines: [{ sku: 'MIXED-ON-B', productSku: 'MIXED' }] })
  })
})

describe('FNSKU lookup — read for the seller SKU of the label\'s market', () => {
  const lookup = async (skus: string[]) => {
    const { lookupFnskus } = await import('../fnsku-lookup.service.js')
    return inside(() => lookupFnskus(skus, 'IT'))
  }
  it('parity: a product without its own SKU is read for its product SKU and the FNSKU is cached on the product, as before', async () => {
    s.account = acc.a; s.fnskuAsked.length = 0
    const [plain] = await lookup(['PLAIN'])
    expect(plain).toMatchObject({ sku: 'PLAIN', fnsku: 'X0PLAIN' })
    expect(plain).not.toHaveProperty('error')
    expect(s.fnskuAsked).toEqual([['PLAIN']])
    expect((await inside(() => database.client.product.findUniqueOrThrow({ where: { id: pid.PLAIN }, select: { fnsku: true } }))).fnsku).toBe('X0PLAIN')
  })
  it('an own SKU in the market is read live for that SKU; the product\'s cached FNSKU (its master SKU\'s) is neither used nor overwritten', async () => {
    s.account = acc.a; s.fnskuAsked.length = 0
    const [ownp] = await lookup(['OWNP'])
    expect(ownp).toMatchObject({ sku: 'OWNP', fnsku: 'X0OWNPIT' })
    expect(s.fnskuAsked).toEqual([['OWNP-IT']])
    expect((await inside(() => database.client.product.findUniqueOrThrow({ where: { id: pid.OWNP }, select: { fnsku: true } }))).fnsku).toBe('X0OWNPMASTER')
  })
  it('🔴 no single seller SKU: an error with the sentence, no FNSKU, nothing read', async () => {
    s.account = acc.a; s.fnskuAsked.length = 0
    const [two] = await lookup(['TWO-OFF'])
    expect(two).toMatchObject({ sku: 'TWO-OFF', fnsku: null, error: expect.stringContaining('more than one seller SKU on record (TWO-A, TWO-B)') })
    expect(s.fnskuAsked).toEqual([])
  })
})

describe('MCF — Amazon is told the seller SKU it holds the item under in the fulfilling market', () => {
  const adapter = {
    createFulfillmentOrder: vi.fn(async (args: any) => { s.mcfItems.push(args.items.map((i: any) => ({ sellerSku: i.sellerSku, quantity: i.quantity }))); return { amazonFulfillmentOrderId: `FO-${Math.random()}`, raw: {} } }),
    getFulfillmentOrder: vi.fn(), cancelFulfillmentOrder: vi.fn(),
  }
  let n = 0
  const order = (lines: Array<{ sku: string; productSku?: string; quantity: number }>) => inside(async () => {
    const created = await database.client.order.create({ data: { channel: 'EBAY', channelOrderId: `S7-MCF-${++n}`, totalPrice: '20.00', customerName: 'Buyer', customerEmail: 'buyer@example.test',
      shippingAddress: { name: 'Buyer', addressLine1: 'Via Roma 1', city: 'Rimini', postalCode: '47921', countryCode: 'IT' } } as never })
    for (const [i, line] of lines.entries()) {
      await database.client.orderItem.create({ data: { orderId: created.id, productId: pid[line.productSku ?? line.sku] ?? null, sku: line.sku, quantity: line.quantity, price: '10.00', externalLineItemId: `${created.id}-${i}` } as never })
    }
    return created.id
  })
  const ship = async (orderId: string, extra: Record<string, unknown> = {}) => {
    const { createMCFShipment } = await import('../amazon-mcf.service.js')
    return inside(() => createMCFShipment(adapter, { orderId, ...extra }))
  }
  const reset = () => { s.mcfItems.length = 0; s.reserved.length = 0; s.released = 0 }

  it('parity: an order line whose product\'s listing has no own SKU sends that SKU; the FBA holds are the order\'s units, as before', async () => {
    s.account = acc.a; reset()
    await ship(await order([{ sku: 'PLAIN', quantity: 2 }]))
    expect(s.mcfItems).toEqual([[{ sellerSku: 'PLAIN', quantity: 2 }]])
    expect(s.reserved).toEqual([{ productId: pid.PLAIN, quantity: 2 }])
  })

  it('an own SKU in the fulfilling market is sent; an eBay line with its own SKU is named by its product (it used to be "unknown SKU")', async () => {
    s.account = acc.a; reset()
    await ship(await order([{ sku: 'OWNP', quantity: 1 }, { sku: 'EBAY-OWN-77', productSku: 'OWNP', quantity: 2 }, { sku: 'MIXED', quantity: 1 }]))
    expect(s.mcfItems).toEqual([[{ sellerSku: 'OWNP-IT', quantity: 1 }, { sellerSku: 'OWNP-IT', quantity: 2 }, { sellerSku: 'MIXED', quantity: 1 }]])
    expect(s.reserved).toEqual([{ productId: pid.OWNP, quantity: 3 }, { productId: pid.MIXED, quantity: 1 }])
  })

  it('no Amazon listing in the fulfilling market → the product\'s master SKU, never the source line\'s own SKU; the holds are the order\'s units', async () => {
    s.account = acc.a; reset()
    await ship(await order([{ sku: 'NOLIST', quantity: 1 }, { sku: 'EBAY-NOLIST-9', productSku: 'NOLIST', quantity: 2 }]))
    expect(s.mcfItems).toEqual([[{ sellerSku: 'NOLIST', quantity: 1 }, { sellerSku: 'NOLIST', quantity: 2 }]])
    expect(s.reserved).toEqual([{ productId: pid.NOLIST, quantity: 3 }])
  })

  it('🔴 the SKU cannot be told (no single seller SKU, an unknown market): refused before anything is held or sent', async () => {
    s.account = acc.a; reset()
    await expect(ship(await order([{ sku: 'TWO-OFF', quantity: 1 }]))).rejects.toThrow(
      'createMCFShipment: TWO-OFF: its Amazon IT listing has more than one seller SKU on record (TWO-A, TWO-B). Nexus did not pick one: set the listing\'s own SKU first. Multi-Channel Fulfilment could ship the wrong item, so nothing was sent.')
    await expect(ship(await order([{ sku: 'PLAIN', quantity: 1 }]), { marketplaceId: 'NOT-A-MARKET' })).rejects.toThrow(/NOT-A-MARKET is not a market Nexus knows/)
    expect(s.reserved).toEqual([])
    expect(s.mcfItems).toEqual([])
  })

  it('an unknown SKU with no product is still "unknown SKU" (the holds are released as before)', async () => {
    s.account = acc.a; reset()
    await expect(ship(await order([{ sku: 'NOBODY', quantity: 1 }]))).rejects.toThrow('createMCFShipment: unknown SKU NOBODY')
    expect(s.released).toBe(1)
  })
})
