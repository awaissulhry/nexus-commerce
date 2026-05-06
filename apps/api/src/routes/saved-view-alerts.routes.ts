/**
 * H.8 — saved-view alert CRUD + manual evaluation.
 *
 *   GET    /api/saved-views/:viewId/alerts
 *     → { alerts: [...] }
 *
 *   POST   /api/saved-views/:viewId/alerts
 *     body: { name?, comparison, threshold, cooldownMinutes? }
 *     → AlertRow
 *
 *   PATCH  /api/saved-view-alerts/:id
 *     body: { name?, isActive?, comparison?, threshold?, cooldownMinutes? }
 *
 *   DELETE /api/saved-view-alerts/:id
 *
 *   POST   /api/saved-view-alerts/:id/evaluate
 *     → { count, matched, fired, reason? }
 *     Force-evaluate one alert. Lets a user test their threshold or
 *     trigger a fire on demand without waiting for the cron tick.
 *
 *   POST   /api/saved-view-alerts/:id/rebaseline
 *     Sets baselineCount = lastCount. The "I've handled this; reset
 *     the bar" button — useful after a CHANGE_PCT fire when the new
 *     normal really is the new normal.
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import prisma from '../db.js'
import { evaluateAlert } from '../services/saved-view-alerts/evaluator.service.js'

const ALLOWED_COMPARISONS = new Set([
  'GT',
  'LT',
  'CHANGE_ABS',
  'CHANGE_PCT',
])

function userIdFor(_req: FastifyRequest): string {
  return 'default-user'
}

interface CreateBody {
  name?: string
  comparison?: string
  threshold?: number
  cooldownMinutes?: number
}

interface UpdateBody {
  name?: string
  isActive?: boolean
  comparison?: string
  threshold?: number
  cooldownMinutes?: number
}

const savedViewAlertsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { viewId: string } }>(
    '/saved-views/:viewId/alerts',
    async (request, reply) => {
      const { viewId } = request.params
      const userId = userIdFor(request)
      const view = await prisma.savedView.findFirst({
        where: { id: viewId, userId },
        select: { id: true },
      })
      if (!view) return reply.code(404).send({ error: 'view not found' })
      const alerts = await prisma.savedViewAlert.findMany({
        where: { savedViewId: viewId },
        orderBy: { createdAt: 'desc' },
      })
      return {
        alerts: alerts.map((a) => ({ ...a, threshold: Number(a.threshold) })),
      }
    },
  )

  fastify.post<{ Params: { viewId: string }; Body: CreateBody }>(
    '/saved-views/:viewId/alerts',
    async (request, reply) => {
      const { viewId } = request.params
      const userId = userIdFor(request)
      const body = request.body ?? {}
      const view = await prisma.savedView.findFirst({
        where: { id: viewId, userId },
      })
      if (!view) return reply.code(404).send({ error: 'view not found' })

      const comparison = (body.comparison ?? '').toUpperCase()
      if (!ALLOWED_COMPARISONS.has(comparison)) {
        return reply
          .code(400)
          .send({ error: 'comparison must be GT|LT|CHANGE_ABS|CHANGE_PCT' })
      }
      const threshold = Number(body.threshold)
      if (!Number.isFinite(threshold) || threshold < 0) {
        return reply
          .code(400)
          .send({ error: 'threshold must be a non-negative number' })
      }
      const cooldown = Math.max(
        1,
        Math.floor(Number(body.cooldownMinutes ?? 60)) || 60,
      )
      const name = (body.name ?? view.name).trim()
      if (!name) {
        return reply.code(400).send({ error: 'name required' })
      }

      // Seed baselineCount with the current count so CHANGE_*
      // comparisons fire on movement, not against zero. GT/LT don't
      // care about baseline but seeding it does no harm.
      const { buildProductWhereFromSavedView } = await import(
        '../services/saved-views/build-where.service.js'
      )
      const where = await buildProductWhereFromSavedView(
        prisma,
        view.filters as any,
      )
      const seedCount = await prisma.product.count({ where })

      const alert = await prisma.savedViewAlert.create({
        data: {
          savedViewId: viewId,
          userId,
          name,
          comparison,
          threshold,
          cooldownMinutes: cooldown,
          baselineCount: seedCount,
          lastCount: seedCount,
          lastCheckedAt: new Date(),
        },
      })
      return { ...alert, threshold: Number(alert.threshold) }
    },
  )

  fastify.patch<{ Params: { id: string }; Body: UpdateBody }>(
    '/saved-view-alerts/:id',
    async (request, reply) => {
      const { id } = request.params
      const userId = userIdFor(request)
      const existing = await prisma.savedViewAlert.findFirst({
        where: { id, userId },
      })
      if (!existing) return reply.code(404).send({ error: 'alert not found' })

      const body = request.body ?? {}
      const data: Record<string, unknown> = {}
      if (typeof body.name === 'string') {
        const t = body.name.trim()
        if (t) data.name = t
      }
      if (typeof body.isActive === 'boolean') data.isActive = body.isActive
      if (typeof body.comparison === 'string') {
        const c = body.comparison.toUpperCase()
        if (!ALLOWED_COMPARISONS.has(c)) {
          return reply
            .code(400)
            .send({ error: 'comparison must be GT|LT|CHANGE_ABS|CHANGE_PCT' })
        }
        data.comparison = c
      }
      if (body.threshold !== undefined) {
        const t = Number(body.threshold)
        if (!Number.isFinite(t) || t < 0) {
          return reply
            .code(400)
            .send({ error: 'threshold must be non-negative' })
        }
        data.threshold = t
      }
      if (body.cooldownMinutes !== undefined) {
        const c = Math.max(1, Math.floor(Number(body.cooldownMinutes)) || 60)
        data.cooldownMinutes = c
      }
      const updated = await prisma.savedViewAlert.update({
        where: { id },
        data,
      })
      return { ...updated, threshold: Number(updated.threshold) }
    },
  )

  fastify.delete<{ Params: { id: string } }>(
    '/saved-view-alerts/:id',
    async (request, reply) => {
      const { id } = request.params
      const userId = userIdFor(request)
      const result = await prisma.savedViewAlert.deleteMany({
        where: { id, userId },
      })
      if (result.count === 0) {
        return reply.code(404).send({ error: 'alert not found' })
      }
      return { ok: true }
    },
  )

  fastify.post<{ Params: { id: string } }>(
    '/saved-view-alerts/:id/evaluate',
    async (request, reply) => {
      const { id } = request.params
      const userId = userIdFor(request)
      const alert = await prisma.savedViewAlert.findFirst({
        where: { id, userId },
        include: {
          savedView: { select: { id: true, name: true, filters: true } },
        },
      })
      if (!alert) return reply.code(404).send({ error: 'alert not found' })
      const result = await evaluateAlert({ prisma }, alert as any)
      return result
    },
  )

  fastify.post<{ Params: { id: string } }>(
    '/saved-view-alerts/:id/rebaseline',
    async (request, reply) => {
      const { id } = request.params
      const userId = userIdFor(request)
      const existing = await prisma.savedViewAlert.findFirst({
        where: { id, userId },
      })
      if (!existing) return reply.code(404).send({ error: 'alert not found' })
      const updated = await prisma.savedViewAlert.update({
        where: { id },
        data: { baselineCount: existing.lastCount },
      })
      return { ...updated, threshold: Number(updated.threshold) }
    },
  )
}

export default savedViewAlertsRoutes
