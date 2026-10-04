/**
 * Sheet publish parity, step 4 (docs/sheet-publish-parity/PLAN.md, item 4) — the publish history's reads.
 *
 *   GET /api/publications                                      the business's runs, newest first (products.view)
 *   GET /api/publications/counts                               exact counts for the same filters (products.view)
 *   GET /api/products/:id/publications                         the runs of :id's product family (products.view)
 *   GET /api/products/:id/publications/counts                  exact counts for that family (products.view)
 *   GET /api/publications/:id                                  one run in full (products.view)
 *   GET /api/publications/:id/listings/:listingId/request      the exact request one listing received (products.publish:
 *                                                              it shows raw seller and item identifiers)
 *
 * Query (both lists): channel, marketplace (or market), accountId, state (comma list), source (comma list), productId,
 * userId (or by=me), from, to, q, checked (true | false), cursor, limit (default 50, max 100). The counts take the same
 * query and ignore state, checked, cursor and limit. No database access here — the service owns it.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { requestUserId } from '../lib/auth/request-permission.js'
import { countPublicationHistory, listPublicationHistory, parseHistoryQuery, publicationRunDetail, publicationRunRequest } from '../services/pim/publication-history.service.js'

function sendError(reply: FastifyReply, request: FastifyRequest, err: unknown) {
  const e = err as { statusCode?: unknown; code?: unknown; message?: unknown }
  if (typeof e?.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500)
    return reply.code(e.statusCode).send({ error: typeof e.code === 'string' ? e.code : 'bad_request', message: String(e.message ?? '') })
  request.log.error({ err }, 'publication history read failed')
  return reply.code(500).send({ error: 'publication_history_failed', message: 'The publish history could not be read. Try again.' })
}

async function queryOf(request: FastifyRequest, productId?: string) {
  const raw = { ...(request.query as Record<string, unknown>) }
  if (productId) raw.productId = productId
  if (raw.by === 'me') raw.userId = requestUserId(request)
  return parseHistoryQuery(raw)
}

async function listFor(request: FastifyRequest, reply: FastifyReply, productId?: string) {
  try {
    const query = await queryOf(request, productId)
    reply.header('Cache-Control', 'no-store')
    return await listPublicationHistory(query)
  } catch (err) {
    return sendError(reply, request, err)
  }
}

async function countsFor(request: FastifyRequest, reply: FastifyReply, productId?: string) {
  try {
    const query = await queryOf(request, productId)
    reply.header('Cache-Control', 'no-store')
    return await countPublicationHistory(query)
  } catch (err) {
    return sendError(reply, request, err)
  }
}

const publicationHistoryRoutes: FastifyPluginAsync = async fastify => {
  fastify.get('/publications', async (request, reply) => listFor(request, reply))

  fastify.get('/publications/counts', async (request, reply) => countsFor(request, reply))

  fastify.get<{ Params: { id: string } }>('/products/:id/publications', async (request, reply) => listFor(request, reply, request.params.id))

  fastify.get<{ Params: { id: string } }>('/products/:id/publications/counts', async (request, reply) => countsFor(request, reply, request.params.id))

  fastify.get<{ Params: { id: string } }>('/publications/:id', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'no-store')
      return await publicationRunDetail(request.params.id)
    } catch (err) {
      return sendError(reply, request, err)
    }
  })

  fastify.get<{ Params: { id: string; listingId: string } }>('/publications/:id/listings/:listingId/request', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'no-store')
      return await publicationRunRequest(request.params.id, request.params.listingId)
    } catch (err) {
      return sendError(reply, request, err)
    }
  })
}

export default publicationHistoryRoutes
