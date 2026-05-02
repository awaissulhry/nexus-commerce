/**
 * Phase 5.5: AI listing-content generation.
 *
 *   POST /api/listing-content/generate
 *      body: { productId, marketplace, fields[], variant? }
 *      → { title?, bullets?, description?, keywords?, metadata }
 *
 * Returns 503 when GEMINI_API_KEY isn't set so the client can show
 * a helpful message rather than the request hanging.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { GeminiService } from '../services/ai/gemini.service.js'
import {
  ListingContentService,
  type ContentField,
} from '../services/ai/listing-content.service.js'

const ALLOWED_FIELDS = new Set<ContentField>([
  'title',
  'bullets',
  'description',
  'keywords',
])

const gemini = new GeminiService()
const service = new ListingContentService(gemini)

interface Body {
  productId?: string
  marketplace?: string
  fields?: string[]
  variant?: number
}

const listingContentRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: Body }>(
    '/listing-content/generate',
    async (request, reply) => {
      if (!service.isConfigured()) {
        return reply.code(503).send({
          error:
            'Gemini API not configured — set GEMINI_API_KEY on the API server.',
        })
      }
      const { productId, marketplace, fields, variant } = request.body ?? {}
      if (!productId || !marketplace || !Array.isArray(fields)) {
        return reply.code(400).send({
          error: 'productId, marketplace, fields[] are all required',
        })
      }
      const requested = fields.filter((f): f is ContentField =>
        ALLOWED_FIELDS.has(f as ContentField),
      )
      if (requested.length === 0) {
        return reply.code(400).send({
          error: `fields must include one or more of ${Array.from(ALLOWED_FIELDS).join(', ')}`,
        })
      }
      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: {
          id: true,
          sku: true,
          name: true,
          brand: true,
          description: true,
          bulletPoints: true,
          keywords: true,
          weightValue: true,
          weightUnit: true,
          dimLength: true,
          dimWidth: true,
          dimHeight: true,
          dimUnit: true,
          productType: true,
          variantAttributes: true,
          categoryAttributes: true,
        },
      })
      if (!product) {
        return reply.code(404).send({ error: 'Product not found' })
      }
      // P0 #27: pull brand+marketplace terminology to inject into the
      // prompt. brand=null rows apply to every brand in the marketplace.
      const terminology = await prisma.terminologyPreference.findMany({
        where: {
          marketplace: marketplace.toUpperCase(),
          OR: [{ brand: product.brand }, { brand: null }],
        },
        select: { preferred: true, avoid: true, context: true },
        orderBy: [{ brand: 'desc' }, { preferred: 'asc' }],
      })
      try {
        const result = await service.generate({
          product: {
            id: product.id,
            sku: product.sku,
            name: product.name,
            brand: product.brand,
            description: product.description,
            bulletPoints: product.bulletPoints,
            keywords: product.keywords,
            weightValue: product.weightValue
              ? Number(product.weightValue)
              : null,
            weightUnit: product.weightUnit,
            dimLength: product.dimLength
              ? Number(product.dimLength)
              : null,
            dimWidth: product.dimWidth ? Number(product.dimWidth) : null,
            dimHeight: product.dimHeight
              ? Number(product.dimHeight)
              : null,
            dimUnit: product.dimUnit,
            productType: product.productType,
            variantAttributes: product.variantAttributes,
            categoryAttributes: product.categoryAttributes,
          },
          marketplace,
          fields: requested,
          variant: typeof variant === 'number' ? variant : 0,
          terminology,
        })
        return result
      } catch (err: any) {
        fastify.log.error({ err }, '[listing-content/generate] failed')
        return reply.code(500).send({
          error: err?.message ?? String(err),
        })
      }
    },
  )
}

export default listingContentRoutes
