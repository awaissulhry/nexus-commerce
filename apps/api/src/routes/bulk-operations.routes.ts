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
  /**
   * Conflict detection (Commit 18). When false/unset, the create endpoint
   * pre-flights `findConflictingJobs` and returns 409 with the conflict
   * list if any active job touches overlapping productIds + same actionType.
   * Set true to acknowledge the conflict and create the job anyway — the
   * "force" path is logged for audit.
   */
  force?: boolean
}

/**
 * W10.1 — Compact change-signature for the SSE stream. Hash the
 * tracked progress fields into a short string; the SSE handler
 * only emits an `update` event when this signature changes.
 * Avoids spamming the client with no-op events on each 1s tick.
 */
function sigFor(job: {
  status: string
  totalItems: number
  processedItems: number
  failedItems: number
  skippedItems: number
  progressPercent: number
  lastError: string | null
}): string {
  return [
    job.status,
    job.totalItems,
    job.processedItems,
    job.failedItems,
    job.skippedItems,
    job.progressPercent,
    job.lastError ?? '',
  ].join('|')
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
        const force = request.body?.force === true
        if (!force) {
          const conflicts = await bulkActionService.findConflictingJobs(
            parsed.data,
          )
          if (conflicts.length > 0) {
            return reply.code(409).send({
              success: false,
              error: 'Conflicting bulk job(s) in flight on overlapping products',
              code: 'BULK_CONFLICT',
              conflicts,
            })
          }
        } else {
          fastify.log.warn(
            {
              actionType: parsed.data.actionType,
              jobName: parsed.data.jobName,
            },
            '[bulk-operations] force=true — bypassing conflict detection',
          )
        }
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
   * POST /api/bulk-operations/check-conflicts
   * Pre-flight conflict check without creating a job. Used by the
   * Bulk Operation modal to surface overlapping in-flight jobs to
   * the operator BEFORE they click Execute, so they can wait for
   * the prior run or explicitly accept the override.
   *
   * Body shape mirrors POST /bulk-operations (validated against
   * CreateBulkJobSchema). Returns `{ conflicts: ConflictingJob[] }`
   * — empty array when clear to proceed.
   */
  fastify.post<{ Body: CreateBody }>(
    '/bulk-operations/check-conflicts',
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
        const conflicts = await bulkActionService.findConflictingJobs(
          parsed.data,
        )
        return reply.send({ success: true, conflicts })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error)
        fastify.log.error(
          { err: error },
          '[bulk-operations] check-conflicts failed',
        )
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
   * GET /api/bulk-operations/history
   * Paginated job history for the /bulk-operations/history page.
   * Ordered by createdAt DESC. Supports status / actionType / since
   * filters. Default limit 50, max 100.
   *
   * Convenience status aliases:
   *   - 'active'   → PENDING / QUEUED / IN_PROGRESS
   *   - 'terminal' → COMPLETED / PARTIALLY_COMPLETED / FAILED / CANCELLED
   */
  fastify.get<{
    Querystring: {
      limit?: string
      status?: string
      actionType?: string
      since?: string
    }
  }>('/bulk-operations/history', async (request, reply) => {
    try {
      const { limit, status, actionType, since } = request.query
      const jobs = await bulkActionService.listJobs({
        limit: limit ? Number(limit) : undefined,
        status,
        actionType,
        since: since ? new Date(since) : undefined,
      })
      return reply.send({ success: true, jobs, count: jobs.length })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      fastify.log.error({ err: error }, '[bulk-operations] history failed')
      return reply.code(500).send({ success: false, error: message })
    }
  })

  /**
   * POST /api/bulk-operations/:id/rollback
   * Roll back a previously-COMPLETED or PARTIALLY_COMPLETED bulk job.
   * Reads each SUCCEEDED BulkActionItem's beforeState snapshot and
   * re-applies the captured before values via the master-cascade
   * primitives (MasterPriceService.update, applyStockMovement,
   * product.update for status). Creates a new BulkActionJob row for
   * audit + per-item BulkActionItems for the rollback.
   *
   * Returns 201 with { rollbackJobId, succeeded, failed, skipped }.
   * Returns 404 if not found, 409 if not eligible (wrong status, no
   * succeeded items, already rolled back, non-rollbackable, or
   * actionType not supported in v0).
   *
   * v0 supports: PRICING_UPDATE / INVENTORY_UPDATE / STATUS_UPDATE.
   * ATTRIBUTE_UPDATE / MARKETPLACE_OVERRIDE_UPDATE / LISTING_SYNC
   * deferred until the corresponding upstream gaps are addressed.
   */
  fastify.post<{ Params: { id: string } }>(
    '/bulk-operations/:id/rollback',
    async (request, reply) => {
      const { id } = request.params
      if (!id) {
        return reply
          .code(400)
          .send({ success: false, error: 'job id required' })
      }
      try {
        const result = await bulkActionService.rollbackBulkActionJob(id)
        return reply.code(201).send({ success: true, ...result })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        fastify.log.error(
          { err, jobId: id },
          '[bulk-operations] rollback failed',
        )
        if (msg.startsWith('Job not found')) {
          return reply.code(404).send({ success: false, error: msg })
        }
        // Eligibility errors → 409 so the client can render a tailored message.
        if (
          msg.startsWith('Cannot rollback') ||
          msg.startsWith('Job has already been rolled back') ||
          msg.startsWith('Job is marked non-rollbackable') ||
          msg.startsWith('Rollback not supported') ||
          msg.startsWith('No SUCCEEDED items')
        ) {
          return reply.code(409).send({ success: false, error: msg })
        }
        return reply.code(500).send({ success: false, error: msg })
      }
    },
  )

  /**
   * POST /api/bulk-operations/:id/retry-failed
   * Create a new BulkActionJob scoped to the FAILED items of the
   * given job. Same actionType / actionPayload / channel — only the
   * scope narrows to the polymorphic target IDs of items that
   * failed. The new job is created in PENDING; the caller should
   * POST /:newId/process to start it (matches the standard create
   * → process flow).
   */
  fastify.post<{ Params: { id: string } }>(
    '/bulk-operations/:id/retry-failed',
    async (request, reply) => {
      const { id } = request.params
      if (!id) {
        return reply
          .code(400)
          .send({ success: false, error: 'job id required' })
      }
      try {
        const job = await bulkActionService.retryFailedItems(id)
        return reply.code(201).send({ success: true, job })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error)
        fastify.log.error(
          { err: error, jobId: id },
          '[bulk-operations] retry-failed failed',
        )
        if (message.startsWith('Job not found')) {
          return reply.code(404).send({ success: false, error: message })
        }
        if (message.startsWith('No failed items')) {
          return reply.code(409).send({ success: false, error: message })
        }
        return reply.code(500).send({ success: false, error: message })
      }
    },
  )

  /**
   * GET /api/bulk-operations/:id/items
   * Per-item drill-down for the history page's "Items" panel.
   * Returns BulkActionItem rows joined with human-readable SKU /
   * channel labels (best-effort — null when the entity has since
   * been deleted; the audit history is preserved on the item row).
   */
  fastify.get<{
    Params: { id: string }
    Querystring: { status?: string; limit?: string }
  }>('/bulk-operations/:id/items', async (request, reply) => {
    const { id } = request.params
    if (!id) {
      return reply
        .code(400)
        .send({ success: false, error: 'job id required' })
    }
    try {
      const items = await bulkActionService.listItems(id, {
        status: request.query.status,
        limit: request.query.limit ? Number(request.query.limit) : undefined,
      })
      return reply.send({ success: true, items, count: items.length })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      fastify.log.error(
        { err: error, jobId: id },
        '[bulk-operations] items failed',
      )
      return reply.code(500).send({ success: false, error: message })
    }
  })

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
   * GET /api/bulk-operations/:id/events
   *
   * W10.1 — Server-sent events stream for live job progress.
   * Replaces the 1-2s polling loop the client used to do for
   * progressPercent / processedItems / failedItems / status.
   *
   * Implementation: 1s server-side tick polls Prisma, emits an
   * `update` event only when a tracked field changes, and closes
   * the stream once status is terminal (COMPLETED / FAILED /
   * PARTIALLY_COMPLETED / CANCELLED). Heartbeat every 25s keeps
   * the connection alive past most reverse-proxy idle windows.
   *
   * No EventEmitter wired into bulk-action.service — that would
   * couple the service to a transport layer. The 1s poll cost
   * is bounded (one Prisma findUnique per active subscriber per
   * second) and the connection auto-closes on terminal state, so
   * a typical bulk job adds ~30s of subscription, not minutes.
   */
  fastify.get<{ Params: { id: string } }>(
    '/bulk-operations/:id/events',
    async (request, reply) => {
      const { id } = request.params
      if (!id) {
        return reply.code(400).send({ success: false, error: 'job id required' })
      }
      const initial = await bulkActionService.getJobStatus(id)
      if (!initial) {
        return reply.code(404).send({ success: false, error: `Job not found: ${id}` })
      }
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      const send = (event: string, data: unknown) => {
        try {
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        } catch {
          // ignore — close handler unwires the timers
        }
      }
      send('snapshot', initial)
      const TERMINAL = new Set(['COMPLETED', 'FAILED', 'PARTIALLY_COMPLETED', 'CANCELLED'])
      let lastSig = sigFor(initial)
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        clearInterval(pollTimer)
        clearInterval(heartbeat)
        try { reply.raw.end() } catch {}
      }
      const pollTimer = setInterval(async () => {
        if (closed) return
        try {
          const row = await bulkActionService.getJobStatus(id)
          if (!row) {
            send('error', { error: 'Job disappeared' })
            close()
            return
          }
          const sig = sigFor(row)
          if (sig !== lastSig) {
            lastSig = sig
            send('update', row)
          }
          if (TERMINAL.has(row.status)) {
            send('done', { status: row.status })
            close()
          }
        } catch (err) {
          send('error', { error: err instanceof Error ? err.message : String(err) })
        }
      }, 1000)
      const heartbeat = setInterval(() => {
        try { reply.raw.write(`: heartbeat ${Date.now()}\n\n`) } catch {}
      }, 25_000)
      request.raw.on('close', close)
      // Hold the connection open until close fires.
      await new Promise(() => {})
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

  // R7.2 — duplicate POST /bulk-operations/:id/rollback registration
  // removed (the canonical handler lives ~line 240; this second copy
  // was a copy-paste regression that crashed boot with FST_ERR_-
  // DUPLICATED_ROUTE).

  // ── T.6 — Server-side bulk-ops templates ─────────────────────────
  // CRUD for the BulkOpsTemplate table. Templates store the full grid
  // configuration (columns, filters, channel/productType filters) so
  // sellers can save / share / restore views across browsers.

  /** GET /api/bulk-ops/templates — list, newest first. */
  fastify.get('/bulk-ops/templates', async (_request, reply) => {
    try {
      const rows = await prisma.bulkOpsTemplate.findMany({
        orderBy: { updatedAt: 'desc' },
      })
      return { templates: rows }
    } catch (e) {
      return reply
        .code(500)
        .send({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  /** POST /api/bulk-ops/templates — create. */
  fastify.post<{
    Body: {
      name?: string
      description?: string | null
      columnIds?: string[]
      filterState?: Record<string, unknown> | null
      enabledChannels?: string[]
      enabledProductTypes?: string[]
      collapsedGroups?: string[]
    }
  }>('/bulk-ops/templates', async (request, reply) => {
    const body = request.body ?? {}
    const name = (body.name ?? '').trim()
    if (!name) {
      return reply.code(400).send({ error: 'name is required' })
    }
    if (!Array.isArray(body.columnIds) || body.columnIds.length === 0) {
      return reply
        .code(400)
        .send({ error: 'columnIds must be a non-empty array' })
    }
    try {
      const created = await prisma.bulkOpsTemplate.create({
        data: {
          name,
          description: body.description ?? null,
          columnIds: body.columnIds,
          filterState: (body.filterState ?? null) as any,
          enabledChannels: body.enabledChannels ?? [],
          enabledProductTypes: body.enabledProductTypes ?? [],
          collapsedGroups: body.collapsedGroups ?? [],
        },
      })
      return { template: created }
    } catch (e) {
      return reply
        .code(500)
        .send({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  /** PATCH /api/bulk-ops/templates/:id — partial update. Pass any
   *  subset of fields. updatedAt is auto-bumped by Prisma. */
  fastify.patch<{
    Params: { id: string }
    Body: {
      name?: string
      description?: string | null
      columnIds?: string[]
      filterState?: Record<string, unknown> | null
      enabledChannels?: string[]
      enabledProductTypes?: string[]
      collapsedGroups?: string[]
    }
  }>('/bulk-ops/templates/:id', async (request, reply) => {
    const { id } = request.params
    const body = request.body ?? {}
    const data: Record<string, unknown> = {}
    if (typeof body.name === 'string') data.name = body.name.trim()
    if ('description' in body) data.description = body.description ?? null
    if (Array.isArray(body.columnIds)) data.columnIds = body.columnIds
    if ('filterState' in body) data.filterState = body.filterState ?? null
    if (Array.isArray(body.enabledChannels))
      data.enabledChannels = body.enabledChannels
    if (Array.isArray(body.enabledProductTypes))
      data.enabledProductTypes = body.enabledProductTypes
    if (Array.isArray(body.collapsedGroups))
      data.collapsedGroups = body.collapsedGroups
    try {
      const updated = await prisma.bulkOpsTemplate.update({
        where: { id },
        data: data as any,
      })
      return { template: updated }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('Record to update not found')) {
        return reply.code(404).send({ error: 'Template not found' })
      }
      return reply.code(500).send({ error: msg })
    }
  })

  /** DELETE /api/bulk-ops/templates/:id */
  fastify.delete<{ Params: { id: string } }>(
    '/bulk-ops/templates/:id',
    async (request, reply) => {
      const { id } = request.params
      try {
        await prisma.bulkOpsTemplate.delete({ where: { id } })
        return { success: true }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes('Record to delete does not exist')) {
          return reply.code(404).send({ error: 'Template not found' })
        }
        return reply.code(500).send({ error: msg })
      }
    },
  )
}

export default bulkOperationsRoutes
