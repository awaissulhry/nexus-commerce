/**
 * BullMQ Queue Configuration
 *
 * Eager Queue / QueueEvents construction (post-TECH_DEBT-#54). The Redis
 * connection itself stays lazy via the `redis.connection` getter so the
 * original Railway boot-failure (module-load Redis dial-out before
 * REDIS_URL was in env) is still avoided — index.ts loads dotenv first
 * via db.js, but the lazy Redis getter is the safety net.
 *
 * History: queues used to be wrapped in a `makeQueueProxy(getter)`
 * Proxy that constructed the Queue on first property access. That
 * proxy interacted badly with BullMQ's internals when `Queue.add(...)`
 * was awaited from bulk-action's processJob context — Queue.add never
 * resolved, the per-job loop wedged, and the API box went unhealthy
 * within ~2 min. The bulk-list service's eager `new Queue(...)`
 * pattern (services/bulk-list.service.ts) was the proof point: same
 * BullMQ version + same redis.connection, no hang.
 *
 * The discriminator is the proxy itself. JavaScript getters on the
 * Queue prototype (e.g. internal `client`, ready-state accessors)
 * resolve with `this = receiver = proxy` rather than the underlying
 * Queue instance, so internal state reads silently return undefined
 * and BullMQ waits for events that never fire. `value.bind(q)` only
 * fixes function-call `this`, not getter-resolution `this`.
 *
 * This file now constructs Queue + QueueEvents eagerly via the
 * `redis.connection` getter (mirrors bulk-list.service.ts). Boot-time
 * cost: one ioredis client + four queue clients open at module load
 * time. That's ~5 sockets in production where Redis is reachable, and
 * graceful retries when it's not (maxRetriesPerRequest: null).
 */

import { Queue, QueueEvents } from 'bullmq'
import Redis from 'ioredis'
import { logger } from '../utils/logger.js'

// ── Lazy Redis client (the only thing that stays lazy) ────────────────────
let _redis: Redis | null = null
let _eventListenersAttached = false

function getRedisConnection(): Redis {
  if (!_redis) {
    const redisConfig = process.env.REDIS_URL?.includes('rediss://')
      ? {
          url: process.env.REDIS_URL,
          tls: { rejectUnauthorized: false },
          maxRetriesPerRequest: null as null,
          enableReadyCheck: false,
        }
      : {
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379'),
          maxRetriesPerRequest: null as null,
          enableReadyCheck: false,
        }

    _redis = new Redis(redisConfig)
  }
  return _redis
}

export const redis = {
  get connection() {
    return getRedisConnection()
  },
}

const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 2000,
  },
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 86400 },
}

// ── Eager Queue + QueueEvents construction ────────────────────────────────
// Mirrors services/bulk-list.service.ts (which never hung in production).
// `connection: redis.connection` resolves the getter at module-load time —
// dotenv has already loaded by import order (index.ts:1 imports db.js
// which loads dotenv before any other side-effecting import).

export const outboundSyncQueue: Queue = new Queue('outbound-sync', {
  connection: redis.connection,
  defaultJobOptions,
})

export const channelSyncQueue: Queue = new Queue('channel-sync', {
  connection: redis.connection,
  defaultJobOptions,
})

export const queueEvents: QueueEvents = new QueueEvents('outbound-sync', {
  connection: redis.connection,
})

export const channelSyncQueueEvents: QueueEvents = new QueueEvents('channel-sync', {
  connection: redis.connection,
})

attachEventListeners(queueEvents)

function attachEventListeners(events: QueueEvents) {
  if (_eventListenersAttached) return
  _eventListenersAttached = true
  events.on('completed', ({ jobId }) => {
    logger.debug('Job completed', { jobId })
  })
  events.on('failed', ({ jobId, failedReason }) => {
    logger.warn('Job failed', { jobId, failedReason })
  })
  events.on('error', (error) => {
    logger.error('Queue error', { error: error instanceof Error ? error.message : String(error) })
  })
}

/**
 * Initialize queue and verify Redis connection
 */
export async function initializeQueue() {
  try {
    const conn = getRedisConnection()
    await conn.ping()
    logger.info('✅ Redis connection established', {
      url: process.env.REDIS_URL ? '[rediss://***]' : undefined,
      host: !process.env.REDIS_URL ? (process.env.REDIS_HOST || 'localhost') : undefined,
      port: !process.env.REDIS_URL ? parseInt(process.env.REDIS_PORT || '6379') : undefined,
    })

    const counts = await outboundSyncQueue.getJobCounts()
    logger.info('📊 Queue initialized', {
      waiting: counts.waiting,
      active: counts.active,
      completed: counts.completed,
      failed: counts.failed,
      delayed: counts.delayed,
    })

    return true
  } catch (error) {
    logger.error('❌ Failed to initialize queue', {
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/**
 * Gracefully close queue and Redis connection
 */
export async function closeQueue() {
  try {
    await outboundSyncQueue.close()
    await channelSyncQueue.close()
    await queueEvents.close()
    await channelSyncQueueEvents.close()
    if (_redis) await _redis.quit()
    logger.info('✅ Queue and Redis connection closed')
  } catch (error) {
    logger.error('Error closing queue', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Get queue statistics for monitoring
 */
export async function getQueueStats() {
  try {
    const counts = await outboundSyncQueue.getJobCounts()
    const isPaused = await outboundSyncQueue.isPaused()

    return {
      waiting: counts.waiting,
      active: counts.active,
      completed: counts.completed,
      failed: counts.failed,
      delayed: counts.delayed,
      isPaused,
      timestamp: new Date().toISOString(),
    }
  } catch (error) {
    logger.error('Error getting queue stats', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
