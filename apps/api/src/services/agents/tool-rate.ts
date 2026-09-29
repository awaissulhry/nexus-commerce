/**
 * MCP.2 — an operator's "at most N calls per hour" for a tool, enforced.
 *
 * `AgentTool.rateLimitPerHour` was stored and shown, and nothing read it. It
 * now counts every request to use the tool in one business (a person's call
 * through the assistant, the MCP endpoint or an autonomous agent's proposal),
 * per clock hour. `null` means no limit; `0` means none this hour.
 *
 * The count is shared by every API replica through the app's Redis while it
 * is connected (one Lua step, atomic), and held per process otherwise — the
 * same fail-open the channel gateway's buckets use. A refused request is not
 * counted, and call-tool.ts only asks after the permission and business
 * checks pass, so a person who may not use a tool cannot spend its budget.
 */

import {
  LEGACY_WORKSPACE_ID,
  workspaceContext,
} from '../../lib/workspace-context.js'

const HOUR_MS = 3_600_000

export interface RedisCounter {
  status?: string
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>
}

// Take one call if the hour has room; -1 when it is full. The key outlives its
// hour by a minute so a late INCR cannot recreate it without an expiry.
const TAKE_LUA = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= tonumber(ARGV[1]) then return -1 end
used = redis.call('INCR', KEYS[1])
if used == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return used`

let sharedRedis: (() => RedisCounter | null) | null = null
const memory = new Map<string, { hour: number; used: number }>()

/** The app's Redis, handed over by lib/queue.ts when it connects. This module never opens one. */
export function registerToolRateRedis(get: () => RedisCounter | null): void {
  sharedRedis = get
}

export interface ToolRateVerdict {
  ok: boolean
  /** Seconds until the next hour starts, when refused. */
  retryAfterSec: number
}

/**
 * Count one call of `tool` in the business that is bound right now (call-tool.ts
 * binds the person's before it asks), or refuse it when the hour is full.
 */
export async function takeToolCall(
  tool: string,
  limitPerHour: number,
  now: number = Date.now(),
): Promise<ToolRateVerdict> {
  const hour = Math.floor(now / HOUR_MS)
  const retryAfterSec = Math.ceil(((hour + 1) * HOUR_MS - now) / 1000)
  if (limitPerHour <= 0) return { ok: false, retryAfterSec }
  const workspaceId = workspaceContext()?.workspaceId ?? LEGACY_WORKSPACE_ID
  const key = `agent:tool-rate:${workspaceId}:${tool}:${hour}`

  const client = sharedRedis?.() ?? null
  if (client && client.status === 'ready') {
    try {
      const used = Number(await client.eval(TAKE_LUA, 1, key, limitPerHour, HOUR_MS + 60_000))
      return { ok: used !== -1, retryAfterSec }
    } catch {
      // A Redis hiccup must not stop the assistant: count in this process instead.
    }
  }

  const slot = `${workspaceId}:${tool}`
  const current = memory.get(slot)
  const used = current && current.hour === hour ? current.used : 0
  if (used >= limitPerHour) return { ok: false, retryAfterSec }
  memory.set(slot, { hour, used: used + 1 })
  return { ok: true, retryAfterSec }
}

export const __toolRateTest = {
  reset() {
    memory.clear()
    sharedRedis = null
  },
}
