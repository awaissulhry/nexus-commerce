import type { Redis } from 'ioredis'

/**
 * The abuse guard's counters (B-W2b-159; PLT-066): fixed windows that start at the first hit, and claims that hold once.
 * In Redis (shared by every replica, under `<FACTORY_QUEUE_PREFIX>:abuse:`), in memory in tests; `failoverStore` keeps
 * counting in this process's memory while Redis does not answer, so a Redis outage neither opens the public routes wide
 * nor locks partners out. Keys are HMACs made by the guard: no address, e-mail or token is ever a key.
 */

export interface WindowCount {
  /** Hits in the window, this one included (peek: without one). */
  readonly count: number
  /** When the window ends, from now. */
  readonly resetInMs: number
}

export interface AbuseStore {
  /** Counts one hit in the key's window (a new window of `windowMs` starts at the first hit). */
  hit(key: string, windowMs: number): Promise<WindowCount>
  /** The key's window without a hit (count 0 when there is none). */
  peek(key: string): Promise<WindowCount>
  /** True the first time a key is claimed within `ttlMs`; false afterwards (a solved challenge is used once). */
  claimOnce(key: string, ttlMs: number): Promise<boolean>
  /** Forgets a key (a window or a claim). */
  forget(key: string): Promise<void>
}

const HIT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`

/** The counters in Redis (atomic: one script per hit). */
export function redisAbuseStore(redis: Redis): AbuseStore {
  return {
    async hit(key, windowMs) {
      const [count, ttl] = (await redis.eval(HIT, 1, key, String(windowMs))) as [number, number]
      return { count: Number(count), resetInMs: Math.max(0, Number(ttl)) }
    },
    async peek(key) {
      const [value, ttl] = await Promise.all([redis.get(key), redis.pttl(key)])
      return { count: value === null ? 0 : Number(value), resetInMs: Math.max(0, ttl) }
    },
    async claimOnce(key, ttlMs) {
      return (await redis.set(key, '1', 'PX', ttlMs, 'NX')) === 'OK'
    },
    async forget(key) {
      await redis.del(key)
    },
  }
}

/** The counters in this process (tests; the fallback while Redis is down). `now` is the guard's clock. */
export function memoryAbuseStore(now: () => number = Date.now): AbuseStore {
  const windows = new Map<string, { count: number; endsAt: number }>()
  const live = (key: string) => {
    const entry = windows.get(key)
    if (entry && entry.endsAt <= now()) {
      windows.delete(key)
      return undefined
    }
    return entry
  }
  const prune = () => {
    if (windows.size < 10_000) return
    const at = now()
    for (const [key, entry] of windows) if (entry.endsAt <= at) windows.delete(key)
  }
  return {
    async hit(key, windowMs) {
      prune()
      const entry = live(key) ?? { count: 0, endsAt: now() + windowMs }
      entry.count += 1
      windows.set(key, entry)
      return { count: entry.count, resetInMs: entry.endsAt - now() }
    },
    async peek(key) {
      const entry = live(key)
      return entry ? { count: entry.count, resetInMs: entry.endsAt - now() } : { count: 0, resetInMs: 0 }
    },
    async claimOnce(key, ttlMs) {
      prune()
      if (live(key)) return false
      windows.set(key, { count: 1, endsAt: now() + ttlMs })
      return true
    },
    async forget(key) {
      windows.delete(key)
    },
  }
}

/**
 * Redis first; while it fails, this process's memory (each replica then counts on its own, which still limits). The
 * first failure is logged once, and again when Redis answers.
 */
export function failoverStore(primary: AbuseStore, fallback: AbuseStore, log: { warn(object: object, message: string): void; info(message: string): void } = console): AbuseStore {
  let down = false
  const run = async <T>(work: (store: AbuseStore) => Promise<T>): Promise<T> => {
    try {
      const result = await work(primary)
      if (down) {
        down = false
        log.info('the abuse counters are back in Redis')
      }
      return result
    } catch (error) {
      if (!down) {
        down = true
        log.warn({ err: error }, 'Redis does not answer: the abuse counters count in this process until it does')
      }
      return work(fallback)
    }
  }
  return {
    hit: (key, windowMs) => run((store) => store.hit(key, windowMs)),
    peek: (key) => run((store) => store.peek(key)),
    claimOnce: (key, ttlMs) => run((store) => store.claimOnce(key, ttlMs)),
    forget: (key) => run((store) => store.forget(key)),
  }
}
