/**
 * F.4 (TECH_DEBT #50) — the v2024-03-20 inbound WIZARD's routes, under /api/fba/inbound/v2/*.
 *
 * Step 4 Send to FBA (2026-10-07): sending stock into FBA runs from the Matrix now (routes/fba-send.routes.ts → a job
 * that claims the plan, polls Amazon outside any request and never confirms twice). The wizard's step routes ran each
 * Amazon step inside an HTTP request and skipped that claim, so every one of them answers 410 Gone with the sentence
 * the web shows (`FBA_SEND_COPY.movedToMatrix`). Only the two reads stay: the plan list and one plan, as they always
 * answered, through the read service (zero database calls in this file).
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { FBA_SEND_COPY } from '@nexus/shared/fba-send'
import { wizardPlanRow, wizardPlanRows } from '../services/fba-inbound/read.service.js'

/** The retired step routes' answer. */
function gone(reply: FastifyReply) {
  return reply.code(410).send({ error: 'gone', message: FBA_SEND_COPY.movedToMatrix, replacement: '/api/fba/inbound/plans' })
}

/** Every wizard step route (each ran Amazon calls inside the request). */
const RETIRED: Array<{ method: 'GET' | 'POST'; url: string }> = [
  { method: 'POST', url: '/fba/inbound/v2' },
  { method: 'GET', url: '/fba/inbound/v2/:id/packing-options' },
  { method: 'POST', url: '/fba/inbound/v2/:id/packing-options/:optionId/confirm' },
  { method: 'GET', url: '/fba/inbound/v2/:id/placement-options' },
  { method: 'POST', url: '/fba/inbound/v2/:id/placement-options/:optionId/confirm' },
  { method: 'GET', url: '/fba/inbound/v2/:id/shipments/:shipmentId/transport-options' },
  { method: 'POST', url: '/fba/inbound/v2/:id/transport-options/confirm' },
  { method: 'GET', url: '/fba/inbound/v2/:id/labels' },
]

const fbaInboundV2Routes: FastifyPluginAsync = async (fastify) => {
  // GET /api/fba/inbound/v2 — list plans (latest first, paginated)
  fastify.get<{
    Querystring: { limit?: string; status?: string; inboundShipmentId?: string }
  }>('/fba/inbound/v2', async (request, reply) => {
    try {
      const plans = await wizardPlanRows({
        limit: Number(request.query.limit ?? '50'),
        status: request.query.status ?? null,
        inboundShipmentId: request.query.inboundShipmentId ?? null,
      })
      return { plans, count: plans.length }
    } catch (error) {
      fastify.log.error({ message: error instanceof Error ? error.message : String(error) }, '[fba-inbound-v2] list failed')
      return reply.code(500).send({
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  // GET /api/fba/inbound/v2/:id — single plan with full state
  fastify.get<{ Params: { id: string } }>(
    '/fba/inbound/v2/:id',
    async (request, reply) => {
      const plan = await wizardPlanRow(request.params.id)
      if (!plan) return reply.code(404).send({ error: 'Plan not found' })
      return { plan }
    },
  )

  for (const route of RETIRED) {
    fastify.route({ method: route.method, url: route.url, handler: async (_request, reply) => gone(reply) })
  }
}

export default fbaInboundV2Routes
