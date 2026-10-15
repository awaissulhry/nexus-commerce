/**
 * Google Ads steps 1a and 1b — the daily operations allowance, shared by every Nexus process through Redis.
 *
 * Google counts operations per Google Cloud project per day (Explorer access: 2,880 in production). Every Search
 * request is one operation (its later pages are free); `customers:listAccessibleCustomers` is counted as one too.
 * Nexus keeps itself under two caps over a ROLLING 24 hours:
 *
 *   global       NEXUS_GOOGLE_ADS_DAILY_OPS (default 2,400), for every account and the connect flow together — about
 *                109 accounts read once a day at 22 operations each
 *   per account  100 (a daily read is 22 with step 1b, an account's first read 27; a manual read at most once an hour.
 *                When it runs short, a read drops its slower parts first: sync-plan.ts)
 *
 * A run reserves what it may spend BEFORE its first call; a refused reservation means zero calls. The counts live in
 * hourly buckets `nexus:gads:ops:<YYYYMMDDHH>` (and `nexus:gads:ops:acct:<account>:<YYYYMMDDHH>`), 25 h TTL, summed
 * over the last 24. When Google answers that the day's allowance is used up, `markQuotaExhausted` stops every
 * reservation for an hour. Redis down = refused: an allowance nobody can count is not spent.
 *
 * Race-safe without a script: a reservation adds to the current bucket FIRST, then sums; when the sum is over a cap it
 * takes its own share back and refuses. Two reservations racing can both refuse, never both overspend. What a run
 * spent beyond its reservation (retries) is added with `addSpentOps`: spent is spent, so it is never refused.
 */

export const DEFAULT_GLOBAL_DAILY_OPS = 2400
export const ACCOUNT_DAILY_OPS = 100
/**
 * Google Ads changes (2026-10-15): what one account may spend in 24 hours on changes — Google's checks of a change
 * (validate-only, counted as Google does not say they are free), the live reads a change stands on, and the changes
 * themselves. Inside the global cap. A build of up to 900 operations (change-build.ts MAX_BUILD_OPERATIONS) is checked
 * and sent within it (Google's acceptance of a plan is remembered for 30 minutes, so a check and the request right after it
 * pay once).
 */
export const WRITE_ACCOUNT_DAILY_OPS = 2000

/** Which allowance a reservation draws on: the daily read's, or the changes'. Both count against the global cap. */
export type OpsLane = 'read' | 'write'
export const QUOTA_EXHAUSTED_HOLD_MS = 60 * 60_000

const PREFIX = 'nexus:gads:ops'
const EXHAUSTED_KEY = 'nexus:gads:quota-exhausted'
const BUCKET_TTL_SEC = 25 * 3600
const HOURS = 24
const OP_TIMEOUT_MS = 3000

/**
 * The Redis commands the Google Ads read uses (ioredis-compatible): this file's counters, and the read's lock and its
 * memory of refused queries (read-guard.ts), which share this connection and its test seam. `eval` (the lock's
 * compare-and-delete) is optional: without it the lock simply runs out.
 */
export interface OpsRedis {
  status?: string
  incrby(key: string, increment: number): Promise<number>
  decrby(key: string, decrement: number): Promise<number>
  expire(key: string, seconds: number): Promise<unknown>
  mget(...keys: string[]): Promise<Array<string | null>>
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: 'PX', ms: number): Promise<unknown>
  /** SET … PX … NX: 'OK' when set, null when the key was there. */
  set(key: string, value: string, mode: 'PX', ms: number, nx: 'NX'): Promise<unknown>
  eval?(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>
}

let override: OpsRedis | null | undefined

/** Tests: a fake Redis (or null = Redis down); undefined goes back to the app's connection. */
export function setOpsBudgetRedisForTests(client: OpsRedis | null | undefined): void {
  override = client
}

/** The app's Redis for the Google Ads read (null when none is configured). Shared with read-guard.ts. */
export async function googleAdsRedis(): Promise<OpsRedis | null> {
  if (override !== undefined) return override
  if (!process.env.REDIS_URL?.trim() && !process.env.REDIS_HOST?.trim()) return null
  const { redis } = await import('../../../lib/queue.js')
  return redis.connection as unknown as OpsRedis
}
const client = googleAdsRedis

/** ioredis queues commands while it reconnects: a Redis that does not answer in 3 s counts as down. */
export function timed<T>(work: Promise<T>): Promise<T> {
  work.catch(() => {})
  const timeout = new Promise<never>((_, reject) => { setTimeout(() => reject(new Error('Redis did not answer in time')), OP_TIMEOUT_MS).unref?.() })
  return Promise.race<T>([work, timeout])
}

export function globalOpsCap(): number {
  const raw = Number(process.env.NEXUS_GOOGLE_ADS_DAILY_OPS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_GLOBAL_DAILY_OPS
}

const hourOf = (at: Date): string => at.toISOString().slice(0, 13).replace(/[-T]/g, '')
const globalKey = (hour: string) => `${PREFIX}:${hour}`
const accountKey = (account: string, hour: string, lane: OpsLane = 'read') => `${PREFIX}:${lane === 'write' ? 'acctw' : 'acct'}:${account}:${hour}`
const capOf = (lane: OpsLane) => (lane === 'write' ? WRITE_ACCOUNT_DAILY_OPS : ACCOUNT_DAILY_OPS)
const notStarted = (lane: OpsLane) => (lane === 'write' ? 'The Google Ads change is not checked or sent' : 'The Google Ads read is not started')
const lastHours = (now: Date): string[] => Array.from({ length: HOURS }, (_, i) => hourOf(new Date(now.getTime() - i * 3_600_000)))
const sum = (values: Array<string | null>) => values.reduce((total, v) => total + (Number(v) || 0), 0)

/**
 * The first hour start at which `want` more operations fit under `cap` again. `hourly[0]` is the current hour's bucket
 * (without this request), `hourly[23]` the oldest one in the rolling window; one more bucket leaves it each hour.
 */
function freesUpAt(hourly: Array<string | null>, want: number, cap: number, now: Date): Date | null {
  if (want > cap) return null
  const values = hourly.map((v) => Number(v) || 0)
  const hourStart = Math.floor(now.getTime() / 3_600_000) * 3_600_000
  for (let later = 1; later <= HOURS; later++) {
    const stillCounted = values.slice(0, HOURS - later).reduce((total, v) => total + v, 0)
    if (stillCounted + want <= cap) return new Date(hourStart + later * 3_600_000)
  }
  return null
}

export interface OpsReservation {
  ok: boolean
  reason: null | 'redis_unavailable' | 'quota_exhausted' | 'global_cap' | 'account_cap'
  /** Operations reserved (0 when refused). */
  ops: number
  /** The hour the reservation was counted in: give unspent operations back with `releaseOps(…, reservedAt)`. */
  reservedAt: Date
  /** Use over the last 24 hours, this reservation included when ok (null when Redis could not be read). */
  usedGlobal: number | null
  usedAccount: number | null
  capGlobal: number
  capAccount: number
  /** When the "allowance used up" hold ends, when that is the reason. */
  exhaustedUntil: Date | null
  /**
   * When a reservation of this size would first fit again, assuming nothing else is spent meanwhile: the hold's end,
   * or the start of the hour in which enough of the oldest hours have left the rolling 24 (null when Redis is down,
   * or when the request is larger than the cap itself).
   */
  retryAt: Date | null
  /** A plain sentence for a person (empty when ok). */
  sentence: string
}

/**
 * Reserve `ops` operations for one read (`account` = the Google Ads customer id; null = connect-flow calls that
 * belong to no account yet, which count against the global cap only), or for a change (`lane` write: the account's
 * change allowance, WRITE_ACCOUNT_DAILY_OPS).
 */
export async function reserveOps(account: string | null, ops: number, now: Date = new Date(), lane: OpsLane = 'read'): Promise<OpsReservation> {
  const capGlobal = globalOpsCap()
  const capAccount = capOf(lane)
  const what = notStarted(lane)
  const result = (fields: Partial<OpsReservation>): OpsReservation => ({
    ok: false, reason: null, ops: 0, reservedAt: now, usedGlobal: null, usedAccount: null, capGlobal, capAccount, exhaustedUntil: null, retryAt: null, sentence: '', ...fields,
  })
  const want = Math.max(0, Math.floor(ops))
  const redis = await client().catch(() => null)
  if (!redis || redis.status === 'end' || redis.status === 'close') {
    return result({ reason: 'redis_unavailable', sentence: `${what}: Nexus cannot count its Google Ads allowance right now (Redis is not available).` })
  }
  try {
    const until: string | null = await timed(redis.get(EXHAUSTED_KEY))
    const untilDate = until ? new Date(until) : null
    if (untilDate && untilDate.getTime() > now.getTime()) {
      return result({ reason: 'quota_exhausted', exhaustedUntil: untilDate, retryAt: untilDate, sentence: `${what}: Google said today's Google Ads API allowance is used up. ${lane === 'write' ? 'Ask again later.' : 'Nexus tries again later.'}` })
    }
    if (want === 0) return result({ ok: true })
    const hour = hourOf(now)
    const hours = lastHours(now)
    await timed(redis.incrby(globalKey(hour), want))
    await timed(redis.expire(globalKey(hour), BUCKET_TTL_SEC))
    if (account) {
      await timed(redis.incrby(accountKey(account, hour, lane), want))
      await timed(redis.expire(accountKey(account, hour, lane), BUCKET_TTL_SEC))
    }
    const globalHours: Array<string | null> = await timed(redis.mget(...hours.map(globalKey)))
    const accountHours: Array<string | null> | null = account ? await timed(redis.mget(...hours.map((h) => accountKey(account, h, lane)))) : null
    const usedGlobal = sum(globalHours)
    const usedAccount = accountHours ? sum(accountHours) : null
    const overGlobal = usedGlobal > capGlobal
    const overAccount = usedAccount !== null && usedAccount > capAccount
    if (overGlobal || overAccount) {
      await timed(redis.decrby(globalKey(hour), want))
      if (account) await timed(redis.decrby(accountKey(account, hour, lane), want))
      // This request was counted in the current hour's bucket: leave it out when asking when it would fit.
      const without = (hourly: Array<string | null>) => [String((Number(hourly[0]) || 0) - want), ...hourly.slice(1)]
      const globalFits = freesUpAt(without(globalHours), want, capGlobal, now)
      const accountFits = accountHours ? freesUpAt(without(accountHours), want, capAccount, now) : null
      const retryAt = overGlobal && overAccount
        ? (globalFits && accountFits ? new Date(Math.max(globalFits.getTime(), accountFits.getTime())) : null)
        : overGlobal ? globalFits : accountFits
      return result({
        reason: overGlobal ? 'global_cap' : 'account_cap',
        retryAt,
        usedGlobal: usedGlobal - want,
        usedAccount: usedAccount === null ? null : usedAccount - want,
        sentence: overGlobal
          ? `${what}: Nexus has used ${usedGlobal - want} of its ${capGlobal} Google Ads operations in the last 24 hours. ${lane === 'write' ? 'Ask again later.' : 'It tries again later.'}`
          : `${what}: this account has used ${usedAccount - want} of its ${capAccount} Google Ads ${lane === 'write' ? 'change ' : ''}operations in the last 24 hours. ${lane === 'write' ? 'Ask again later.' : 'It tries again later.'}`,
      })
    }
    return result({ ok: true, ops: want, usedGlobal, usedAccount })
  } catch {
    return result({ reason: 'redis_unavailable', sentence: `${what}: Nexus cannot count its Google Ads allowance right now (Redis did not answer).` })
  }
}

/** Give back operations a run reserved and did not spend (to the hour they were counted in). Never throws. */
export async function releaseOps(account: string | null, ops: number, reservedAt: Date, lane: OpsLane = 'read'): Promise<void> {
  const give = Math.max(0, Math.floor(ops))
  if (give === 0) return
  try {
    const redis = await client()
    if (!redis) return
    const hour = hourOf(reservedAt)
    await timed(redis.decrby(globalKey(hour), give))
    if (account) await timed(redis.decrby(accountKey(account, hour, lane), give))
  } catch { /* an unreturned operation only makes the next reservation stricter */ }
}

/**
 * Count operations a run spent beyond what it reserved (a retry that reached Google costs one more). They were spent:
 * they are added to the hour's buckets as they are — never refused, never given back, even over a cap (the next
 * reservation then waits longer). Counted in the reservation's hour, like `releaseOps`. Never throws.
 */
export async function addSpentOps(account: string | null, ops: number, reservedAt: Date, lane: OpsLane = 'read'): Promise<void> {
  const spent = Math.max(0, Math.floor(ops))
  if (spent === 0) return
  try {
    const redis = await client()
    if (!redis) return
    const hour = hourOf(reservedAt)
    await timed(redis.incrby(globalKey(hour), spent))
    await timed(redis.expire(globalKey(hour), BUCKET_TTL_SEC))
    if (account) {
      await timed(redis.incrby(accountKey(account, hour, lane), spent))
      await timed(redis.expire(accountKey(account, hour, lane), BUCKET_TTL_SEC))
    }
  } catch { /* Redis is down: the next reservation is refused anyway */ }
}

/** Google said the day's allowance is used up: refuse every reservation for the next hour. Never throws. */
export async function markQuotaExhausted(now: Date = new Date(), holdMs: number = QUOTA_EXHAUSTED_HOLD_MS): Promise<void> {
  try {
    const redis = await client()
    if (!redis) return
    await timed(redis.set(EXHAUSTED_KEY, new Date(now.getTime() + holdMs).toISOString(), 'PX', holdMs))
  } catch { /* the next call meets Google's own answer again */ }
}

/** Operations counted over the last 24 hours (null when Redis cannot be read). */
export async function opsUsedLast24h(account: string | null, now: Date = new Date()): Promise<{ global: number; account: number | null } | null> {
  try {
    const redis = await client()
    if (!redis) return null
    const hours = lastHours(now)
    const global = sum(await timed(redis.mget(...hours.map(globalKey))))
    const own = account ? sum(await timed(redis.mget(...hours.map((h) => accountKey(account, h))))) : null
    return { global, account: own }
  } catch {
    return null
  }
}
