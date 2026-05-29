import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import { config } from './config.js'
import type { SetBidJob } from './types.js'

/** Shared connection. BullMQ requires maxRetriesPerRequest: null on the bclient. */
export const connection: Redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null })

export const bidQueue = new Queue<SetBidJob>(config.queueName, {
  connection,
  defaultJobOptions: {
    attempts: 6,
    backoff: { type: 'exponential', delay: 1_000 }, // 1s,2s,4s,…32s
    removeOnComplete: 1_000,
    removeOnFail: 5_000,
  },
})

export const JOB_SET_BID = 'set-keyword-bid' as const
