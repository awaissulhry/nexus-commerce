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
  ETSY: { capacity: 10, refillPerSec: 5 },
  // Google: a host with no group of its own (GOOGLE_BUCKETS below holds the four that have one).
  GOOGLE: { capacity: 5, refillPerSec: 1 },
  // Meta: a call with no group of its own (META_BUCKETS below holds the three that have one).
  META: { capacity: 5, refillPerSec: 0.2 },
}

/**
 * Meta, per kind of call (the key's operation group, channels.bucketGroupOf → meta-calls.ts metaCallGroup), per
 * connection. Sized for Meta's Limited (default) Marketing API tier (checked 2026-10-20:
 * developers.facebook.com/documentation/ads-commerce/marketing-api/overview/rate-limiting): an ad account's score is
 * at most 60, a read costs 1 point and the score decays over 300 s — so a burst of 40 refilled one read per 5 s keeps a
 * daily read inside it. Insights (ads_insights, 600 an hour per account at Limited) refill one per 6 s. The sign-in
 * calls (debug_token, the token renewal) are rare. Meta's own usage headers then hold a bucket (rate-readings.ts
 * metaRateReading): the gateway backs off at 75 % and while Meta says access is blocked.
 */
export const META_BUCKETS: Record<'ads' | 'insights' | 'auth', BucketParams> = {
  ads: { capacity: 40, refillPerSec: 0.2 },
  insights: { capacity: 30, refillPerSec: 1 / 6 },
  auth: { capacity: 5, refillPerSec: 1 },
}

/** The longest a channel's own wait holds a bucket: Meta names its block in minutes (up to an hour), others in seconds. */
const MAX_HOLD_SEC: Partial<Record<GatewayChannel, number>> = { META: 3600 }

/**
 * Google, per API (the key's operation group is the host's, channels.googleHostGroup). Google Ads is the
 * scarce one — a daily operation budget per Cloud project — so its bucket is a burst of 60 refilled one
 * call per 30 s, per connection: a connect's discovery (≤ 1 + 20 + a few manager reads) and a step-1b daily
 * read (21 first pages, 27 on an account's first run, plus the extra pages of a big account) fit in the
 * burst; a runaway loop cannot spend the day's budget (ops-budget.ts reserves every run's operations first).
 * Merchant Center, Analytics and the userinfo heartbeat are generous.
 */
export const GOOGLE_BUCKETS: Record<'ads' | 'merchant' | 'analytics' | 'identity', BucketParams> = {
  ads: { capacity: 60, refillPerSec: 1 / 30 },
  merchant: { capacity: 10, refillPerSec: 2 },
  analytics: { capacity: 10, refillPerSec: 1 },
  identity: { capacity: 5, refillPerSec: 1 },
}

/**
 * Shopify: REST is a leaky bucket of 40 draining at 2/s; GraphQL is cost-based (about 100 points/s, a
 * mutation ~10) — its own, faster bucket. The key's operation group says which (channels.bucketGroupOf).
 */
const SHOPIFY_GRAPHQL: BucketParams = { capacity: 50, refillPerSec: 10 }
const SHOPIFY_REST: BucketParams = { capacity: 40, refillPerSec: 2 }

export function defaultsFor(channel: GatewayChannel, key: string): BucketParams {
  if (channel === 'SHOPIFY') return key.endsWith(':graphql') ? SHOPIFY_GRAPHQL : SHOPIFY_REST
  if (channel === 'GOOGLE') {
    const group = key.slice(key.lastIndexOf(':') + 1) as keyof typeof GOOGLE_BUCKETS
    return GOOGLE_BUCKETS[group] ?? DEFAULT_BUCKETS.GOOGLE
  }
  if (channel === 'META') {
    const group = key.slice(key.lastIndexOf(':') + 1) as keyof typeof META_BUCKETS
    return META_BUCKETS[group] ?? DEFAULT_BUCKETS.META
  }
  return DEFAULT_BUCKETS[channel]
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

export interface RedisLike {
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
let sharedRedis: (() => RedisLike | null) | null = null
let sharedStore: { client: RedisLike; store: RedisBucketStore } | null = null

/**
 * The app's Redis, handed over by `lib/queue.ts` when it creates its connection. The bucket never opens
 * a connection itself (importing the queue module would connect every script and test that loads the
 * gateway).
 */
export function registerRateRedis(get: () => RedisLike | null): void {
  sharedRedis = get
}

/** Redis while it is connected; else this process's memory. Never blocks on Redis. */
async function store(): Promise<BucketStore> {
  if (override) return override
  const client = sharedRedis?.() ?? null
  if (!client || client.status !== 'ready') return memory
  if (sharedStore?.client !== client) sharedStore = { client, store: new RedisBucketStore(client) }
  return sharedStore.store
}

export const __rateTest = {
  useMemory() { override = new MemoryBucketStore() },
  /** The shared store on a given Redis client (the P1.1 probe runs it on a throwaway Redis). */
  useRedis(client: RedisLike) { override = new RedisBucketStore(client) },
  reset() { override = null },
  /** What `store()` would pick with no override — for the registration test. */
  async picked() { const saved = override; override = null; try { return (await store()) === memory ? 'memory' : 'redis' } finally { override = saved } },
}

export function bucketKey(channel: GatewayChannel, connectionId: string | null, group: string): string {
  return `${channel}:${connectionId ?? 'app'}:${group}`
}

/** Wait for a token, up to `maxWaitMs`. `ok: false` = still none after waiting (answer rate_limited). */
export async function takeToken(channel: GatewayChannel, key: string, maxWaitMs: number, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<TakeResult & { waitedMs: number }> {
  const s = await store()
  const params = (await s.getParams(key).catch(() => null)) ?? defaultsFor(channel, key)
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
    if (reading.retryAfterSec && reading.retryAfterSec > 0) await s.holdUntil(key, Date.now() + Math.min(reading.retryAfterSec, MAX_HOLD_SEC[channel] ?? 60) * 1000)
    // Amazon reports the operation's sustained rate (requests per second), not its burst: the
    // refill follows the header, the burst stays at the default (10 — Amazon's bursts are 10–30).
    if (channel === 'AMAZON_SP' && reading.limit && reading.limit > 0) {
      const current = (await s.getParams(key)) ?? DEFAULT_BUCKETS.AMAZON_SP
      if (Math.abs(current.refillPerSec - reading.limit) > 1e-9) await s.setParams(key, { refillPerSec: reading.limit, capacity: DEFAULT_BUCKETS.AMAZON_SP.capacity })
    }
  } catch { /* the bucket is advisory; a store error never blocks a call */ }
}
