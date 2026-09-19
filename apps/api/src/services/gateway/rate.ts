/**
 * P1.1 (FINAL-PLAN section 5 item 1, step 6) — one rate bucket per channel × account × operation group,
 * fed by the channel's own rate headers. Before this, writes read no rate header at all: Amazon waited
 * a fixed 200 ms per client instance, eBay and Shopify had in-process buckets with fixed numbers.
 *
 * A token bucket (capacity, refill per second). Shared across API replicas through Redis (one Lua step,
 * atomic) when Redis is connected; otherwise per process — the same fail-open the clustered cron uses.
 * The channel tunes it: Amazon's `x-amzn-RateLimit-Limit` sets the refill rate of that operation's
 * bucket; a `Retry-After` / 429 empties the bucket until the wait is over; Shopify's reported headroom
 * is recorded. A caller waits up to `maxWaitMs` for a token; past that the gateway answers
 * `rate_limited` (retryable) without calling the channel, so a queue retries later instead of failing.
 */
import type { GatewayChannel } from './vocabulary.js'

export interface BucketParams { capacity: number; refillPerSec: number }

/** Defaults per account, before the channel has told us anything. Conservative on purpose. */
export const DEFAULT_BUCKETS: Record<GatewayChannel, BucketParams> = {
  AMAZON_SP: { capacity: 10, refillPerSec: 5 },
  EBAY: { capacity: 50, refillPerSec: 10 },
  SHOPIFY: { capacity: 20, refillPerSec: 2 },
  AMAZON_ADS: { capacity: 20, refillPerSec: 10 },
}

export interface TakeResult { ok: boolean; waitMs: number; tokensLeft: number }

interface BucketStore {
  take(key: string, params: BucketParams, cost: number, nowMs: number): Promise<TakeResult>
  /** Force the bucket empty until `untilMs` (a Retry-After). */
  holdUntil(key: string, untilMs: number): Promise<void>
  setParams(key: string, params: BucketParams): Promise<void>
  getParams(key: string): Promise<BucketParams | null>
}

class MemoryBucketStore implements BucketStore {
  private buckets = new Map<string, { tokens: number; ts: number; holdUntil: number }>()
  private params = new Map<string, BucketParams>()
  async take(key: string, p: BucketParams, cost: number, now: number): Promise<TakeResult> {
    const b = this.buckets.get(key) ?? { tokens: p.capacity, ts: now, holdUntil: 0 }
    if (b.holdUntil > now) { this.buckets.set(key, b); return { ok: false, waitMs: b.holdUntil - now, tokensLeft: 0 } }
    b.tokens = Math.min(p.capacity, b.tokens + ((now - b.ts) / 1000) * p.refillPerSec)
    b.ts = now
    if (b.tokens >= cost) { b.tokens -= cost; this.buckets.set(key, b); return { ok: true, waitMs: 0, tokensLeft: b.tokens } }
    this.buckets.set(key, b)
    return { ok: false, waitMs: Math.ceil(((cost - b.tokens) / p.refillPerSec) * 1000), tokensLeft: b.tokens }
  }
  async holdUntil(key: string, untilMs: number) {
    const b = this.buckets.get(key) ?? { tokens: 0, ts: Date.now(), holdUntil: 0 }
    b.tokens = 0; b.holdUntil = Math.max(b.holdUntil, untilMs)
    this.buckets.set(key, b)
  }
  async setParams(key: string, params: BucketParams) { this.params.set(key, params) }
  async getParams(key: string) { return this.params.get(key) ?? null }
}

const TAKE_LUA = `
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts', 'hold')
local capacity = tonumber(ARGV[1]); local rate = tonumber(ARGV[2]); local now = tonumber(ARGV[3]); local cost = tonumber(ARGV[4])
local hold = tonumber(b[3]) or 0
if hold > now then return {0, '0', hold - now} end
local tokens = tonumber(b[1]) or capacity
local ts = tonumber(b[2]) or now
tokens = math.min(capacity, tokens + (now - ts) / 1000 * rate)
local ok = 0; local wait = 0
if tokens >= cost then tokens = tokens - cost; ok = 1 else wait = math.ceil((cost - tokens) / rate * 1000) end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], 3600000)
return {ok, tostring(tokens), wait}
`

interface RedisLike {
  status?: string
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>
  hset(key: string, ...args: Array<string | number>): Promise<unknown>
  hgetall(key: string): Promise<Record<string, string>>
  pexpire(key: string, ms: number): Promise<unknown>
}

class RedisBucketStore implements BucketStore {
  constructor(private readonly redis: RedisLike) {}
  async take(key: string, p: BucketParams, cost: number, now: number): Promise<TakeResult> {
    const [ok, tokens, wait] = (await this.redis.eval(TAKE_LUA, 1, `gw:bucket:${key}`, p.capacity, p.refillPerSec, now, cost)) as [number, string, number]
    return { ok: ok === 1, waitMs: Number(wait), tokensLeft: Number(tokens) }
  }
  async holdUntil(key: string, untilMs: number) {
    await this.redis.hset(`gw:bucket:${key}`, 'hold', String(untilMs), 'tokens', '0', 'ts', String(Date.now()))
    await this.redis.pexpire(`gw:bucket:${key}`, 3_600_000)
  }
  async setParams(key: string, params: BucketParams) {
    await this.redis.hset(`gw:params:${key}`, 'capacity', String(params.capacity), 'refillPerSec', String(params.refillPerSec))
    await this.redis.pexpire(`gw:params:${key}`, 86_400_000)
  }
  async getParams(key: string) {
    const row = await this.redis.hgetall(`gw:params:${key}`)
    const capacity = Number(row?.capacity); const refillPerSec = Number(row?.refillPerSec)
    return capacity > 0 && refillPerSec > 0 ? { capacity, refillPerSec } : null
  }
}

const memory = new MemoryBucketStore()
let override: BucketStore | null = null

/** Redis when it is connected; else this process's memory. Never blocks on Redis. */
async function store(): Promise<BucketStore> {
  if (override) return override
  try {
    const { getRedisRuntimeStatus, redis } = await import('../../lib/queue.js')
    if (getRedisRuntimeStatus().status === 'ready') return new RedisBucketStore(redis.connection as unknown as RedisLike)
  } catch { /* no queue module / Redis not configured */ }
  return memory
}

export const __rateTest = {
  useMemory() { override = new MemoryBucketStore() },
  /** The shared store on a given Redis client (the P1.1 probe runs it on a throwaway Redis). */
  useRedis(client: RedisLike) { override = new RedisBucketStore(client) },
  reset() { override = null },
}

export function bucketKey(channel: GatewayChannel, connectionId: string | null, group: string): string {
  return `${channel}:${connectionId ?? 'app'}:${group}`
}

/** Wait for a token, up to `maxWaitMs`. `ok: false` = still none after waiting (answer rate_limited). */
export async function takeToken(channel: GatewayChannel, key: string, maxWaitMs: number, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<TakeResult & { waitedMs: number }> {
  const s = await store()
  const params = (await s.getParams(key).catch(() => null)) ?? DEFAULT_BUCKETS[channel]
  let waitedMs = 0
  for (;;) {
    const result = await s.take(key, params, 1, Date.now()).catch(() => ({ ok: true, waitMs: 0, tokensLeft: 0 } as TakeResult))
    if (result.ok) return { ...result, waitedMs }
    if (waitedMs + result.waitMs > maxWaitMs) return { ...result, waitedMs }
    await sleep(result.waitMs)
    waitedMs += result.waitMs
  }
}

export interface RateObservation { remaining?: number; limit?: number; retryAfterSec?: number }

/**
 * Feed the channel's own reading back into the bucket. Amazon's limit header is a rate per second:
 * it becomes that bucket's refill (burst stays at least 1 second's worth). A Retry-After holds the
 * bucket empty until it passes.
 */
export async function observeRate(channel: GatewayChannel, key: string, reading: RateObservation | null): Promise<void> {
  if (!reading) return
  const s = await store()
  try {
    if (reading.retryAfterSec && reading.retryAfterSec > 0) await s.holdUntil(key, Date.now() + Math.min(reading.retryAfterSec, 60) * 1000)
    // Amazon reports the operation's sustained rate (requests per second), not its burst: the
    // refill follows the header, the burst stays at the default (10 — Amazon's bursts are 10–30).
    if (channel === 'AMAZON_SP' && reading.limit && reading.limit > 0) {
      const current = (await s.getParams(key)) ?? DEFAULT_BUCKETS.AMAZON_SP
      if (Math.abs(current.refillPerSec - reading.limit) > 1e-9) await s.setParams(key, { refillPerSec: reading.limit, capacity: DEFAULT_BUCKETS.AMAZON_SP.capacity })
    }
  } catch { /* the bucket is advisory; a store error never blocks a call */ }
}
