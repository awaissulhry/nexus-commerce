import { Redis } from 'ioredis'
import { loadFactoryEnv } from '../../env'
import { processSecrets } from '../secrets/service'
import { createGateway, type Gateway } from './gateway'

/**
 * The process's gateway, made on first use from apps/factory-api/.env (Redis, queue prefix, environment) and the
 * process's secrets service; tests and the processes that already hold a Redis connection set their own with
 * useGateway(createGateway({ … })), like core/sse.ts useLiveFeed(). Its Redis connection fails fast (one retry, 2 s to
 * connect): a call without its limits is refused, never sent.
 */

let configured: Gateway | undefined
let fromEnv: Gateway | undefined

export function useGateway(gateway: Gateway | undefined): void {
  configured = gateway
}

export function processGateway(): Gateway {
  if (configured) return configured
  if (!fromEnv) {
    const env = loadFactoryEnv()
    const redis = new Redis(env.FACTORY_REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 2_000 })
    redis.on('error', () => {})
    fromEnv = createGateway({ environment: env.FACTORY_ENV, redis, prefix: env.FACTORY_QUEUE_PREFIX, secrets: processSecrets() })
  }
  return fromEnv
}
