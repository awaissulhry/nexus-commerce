/**
 * BullMQ Queue Configuration
 *
 * Enterprise-grade Redis message broker for the Autopilot
 *
 * IMPORTANT: every Redis-touching object (Redis client, Queue, QueueEvents)
 * is lazy-initialized. Module load must NEVER open a Redis connection — that
 * caused boot failures on Railway when REDIS_URL wasn't yet in env. Queues
 * are created on first property access via the getters below.
 */

import { Queue, QueueEvents } from 'bullmq'
import Redis from 'ioredis'
import { logger } from '../utils/logger.js'

// ── Lazy singletons ──────────────────────────────────────────────────────
let _redis: Redis | null = null
let _outboundSyncQueue: Queue | null = null
let _channelSyncQueue: Queue | null = null
let _queueEvents: QueueEvents | null = null
let _channelSyncQueueEvents: QueueEvents | null = null
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

const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 2000,
  },
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 86400 },
}

function getOutboundSyncQueue(): Queue {
  if (!_outboundSyncQueue) {
    _outboundSyncQueue = new Queue('outbound-sync', {
      connection: getRedisConnection(),
      defaultJobOptions,
    })
  }
  return _outboundSyncQueue
}

function getChannelSyncQueue(): Queue {
  if (!_channelSyncQueue) {
    _channelSyncQueue = new Queue('channel-sync', {
      connection: getRedisConnection(),
      defaultJobOptions,
    })
  }
  return _channelSyncQueue
}

function getQueueEvents(): QueueEvents {
  if (!_queueEvents) {
    _queueEvents = new QueueEvents('outbound-sync', {
      connection: getRedisConnection(),
    })
    attachEventListeners(_queueEvents)
  }
  return _queueEvents
}

function getChannelSyncQueueEvents(): QueueEvents {
  if (!_channelSyncQueueEvents) {
    _channelSyncQueueEvents = new QueueEvents('channel-sync', {
      connection: getRedisConnection(),
    })
  }
  return _channelSyncQueueEvents
}

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

// ── Public proxy exports ─────────────────────────────────────────────────
// These wrap the lazy getters so existing call sites (e.g. `outboundSyncQueue.add(...)`)
// keep working unchanged. The first method invocation triggers initialization.
//
// SUSPECT SITE — TECH_DEBT #54.  `outboundSyncQueue.add()` awaited from
// bulk-action's processJob (and from its request-scoped POST handler) hangs
// indefinitely. `bulkListQueue` (constructed eagerly via `new Queue(...)` in
// services/bulk-list.service.ts) does NOT hang from the same BullMQ version
// + same redis.connection — strongly suggesting the discriminator is THIS
// proxy. Hypothesis worth testing on a focused investigation session: rip
// out the proxy for outboundSyncQueue and switch to the eager pattern,
// keeping it lazy for the remaining queues. The lazy pattern was added to
// prevent module-load Redis dial-out before REDIS_URL was in env on
// Railway (boot failure); index.ts:1 now loads dotenv first via db.js so
// the original race may no longer apply, but verify before changing.

function makeQueueProxy(getter: () => Queue): Queue {
  return new Proxy({} as Queue, {
    get(_target, prop, receiver) {
      const q = getter()
      const value = Reflect.get(q, prop, receiver)
      return typeof value === 'function' ? value.bind(q) : value
    },
  })
}

function makeQueueEventsProxy(getter: () => QueueEvents): QueueEvents {
  return new Proxy({} as QueueEvents, {
    get(_target, prop, receiver) {
      const e = getter()
      const value = Reflect.get(e, prop, receiver)
      return typeof value === 'function' ? value.bind(e) : value
    },
  })
}

export const redis = {
  get connection() {
    return getRedisConnection()
  },
}

export const outboundSyncQueue: Queue = makeQueueProxy(getOutboundSyncQueue)
export const channelSyncQueue: Queue = makeQueueProxy(getChannelSyncQueue)
export const queueEvents: QueueEvents = makeQueueEventsProxy(getQueueEvents)
export const channelSyncQueueEvents: QueueEvents = makeQueueEventsProxy(getChannelSyncQueueEvents)

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

    // Force queue creation + attach event listeners
    getQueueEvents()
    const counts = await getOutboundSyncQueue().getJobCounts()
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
    if (_outboundSyncQueue) await _outboundSyncQueue.close()
    if (_channelSyncQueue) await _channelSyncQueue.close()
    if (_queueEvents) await _queueEvents.close()
    if (_channelSyncQueueEvents) await _channelSyncQueueEvents.close()
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
    const queue = getOutboundSyncQueue()
    const counts = await queue.getJobCounts()
    const isPaused = await queue.isPaused()

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
