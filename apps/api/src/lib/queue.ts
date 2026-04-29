/**
 * BullMQ Queue Configuration
 *
 * Enterprise-grade Redis message broker for the Autopilot
 * Replaces node-cron database polling with event-driven architecture
 */

import { Queue, QueueEvents } from 'bullmq'
import Redis from 'ioredis'
import { logger } from '../utils/logger.js'

// Lazy-initialized Redis singleton — reads env vars on first access, not at module load
let _redis: Redis | null = null

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

export const redis = getRedisConnection()

// Initialize the outbound-sync queue
export const outboundSyncQueue = new Queue('outbound-sync', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: {
      age: 3600,
    },
    removeOnFail: {
      age: 86400,
    },
  },
})

// Initialize the channel-sync queue (Phase 25)
export const channelSyncQueue = new Queue('channel-sync', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: {
      age: 3600,
    },
    removeOnFail: {
      age: 86400,
    },
  },
})

// Initialize the stock-updates queue (inventory sync)
export const stockUpdateQueue = new Queue('stock-updates', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: {
      age: 3600,
    },
    removeOnFail: {
      age: 86400,
    },
  },
})

// Queue events for monitoring
export const queueEvents = new QueueEvents('outbound-sync', {
  connection: redis,
})

// Channel sync queue events for monitoring
export const channelSyncQueueEvents = new QueueEvents('channel-sync', {
  connection: redis,
})

// Event listeners for queue monitoring
queueEvents.on('completed', ({ jobId }) => {
  logger.debug('Job completed', { jobId })
})

queueEvents.on('failed', ({ jobId, failedReason }) => {
  logger.warn('Job failed', { jobId, failedReason })
})

queueEvents.on('error', (error) => {
  logger.error('Queue error', { error: error instanceof Error ? error.message : String(error) })
})

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
    await queueEvents.close()
    await redis.quit()
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
