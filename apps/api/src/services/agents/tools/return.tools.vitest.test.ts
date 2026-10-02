/**
 * MCP full control 07 O12 — returns and refunds through the one door (call-tool.ts), on a real PostgreSQL with the
 * production schema and policies (PGlite). The channel refund is MOCKED (the publisher's call); nothing leaves the
 * machine.
 *
 *   create-return  — only a shipped order; never more units than a line has left; Amazon's orders refused; one return
 *                    per approval (run twice: one); undo rejects it while REQUESTED.
 *   update-return  — authorize / reject / receive / inspect / warranty; a step the return no longer allows is refused;
 *                    a return that moved after the approval is refused (stale); Amazon's returns refused.
 *   dispose-return-items — restock puts the graded units back (and scrap does not); refused before inspection, for an
 *                    ungraded item and for an FBA return (no stock moves); never auto.
 *   issue-refund   — capped at what is still refundable on the order; one refund per return; Amazon refunds "in Seller
 *                    Central"; Shopify only while its switch is live; a channel failure moves no money; stale refused;
 *                    needs orders.refund; never confirm or auto, cannot be undone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
const channel = vi.hoisted(() => ({ calls: [] as string[], fail: new Set<string>() }))
vi.mock('../../refunds/refund-publisher.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  publishRefundToChannel: vi.fn(async (input: { returnId: string }) => {
    channel.calls.push(input.returnId)
    return channel.fail.has(input.returnId) ? { outcome: 'FAILED', error: 'Test eBay refused' } : { outcome: 'OK', channelRefundId: `TEST-EBAY-REFUND-${channel.calls.length}` }
  }),
}))
vi.mock('../../credit-note.service.js', () => ({ assignCreditNoteNumber: vi.fn(async () => null) }))

import { callTool, executeTool, ToolAccessError, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const SECOND = 'test_o12_second_business'
const person = (permissions: string[], workspaceId = LEGACY_WORKSPACE_ID): UserPrincipal => ({
  kind: 'user', userId: 'u-o12', label: '07 O12 test', permissions: { isOwner: false, permissions: new Set(permissions) },
  workspace: { ...business, workspaceId }, via: 'claude',
})
const everything = person([...Object.values(FEATURES), ...Object.values(FIELDS)])
const inside = <T>(work: () => Promise<T>, workspaceId = LEGACY_WORKSPACE_ID) => withWorkspace({ ...business, workspaceId }, work)
type Out = { ok: boolean; error?: string; preview?: any; data?: any; change?: any }
const dryRun = async (tool: string, args: Record<string, unknown>, who = everything) => (await callTool(who, tool, args)).raw as Out
const run = async (tool: string, args: Record<string, unknown>, approvedPreview: unknown, approvalId?: string) =>
  (await executeTool(everything, tool, args, { approvedPreview, ...(approvalId ? { approvalId } : {}) })).raw as Out
/** Preview, then run with that preview approved. */
const approved = async (tool: string, args: Record<string, unknown>) => {
  const asked = await dryRun(tool, args)
  expect(asked.ok, asked.error).toBe(true)
  return run(tool, args, asked.preview)
}
let seq = 0
const order = (data: Record<string, unknown> = {}, workspaceId = LEGACY_WORKSPACE_ID) => inside(async () => {
  const n = ++seq
  const made = await database.client.order.create({
    data: {
      id: `test-o12-order-${n}`, channel: 'EBAY', channelOrderId: `TEST-O12-${n}`, marketplace: 'IT', status: 'DELIVERED', currencyCode: 'EUR', totalPrice: '50.00',
      customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: { city: 'Testville' }, fulfillmentMethod: 'MFN',
      items: { create: [{ id: `test-o12-line-${n}`, sku: 'TEST-SKU-1', ...(workspaceId === LEGACY_WORKSPACE_ID ? { productId: 'test-o12-product' } : {}), quantity: 2, price: '25.00' }] }, ...data,
    } as never,
  })
  return { orderId: made.id, lineId: `test-o12-line-${n}` }
}, workspaceId)
const aReturn = (orderId: string | null, data: Record<string, unknown> = {}, items: Array<Record<string, unknown>> = [{ sku: 'TEST-SKU-1', productId: 'test-o12-product', quantity: 1, conditionGrade: 'GOOD' }]) =>
  inside(async () => (await database.client.return.create({
    data: { orderId, channel: 'EBAY', rmaNumber: `TEST-O12-RMA-${++seq}`, status: 'INSPECTING', items: { create: items }, ...data } as never,
  })).id)
const statusOf = (id: string) => inside(async () => (await database.client.return.findUniqueOrThrow({ where: { id }, select: { status: true } })).status)
const stock = () => inside(async () => (await database.client.stockLevel.findMany({ where: { productId: 'test-o12-product' }, select: { quantity: true } })).reduce((n, l) => n + l.quantity, 0))

beforeAll(async () => {
  database = await formulaDatabase()
  await database.client.workspace.create({ data: { id: SECOND, name: 'Second test business', createdByUserId: 'test', creationKey: 'test-o12-second' } })
  await inside(async () => {
    await database.client.warehouse.create({ data: { id: 'test-o12-wh', code: 'TEST-O12-WH', name: 'Test warehouse', isDefault: true, addressLine1: 'Via Magazzino 1', city: 'Testville', postalCode: '00100', country: 'IT' } as never })
    await database.client.stockLocation.create({ data: { id: 'test-o12-loc', code: 'TEST-O12-LOC', name: 'Test warehouse', type: 'WAREHOUSE', warehouseId: 'test-o12-wh' } as never })
    await database.client.product.create({ data: { id: 'test-o12-product', sku: 'TEST-SKU-1', name: 'Test jacket', basePrice: 25, costPrice: 10, totalStock: 0, fulfillmentMethod: 'FBM' } as never })
  })
}, 180_000)
afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('create-return (07 O12)', () => {
  it('opens a REQUESTED return of a shipped order, once per approval (two runs at once: one return); undo rejects it', async () => {
    const { orderId, lineId } = await order()
    const args = { orderId, items: [{ orderItemId: lineId, quantity: 1 }], reason: 'Too small' }
    const asked = await dryRun('create-return', args)
    expect(asked.preview).toMatchObject({ order: { channelOrderId: expect.stringMatching(/^TEST-O12-/), status: 'DELIVERED' }, items: [{ sku: 'TEST-SKU-1', quantity: 1, ordered: 2, alreadyReturned: 0 }] })
    const [first, twin] = await Promise.all([run('create-return', args, asked.preview, 'test-approval-o12-1'), run('create-return', args, asked.preview, 'test-approval-o12-1')])
    expect(first.ok, first.error).toBe(true)
    expect(twin.ok, twin.error).toBe(true)
    expect(twin.data.returnId).toBe(first.data.returnId)
    // Run again later: the order's line now has a unit in a return, so the approval no longer describes it.
    expect((await run('create-return', args, asked.preview, 'test-approval-o12-1')).error).toMatch(/^Not changed: the order changed since you approved it \(items\)/)
    expect(await inside(() => database.client.return.count({ where: { orderId } }))).toBe(1)
    expect(getTool('create-return')!.undo!.request(first.change)).toEqual({ tool: 'update-return', args: { returns: [{ returnId: first.data.returnId, action: 'reject' }] } })
  })

  it('refuses an order that has not shipped, Amazon\'s orders, more units than are left, and another business\'s order', async () => {
    const pending = await order({ status: 'PROCESSING' })
    expect((await dryRun('create-return', { orderId: pending.orderId, items: [{ orderItemId: pending.lineId, quantity: 1 }] })).error).toMatch(/is PROCESSING: only an order that has shipped/)
    const fba = await order({ channel: 'AMAZON', fulfillmentMethod: 'FBA' })
    expect((await dryRun('create-return', { orderId: fba.orderId, items: [{ orderItemId: fba.lineId, quantity: 1 }] })).error).toMatch(/Amazon ships it .* Amazon handles its returns/)
    const partly = await order()
    await aReturn(partly.orderId, { status: 'RECEIVED' }, [{ sku: 'TEST-SKU-1', orderItemId: partly.lineId, quantity: 1 }])
    expect((await dryRun('create-return', { orderId: partly.orderId, items: [{ orderItemId: partly.lineId, quantity: 2 }] })).error).toMatch(/2 units asked, 1 of its 2 not yet in a return/)
    const other = await order({}, SECOND)
    expect(await dryRun('create-return', { orderId: other.orderId, items: [{ orderItemId: other.lineId, quantity: 1 }] })).toEqual({ ok: false, error: 'Order not found' })
  })
})

describe('update-return (07 O12)', () => {
  it('authorize, receive, inspect and the warranty diagnosis; undo puts the diagnosis back', async () => {
    const { orderId } = await order()
    const id = await aReturn(orderId, { status: 'REQUESTED', returnType: 'WARRANTY', warrantyStatus: 'PENDING_DIAGNOSIS' }, [{ id: 'test-o12-item-w', sku: 'TEST-SKU-1', productId: 'test-o12-product', quantity: 1 }])
    expect((await approved('update-return', { returns: [{ returnId: id, action: 'authorize' }] })).ok).toBe(true)
    expect(await statusOf(id)).toBe('AUTHORIZED')
    expect((await approved('update-return', { returns: [{ returnId: id, action: 'receive', warehouseId: 'test-o12-wh' }] })).ok).toBe(true)
    expect(await inside(() => database.client.stockMovement.findMany({ where: { referenceId: id }, select: { reason: true, change: true } }))).toEqual([{ reason: 'RETURN_RECEIVED', change: 0 }])
    expect((await approved('update-return', { returns: [{ returnId: id, action: 'inspect', items: [{ itemId: 'test-o12-item-w', grade: 'LIKE_NEW' }] }] })).ok).toBe(true)
    expect(await inside(() => database.client.returnItem.findUnique({ where: { id: 'test-o12-item-w' }, select: { conditionGrade: true, disposition: true } }))).toEqual({ conditionGrade: 'LIKE_NEW', disposition: 'SELLABLE' })
    const diagnosed = await approved('update-return', { returns: [{ returnId: id, action: 'warranty', warrantyStatus: 'DIAGNOSED', manufacturerRef: 'TEST-MREF' }] })
    expect(diagnosed.ok).toBe(true)
    const undo = getTool('update-return')!.undo!.request(diagnosed.change)
    expect(undo).toEqual({ tool: 'update-return', args: { returns: [{ returnId: id, action: 'warranty', warrantyStatus: 'PENDING_DIAGNOSIS', warrantyResolution: null, manufacturerRef: null }] } })
    expect((await approved('update-return', (undo as { args: Record<string, unknown> }).args)).ok).toBe(true)
    expect(await inside(() => database.client.return.findUnique({ where: { id }, select: { status: true, warrantyStatus: true, manufacturerRef: true } }))).toEqual({ status: 'INSPECTING', warrantyStatus: 'PENDING_DIAGNOSIS', manufacturerRef: null })
  })

  it('refuses a step the return no longer allows, a return that moved after the approval, and Amazon\'s returns', async () => {
    const { orderId } = await order()
    const id = await aReturn(orderId, { status: 'REQUESTED' })
    const asked = await dryRun('update-return', { returns: [{ returnId: id, action: 'authorize' }] })
    await inside(() => database.client.return.update({ where: { id }, data: { status: 'REJECTED' } }))
    expect((await run('update-return', { returns: [{ returnId: id, action: 'authorize' }] }, asked.preview)).error).toMatch(/it is REJECTED; only a REQUESTED return/)
    const received = await aReturn(orderId, { status: 'AUTHORIZED' })
    const askedReceive = await dryRun('update-return', { returns: [{ returnId: received, action: 'receive' }] })
    await inside(() => database.client.return.update({ where: { id: received }, data: { status: 'IN_TRANSIT' } }))
    expect((await run('update-return', { returns: [{ returnId: received, action: 'receive' }] }, askedReceive.preview)).error).toMatch(/^Not changed: a return changed since you approved it \(returns\)/)
    expect((await dryRun('update-return', { returns: [{ returnId: received, action: 'warranty', warrantyStatus: 'DIAGNOSED' }] })).error).toMatch(/a STANDARD return; only a WARRANTY or DEFECT return/)
    const fba = await aReturn((await order({ channel: 'AMAZON', fulfillmentMethod: 'FBA' })).orderId, { status: 'REQUESTED', channel: 'AMAZON', isFbaReturn: true })
    expect((await dryRun('update-return', { returns: [{ returnId: fba, action: 'authorize' }] })).error).toMatch(/is Amazon's: Nexus mirrors it read-only/)
  })
})

describe('dispose-return-items (07 O12)', () => {
  it('restock puts the graded units back; scrap does not; both close the return', async () => {
    const before = await stock()
    const { orderId } = await order()
    const restock = await aReturn(orderId, {}, [
      { sku: 'TEST-SKU-1', productId: 'test-o12-product', quantity: 1, conditionGrade: 'GOOD' },
      { sku: 'TEST-SKU-1', productId: 'test-o12-product', quantity: 1, conditionGrade: 'DAMAGED' },
    ])
    const scrap = await aReturn(orderId)
    const args = { returns: [{ returnId: restock, action: 'restock' }, { returnId: scrap, action: 'scrap' }] }
    const asked = await dryRun('dispose-return-items', args)
    expect(asked.preview).toMatchObject({ unitsBackInStock: 1, returns: [{ to: 'RESTOCKED', warehouse: 'TEST-O12-WH', items: [{ outcome: 'back in stock' }, { outcome: 'skipped: DAMAGED' }] }, { to: 'SCRAPPED' }] })
    const done = await run('dispose-return-items', args, asked.preview)
    expect(done.ok, done.error).toBe(true)
    expect(await stock()).toBe(before + 1)
    expect([await statusOf(restock), await statusOf(scrap)]).toEqual(['RESTOCKED', 'SCRAPPED'])
  })

  it('refused before inspection, for an ungraded item and for an FBA return — no stock moves; it always waits for a person', async () => {
    const before = await stock()
    const { orderId } = await order()
    const received = await aReturn(orderId, { status: 'RECEIVED' })
    expect((await dryRun('dispose-return-items', { returns: [{ returnId: received, action: 'restock' }] })).error).toMatch(/it is RECEIVED; a return is restocked or scrapped once inspected/)
    const ungraded = await aReturn(orderId, {}, [{ sku: 'TEST-SKU-1', productId: 'test-o12-product', quantity: 1 }])
    expect((await dryRun('dispose-return-items', { returns: [{ returnId: ungraded, action: 'restock' }] })).error).toMatch(/grade TEST-SKU-1 first/)
    const fba = await aReturn((await order({ channel: 'AMAZON', fulfillmentMethod: 'FBA' })).orderId, { channel: 'AMAZON' })
    expect((await dryRun('dispose-return-items', { returns: [{ returnId: fba, action: 'restock' }] })).error).toMatch(/Amazon keeps the units/)
    expect(await stock()).toBe(before)
    expect(getTool('dispose-return-items')).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', reversibility: 'none' })
  })
})

describe('issue-refund (07 O12)', () => {
  it('refunds through eBay (mocked) within what is still refundable, once per return, and publishes refund.issued', async () => {
    const { orderId } = await order()
    const first = await aReturn(orderId)
    const second = await aReturn(orderId)
    const asked = await dryRun('issue-refund', { returnId: first, amount: 30, reason: 'Item damaged' })
    expect(asked.preview).toMatchObject({
      refund: { amount: 30, currencyCode: 'EUR' }, refundable: { paid: 50, refunded: 0, leftAfter: 20 },
      channelRefund: expect.stringMatching(/^live: eBay refunds the buyer at once/), note: expect.stringMatching(/30\.00 EUR leaves your account/),
    })
    channel.calls.length = 0
    const done = await run('issue-refund', { returnId: first, amount: 30, reason: 'Item damaged' }, asked.preview)
    expect(done.ok, done.error).toBe(true)
    expect(done.data).toMatchObject({ channelOutcome: 'OK', returnStatus: 'REFUNDED' })
    expect(channel.calls).toEqual([first])
    expect((await dryRun('issue-refund', { returnId: first, amount: 1 })).error).toMatch(/it has a refund already \(POSTED\); one refund per return/)
    expect((await dryRun('issue-refund', { returnId: second, amount: 20.01 })).error).toMatch(/20\.01 EUR is more than is still refundable on the order: 20\.00 EUR \(paid 50\.00, refunded 30\.00\)/)
    expect((await dryRun('issue-refund', { returnId: second, amount: 20 })).ok).toBe(true)
    const events = await inside(() => database.client.eventOutbox.findMany({ where: { type: 'refund.issued' } }))
    expect(events.map((e) => e.payload)).toContainEqual({ refundId: done.data.refundId, returnId: first, orderId, channel: 'EBAY', outcome: 'OK' })
  })

  it('stale: another refund of the order after the approval refuses the run, and nothing is sent', async () => {
    const { orderId } = await order()
    const a = await aReturn(orderId)
    const b = await aReturn(orderId)
    const asked = await dryRun('issue-refund', { returnId: a, amount: 10 })
    expect((await approved('issue-refund', { returnId: b, amount: 10 })).ok).toBe(true)
    channel.calls.length = 0
    expect((await run('issue-refund', { returnId: a, amount: 10 }, asked.preview)).error).toMatch(/^Not changed: the return changed since you approved it \(refundable\)/)
    expect(channel.calls).toEqual([])
  })

  it('a channel failure moves no money and says so', async () => {
    const id = await aReturn((await order()).orderId)
    channel.fail.add(id)
    const failed = await approved('issue-refund', { returnId: id, amount: 5 })
    expect(failed.ok).toBe(false)
    expect(failed.error).toMatch(/^The channel refused the refund: Test eBay refused\. No money moved/)
  })

  it('Amazon "in Seller Central"; Shopify only while its switch is live; Etsy not wired; a return without an order', async () => {
    const amazon = await aReturn((await order({ channel: 'AMAZON', fulfillmentMethod: 'FBM' })).orderId, { channel: 'AMAZON' })
    expect((await dryRun('issue-refund', { returnId: amazon, amount: 5 })).error).toMatch(/an Amazon refund is made in Seller Central/)
    const shopify = await aReturn((await order({ channel: 'SHOPIFY' })).orderId, { channel: 'SHOPIFY' })
    expect((await dryRun('issue-refund', { returnId: shopify, amount: 5 })).error).toMatch(/Shopify refunds are a dry run here \(NEXUS_ENABLE_SHOPIFY_REFUND off\)/)
    vi.stubEnv('NEXUS_ENABLE_SHOPIFY_REFUND', 'true')
    expect((await dryRun('issue-refund', { returnId: shopify, amount: 5 })).preview.channelRefund).toMatch(/^live: Shopify refunds the buyer/)
    vi.unstubAllEnvs()
    const etsy = await aReturn((await order({ channel: 'ETSY' })).orderId, { channel: 'ETSY' })
    expect((await dryRun('issue-refund', { returnId: etsy, amount: 5 })).error).toMatch(/Nexus cannot refund on ETSY/)
    const loose = await aReturn(null)
    expect((await dryRun('issue-refund', { returnId: loose, amount: 5 })).error).toMatch(/it has no order/)
    expect((await dryRun('issue-refund', { returnId: loose, amount: 5.001 })).error).toMatch(/at most two decimals/)
  })

  it('needs orders.refund; never confirmed in Claude or auto; cannot be undone', async () => {
    const id = await aReturn((await order()).orderId)
    const noRefund = person(Object.values(FEATURES).filter((f) => f !== FEATURES.ordersRefund))
    await expect(callTool(noRefund, 'issue-refund', { returnId: id, amount: 5 })).rejects.toBeInstanceOf(ToolAccessError)
    expect(getTool('issue-refund')).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', reversibility: 'none', openWorld: true })
    expect(getTool('issue-refund')!.undo).toBeUndefined()
  })
})
