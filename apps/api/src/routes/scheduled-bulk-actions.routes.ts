/**
 * W6.2 — Scheduled bulk-action routes.
 *
 * /api/scheduled-bulk-actions — CRUD + pause / resume + manual run.
 * The schedule picker in BulkOperationModal (W6.3) and the
 * /bulk-operations/schedules page (W6.4) both consume this surface.
 */

import type { FastifyPluginAsync } from 'fastify'
import {
  ScheduledBulkActionService,
} from '../services/scheduled-bulk-action.service.js'
import { runScheduledBulkActionTickOnce } from '../jobs/scheduled-bulk-action.job.js'
import prisma from '../db.js'

const scheduleService = new ScheduledBulkActionService(prisma)

interface CreateBody {
  name?: string
  description?: string | null
  actionType?: string
  channel?: string | null
  actionPayload?: Record<string, unknown>
  targetProductIds?: string[]
  targetVariationIds?: string[]
  filters?: Record<string, unknown> | null
  scheduledFor?: string | null
  cronExpression?: string | null
  timezone?: string
  templateId?: string | null
  createdBy?: string | null
}

const scheduledBulkActionRoutes: FastifyPluginAsync = async (fastify) => {
  /** GET /api/scheduled-bulk-actions */
  fastify.get<{
    Querystring: {
      enabled?: string
      actionType?: string
      templateId?: string
      limit?: string
    }
  }>('/scheduled-bulk-actions', async (request, reply) => {
    try {
      const q = request.query
      const schedules = await scheduleService.list({
        enabled:
          q.enabled === 'true'
            ? true
            : q.enabled === 'false'
              ? false
              : undefined,
        actionType: q.actionType,
        templateId: q.templateId,
        limit: q.limit ? Number(q.limit) : undefined,
      })
      return reply.send({ success: true, schedules })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return reply.code(500).send({ success: false, error: msg })
    }
  })

  /** GET /api/scheduled-bulk-actions/:id */
  fastify.get<{ Params: { id: string } }>(
    '/scheduled-bulk-actions/:id',
    async (request, reply) => {
      const schedule = await scheduleService.get(request.params.id)
      if (!schedule) {
        return reply
          .code(404)
          .send({ success: false, error: 'Schedule not found' })
      }
      return reply.send({ success: true, schedule })
    },
  )

  /** POST /api/scheduled-bulk-actions */
  fastify.post<{ Body: CreateBody }>(
    '/scheduled-bulk-actions',
    async (request, reply) => {
      const body = request.body ?? {}
      if (!body.name || !body.name.trim()) {
        return reply
          .code(400)
          .send({ success: false, error: 'name is required' })
      }
      if (!body.actionType) {
        return reply
          .code(400)
          .send({ success: false, error: 'actionType is required' })
      }
      try {
        const schedule = await scheduleService.create({
          name: body.name,
          description: body.description ?? null,
          actionType: body.actionType as never,
          channel: body.channel ?? null,
          actionPayload: body.actionPayload ?? {},
          targetProductIds: body.targetProductIds ?? [],
          targetVariationIds: body.targetVariationIds ?? [],
          filters: body.filters ?? null,
          scheduledFor: body.scheduledFor ?? null,
          cronExpression: body.cronExpression ?? null,
          timezone: body.timezone,
          templateId: body.templateId ?? null,
          createdBy: body.createdBy ?? null,
        })
        return reply.code(201).send({ success: true, schedule })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const status =
          msg.includes('not in KNOWN_BULK_ACTION_TYPES') ||
          msg.startsWith('Invalid cron expression') ||
          msg.startsWith('Schedule must carry')
            ? 400
            : 500
        return reply.code(status).send({ success: false, error: msg })
      }
    },
  )

  /** PATCH /api/scheduled-bulk-actions/:id/enabled */
  fastify.patch<{
    Params: { id: string }
    Body: { enabled?: boolean }
  }>('/scheduled-bulk-actions/:id/enabled', async (request, reply) => {
    if (typeof request.body?.enabled !== 'boolean') {
      return reply
        .code(400)
        .send({ success: false, error: 'enabled boolean is required' })
    }
    try {
      const schedule = await scheduleService.setEnabled(
        request.params.id,
        request.body.enabled,
      )
      return reply.send({ success: true, schedule })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.startsWith('Schedule not found')) {
        return reply.code(404).send({ success: false, error: msg })
      }
      return reply.code(500).send({ success: false, error: msg })
    }
  })

  /** DELETE /api/scheduled-bulk-actions/:id */
  fastify.delete<{ Params: { id: string } }>(
    '/scheduled-bulk-actions/:id',
    async (request, reply) => {
      try {
        await scheduleService.delete(request.params.id)
        return reply.send({ success: true })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return reply.code(500).send({ success: false, error: msg })
      }
    },
  )

  /**
   * POST /api/scheduled-bulk-actions/tick
   *
   * Manually fire the tick — used by the /bulk-operations/schedules
   * UI's "Run scheduler now" button. Returns the same TickSummary
   * shape the cron observability layer logs.
   */
  fastify.post('/scheduled-bulk-actions/tick', async (_request, reply) => {
    try {
      const result = await runScheduledBulkActionTickOnce()
      return reply.send({ success: true, ...result })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return reply.code(500).send({ success: false, error: msg })
    }
  })
}

export default scheduledBulkActionRoutes
