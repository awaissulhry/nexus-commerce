import { Redis } from 'ioredis'
import { loadFactoryEnv } from '../../../env'

/**
 * The API's Redis for integration health (B-W2b-415): the Run-now list the scheduler reads (core/cron-runs.ts), the
 * background queues a failed job is run again from, and a connection's circuit that Reconnect closes. Made on first use from
 * the environment (Redis, queue prefix), like the gateway's (platform/gateway/service.ts); it fails fast (one retry, 2 s to
 * connect): an action that needs it answers 503 in words, never waits. Tests set their own with useHealthRedis.
 */

export interface HealthRedis {
  readonly redis: Redis
  readonly prefix: string
}

let configured: HealthRedis | undefined
let fromEnv: HealthRedis | undefined

export function useHealthRedis(value: HealthRedis | undefined): void {
  configured = value
}

export function processHealthRedis(): HealthRedis {
  if (configured) return configured
  if (!fromEnv) {
    const env = loadFactoryEnv()
    const redis = new Redis(env.FACTORY_REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 2_000 })
    redis.on('error', () => {})
    fromEnv = { redis, prefix: env.FACTORY_QUEUE_PREFIX }
  }
  return fromEnv
}
