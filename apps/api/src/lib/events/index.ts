// EV.1 — event infrastructure barrel + the process-wide broker.
//
// One broker instance per process. Redis Streams when Redis is configured,
// otherwise a no-op that drops publishes — the outbox row is already committed
// either way, so nothing is lost: the events simply stay pending until a
// broker exists. That is what lets the whole system boot and serve HTTP on a
// machine with no Redis, which local development depends on.

import { logger } from '../../utils/logger.js'
import { NoopBroker, type EventBroker } from './broker.js'
import { RedisStreamsBroker, isRedisConfigured } from './redis-streams.driver.js'

export * from './broker.js'
export * from './correlation.js'
export * from './publish.js'
export * from './relay.js'
export * from './subscribe.js'
export { isRedisConfigured, streamStats } from './redis-streams.driver.js'
export * from './ephemeral.js'

let instance: EventBroker | null = null

export function getBroker(): EventBroker {
  if (!instance) {
    instance = isRedisConfigured() ? new RedisStreamsBroker() : new NoopBroker()
    if (instance.name === 'noop') {
      logger.warn('event broker: Redis not configured — events will accumulate in the outbox unpublished')
    }
  }
  return instance
}

/** Test seam: swap the process broker (e.g. for InMemoryBroker). */
export function setBroker(broker: EventBroker | null): void {
  instance = broker
}

export async function closeBroker(): Promise<void> {
  await instance?.close()
  instance = null
}
