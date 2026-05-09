/**
 * W8.4 — Scheduled-import routes.
 *
 * /api/scheduled-imports — CRUD + pause/resume + manual fire.
 * Operator-facing UI surfaces in the W8.3 imports page in a follow-
 * up; this commit ships the REST surface.
 */

import type { FastifyPluginAsync } from 'fastify'
import { ScheduledImportService } from '../services/scheduled-import.service.js'
import { runScheduledImportTickOnce } from '../jobs/scheduled-import.job.js'
import prisma from '../db.js'

const scheduleService = new ScheduledImportService(prisma)

interface CreateBody {
  name?: string
  description?: string | null
  source?: 'url' | 'ftp'
  sourceUrl?: string
  targetEntity?: 'product' | 'channelListing' | 'inventory'
  columnMapping?: Record<string, string>
  onError?: 'abort' | 'skip'
  cronExpression?: string | null
  scheduledFor?: string | null
  timezone?: string
  createdBy?: string | null
}

const scheduledImportsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { enabled?: string; limit?: string } }>(
    '/scheduled-imports',
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
    '/scheduled-imports/:id',
    async (request, reply) => {
      const s = await scheduleService.get(request.params.id)
      if (!s) return reply.code(404).send({ success: false, error: 'Not found' })
      return reply.send({ success: true, schedule: s })
    },
  )

  fastify.post<{ Body: CreateBody }>(
    '/scheduled-imports',
    async (request, reply) => {
      const body = request.body ?? {}
      if (!body.name || !body.name.trim()) {
        return reply.code(400).send({ success: false, error: 'name is required' })
      }
      if (!body.sourceUrl) {
        return reply.code(400).send({ success: false, error: 'sourceUrl is required' })
      }
      try {
        const s = await scheduleService.create({
          name: body.name,
          description: body.description ?? null,
          source: body.source ?? 'url',
          sourceUrl: body.sourceUrl,
          targetEntity: body.targetEntity ?? 'product',
          columnMapping: body.columnMapping ?? {},
          onError: body.onError ?? 'skip',
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
          msg.startsWith('sourceUrl must be') ||
          msg.startsWith('Unknown source') ||
          msg.startsWith('FTP source not yet supported')
            ? 400
            : 500
        return reply.code(status).send({ success: false, error: msg })
      }
    },
  )

  fastify.patch<{
    Params: { id: string }
    Body: { enabled?: boolean }
  }>('/scheduled-imports/:id/enabled', async (request, reply) => {
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
      if (msg.startsWith('ScheduledImport not found')) {
        return reply.code(404).send({ success: false, error: msg })
      }
      return reply.code(500).send({ success: false, error: msg })
    }
  })

  fastify.delete<{ Params: { id: string } }>(
    '/scheduled-imports/:id',
    async (request, reply) => {
      await scheduleService.delete(request.params.id)
      return reply.send({ success: true })
    },
  )

  fastify.post('/scheduled-imports/tick', async (_req, reply) => {
    try {
      const r = await runScheduledImportTickOnce()
      return reply.send({ success: true, ...r })
    } catch (e) {
      return reply
        .code(500)
        .send({ success: false, error: e instanceof Error ? e.message : String(e) })
    }
  })
}

export default scheduledImportsRoutes
