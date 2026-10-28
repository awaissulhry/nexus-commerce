import type { Redis } from 'ioredis'

/**
 * The gateway's per-account limits in Redis (feature PLT-195), shared by every API, worker and scheduler replica, all
 * under the process's queue prefix (FACTORY_QUEUE_PREFIX: the local Redis is shared by every worktree):
 *
 *   <prefix>:gateway:rate:<accountId>      a token bucket: `rateLimitBurst` tokens, refilled at `rateLimitPerMinute`;
 *                                          one token per call. Out of tokens → the wait until the next one.
 *   <prefix>:gateway:circuit:<accountId>   the circuit breaker: failed calls in a row; at `circuitFailureThreshold`
 *                                          the circuit opens for `circuitCooldownSeconds` (calls are refused without
 *                                          reaching the provider). Then ONE trial call is let through
 *                                          (<prefix>:gateway:probe:<accountId>, SET NX): success closes the circuit,
 *                                          failure opens it again for another cool-down.
 *
 * Each step is one Lua script, so replicas never race. Times are the gateway clock's milliseconds (tests move it).
 * Keys expire on their own (a day after the last use), so an account that is no longer called leaves nothing behind.
 */

export interface AccountLimits {
  readonly id: string
  readonly rateLimitPerMinute: number
  readonly rateLimitBurst: number
  readonly circuitFailureThreshold: number
  readonly circuitCooldownSeconds: number
}

const DAY_MS = 24 * 60 * 60 * 1000

const TAKE = `
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local rate = tonumber(ARGV[3])
local data = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(data[1])
local at = tonumber(data[2])
if tokens == nil or at == nil then
  tokens = capacity
  at = now
end
if now > at then
  tokens = math.min(capacity, tokens + (now - at) * rate)
  at = now
end
local allowed = 0
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  wait = math.ceil((1 - tokens) / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'at', tostring(at))
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return {allowed, wait}
`

const CHECK = `
local now = tonumber(ARGV[1])
local openUntil = tonumber(redis.call('HGET', KEYS[1], 'openUntil') or '0')
if openUntil == 0 then
  return {1, 0, 0}
end
if now < openUntil then
  return {0, 0, openUntil - now}
end
if redis.call('SET', KEYS[2], ARGV[1], 'NX', 'PX', ARGV[2]) then
  return {1, 1, 0}
end
return {0, 0, tonumber(ARGV[2])}
`

const FAILURE = `
local now = tonumber(ARGV[1])
local failures = redis.call('HINCRBY', KEYS[1], 'failures', 1)
local opened = 0
if ARGV[4] == '1' or failures >= tonumber(ARGV[2]) then
  redis.call('HSET', KEYS[1], 'openUntil', tostring(now + tonumber(ARGV[3])))
  opened = 1
end
redis.call('DEL', KEYS[2])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return {failures, opened}
`

export interface Take {
  readonly allowed: boolean
  /** When not allowed: milliseconds until the next token. */
  readonly waitMs: number
}

export interface CircuitCheck {
  readonly allowed: boolean
  /** This call is the one trial call of a half-open circuit. */
  readonly probe: boolean
  /** When not allowed: milliseconds until a call may try again. */
  readonly retryAfterMs: number
}

export class GatewayLimits {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  private key(kind: 'rate' | 'circuit' | 'probe', accountId: string): string {
    return `${this.prefix}:gateway:${kind}:${accountId}`
  }

  /** Takes one token from the account's bucket. */
  async take(account: AccountLimits, nowMs: number): Promise<Take> {
    const capacity = Math.max(1, account.rateLimitBurst)
    const perMs = Math.max(1, account.rateLimitPerMinute) / 60_000
    const [allowed, wait] = (await this.redis.eval(TAKE, 1, this.key('rate', account.id), nowMs, capacity, perMs, DAY_MS)) as [number, number]
    return { allowed: allowed === 1, waitMs: allowed === 1 ? 0 : Math.max(1, wait) }
  }

  /** May the account be called now? An open circuit refuses; after its cool-down one trial call passes. */
  async check(account: AccountLimits, nowMs: number): Promise<CircuitCheck> {
    const cooldownMs = Math.max(1, account.circuitCooldownSeconds) * 1000
    const [allowed, probe, retryAfter] = (await this.redis.eval(CHECK, 2, this.key('circuit', account.id), this.key('probe', account.id), nowMs, cooldownMs)) as [
      number,
      number,
      number,
    ]
    return { allowed: allowed === 1, probe: probe === 1, retryAfterMs: Number(retryAfter) }
  }

  /** A call reached the provider and it answered (any answer but a server error or a rate limit): the circuit closes. */
  async succeeded(account: AccountLimits): Promise<void> {
    await this.redis.del(this.key('circuit', account.id), this.key('probe', account.id))
  }

  /** A call failed (timeout, network, 5xx, 429): one more in a row; at the threshold, or a failed trial, it opens. */
  async failed(account: AccountLimits, nowMs: number, probe: boolean): Promise<{ failures: number; opened: boolean }> {
    const cooldownMs = Math.max(1, account.circuitCooldownSeconds) * 1000
    const [failures, opened] = (await this.redis.eval(
      FAILURE,
      2,
      this.key('circuit', account.id),
      this.key('probe', account.id),
      nowMs,
      Math.max(1, account.circuitFailureThreshold),
      cooldownMs,
      probe ? '1' : '0',
      cooldownMs + DAY_MS,
    )) as [number, number]
    return { failures, opened: opened === 1 }
  }
}
