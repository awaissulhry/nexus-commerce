/**
 * MCP.2 — an operator's hourly limit for a tool is enforced (tool-rate.ts).
 *
 * The count is per business, per tool, per clock hour; shared through Redis
 * while it is connected and held per process otherwise. A refused call is not
 * counted, and nor is a call the person was never allowed to make.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { AgentTool } from './tool-types.js'

const handler = vi.fn()

const TOOLS: Record<string, AgentTool> = {
  'read-stock': {
    name: 'read-stock',
    category: 'fulfillment',
    description: 'test tool',
    riskTier: 'low',
    readOnly: true,
    requires: ['inventory.view'],
    input: z.object({}).loose(),
    handler,
  },
}

vi.mock('./tool-registry.js', () => ({
  getTool: (name: string) => TOOLS[name],
  listTools: () => Object.values(TOOLS),
}))

import { withWorkspace } from '../../lib/workspace-context.js'
import { callTool, systemPrincipal, type UserPrincipal } from './call-tool.js'
import { __toolRateTest, registerToolRateRedis, takeToolCall, type RedisCounter } from './tool-rate.js'

const HOUR = 3_600_000
const T0 = Date.UTC(2026, 8, 29, 10, 15) // 10:15 UTC — 45 minutes left in the hour
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inBusiness = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace(business(workspaceId), work)

function person(permissions: string[]): UserPrincipal {
  return {
    kind: 'user',
    userId: 'u1',
    label: 'Awais',
    permissions: { isOwner: false, permissions: new Set(permissions) },
    workspace: business('ws_alpha_0001'),
    via: 'app',
  }
}

/** The Lua step, run in JS against a Map: the same contract the Redis script keeps. */
function fakeRedis(): RedisCounter & { store: Map<string, number>; expiries: Map<string, number> } {
  const store = new Map<string, number>()
  const expiries = new Map<string, number>()
  return {
    status: 'ready',
    store,
    expiries,
    async eval(_script, _keys, key, limit, ttl) {
      const used = store.get(String(key)) ?? 0
      if (used >= Number(limit)) return -1
      store.set(String(key), used + 1)
      if (used === 0) expiries.set(String(key), Number(ttl))
      return used + 1
    },
  }
}

beforeEach(() => {
  __toolRateTest.reset()
  vi.clearAllMocks()
  handler.mockResolvedValue({ ok: true, data: { onHand: 3 } })
})

afterEach(() => {
  __toolRateTest.reset()
})

describe('MCP.2 — the count', () => {
  it('allows the limit, then refuses until the next hour', async () => {
    const take = () => inBusiness('ws_alpha_0001', () => takeToolCall('read-stock', 2, T0))
    expect((await take()).ok).toBe(true)
    expect((await take()).ok).toBe(true)
    expect(await take()).toEqual({ ok: false, retryAfterSec: 45 * 60 })
    const nextHour = await inBusiness('ws_alpha_0001', () => takeToolCall('read-stock', 2, T0 + HOUR))
    expect(nextHour.ok).toBe(true)
  })

  it('counts each business and each tool on its own', async () => {
    await inBusiness('ws_alpha_0001', () => takeToolCall('read-stock', 1, T0))
    expect((await inBusiness('ws_alpha_0001', () => takeToolCall('read-stock', 1, T0))).ok).toBe(false)
    expect((await inBusiness('ws_bravo_0002', () => takeToolCall('read-stock', 1, T0))).ok).toBe(true)
    expect((await inBusiness('ws_alpha_0001', () => takeToolCall('set-price', 1, T0))).ok).toBe(true)
  })

  it('a limit of 0 allows nothing', async () => {
    expect((await inBusiness('ws_alpha_0001', () => takeToolCall('read-stock', 0, T0))).ok).toBe(false)
  })

  it('is shared through Redis while it is connected, keyed per business, tool and hour', async () => {
    const redis = fakeRedis()
    registerToolRateRedis(() => redis)
    await inBusiness('ws_alpha_0001', () => takeToolCall('read-stock', 5, T0))
    const key = `agent:tool-rate:ws_alpha_0001:read-stock:${Math.floor(T0 / HOUR)}`
    expect(redis.store.get(key)).toBe(1)
    // The key outlives its hour, so a late write cannot recreate it without an expiry.
    expect(redis.expiries.get(key)).toBeGreaterThan(HOUR)
  })

  it('falls back to this process when Redis is not ready or fails', async () => {
    const redis = { ...fakeRedis(), eval: vi.fn().mockRejectedValue(new Error('down')) }
    registerToolRateRedis(() => redis)
    const take = () => inBusiness('ws_alpha_0001', () => takeToolCall('read-stock', 1, T0))
    expect((await take()).ok).toBe(true)
    expect((await take()).ok).toBe(false)
    registerToolRateRedis(() => ({ ...fakeRedis(), status: 'connecting' }))
    expect((await take()).ok).toBe(false)
  })
})

describe('MCP.2 — through the one door', () => {
  it('refuses the call over the limit with 429, before the tool runs', async () => {
    const reader = person(['ai.run', 'inventory.view'])
    await callTool(reader, 'read-stock', {}, { hourlyLimit: 1 })
    const second = callTool(reader, 'read-stock', {}, { hourlyLimit: 1 })
    await expect(second).rejects.toMatchObject({ code: 'rate_limited', statusCode: 429 })
    await expect(second).rejects.toThrow('limited to 1 call per hour')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('a person without the permission cannot spend the budget', async () => {
    const outsider = person(['ai.run'])
    await expect(callTool(outsider, 'read-stock', {}, { hourlyLimit: 1 })).rejects.toMatchObject({
      code: 'forbidden',
    })
    await expect(
      callTool(person(['ai.run', 'inventory.view']), 'read-stock', {}, { hourlyLimit: 1 }),
    ).resolves.toMatchObject({ raw: { ok: true } })
  })

  it('counts in the business the principal names', async () => {
    await callTool(person(['ai.run', 'inventory.view']), 'read-stock', {}, { hourlyLimit: 1 })
    const other = { ...person(['ai.run', 'inventory.view']), workspace: business('ws_bravo_0002') }
    await expect(callTool(other, 'read-stock', {}, { hourlyLimit: 1 })).resolves.toBeTruthy()
  })

  it('without a limit nothing is counted — the approval re-check runs freely', async () => {
    for (let i = 0; i < 3; i++) await callTool(systemPrincipal('approval-recheck'), 'read-stock', {})
    expect(handler).toHaveBeenCalledTimes(3)
  })
})
