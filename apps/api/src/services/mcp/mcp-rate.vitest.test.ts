/**
 * MCP.11 — /mcp is limited per Claude connection and per business (mcp-rate.ts).
 *
 * Two counts per clock minute, taken together: shared through Redis while it is connected,
 * held per process otherwise. A refused request is not counted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __mcpRateTest, mcpRateLimits, registerMcpRateRedis, takeMcpRequest, type McpRateRedis } from './mcp-rate.js'

const MINUTE = 60_000
const T0 = Date.UTC(2026, 8, 29, 10, 15, 20) // 10:15:20 UTC — 40 seconds left in the minute
const ALPHA = { workspaceId: 'ws_alpha_0001', grantId: 'grant_alpha_one' }
const ALPHA_TWO = { workspaceId: 'ws_alpha_0001', grantId: 'grant_alpha_two' }
const BRAVO = { workspaceId: 'ws_bravo_0002', grantId: 'grant_bravo_one' }

/** The Lua step, run in JS against a Map: the same contract the Redis script keeps. */
function fakeRedis(): McpRateRedis & { store: Map<string, number>; expiries: Map<string, number> } {
  const store = new Map<string, number>()
  const expiries = new Map<string, number>()
  return {
    status: 'ready',
    store,
    expiries,
    async eval(_script, keys, grantKey, businessKey, perGrant, perBusiness, ttl) {
      expect(keys).toBe(2)
      if ((store.get(String(grantKey)) ?? 0) >= Number(perGrant)) return 1
      if ((store.get(String(businessKey)) ?? 0) >= Number(perBusiness)) return 2
      for (const key of [String(grantKey), String(businessKey)]) {
        const used = (store.get(key) ?? 0) + 1
        store.set(key, used)
        if (used === 1) expiries.set(key, Number(ttl))
      }
      return 0
    },
  }
}

const limits = (perGrant: number, perBusiness: number) => {
  vi.stubEnv('NEXUS_MCP_RATE_PER_GRANT', String(perGrant))
  vi.stubEnv('NEXUS_MCP_RATE_PER_BUSINESS', String(perBusiness))
}

beforeEach(() => {
  __mcpRateTest.reset()
})

afterEach(() => {
  __mcpRateTest.reset()
  vi.unstubAllEnvs()
})

describe('MCP.11 — the limits', () => {
  it('default to 120 a minute per connection and 600 per business', () => {
    vi.stubEnv('NEXUS_MCP_RATE_PER_GRANT', '')
    vi.stubEnv('NEXUS_MCP_RATE_PER_BUSINESS', '')
    expect(mcpRateLimits()).toEqual({ perGrant: 120, perBusiness: 600 })
  })

  it('are set by the environment; a value that is not a whole number keeps the default', () => {
    limits(30, 90)
    expect(mcpRateLimits()).toEqual({ perGrant: 30, perBusiness: 90 })
    vi.stubEnv('NEXUS_MCP_RATE_PER_GRANT', 'lots')
    vi.stubEnv('NEXUS_MCP_RATE_PER_BUSINESS', '-5')
    expect(mcpRateLimits()).toEqual({ perGrant: 120, perBusiness: 600 })
  })

  it('0 refuses every request', async () => {
    limits(0, 600)
    expect(await takeMcpRequest(ALPHA, T0)).toMatchObject({ ok: false, limitedBy: 'connection', limit: 0 })
  })
})

describe('MCP.11 — per connection', () => {
  it('allows the limit, then refuses until the next minute, saying when', async () => {
    limits(2, 600)
    expect((await takeMcpRequest(ALPHA, T0)).ok).toBe(true)
    expect((await takeMcpRequest(ALPHA, T0)).ok).toBe(true)
    expect(await takeMcpRequest(ALPHA, T0)).toEqual({ ok: false, limitedBy: 'connection', limit: 2, retryAfterSec: 40 })
    expect((await takeMcpRequest(ALPHA, T0 + MINUTE)).ok).toBe(true)
  })

  it('another connection of the same business has its own count', async () => {
    limits(1, 600)
    await takeMcpRequest(ALPHA, T0)
    expect((await takeMcpRequest(ALPHA, T0)).ok).toBe(false)
    expect((await takeMcpRequest(ALPHA_TWO, T0)).ok).toBe(true)
  })
})

describe('MCP.11 — per business', () => {
  it('every connection of a business shares its count; another business does not', async () => {
    limits(100, 3)
    await takeMcpRequest(ALPHA, T0)
    await takeMcpRequest(ALPHA_TWO, T0)
    await takeMcpRequest(ALPHA, T0)
    expect(await takeMcpRequest(ALPHA_TWO, T0)).toEqual({ ok: false, limitedBy: 'business', limit: 3, retryAfterSec: 40 })
    expect((await takeMcpRequest(BRAVO, T0)).ok).toBe(true)
  })

  it('a refused request is not counted against the connection', async () => {
    limits(2, 1)
    expect((await takeMcpRequest(ALPHA, T0)).ok).toBe(true)
    expect((await takeMcpRequest(ALPHA, T0)).limitedBy).toBe('business')
    // Next minute: had the refusal been counted, the connection would be full after one.
    expect((await takeMcpRequest(ALPHA, T0 + MINUTE)).ok).toBe(true)
  })
})

describe('MCP.11 — shared through Redis', () => {
  it('both counts, in one step, keyed per minute in one cluster slot, with an expiry past the minute', async () => {
    limits(5, 50)
    const redis = fakeRedis()
    registerMcpRateRedis(() => redis)
    expect((await takeMcpRequest(ALPHA, T0)).ok).toBe(true)
    const minute = Math.floor(T0 / MINUTE)
    const grantKey = `mcp:rate:{ws_alpha_0001}:grant:grant_alpha_one:${minute}`
    const businessKey = `mcp:rate:{ws_alpha_0001}:business:${minute}`
    expect(redis.store.get(grantKey)).toBe(1)
    expect(redis.store.get(businessKey)).toBe(1)
    expect(redis.expiries.get(grantKey)).toBeGreaterThan(MINUTE)
  })

  it('what Redis refuses is refused, naming the count that is full', async () => {
    limits(1, 50)
    const redis = fakeRedis()
    registerMcpRateRedis(() => redis)
    await takeMcpRequest(ALPHA, T0)
    expect(await takeMcpRequest(ALPHA, T0)).toMatchObject({ ok: false, limitedBy: 'connection' })
    limits(50, 1)
    expect(await takeMcpRequest(ALPHA_TWO, T0)).toMatchObject({ ok: false, limitedBy: 'business' })
  })

  it('falls back to this process when Redis is not ready or fails', async () => {
    limits(1, 50)
    const failing = { ...fakeRedis(), eval: vi.fn().mockRejectedValue(new Error('down')) }
    registerMcpRateRedis(() => failing)
    expect((await takeMcpRequest(ALPHA, T0)).ok).toBe(true)
    expect((await takeMcpRequest(ALPHA, T0)).ok).toBe(false)
    expect(failing.eval).toHaveBeenCalled()
    registerMcpRateRedis(() => ({ ...fakeRedis(), status: 'connecting' }))
    expect((await takeMcpRequest(ALPHA, T0)).ok).toBe(false)
    expect((await takeMcpRequest(BRAVO, T0)).ok).toBe(true)
  })
})
