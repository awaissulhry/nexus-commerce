/**
 * W9.4 — Scheduled-export routes.
 *
 * /api/scheduled-exports — CRUD + pause/resume + manual fire.
 * Mirror of the scheduled-imports REST surface.
 */

import type { FastifyPluginAsync } from 'fastify'
import { ScheduledExportService } from '../services/scheduled-export.service.js'
import { runScheduledExportTickOnce } from '../jobs/scheduled-export.job.js'
import type {
  ColumnSpec,
  ExportFormat,
} from '../services/export/renderers.js'
import type { TargetEntity } from '../services/export-wizard.service.js'
import type { DeliveryMode } from '../services/scheduled-export.service.js'
import prisma from '../db.js'

const scheduleService = new ScheduledExportService(prisma)

interface CreateBody {
  name?: string
  description?: string | null
  format?: ExportFormat
  targetEntity?: TargetEntity
  columns?: ColumnSpec[]
  filters?: Record<string, unknown> | null
  delivery?: DeliveryMode
  deliveryTarget?: string | null
  cronExpression?: string | null
  scheduledFor?: string | null
  timezone?: string
  createdBy?: string | null
}

const scheduledExportsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { enabled?: string; limit?: string } }>(
    '/scheduled-exports',
    async (request, reply) => {
      const q = request.query
      const schedules = await scheduleService.list({
        enabled:
          q.enabled === 'true'
            ? true
            : q.enabled === 'false'
              ? false
              : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      })
      return reply.send({ success: true, schedules })
    },
  )

  fastify.get<{ Params: { id: string } }>(
    '/scheduled-exports/:id',
    async (request, reply) => {
      const s = await scheduleService.get(request.params.id)
      if (!s) return reply.code(404).send({ success: false, error: 'Not found' })
      return reply.send({ success: true, schedule: s })
    },
  )

  fastify.post<{ Body: CreateBody }>(
    '/scheduled-exports',
    async (request, reply) => {
      const body = request.body ?? {}
      if (!body.name || !body.name.trim()) {
        return reply.code(400).send({ success: false, error: 'name is required' })
      }
      try {
        const s = await scheduleService.create({
          name: body.name,
          description: body.description ?? null,
          format: (body.format ?? 'csv') as ExportFormat,
          targetEntity: (body.targetEntity ?? 'product') as TargetEntity,
          columns: body.columns ?? [],
          filters: body.filters ?? null,
          delivery: (body.delivery ?? 'email') as DeliveryMode,
          deliveryTarget: body.deliveryTarget ?? null,
          cronExpression: body.cronExpression ?? null,
          scheduledFor: body.scheduledFor ?? null,
          timezone: body.timezone,
          createdBy: body.createdBy ?? null,
        })
        return reply.code(201).send({ success: true, schedule: s })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const status =
          msg.startsWith('Invalid cron expression') ||
          msg.startsWith('Schedule must carry') ||
          msg.startsWith('Unknown format') ||
          msg.startsWith('Unknown targetEntity') ||
          msg.startsWith('Unknown delivery') ||
          msg.startsWith('columns is required') ||
          msg.startsWith('FTP delivery not yet supported') ||
          msg.startsWith('webhook delivery requires deliveryTarget') ||
          msg.startsWith('email delivery target must be')
            ? 400
            : 500
        return reply.code(status).send({ success: false, error: msg })
      }
    },
  )

  fastify.patch<{
    Params: { id: string }
    Body: { enabled?: boolean }
  }>('/scheduled-exports/:id/enabled', async (request, reply) => {
    if (typeof request.body?.enabled !== 'boolean') {
      return reply.code(400).send({ success: false, error: 'enabled boolean required' })
    }
    try {
      const s = await scheduleService.setEnabled(
        request.params.id,
        request.body.enabled,
      )
      return reply.send({ success: true, schedule: s })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.startsWith('ScheduledExport not found')) {
        return reply.code(404).send({ success: false, error: msg })
      }
      return reply.code(500).send({ success: false, error: msg })
    }
  })

  fastify.delete<{ Params: { id: string } }>(
    '/scheduled-exports/:id',
    async (request, reply) => {
      await scheduleService.delete(request.params.id)
      return reply.send({ success: true })
    },
  )

  fastify.post('/scheduled-exports/tick', async (_req, reply) => {
    try {
      const r = await runScheduledExportTickOnce()
      return reply.send({ success: true, ...r })
    } catch (e) {
      return reply
        .code(500)
        .send({ success: false, error: e instanceof Error ? e.message : String(e) })
    }
  })
}

export default scheduledExportsRoutes
