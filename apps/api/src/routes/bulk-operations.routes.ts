/**
 * Bulk Operations Routes (Phase B-5).
 *
 * Fastify port of the original Express `bulk-actions.routes.ts` (deleted).
 * Endpoints registered at /api/bulk-operations/*. The /preview endpoint
 * is added in Phase B-6; rollback (POST /:id/rollback) is deferred to
 * v2 along with the rollbackData capture work.
 */

import type { FastifyPluginAsync } from 'fastify'
import {
  BulkActionService,
  type BulkActionType,
} from '../services/bulk-action.service.js'
import prisma from '../db.js'
import { CreateBulkJobSchema } from './validation.js'

const bulkActionService = new BulkActionService(prisma)

interface CreateBody {
  jobName?: string
  actionType?: BulkActionType
  channel?: string
  targetProductIds?: string[]
  targetVariationIds?: string[]
  filters?: Record<string, unknown>
  actionPayload?: Record<string, unknown>
  createdBy?: string
}

const bulkOperationsRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /api/bulk-operations
   * Create a new bulk-operation job. Returns the job row including
   * id, totalItems, and PENDING status.
   *
   * The frontend's typical flow:
   *   1. POST here → get jobId
   *   2. POST /:id/process → kick off async processing
   *   3. Poll GET /:id every 1-2s for progressPercent + status
   */
  fastify.post<{ Body: CreateBody }>(
    '/bulk-operations',
    async (request, reply) => {
      const parsed = CreateBulkJobSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({
          success: false,
          error: 'Invalid request body',
          details: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        })
      }
      try {
        const job = await bulkActionService.createJob(parsed.data)
        return reply.code(201).send({ success: true, job })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error)
        fastify.log.error({ err: error }, '[bulk-operations] create failed')
        return reply.code(500).send({ success: false, error: message })
      }
    },
  )

  /**
   * POST /api/bulk-operations/preview
   * Resolve scope + simulate the operation against the first N items
   * without writing. Returns the affected count plus a sample list
   * of current → new values per item. The frontend uses this for
   * the "Preview" step before the user confirms execute.
   *
   * Same body shape as POST /bulk-operations (createJob). No DB
   * write happens — even if the body is valid, no job row is
   * created until the user calls the create endpoint separately.
   */
  fastify.post<{
    Body: CreateBody & { sampleSize?: number }
  }>(
    '/bulk-operations/preview',
    async (request, reply) => {
      const parsed = CreateBulkJobSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({
          success: false,
          error: 'Invalid request body',
          details: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        })
      }
      const sampleSize = Math.min(
        Math.max(request.body?.sampleSize ?? 10, 1),
        50,
      )
      try {
        const result = await bulkActionService.previewJob(
          parsed.data,
          sampleSize,
        )
        return reply.send({ success: true, ...result })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error)
        fastify.log.error(
          { err: error },
          '[bulk-operations] preview failed',
        )
        return reply.code(500).send({ success: false, error: message })
      }
    },
  )

  /**
   * GET /api/bulk-operations
   * List jobs that are still pending (PENDING or QUEUED). Useful for
   * a "recent operations" panel; completed/failed jobs are not in
   * this list — they're queryable via GET /:id when you have the id.
   */
  fastify.get('/bulk-operations', async (_request, reply) => {
    try {
      const jobs = await bulkActionService.getPendingJobs()
      return reply.send({ success: true, jobs, count: jobs.length })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      fastify.log.error({ err: error }, '[bulk-operations] list failed')
      return reply.code(500).send({ success: false, error: message })
    }
  })

  /**
   * GET /api/bulk-operations/:id
   * Status + progress for a specific job. Frontend polls this.
   */
  fastify.get<{ Params: { id: string } }>(
    '/bulk-operations/:id',
    async (request, reply) => {
      const { id } = request.params
      if (!id) {
        return reply
          .code(400)
          .send({ success: false, error: 'job id required' })
      }
      try {
        const job = await bulkActionService.getJobStatus(id)
        if (!job) {
          return reply.code(404).send({
            success: false,
            error: `Job not found: ${id}`,
          })
        }
        return reply.send({ success: true, job })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error)
        fastify.log.error(
          { err: error, jobId: id },
          '[bulk-operations] status failed',
        )
        return reply.code(500).send({ success: false, error: message })
      }
    },
  )

  /**
   * POST /api/bulk-operations/:id/process
   * Trigger processing. Fire-and-forget — returns immediately with
   * "started" and the client polls GET /:id for progress. processJob
   * runs in-process (no queue worker for v1) and updates the job
   * row every 10 items.
   *
   * Hardening for >100-item jobs (BullMQ etc.) is v2 — current code
   * works fine for Xavia-scale operations (~hundreds of products).
   */
  fastify.post<{ Params: { id: string } }>(
    '/bulk-operations/:id/process',
    async (request, reply) => {
      const { id } = request.params
      if (!id) {
        return reply
          .code(400)
          .send({ success: false, error: 'job id required' })
      }
      const job = await bulkActionService.getJobStatus(id)
      if (!job) {
        return reply.code(404).send({
          success: false,
          error: `Job not found: ${id}`,
        })
      }
      if (job.status !== 'PENDING' && job.status !== 'QUEUED') {
        return reply.code(409).send({
          success: false,
          error: `Cannot process job with status: ${job.status}`,
        })
      }
      // Fire-and-forget — log internal failures so they're visible
      // in Railway logs even though the response already returned.
      bulkActionService.processJob(id).catch((error) => {
        const message =
          error instanceof Error ? error.message : String(error)
        fastify.log.error(
          { err: error, jobId: id },
          '[bulk-operations] async processJob failed',
        )
        return message
      })
      return reply.send({
        success: true,
        jobId: id,
        status: 'IN_PROGRESS',
        message: 'Job processing started',
      })
    },
  )

  /**
   * POST /api/bulk-operations/:id/cancel
   * Cancel a still-pending job. Once IN_PROGRESS, in-flight items
   * complete; the queued remainder doesn't run. (For v1, processJob
   * doesn't check the cancel flag mid-loop — it only matters for
   * jobs that haven't started yet. Mid-run cancellation is v2.)
   */
  fastify.post<{ Params: { id: string } }>(
    '/bulk-operations/:id/cancel',
    async (request, reply) => {
      const { id } = request.params
      if (!id) {
        return reply
          .code(400)
          .send({ success: false, error: 'job id required' })
      }
      try {
        const cancelled = await bulkActionService.cancelJob(id)
        return reply.send({ success: true, job: cancelled })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error)
        fastify.log.error(
          { err: error, jobId: id },
          '[bulk-operations] cancel failed',
        )
        // Map state-machine guards from the service to a 409.
        if (message.startsWith('Cannot cancel job')) {
          return reply.code(409).send({ success: false, error: message })
        }
        if (message.startsWith('Job not found')) {
          return reply.code(404).send({ success: false, error: message })
        }
        return reply.code(500).send({ success: false, error: message })
      }
    },
  )
}

export default bulkOperationsRoutes
