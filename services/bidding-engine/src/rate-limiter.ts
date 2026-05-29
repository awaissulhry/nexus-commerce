/**
 * Distributed token-bucket rate limiter (per Amazon profile), backed by Redis
 * so it stays correct across multiple worker replicas. The whole take/refill is
 * one atomic Lua script — no read-modify-write races.
 *
 * `take()` returns 0 when a token was granted, or the milliseconds to wait until
 * one will be available, so the caller can delay rather than spin.
 */
import type { Redis } from 'ioredis'

const LUA = `
local key       = KEYS[1]
local capacity  = tonumber(ARGV[1])
local refill    = tonumber(ARGV[2])   -- tokens per second
local now_ms    = tonumber(ARGV[3])
local ttl_ms    = tonumber(ARGV[4])

local data   = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts     = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now_ms end

-- refill based on elapsed time
local elapsed = math.max(0, now_ms - ts) / 1000.0
tokens = math.min(capacity, tokens + elapsed * refill)
ts = now_ms

if tokens >= 1 then
  tokens = tokens - 1
  redis.call('HMSET', key, 'tokens', tokens, 'ts', ts)
  redis.call('PEXPIRE', key, ttl_ms)
  return 0
else
  -- ms until one token regenerates
  local wait_ms = math.ceil((1 - tokens) / refill * 1000)
  redis.call('HMSET', key, 'tokens', tokens, 'ts', ts)
  redis.call('PEXPIRE', key, ttl_ms)
  return wait_ms
end
`

export class TokenBucket {
  private sha: string | null = null
  constructor(
    private readonly redis: Redis,
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly prefix = 'rl:bid:',
  ) {}

  private async ensureScript(): Promise<string> {
    if (this.sha) return this.sha
    this.sha = (await this.redis.script('LOAD', LUA)) as string
    return this.sha
  }

  /** Returns ms to wait (0 = token granted). */
  async take(profileId: string): Promise<number> {
    const key = this.prefix + profileId
    const ttlMs = Math.ceil((this.capacity / this.refillPerSec) * 1000) + 5_000
    const args = [String(this.capacity), String(this.refillPerSec), String(Date.now()), String(ttlMs)]
    try {
      const sha = await this.ensureScript()
      return Number(await this.redis.evalsha(sha, 1, key, ...args))
    } catch (err) {
      // NOSCRIPT after a Redis restart → reload and retry once with EVAL.
      if (String(err).includes('NOSCRIPT')) {
        this.sha = null
        return Number(await this.redis.eval(LUA, 1, key, ...args))
      }
      throw err
    }
  }

  /** Acquire a token, sleeping in bounded steps until granted. */
  async acquire(profileId: string, maxWaitMs = 30_000): Promise<void> {
    const deadline = Date.now() + maxWaitMs
    for (;;) {
      const wait = await this.take(profileId)
      if (wait === 0) return
      if (Date.now() + wait > deadline) throw new Error(`rate-limit acquire timeout for ${profileId}`)
      await new Promise((r) => setTimeout(r, Math.min(wait, 1_000)))
    }
  }
}
