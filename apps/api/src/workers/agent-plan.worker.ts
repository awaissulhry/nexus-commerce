/**
 * MCP full control C6 — the change-plan worker.
 *
 * One job per approved plan (jobId "agent-plan-<approvalId>", queued by the approval's commit and, for a plan nobody
 * runs, by the approval sweep). It runs the plan's pending steps in order (services/agents/change-plan.service.ts
 * runPlan): each claimed, re-checked and run as the person who approved it, in the plan's business (WorkspaceWorker
 * binds the job's business). Safe to run twice or after a stop: only pending steps are claimed.
 */

import { WorkspaceWorker as Worker } from '../lib/workspace-jobs.js'
import { redis } from '../lib/queue.js'
import { runPlan } from '../services/agents/change-plan.service.js'
import { logger } from '../utils/logger.js'

export function initializeAgentPlanWorker() {
  const worker = new Worker(
    'agent-plan',
    async (job) => {
      const { approvalId } = job.data as { approvalId?: string }
      if (!approvalId) {
        logger.warn('[agent-plan] job missing approvalId', { jobId: job.id })
        return
      }
      const out = await runPlan(approvalId)
      logger.info('[agent-plan] plan run', { approvalId, ran: out.ran, finished: out.finished, counts: out.counts ?? null })
    },
    // One plan at a time per worker: its steps run in order, and a plan of 200 price changes is enough load.
    { connection: redis.connection, concurrency: 1 },
  )
  worker.on('failed', (job, err) => {
    logger.warn('[agent-plan] job failed', { jobId: job?.id, approvalId: job?.data?.approvalId, error: err.message })
  })
  return worker
}
