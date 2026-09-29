/**
 * MCP.11 — how often one Claude connection, and one business, may call /mcp.
 *
 * Two counts per clock minute, taken together after the token is verified (the keys come from
 * it) and before the request reaches any tool:
 *
 *   per connection (OAuthGrant)   NEXUS_MCP_RATE_PER_GRANT      default 120 a minute
 *   per business (workspace)      NEXUS_MCP_RATE_PER_BUSINESS   default 600 a minute
 *
 * Why these numbers: a Claude turn sends a few requests (a list, then one call per tool it
 * uses), so a person working stays far below 2 a second, and a client stuck in a loop is held
 * there. Every request also costs a token and membership check in the database. A business
 * gets five connections' worth, so several people (or Claude and Claude Code) can work at
 * once while one business still cannot crowd out the others. `0` refuses every request.
 *
 * Shared by every API replica through the app's Redis while it is connected (one Lua step:
 * both counts are checked, then both taken, atomically), and held per process otherwise — the
 * same fail-open as tool-rate.ts. A refused request is not counted.
 */

const MINUTE_MS = 60_000
const DEFAULT_PER_GRANT = 120
const DEFAULT_PER_BUSINESS = 600

export interface McpRateRedis {
  status?: string
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>
}

// 1 = the connection is full, 2 = the business is full, 0 = taken from both. Keys outlive their
// minute so a late INCR cannot recreate one without an expiry.
const TAKE_LUA = `
if tonumber(redis.call('GET', KEYS[1]) or '0') >= tonumber(ARGV[1]) then return 1 end
if tonumber(redis.call('GET', KEYS[2]) or '0') >= tonumber(ARGV[2]) then return 2 end
for i = 1, 2 do
  if redis.call('INCR', KEYS[i]) == 1 then redis.call('PEXPIRE', KEYS[i], ARGV[3]) end
end
return 0`

let sharedRedis: (() => McpRateRedis | null) | null = null
const memory = new Map<string, { minute: number; used: number }>()

/** The app's Redis, handed over by lib/queue.ts when it connects. This module never opens one. */
export function registerMcpRateRedis(get: () => McpRateRedis | null): void {
  sharedRedis = get
}

function limit(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

export interface McpRateLimits {
  perGrant: number
  perBusiness: number
}

export function mcpRateLimits(): McpRateLimits {
  return {
    perGrant: limit('NEXUS_MCP_RATE_PER_GRANT', DEFAULT_PER_GRANT),
    perBusiness: limit('NEXUS_MCP_RATE_PER_BUSINESS', DEFAULT_PER_BUSINESS),
  }
}

export interface McpRateVerdict {
  ok: boolean
  /** Which count is full, when refused. */
  limitedBy?: 'connection' | 'business'
  /** That count's limit per minute, when refused. */
  limit?: number
  /** Seconds until the next minute starts. */
  retryAfterSec: number
}

/**
 * Count one /mcp request for this connection and its business, or refuse it when either count
 * is full this minute.
 */
export async function takeMcpRequest(
  caller: { workspaceId: string; grantId: string },
  now: number = Date.now(),
): Promise<McpRateVerdict> {
  const { perGrant, perBusiness } = mcpRateLimits()
  const minute = Math.floor(now / MINUTE_MS)
  const retryAfterSec = Math.max(1, Math.ceil(((minute + 1) * MINUTE_MS - now) / 1000))
  const refused = (limitedBy: 'connection' | 'business'): McpRateVerdict => ({
    ok: false,
    limitedBy,
    limit: limitedBy === 'connection' ? perGrant : perBusiness,
    retryAfterSec,
  })

  // One hash tag, the business: both keys sit in one Redis Cluster slot, as a Lua step needs.
  const tag = `{${caller.workspaceId}}`
  const grantKey = `mcp:rate:${tag}:grant:${caller.grantId}:${minute}`
  const businessKey = `mcp:rate:${tag}:business:${minute}`
  const client = sharedRedis?.() ?? null
  if (client && client.status === 'ready') {
    try {
      const full = Number(await client.eval(TAKE_LUA, 2, grantKey, businessKey, perGrant, perBusiness, MINUTE_MS + 60_000))
      if (full === 1) return refused('connection')
      if (full === 2) return refused('business')
      return { ok: true, retryAfterSec }
    } catch {
      // A Redis hiccup must not take Claude down: count in this process instead.
    }
  }

  const used = (slot: string) => {
    const current = memory.get(slot)
    return current && current.minute === minute ? current.used : 0
  }
  const grantSlot = `grant:${caller.grantId}`
  const businessSlot = `business:${caller.workspaceId}`
  if (used(grantSlot) >= perGrant) return refused('connection')
  if (used(businessSlot) >= perBusiness) return refused('business')
  memory.set(grantSlot, { minute, used: used(grantSlot) + 1 })
  memory.set(businessSlot, { minute, used: used(businessSlot) + 1 })
  return { ok: true, retryAfterSec }
}

export const __mcpRateTest = {
  reset() {
    memory.clear()
    sharedRedis = null
  },
}
