/**
 * W5.49 — listing recovery API.
 *
 * POST /api/products/:id/recover/preview
 *   Pure preview — returns consequences (reviews preserved? cooldown
 *   risk? blockers?) for a (channel, marketplace, action) tuple.
 *   Drives the consequence-card UI on every action click.
 *
 * POST /api/products/:id/recover
 *   Executes the destructive part of the flow + writes the audit row.
 *   Returns the audit eventId + a wizardUrl the client should redirect
 *   to for the recreate step.
 *
 * GET /api/products/:id/recover/events
 *   Last 20 ListingRecoveryEvent rows for a product. Renders the
 *   "previous recoveries" history strip on the recovery page.
 *
 * Presence D18: /recover folds into History in Wave 5.
 * Explicit operator guards enforce independently of the global RBAC mode.
 */

import type { FastifyPluginAsync } from 'fastify'
import {
  executeRecovery,
  previewRecovery,
  type RecoveryAction,
  type RecoveryRequest,
} from '../services/listings/recovery.service.js'
import prisma from '../db.js'
import { assertRequestPermission, requestUserId } from '../lib/auth/request-permission.js'

const listingRecoveryRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Params: { id: string }
    Body: {
      channel: string
      marketplace: string
      channelConnectionId: string | null
      aliasKey: string
      action: RecoveryAction
      newSku?: string
    }
  }>('/products/:id/recover/preview', {
    preHandler: async (request) => assertRequestPermission(request, 'products.view'),
  }, async (request, reply) => {
    const { id } = request.params
    const { channel, marketplace, channelConnectionId, aliasKey, action, newSku } = request.body
    if (!channel || !marketplace || !action) {
      return reply.status(400).send({
        error: 'channel, marketplace, action are required',
      })
    }
    try {
      const preview = await previewRecovery({
        productId: id,
        channel,
        marketplace,
        channelConnectionId,
        aliasKey,
        action,
        newSku,
      })
      return reply.send({ preview })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return reply.status(400).send({ error: msg })
    }
  })

  fastify.post<{
    Params: { id: string }
    Body: {
      channel: string
      marketplace: string
      channelConnectionId: string | null
      aliasKey: string
      action: RecoveryAction
      newSku?: string
    }
  }>('/products/:id/recover', {
    preHandler: async (request) => assertRequestPermission(request, 'products.delete'),
  }, async (request, reply) => {
    const { id } = request.params
    const { channel, marketplace, channelConnectionId, aliasKey, action, newSku } = request.body
    if (!channel || !marketplace || !action) {
      return reply.status(400).send({
        error: 'channel, marketplace, action are required',
      })
    }
    try {
      const req: RecoveryRequest = {
        productId: id,
        channel,
        marketplace,
        channelConnectionId,
        aliasKey,
        action,
        newSku,
        initiatedBy: requestUserId(request),
      }
      const result = await executeRecovery(req)
      return reply.send({ recovery: result })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return reply.status(400).send({ error: msg })
    }
  })

  fastify.get<{ Params: { id: string } }>(
    '/products/:id/recover/events',
    { preHandler: async (request) => assertRequestPermission(request, 'products.view') },
    async (request, reply) => {
      const { id } = request.params
      const events = await prisma.listingRecoveryEvent.findMany({
        where: { productId: id },
        orderBy: { startedAt: 'desc' },
        take: 20,
      })
      return reply.send({ events })
    },
  )
}

export default listingRecoveryRoutes
