/**
 * Review-insert PDF endpoints — compliant Amazon in-box review cards (services/reviews/review-inserts.service.ts).
 *
 * - GET  /api/review-inserts/count               → how many products would print
 * - GET  /api/review-inserts/product/:id         → one card (inline preview)
 * - POST /api/review-inserts/bulk                 → one card per product (download)
 *
 * Each card carries the name of the business the request runs in (its identity for buyers), never one deployment-wide
 * name. No database call here.
 */

import type { FastifyInstance, FastifyReply } from 'fastify'
import { InsertsRefusal, bulkInsertsPdf, insertsCount, oneInsertPdf } from '../services/reviews/review-inserts.service.js'
import { logger } from '../utils/logger.js'

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
}

function refused(reply: FastifyReply, err: unknown) {
  if (err instanceof InsertsRefusal) return reply.status(err.statusCode).send({ error: err.message })
  logger.error('review-inserts failed', { error: err instanceof Error ? err.message : String(err) })
  return reply.status(500).send({ error: 'The cards could not be made — try again' })
}

export default async function reviewInsertsRoutes(app: FastifyInstance) {
  // how many products have an ASIN (drives the UI count + "print all")
  app.get('/review-inserts/count', async (_req, reply) => reply.send(await insertsCount()))

  // single-product card, inline so the browser previews it
  app.get('/review-inserts/product/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      const pdf = await oneInsertPdf(id, (req.query as { marketplace?: string })?.marketplace)
      reply.header('Content-Type', 'application/pdf')
      reply.header('Content-Disposition', `inline; filename="review-insert-${safeName(id)}.pdf"`)
      return reply.send(pdf)
    } catch (err) {
      return refused(reply, err)
    }
  })

  // bulk: every active product with an ASIN (or a provided id list), one card each
  app.post('/review-inserts/bulk', async (req, reply) => {
    try {
      const { pdf, marketplace } = await bulkInsertsPdf((req.body || {}) as { marketplace?: unknown; productIds?: unknown })
      reply.header('Content-Type', 'application/pdf')
      reply.header('Content-Disposition', `attachment; filename="review-inserts-${safeName(marketplace)}.pdf"`)
      return reply.send(pdf)
    } catch (err) {
      return refused(reply, err)
    }
  })
}
