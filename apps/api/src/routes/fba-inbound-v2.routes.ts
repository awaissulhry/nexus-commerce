/**
 * F.4 (TECH_DEBT #50) — HTTP routes for the v2024-03-20 inbound flow.
 *
 * Exposes the F.3 service as REST endpoints under
 * /api/fba/inbound/v2/*. Each step is its own route so the UI can
 * drive the flow as a wizard (operator clicks "Next" between steps).
 *
 * The async-poll model is hidden inside the service — each route
 * waits for the underlying SP-API operation to settle before
 * responding. Operators see "Processing…" until the step completes,
 * then a green check / red error.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import * as svc from '../services/fba-inbound-v2.service.js'
import type {
  CreateInboundPlanInput,
  TransportationConfirmation,
  ShipmentLabelsInput,
} from '../clients/amazon-fba-inbound-v2.client.js'

const fbaInboundV2Routes: FastifyPluginAsync = async (fastify) => {
  // GET /api/fba/inbound/v2 — list plans (latest first, paginated)
  fastify.get<{
    Querystring: { limit?: string; status?: string; inboundShipmentId?: string }
  }>('/fba/inbound/v2', async (request, reply) => {
    try {
      const limit = Math.min(
        Math.max(Number(request.query.limit ?? '50'), 1),
        200,
      )
      const where: Record<string, unknown> = {}
      if (request.query.status) where.status = request.query.status
      if (request.query.inboundShipmentId) {
        where.inboundShipmentId = request.query.inboundShipmentId
      }
      const plans = await prisma.fbaInboundPlanV2.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
      })
      return { plans, count: plans.length }
    } catch (error) {
      fastify.log.error({ err: error }, '[fba-inbound-v2] list failed')
      return reply.code(500).send({
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  // GET /api/fba/inbound/v2/:id — single plan with full state
  fastify.get<{ Params: { id: string } }>(
    '/fba/inbound/v2/:id',
    async (request, reply) => {
      const plan = await prisma.fbaInboundPlanV2.findUnique({
        where: { id: request.params.id },
        include: { inboundShipment: true },
      })
      if (!plan) return reply.code(404).send({ error: 'Plan not found' })
      return { plan }
    },
  )

  // POST /api/fba/inbound/v2 — create new plan (step 1)
  fastify.post<{
    Body: { spApi: CreateInboundPlanInput; inboundShipmentId?: string; createdBy?: string }
  }>('/fba/inbound/v2', async (request, reply) => {
    try {
      const r = await svc.createPlan(request.body)
      return reply.code(201).send(r)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      fastify.log.error({ err: error }, '[fba-inbound-v2] create failed')
      return reply.code(400).send({ error: msg })
    }
  })

  // GET /api/fba/inbound/v2/:id/packing-options — step 2
  fastify.get<{ Params: { id: string } }>(
    '/fba/inbound/v2/:id/packing-options',
    async (request, reply) => {
      try {
        const r = await svc.listPlanPackingOptions(request.params.id)
        return r
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  )

  // POST /api/fba/inbound/v2/:id/packing-options/:optionId/confirm — step 3
  fastify.post<{ Params: { id: string; optionId: string } }>(
    '/fba/inbound/v2/:id/packing-options/:optionId/confirm',
    async (request, reply) => {
      try {
        await svc.confirmPlanPackingOption(
          request.params.id,
          request.params.optionId,
        )
        return { ok: true }
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  )

  // GET /api/fba/inbound/v2/:id/placement-options — step 4
  fastify.get<{ Params: { id: string } }>(
    '/fba/inbound/v2/:id/placement-options',
    async (request, reply) => {
      try {
        const r = await svc.listPlanPlacementOptions(request.params.id)
        return r
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  )

  // POST /api/fba/inbound/v2/:id/placement-options/:optionId/confirm — step 5
  fastify.post<{ Params: { id: string; optionId: string } }>(
    '/fba/inbound/v2/:id/placement-options/:optionId/confirm',
    async (request, reply) => {
      try {
        await svc.confirmPlanPlacementOption(
          request.params.id,
          request.params.optionId,
        )
        return { ok: true }
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  )

  // GET /api/fba/inbound/v2/:id/shipments/:shipmentId/transport-options — step 6
  fastify.get<{ Params: { id: string; shipmentId: string } }>(
    '/fba/inbound/v2/:id/shipments/:shipmentId/transport-options',
    async (request, reply) => {
      try {
        const r = await svc.listPlanTransportOptions(
          request.params.id,
          request.params.shipmentId,
        )
        return r
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  )

  // POST /api/fba/inbound/v2/:id/transport-options/confirm — step 7
  fastify.post<{
    Params: { id: string }
    Body: { selections: TransportationConfirmation[] }
  }>('/fba/inbound/v2/:id/transport-options/confirm', async (request, reply) => {
    try {
      await svc.confirmPlanTransportOptions(
        request.params.id,
        request.body.selections,
      )
      return { ok: true }
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  // GET /api/fba/inbound/v2/:id/labels — step 8
  fastify.get<{
    Params: { id: string }
    Querystring: ShipmentLabelsInput & Record<string, unknown>
  }>('/fba/inbound/v2/:id/labels', async (request, reply) => {
    try {
      const labels = await svc.fetchPlanLabels(request.params.id, request.query)
      return { labels }
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
}

export default fbaInboundV2Routes
