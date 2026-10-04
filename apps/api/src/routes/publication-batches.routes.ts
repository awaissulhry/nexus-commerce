/**
 * Sheet publish parity, step 5 (item 3) — publish one family to several destinations in one action.
 *
 *   POST /api/publication-batches                body { reviews: [{ reviewId, selectionToken?, confirmOverwrite?, locationId? }] }
 *                                                → 202 { batchId }; the batch sends in the background
 *                                                Step 6: body { productIds, destinations, options? } → 202 { batchId };
 *                                                the batch REVIEWS every family × destination, then waits (REVIEWED)
 *                                                P11: options.status 'active' | 'inactive' | 'ended' (ManyPublishRequest)
 *                                                sets every listing there to that Status (no Delete); Ended needs
 *                                                products.delete (403 otherwise)
 *                                                Build shape v2 (P6): body { plan: PublishPlanSubmit } → 202 { batchId };
 *                                                one mixed Publish: content reviews + waiting Status changes and Deletes
 *   POST /api/publication-batches/:id/submit     body { confirmOverwrite?, shopifyLocations?, confirmText? } → send what was
 *                                                reviewed; ending listings needs products.delete (403) and the typed count
 *                                                (400 confirm_required)
 *   GET  /api/publication-batches/:id            → the phase and every destination's status; a many-family batch also
 *                                                echoes its options (`request.options`: startAs, keepChannelValues, …)
 *   POST /api/publication-batches/:id/cancel     → destinations not started are never sent; returns the batch
 *   POST /api/publication-batches/listed-markets body { productIds } → { families, markets: [{ channel, marketplace,
 *                                                accountId, families }] }: where the chosen families are listed (Active or
 *                                                Inactive), so the products list's window starts with those markets
 *                                                (One-click O5). Reads Nexus only; no channel call.
 *
 * Every route needs products.publish (permissions-manifest.ts). A plan's Ended and Delete rows (and P11's Ended) also need products.delete:
 * the service checks the caller's resolved permissions (`permissionCheckerFor`). No database access here — the service owns it.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { WorkspaceScopeError } from '../services/pim/workspace-destination.js'
import { cancelPublicationBatch, createPublicationBatch, listedMarkets, readPublicationBatch, submitReviewedBatch } from '../services/pim/publication-batch.service.js'
import { permissionCheckerFor } from './studio-matrix.routes.js'

const CODES: Record<number, string> = { 400: 'invalid_request', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 422: 'refused' }

function sendError(reply: FastifyReply, request: FastifyRequest, err: unknown) {
  // The service's refusals are WorkspaceScopeError; their status says what kind, their message says what to do.
  if (err instanceof WorkspaceScopeError) return reply.code(err.statusCode).send({ error: CODES[err.statusCode] ?? 'refused', message: err.message })
  const e = err as { statusCode?: unknown; code?: unknown; message?: unknown }
  if (typeof e?.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500)
    return reply.code(e.statusCode).send({ error: typeof e.code === 'string' ? e.code : CODES[e.statusCode] ?? 'bad_request', message: String(e.message ?? '') })
  request.log.error({ err }, 'publication batch request failed')
  return reply.code(500).send({ error: 'publication_batch_failed', message: 'The publication batch could not be read or changed. Try again.' })
}

const userOf = (request: FastifyRequest) => request.authUser?.id ?? null

const publicationBatchRoutes: FastifyPluginAsync = async fastify => {
  fastify.post('/publication-batches', async (request, reply) => {
    try {
      const created = await createPublicationBatch(request.body, userOf(request), { userId: userOf(request), can: permissionCheckerFor(request) })
      reply.header('Cache-Control', 'no-store')
      return reply.code(202).send(created)
    } catch (err) {
      return sendError(reply, request, err)
    }
  })

  fastify.post('/publication-batches/listed-markets', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'no-store')
      return await listedMarkets(request.body ?? {})
    } catch (err) {
      return sendError(reply, request, err)
    }
  })

  fastify.get<{ Params: { id: string } }>('/publication-batches/:id', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'no-store')
      return await readPublicationBatch(request.params.id, userOf(request))
    } catch (err) {
      return sendError(reply, request, err)
    }
  })

  fastify.post<{ Params: { id: string } }>('/publication-batches/:id/submit', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'no-store')
      return reply.code(202).send(await submitReviewedBatch(request.params.id, request.body ?? {}, userOf(request), { userId: userOf(request), can: permissionCheckerFor(request) }))
    } catch (err) {
      return sendError(reply, request, err)
    }
  })

  fastify.post<{ Params: { id: string } }>('/publication-batches/:id/cancel', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'no-store')
      return await cancelPublicationBatch(request.params.id, userOf(request))
    } catch (err) {
      return sendError(reply, request, err)
    }
  })
}

export default publicationBatchRoutes
