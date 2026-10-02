/**
 * MCP full control 07 O7 — `update-order`, `update-customer`, `triage-reviews` through the one door (call-tool.ts):
 * the dry run (`callTool`) and the run a person's approval starts (`executeTool` with the approved preview), on a real
 * PostgreSQL with the production schema and policies (PGlite).
 *
 *   - each writes through the service its Nexus page uses; nothing reaches the buyer or a channel
 *   - undo round trip: the recorded change, `undo.current` equals what it wrote, and the undo request (run through the
 *     same tool) puts every part back; a delivered mark is refused, not undone
 *   - stale refused: a change whose preview moved after the approval does not run, and nothing changes
 *   - limits (update-customer, triage-reviews): inside → null; outside → the reason a person is asked
 *   - refusals: unknown tag, a final order, the bin, another business, without the permission
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

import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'
import type { ToolChange } from '../tool-types.js'

const SECOND = 'test_o7_second_business'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const principal = (permissions: string[], workspaceId = LEGACY_WORKSPACE_ID): UserPrincipal => ({
  kind: 'user', userId: 'u-o7', label: '07 O7 test', permissions: { isOwner: false, permissions: new Set(permissions) },
  workspace: business(workspaceId), via: 'claude',
})
const everything = principal([...Object.values(FEATURES), ...Object.values(FIELDS)])
const inside = <T>(work: () => Promise<T>) => withWorkspace(business(LEGACY_WORKSPACE_ID), work)
type Out = { ok: boolean; error?: string; preview?: any; data?: any; change?: ToolChange }
const dryRun = async (tool: string, args: Record<string, unknown>) => (await callTool(everything, tool, args)).raw as Out
/** The run a person's approval starts: the stored preview goes with it. */
const run = async (tool: string, args: Record<string, unknown>, approvedPreview: unknown) =>
  (await executeTool(everything, tool, args, { approvedPreview })).raw as Out
/** Asks, approves what it showed, runs. */
async function approveAndRun(tool: string, args: Record<string, unknown>) {
  const asked = await dryRun(tool, args)
  expect(asked.ok, asked.error).toBe(true)
  const done = await run(tool, args, asked.preview)
  expect(done.ok, done.error).toBe(true)
  return done
}
/** The undo of a change: what is stored now must be what it wrote; then its request is asked, approved and run. */
async function undo(tool: string, change: ToolChange) {
  const definition = getTool(tool)!
  expect(await inside(() => definition.undo!.current(change))).toEqual(change.after)
  const request = definition.undo!.request(change)
  if ('refusal' in request) return request
  expect(request.tool).toBe(tool)
  return approveAndRun(request.tool, request.args)
}

const ids: Record<string, string> = {}
const tagsOf = (orderId: string) => inside(async () =>
  (await database.client.orderTag.findMany({ where: { orderId }, select: { tag: { select: { name: true } } } })).map((t) => t.tag.name).sort())

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  await db.workspace.create({ data: { id: SECOND, name: 'Second test business', createdByUserId: 'test', creationKey: 'test-o7-second' } })
  await inside(async () => {
    const order = (key: string, data: Record<string, unknown> = {}) => db.order.create({
      data: {
        channel: 'EBAY', channelOrderId: `TEST-O7-${key}`, marketplace: 'IT', status: 'SHIPPED', currencyCode: 'EUR', totalPrice: '10.00',
        customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: { city: 'Testville' }, ...data,
      } as never,
    })
    ids.order = (await order('MAIN')).id
    ids.delivered = (await order('TO-DELIVER')).id
    ids.cancelled = (await order('CANCELLED', { status: 'CANCELLED' })).id
    ids.binned = (await order('BIN', { deletedAt: new Date() })).id
    for (const name of ['vip', 'gift', 'priority']) await db.tag.create({ data: { name } as never })
    const vip = await db.tag.findFirstOrThrow({ where: { name: 'vip' } })
    await db.orderTag.create({ data: { orderId: ids.order, tagId: vip.id } as never })
    ids.oldNote = (await db.orderNote.create({ data: { orderId: ids.order, body: 'Old note to remove', pinned: true } as never })).id
    ids.customer = (await db.customer.create({ data: { id: 'test-o7-customer', email: 'buyer@example.test', name: 'Test Buyer', tags: ['loyal'] } as never })).id
    for (const n of [1, 2, 3]) {
      ids[`review${n}`] = (await db.review.create({
        data: { channel: 'EBAY', externalReviewId: `TEST-O7-REV-${n}`, rating: n, body: `Review ${n} text`, postedAt: new Date(), ...(n === 2 ? { triageStatus: 'NEW', assignee: 'Anna', triageTags: ['sizing'] } : {}) } as never,
      })).id
    }
  })
  await withWorkspace(business(SECOND), async () => {
    ids.otherOrder = (await db.order.create({ data: { channel: 'EBAY', channelOrderId: 'TEST-O7-OTHER', marketplace: 'IT', currencyCode: 'EUR', totalPrice: '1.00', customerName: 'Other', customerEmail: 'o@example.test', shippingAddress: {} } as never })).id
  })
}, 180_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

describe('update-order', () => {
  it('adds a note, takes a note off, changes the tags; undo puts all of it back', async () => {
    const args = { orderId: ids.order, note: 'Buyer asked for a gift wrap', addTags: ['gift'], removeTags: ['vip'], removeNoteId: ids.oldNote }
    const asked = await dryRun('update-order', args)
    expect(asked.preview).toMatchObject({
      order: { channelOrderId: 'TEST-O7-MAIN' },
      changes: { note: { add: 'Buyer asked for a gift wrap' }, removeNote: { id: ids.oldNote, text: 'Old note to remove' }, tags: { from: ['vip'], to: ['gift'] } },
    })
    const done = await run('update-order', args, asked.preview)
    expect(done.ok, done.error).toBe(true)
    expect(await tagsOf(ids.order)).toEqual(['gift'])
    const notes = await inside(() => database.client.orderNote.findMany({ where: { orderId: ids.order }, select: { body: true } }))
    expect(notes.map((n) => n.body)).toEqual(['Buyer asked for a gift wrap'])
    const undone = await undo('update-order', done.change!)
    expect((undone as Out).ok).toBe(true)
    expect(await tagsOf(ids.order)).toEqual(['vip'])
    const back = await inside(() => database.client.orderNote.findMany({ where: { orderId: ids.order }, select: { body: true, pinned: true } }))
    expect(back).toEqual([{ body: 'Old note to remove', pinned: true }])
  })

  it('stale refused: the tags moved after the approval, so nothing runs', async () => {
    const args = { orderId: ids.order, addTags: ['priority'] }
    const asked = await dryRun('update-order', args)
    await inside(async () => {
      const gift = await database.client.tag.findFirstOrThrow({ where: { name: 'gift' } })
      await database.client.orderTag.create({ data: { orderId: ids.order, tagId: gift.id } as never })
    })
    const done = await run('update-order', args, asked.preview)
    expect(done).toEqual({ ok: false, error: expect.stringMatching(/changed since you approved it \(changes\)/) })
    expect(await tagsOf(ids.order)).toEqual(['gift', 'vip'])
  })

  it('marks delivered; its undo is refused, not run', async () => {
    const done = await approveAndRun('update-order', { orderId: ids.delivered, markDelivered: true, deliveredAt: '2026-04-05T10:00:00Z' })
    const order = await inside(() => database.client.order.findUniqueOrThrow({ where: { id: ids.delivered }, select: { status: true, deliveredAtSource: true, deliveredAt: true } }))
    expect(order).toEqual({ status: 'DELIVERED', deliveredAtSource: 'MANUAL', deliveredAt: new Date('2026-04-05T10:00:00Z') })
    expect(await undo('update-order', done.change!)).toEqual({ refusal: expect.stringMatching(/not taken back from Claude/) })
  })

  it('refuses an unknown tag, a final order, nothing to do, the bin and another business', async () => {
    expect((await dryRun('update-order', { orderId: ids.order, addTags: ['made-up'] })).error).toMatch(/No such tag/)
    expect((await dryRun('update-order', { orderId: ids.cancelled, markDelivered: true })).error).toMatch(/CANCELLED/)
    expect((await dryRun('update-order', { orderId: ids.order })).error).toMatch(/Name at least one change/)
    expect(await dryRun('update-order', { orderId: ids.binned, note: 'x' })).toEqual({ ok: false, error: 'Order not found' })
    expect(await dryRun('update-order', { orderId: ids.otherOrder, note: 'x' })).toEqual({ ok: false, error: 'Order not found' })
  })
})

describe('update-customer', () => {
  it('note, tags and manual review; undo puts every part back', async () => {
    const done = await approveAndRun('update-customer', { customerId: ids.customer, note: 'Prefers phone calls', addTags: ['wholesale'], removeTags: ['loyal'], manualReview: 'APPROVED' })
    const now = await inside(() => database.client.customer.findUniqueOrThrow({ where: { id: ids.customer }, select: { tags: true, manualReviewState: true, notes: { select: { body: true } } } }))
    expect(now).toEqual({ tags: ['wholesale'], manualReviewState: 'APPROVED', notes: [{ body: 'Prefers phone calls' }] })
    expect((await undo('update-customer', done.change!) as Out).ok).toBe(true)
    const back = await inside(() => database.client.customer.findUniqueOrThrow({ where: { id: ids.customer }, select: { tags: true, manualReviewState: true, notes: { select: { body: true } } } }))
    expect(back).toEqual({ tags: ['loyal'], manualReviewState: null, notes: [] })
  })

  it('limits: tags inside run without a person; the manual review, a note deletion or too many tags ask one', async () => {
    const tool = getTool('update-customer')!
    const limits = tool.limits!.parse({})
    expect(tool.withinLimits!({ changes: { tags: { from: ['a'], to: ['a', 'b'] }, note: { add: 'x' } } }, limits)).toBeNull()
    expect(tool.withinLimits!({ changes: { manualReview: { from: 'NONE', to: 'APPROVED' } } }, limits)).toMatch(/manual risk review/)
    expect(tool.withinLimits!({ changes: { removeNote: { id: 'n' } } }, limits)).toMatch(/deletes a note/)
    expect(tool.withinLimits!({ changes: { tags: { from: [], to: ['1', '2', '3', '4', '5', '6'] } } }, limits)).toMatch(/6 tags/)
  })

  it('refuses another business\'s customer and a call without customers.edit', async () => {
    expect(await dryRun('update-customer', { customerId: 'test-o7-nobody', note: 'x' })).toEqual({ ok: false, error: 'Customer not found' })
    const none = principal(Object.values(FEATURES).filter((p) => p !== FEATURES.customersEdit))
    await expect(callTool(none, 'update-customer', { customerId: ids.customer, note: 'x' })).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('triage-reviews', () => {
  it('each review its own triage; undo puts each one back (a review that had none included)', async () => {
    const done = await approveAndRun('triage-reviews', {
      reviews: [
        { reviewId: ids.review1, status: 'IN_PROGRESS', assignee: 'Luca', tags: ['quality'] },
        { reviewId: ids.review2, status: 'RESOLVED', note: 'Refunded' },
      ],
    })
    const read = () => inside(() => database.client.review.findMany({
      where: { id: { in: [ids.review1, ids.review2] } }, orderBy: { rating: 'asc' }, select: { triageStatus: true, assignee: true, triageTags: true, triageNote: true },
    }))
    expect(await read()).toEqual([
      { triageStatus: 'IN_PROGRESS', assignee: 'Luca', triageTags: ['quality'], triageNote: null },
      { triageStatus: 'RESOLVED', assignee: 'Anna', triageTags: ['sizing'], triageNote: 'Refunded' },
    ])
    expect((await undo('triage-reviews', done.change!) as Out).ok).toBe(true)
    expect(await read()).toEqual([
      { triageStatus: null, assignee: null, triageTags: [], triageNote: null },
      { triageStatus: 'NEW', assignee: 'Anna', triageTags: ['sizing'], triageNote: null },
    ])
  })

  it('stale refused, limits, unknown and doubled reviews', async () => {
    const args = { reviews: [{ reviewId: ids.review3, status: 'IGNORED' }] }
    const asked = await dryRun('triage-reviews', args)
    await inside(() => database.client.review.update({ where: { id: ids.review3 }, data: { assignee: 'Someone' } }))
    expect((await run('triage-reviews', args, asked.preview)).error).toMatch(/changed since you approved it/)
    const tool = getTool('triage-reviews')!
    expect(tool.withinLimits!({ reviews: new Array(10).fill({}) }, tool.limits!.parse({}))).toBeNull()
    expect(tool.withinLimits!({ reviews: new Array(11).fill({}) }, tool.limits!.parse({}))).toMatch(/11 reviews/)
    expect((await dryRun('triage-reviews', { reviews: [{ reviewId: 'test-o7-none', status: 'NEW' }] })).error).toMatch(/Review not found/)
    expect((await dryRun('triage-reviews', { reviews: [{ reviewId: ids.review3, status: 'NEW' }, { reviewId: ids.review3, status: 'NEW' }] })).error).toMatch(/named twice/)
  })
})
