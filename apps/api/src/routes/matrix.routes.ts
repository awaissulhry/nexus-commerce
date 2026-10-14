/**
 * Phase 9: the legacy Matrix API — only its retired tombstone is left.
 *
 * GET /api/products/:id/matrix went with the old /catalog/[id]/edit page (2026-10-14), its only caller. The Matrix is
 * the product page's Matrix (`/api/products/:id/studio/matrix`, `studio-matrix.routes.ts`).
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { assertRequestPermission } from '../lib/auth/request-permission.js'

/**
 * PUT /api/products/:id/matrix/channel-listing/:listingId — RETIRED (S1, F6).
 *
 * It wrote `price` and `quantity` straight onto the listing row: no price door (no bounds, no currency check, no queue
 * row), no stock door (no FBA check: it could write an Amazon-managed quantity), no audit and no version. Nothing in the
 * app called it. Price and quantity per listing go through the Matrix (`/api/products/:id/studio/matrix`) and the
 * listing edit (`PATCH /api/listings/:id`). Kept as 410 Gone, behind the same permission, so a straggler is told where.
 */
async function updateChannelListing(_request: FastifyRequest, reply: FastifyReply) {
  return reply.status(410).send({
    error: 'gone',
    code: 'ROUTE_RETIRED',
    message: 'This route was retired. Change a listing through the Matrix (/api/products/:id/studio/matrix) or PATCH /api/listings/:id.',
    replacement: '/api/products/:id/studio/matrix',
  })
}

// Presence D24: legacy Offer writers retired; use the studio Matrix write door.
// Step 7, part 3: the listing creator (POST …/matrix/channel-listing) is gone too — it never set the
// required channelMarket, so every call failed, and nothing called it.
export async function matrixRoutes(fastify: FastifyInstance) {
  fastify.put('/api/products/:id/matrix/channel-listing/:listingId', {
    preHandler: async (request) => assertRequestPermission(request, 'products.edit'),
  }, updateChannelListing)
}
