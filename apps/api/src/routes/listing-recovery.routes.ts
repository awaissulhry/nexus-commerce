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
 * No auth gate yet — this is solo-tenant. When auth lands, restrict
 * to operators with `listings.recover` permission.
 */

import type { FastifyPluginAsync } from 'fastify'
import {
  executeRecovery,
  previewRecovery,
  type RecoveryAction,
  type RecoveryRequest,
} from '../services/listings/recovery.service.js'
import prisma from '../db.js'

const listingRecoveryRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Params: { id: string }
    Body: {
      channel: string
      marketplace: string
      action: RecoveryAction
      newSku?: string
    }
  }>('/products/:id/recover/preview', async (request, reply) => {
    const { id } = request.params
    const { channel, marketplace, action, newSku } = request.body
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
      action: RecoveryAction
      newSku?: string
    }
  }>('/products/:id/recover', async (request, reply) => {
    const { id } = request.params
    const { channel, marketplace, action, newSku } = request.body
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
        action,
        newSku,
        // TODO: thread real user identity once auth is wired.
        initiatedBy: undefined,
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
