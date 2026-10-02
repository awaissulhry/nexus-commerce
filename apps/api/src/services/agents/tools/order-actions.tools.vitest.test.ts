/**
 * MCP full control 07 — the irreversible order actions through the one door (call-tool.ts), on a real PostgreSQL with
 * the production schema and policies (PGlite). The channels are MOCKED: nothing leaves the machine.
 *
 * cancel-order (O10): the preview says per channel whether the cancel is live or a dry run; two cancels at once — one
 * wins and the other is refused; refused for an order Amazon ships and for a shipped, returned or refunded order; a
 * channel switch flipping after the approval refuses the run (stale); never auto (irreversible).
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
const channel = vi.hoisted(() => ({ calls: [] as unknown[][] }))
vi.mock('../../order-cancellation/channel-cancel.js', () => ({
  cancelOnAmazon: vi.fn(async (...args: unknown[]) => { channel.calls.push(['AMAZON', ...args]); return { ok: true, channel: 'AMAZON', channelOrderId: String(args[0]), ackRef: null, dryRun: true } }),
  cancelOnEbay: vi.fn(async (...args: unknown[]) => { channel.calls.push(['EBAY', ...args]); return { ok: true, channel: 'EBAY', channelOrderId: String(args[0]), ackRef: null, dryRun: true } }),
  cancelOnShopify: vi.fn(async (...args: unknown[]) => { channel.calls.push(['SHOPIFY', ...args]); return { ok: true, channel: 'SHOPIFY', channelOrderId: String(args[0]), ackRef: null, dryRun: true } }),
}))

import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const everything: UserPrincipal = {
  kind: 'user', userId: 'u-o10', label: '07 O10 test', permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) }, workspace: business, via: 'claude',
}
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
type Out = { ok: boolean; error?: string; preview?: any; data?: any }
const dryRun = async (tool: string, args: Record<string, unknown>) => (await callTool(everything, tool, args)).raw as Out
const run = async (tool: string, args: Record<string, unknown>, approvedPreview: unknown) => (await executeTool(everything, tool, args, { approvedPreview })).raw as Out
const statusOf = (id: string) => inside(async () => (await database.client.order.findUniqueOrThrow({ where: { id }, select: { status: true } })).status)
let seq = 0
const order = (data: Record<string, unknown> = {}) => inside(async () => (await database.client.order.create({
  data: {
    channel: 'SHOPIFY', channelOrderId: `TEST-O10-${++seq}`, marketplace: 'IT', status: 'PROCESSING', currencyCode: 'EUR', totalPrice: '30.00',
    customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: { city: 'Testville' },
    items: { create: [{ sku: `TEST-O10-SKU-${seq}`, quantity: 2, price: '15.00' }] }, ...data,
  } as never,
})).id)

beforeAll(async () => {
  database = await formulaDatabase()
}, 180_000)
afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('cancel-order (07 O10)', () => {
  it('the preview says what the cancel does in Nexus and whether the channel cancel is live or a dry run', async () => {
    const id = await order()
    const dry = await dryRun('cancel-order', { orderId: id, reason: 'Buyer asked to cancel' })
    expect(dry.preview).toMatchObject({ inNexus: { status: 'CANCELLED', unitsBackInStock: 2 }, channelCancel: expect.stringMatching(/^dry run: Shopify is not told/) })
    vi.stubEnv('NEXUS_ENABLE_SHOPIFY_ORDER_CANCEL', 'true')
    expect((await dryRun('cancel-order', { orderId: id, reason: 'Buyer asked to cancel' })).preview.channelCancel).toMatch(/^live: Shopify cancels it and refunds the buyer/)
    vi.unstubAllEnvs()
  })

  it('two approved cancels at once: one wins, the other is refused, the channel is told once', async () => {
    const id = await order()
    const args = { orderId: id, reason: 'Duplicate order' }
    const preview = (await dryRun('cancel-order', args)).preview
    channel.calls.length = 0
    const results = await Promise.all([run('cancel-order', args, preview), run('cancel-order', args, preview)])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)!.error).toMatch(/already cancelled|changed while it was being cancelled/)
    expect(await statusOf(id)).toBe('CANCELLED')
    expect(channel.calls).toHaveLength(1)
  })

  it('refused for an order Amazon ships, and for a shipped, returned or refunded order; nothing changes', async () => {
    const fba = await order({ channel: 'AMAZON', fulfillmentMethod: 'FBA' })
    expect((await dryRun('cancel-order', { orderId: fba, reason: 'test reason' })).error).toMatch(/Amazon ships it/)
    for (const status of ['SHIPPED', 'RETURNED', 'REFUNDED']) {
      const id = await order({ status })
      expect((await dryRun('cancel-order', { orderId: id, reason: 'test reason' })).error).toMatch(new RegExp(`is ${status}`))
      expect(await statusOf(id)).toBe(status)
    }
  })

  it('stale refused: the channel cancel went live after the approval, so nothing is cancelled', async () => {
    const id = await order()
    const args = { orderId: id, reason: 'Buyer asked to cancel' }
    const preview = (await dryRun('cancel-order', args)).preview
    vi.stubEnv('NEXUS_ENABLE_SHOPIFY_ORDER_CANCEL', 'true')
    const done = await run('cancel-order', args, preview)
    vi.unstubAllEnvs()
    expect(done.error).toMatch(/changed since you approved it \(channelCancel\)/)
    expect(await statusOf(id)).toBe('PROCESSING')
  })

  it('irreversible: always asks, never more than a person\'s approval in Nexus', () => {
    const tool = getTool('cancel-order')!
    expect({ alwaysAsk: tool.alwaysAsk, reversibility: tool.reversibility, maxClaudeTrust: tool.maxClaudeTrust, undo: tool.undo }).toEqual({ alwaysAsk: true, reversibility: 'none', maxClaudeTrust: 'ask', undo: undefined })
  })
})
