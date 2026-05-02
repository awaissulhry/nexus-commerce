/**
 * Phase 5.3: ListingWizard CRUD.
 *
 *   POST /api/listing-wizard/start   — find-or-create by
 *                                       (productId, channel, marketplace)
 *   GET  /api/listing-wizard/:id     — read one wizard
 *   PATCH /api/listing-wizard/:id    — partial state merge + step
 *                                       advance
 *   POST /api/listing-wizard/:id/submit — placeholder, returns 501
 *                                          until Phase 6 wires the
 *                                          channel push.
 *
 * The state column is a free-form JSONB blob. Callers PATCH partial
 * objects and the merge layer here preserves keys that aren't in the
 * patch (so Step 1 doesn't blow away Step 6's draft etc.).
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'

interface StartBody {
  productId?: string
  channel?: string
  marketplace?: string
}

interface PatchBody {
  currentStep?: number
  state?: Record<string, unknown>
  status?: string
}

const VALID_CHANNELS = new Set([
  'AMAZON',
  'EBAY',
  'SHOPIFY',
  'WOOCOMMERCE',
])

const listingWizardRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: StartBody }>(
    '/listing-wizard/start',
    async (request, reply) => {
      const { productId, channel, marketplace } = request.body ?? {}
      if (!productId || !channel || !marketplace) {
        return reply.code(400).send({
          error: 'productId, channel, and marketplace are all required',
        })
      }
      if (!VALID_CHANNELS.has(channel)) {
        return reply
          .code(400)
          .send({ error: `Unsupported channel: ${channel}` })
      }
      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { id: true, sku: true, name: true, isParent: true },
      })
      if (!product) {
        return reply.code(404).send({ error: 'Product not found' })
      }
      // Find an existing DRAFT wizard for this combo so the user can
      // resume; SUBMITTED/LIVE/FAILED wizards are terminal and a new
      // one starts fresh.
      let wizard = await prisma.listingWizard.findFirst({
        where: {
          productId,
          channel,
          marketplace,
          status: 'DRAFT',
        },
        orderBy: { createdAt: 'desc' },
      })
      if (!wizard) {
        wizard = await prisma.listingWizard.create({
          data: {
            productId,
            channel,
            marketplace,
            currentStep: 1,
            state: {},
            status: 'DRAFT',
          },
        })
      }
      return { wizard, product }
    },
  )

  fastify.get<{ Params: { id: string } }>(
    '/listing-wizard/:id',
    async (request, reply) => {
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
      })
      if (!wizard) {
        return reply.code(404).send({ error: 'Wizard not found' })
      }
      const product = await prisma.product.findUnique({
        where: { id: wizard.productId },
        select: { id: true, sku: true, name: true, isParent: true },
      })
      return { wizard, product }
    },
  )

  fastify.patch<{ Params: { id: string }; Body: PatchBody }>(
    '/listing-wizard/:id',
    async (request, reply) => {
      const wizard = await prisma.listingWizard.findUnique({
        where: { id: request.params.id },
      })
      if (!wizard) {
        return reply.code(404).send({ error: 'Wizard not found' })
      }
      if (wizard.status !== 'DRAFT') {
        return reply
          .code(409)
          .send({ error: `Wizard is ${wizard.status.toLowerCase()}` })
      }
      const body = request.body ?? {}
      const merged = {
        ...((wizard.state as Record<string, unknown> | null) ?? {}),
        ...((body.state ?? {}) as Record<string, unknown>),
      }
      const next = await prisma.listingWizard.update({
        where: { id: wizard.id },
        data: {
          currentStep:
            typeof body.currentStep === 'number'
              ? Math.min(Math.max(body.currentStep, 1), 10)
              : wizard.currentStep,
          state: merged as any,
        },
      })
      return { wizard: next }
    },
  )

  // Phase 5.3 ships the route stub so the client can wire its
  // submit button without a 404. The actual SP-API push lands in
  // Phase 6 after the per-step content is filled in.
  fastify.post<{ Params: { id: string } }>(
    '/listing-wizard/:id/submit',
    async (_request, reply) => {
      return reply.code(501).send({
        error:
          'Submit is not yet implemented — the channel push lands in Phase 6 once the per-step data is collected.',
      })
    },
  )
}

export default listingWizardRoutes
