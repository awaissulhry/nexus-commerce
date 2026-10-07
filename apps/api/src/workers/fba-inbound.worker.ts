/**
 * Step 4 Send to FBA — the plan worker. Thin: it runs `runFbaPlan`, which claims the plan and runs its Amazon steps
 * until a person is needed or Amazon is still working (services/fba-inbound/runner.ts). The job carries its business
 * profile (`WorkspaceWorker` + `scopeJobData`), so every read and call happens in it. Concurrency 1: Amazon allows two
 * inbound writes a second per account, and a plan's steps run one after another anyway.
 */
import { type Job } from 'bullmq'
import { WorkspaceWorker as Worker } from '../lib/workspace-jobs.js'
import { redis } from '../lib/queue.js'
import { logger } from '../utils/logger.js'
import { FBA_INBOUND_QUEUE } from '../services/fba-inbound/contract.js'

export interface FbaInboundJobData { planRowId: string }

let worker: Worker<FbaInboundJobData> | null = null

export function initializeFbaInboundWorker(): Worker<FbaInboundJobData> {
  if (worker) return worker
  worker = new Worker<FbaInboundJobData>(FBA_INBOUND_QUEUE, async (job: Job<FbaInboundJobData>) => {
    const { runFbaPlan } = await import('../services/fba-inbound/contract.js')
    return runFbaPlan(job.data.planRowId)
  }, {
    connection: redis.connection,
    concurrency: 1,
  })
  worker.on('failed', (job, error) => logger.warn('[fba-inbound-worker] failed; the resume job re-queues the plan when its nextCheckAt is due',
    { bullJobId: job?.id, planRowId: job?.data?.planRowId, error: error instanceof Error ? error.message : String(error) }))
  return worker
}
