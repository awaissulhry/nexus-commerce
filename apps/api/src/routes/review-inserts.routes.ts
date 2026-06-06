/**
 * Review-insert PDF endpoints — compliant Amazon in-box review cards.
 *
 * - GET  /api/review-inserts/count               → how many products would print
 * - GET  /api/review-inserts/product/:id         → one card (inline preview)
 * - POST /api/review-inserts/bulk                 → one card per product (download)
 *
 * Brand wordmark defaults to "Xavia" (override via NEXUS_REVIEW_INSERT_BRAND).
 */

import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { buildReviewInsertPdf } from '../services/reviews/review-insert-pdf.service.js'
import { logger } from '../utils/logger.js'

const BRAND = process.env.NEXUS_REVIEW_INSERT_BRAND || 'Xavia'
const BULK_CAP = 500

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
}

export default async function reviewInsertsRoutes(app: FastifyInstance) {
  // how many products have an ASIN (drives the UI count + "print all")
  app.get('/review-inserts/count', async (_req, reply) => {
    const count = await prisma.product.count({
      where: { amazonAsin: { not: null }, deletedAt: null },
    })
    return reply.send({ count, cap: BULK_CAP })
  })

  // single-product card, inline so the browser previews it
  app.get('/review-inserts/product/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const marketplace = ((req.query as any)?.marketplace || 'IT').toString().toUpperCase()
    const product = await prisma.product.findUnique({
      where: { id },
      select: { name: true, amazonAsin: true },
    })
    if (!product) return reply.status(404).send({ error: 'product not found' })
    if (!product.amazonAsin) return reply.status(422).send({ error: 'product has no Amazon ASIN' })

    const pdf = await buildReviewInsertPdf({
      brand: BRAND,
      marketplace,
      products: [{ name: product.name, asin: product.amazonAsin, marketplace }],
    })
    reply.header('Content-Type', 'application/pdf')
    reply.header('Content-Disposition', `inline; filename="review-insert-${safeName(id)}.pdf"`)
    return reply.send(pdf)
  })

  // bulk: every active product with an ASIN (or a provided id list), one card each
  app.post('/review-inserts/bulk', async (req, reply) => {
    const body = (req.body || {}) as { marketplace?: string; productIds?: string[] }
    const marketplace = (body.marketplace || 'IT').toString().toUpperCase()
    const where: any = { amazonAsin: { not: null }, deletedAt: null }
    if (Array.isArray(body.productIds) && body.productIds.length > 0) {
      where.id = { in: body.productIds.slice(0, BULK_CAP) }
    }
    const products = await prisma.product.findMany({
      where,
      select: { name: true, amazonAsin: true },
      orderBy: { name: 'asc' },
      take: BULK_CAP,
    })

    try {
      const pdf = await buildReviewInsertPdf({
        brand: BRAND,
        marketplace,
        products: products.map((p) => ({ name: p.name, asin: p.amazonAsin as string, marketplace })),
      })
      reply.header('Content-Type', 'application/pdf')
      reply.header('Content-Disposition', `attachment; filename="review-inserts-${safeName(marketplace)}.pdf"`)
      return reply.send(pdf)
    } catch (err: any) {
      logger.error('review-inserts bulk failed', { error: err?.message })
      return reply.status(500).send({ error: err?.message ?? 'failed' })
    }
  })
}
