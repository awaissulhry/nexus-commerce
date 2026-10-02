/**
 * MCP full control 07 O1 — an order in the bin (`Order.deletedAt` set, the Orders page's soft delete) is not a
 * result of Claude's two order tools. Before, `order-search` listed it and `order-detail` read it.
 *
 * Through the one door (call-tool.ts), on a real PostgreSQL with the production schema and policies (PGlite).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { callTool, type UserPrincipal } from '../call-tool.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const everyone: UserPrincipal = {
  kind: 'user',
  userId: 'u-o1-bin',
  label: '07 O1 test',
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
  workspace: business,
  via: 'claude',
}
const ids = { live: '', binned: '' }
const call = async (tool: string, args: Record<string, unknown>) =>
  (await callTool(everyone, tool, args)).visible as { ok: boolean; error?: string; data?: Record<string, any> }

beforeAll(async () => {
  database = await formulaDatabase()
  await withWorkspace(business, async () => {
    const order = (n: number, deletedAt: Date | null) => database.client.order.create({
      data: {
        channel: 'EBAY', channelOrderId: `TEST-O1-BIN-${n}`, marketplace: 'IT', currencyCode: 'EUR', totalPrice: '10.00',
        customerName: 'Bin Buyer', customerEmail: `bin${n}@example.test`, shippingAddress: { city: 'Milano' },
        purchaseDate: new Date(), deletedAt,
      } as never,
    })
    ids.live = (await order(1, null)).id
    ids.binned = (await order(2, new Date())).id
  })
}, 120_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

describe('07 O1 — an order in the bin is not a result', () => {
  it('order-search leaves it out (and still finds the live one)', async () => {
    const out = await call('order-search', { buyer: 'Bin Buyer', limit: 50 })
    expect(out.ok, out.error).toBe(true)
    expect((out.data!.orders as Array<{ channelOrderId: string }>).map((o) => o.channelOrderId)).toEqual(['TEST-O1-BIN-1'])
  })

  it('order-detail answers "not found" for it (and still reads the live one)', async () => {
    expect(await call('order-detail', { orderId: ids.binned })).toEqual({ ok: false, error: 'Order not found' })
    expect((await call('order-detail', { orderId: ids.live })).ok).toBe(true)
  })
})
