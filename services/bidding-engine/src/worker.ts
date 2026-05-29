/**
 * The BullMQ worker. For each bid job it:
 *   1. acquires a per-profile token (distributed bucket) — never exceeds the rate,
 *   2. performs the v3 Amazon write,
 *   3. on 429, delays the job by the server's Retry-After and rethrows so BullMQ's
 *      exponential backoff + attempts own the retry (the DLQ catches the rest),
 *   4. reports the outcome to the primary app (which updates the row + audit).
 */
import { Worker, type Job } from 'bullmq'
import { connection } from './queue.js'
import { config } from './config.js'
import { TokenBucket } from './rate-limiter.js'
import { AmazonAdsClient, ThrottleError } from './amazon-client.js'
import { PrimaryClient } from './primary-client.js'
import type { SetBidJob } from './types.js'

const bucket = new TokenBucket(connection, config.worker.bucketCapacity, config.worker.bucketRefillPerSec)
const amazon = new AmazonAdsClient()
const primary = new PrimaryClient()

export const metrics = { processed: 0, applied: 0, throttled: 0, failed: 0 }

export function startWorker(): Worker<SetBidJob> {
  const worker = new Worker<SetBidJob>(
    config.queueName,
    async (job: Job<SetBidJob>) => {
      const { accountRef, externalId, bidMinor, prevBidMinor, bridgeId } = job.data

      // 1) rate gate (per Amazon profile, cross-replica)
      await bucket.acquire(accountRef)

      // 2) write
      try {
        await amazon.updateKeywordBid(accountRef, externalId, bidMinor)
      } catch (err) {
        if (err instanceof ThrottleError) {
          metrics.throttled++
          await job.moveToDelayed(Date.now() + err.retryAfterMs, job.token)
          throw new Error('throttled-429') // backoff owns the retry
        }
        throw err
      }

      // 3) ack to the primary app (row update + audit live there)
      metrics.applied++
      await primary
        .reportApplied({ bridgeId, externalId, bidMinor, prevBidMinor, status: config.worker.dryRun ? 'dry-run' : 'applied' })
        .catch(() => undefined) // ack failure must not fail an already-applied write
    },
    {
      connection,
      concurrency: config.worker.concurrency,
      // global safety valve on top of the per-profile bucket
      limiter: { max: 20, duration: 1_000 },
    },
  )

  worker.on('completed', () => { metrics.processed++ })
  worker.on('failed', (job, err) => {
    if (err?.message === 'throttled-429') return // expected backoff, not a real failure
    metrics.failed++
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      // exhausted → tell the primary so the local row isn't left optimistic
      void primary.reportApplied({
        bridgeId: job.data.bridgeId, externalId: job.data.externalId,
        bidMinor: job.data.bidMinor, prevBidMinor: job.data.prevBidMinor, status: 'failed',
      }).catch(() => undefined)
    }
  })

  return worker
}
