/**
 * Sheet publish parity, step 7 (item 5) and build shape v2 — the listing-action engine's doors (the sheet's Status
 * column, the Action column's Delete).
 *
 *   GET  /api/products/:id/listing-actions/state?channel&market&accountId&aliasKey
 *        → every row's selling state (Active / Inactive / Ended / …) and the changes it may offer        products.view
 *   POST /api/products/:id/listing-actions/<action>/preview  { scope: { channel, marketplace, accountId, aliasKey }, productIds?, reason? }
 *        → what each row would do, saved for 15 minutes
 *   POST /api/products/:id/listing-actions/<action>/run      { previewId, confirm? }   (End: confirm 'END'; Delete: confirm 'DELETE')
 *        → the channel calls, through the gateway; refused with a plain sentence when the publish mode is not live
 *   <action> = pause | resume | relist (products.publish) · end | delete (products.delete)
 *
 * Each action is its own registered path: the permission manifest sees the route PATTERN, never the URL, so a
 * `:action` parameter would have read every action as products.publish (End and Delete included). No database access
 * here — the service owns it.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { LISTING_ACTIONS } from '@nexus/shared/listing-actions'
import { ListingActionError, previewListingAction, readListingActionState, runListingAction } from '../services/listings/listing-action.service.js'
import { WorkspaceScopeError } from '../services/pim/workspace-destination.js'

const CODES: Record<number, string> = { 400: 'invalid_request', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 422: 'refused' }

function sendError(reply: FastifyReply, request: FastifyRequest, err: unknown) {
  if (err instanceof ListingActionError) return reply.code(err.statusCode).send({ error: err.code, message: err.message })
  if (err instanceof WorkspaceScopeError) return reply.code(err.statusCode).send({ error: CODES[err.statusCode] ?? 'refused', message: err.message })
  const e = err as { statusCode?: unknown; code?: unknown; message?: unknown }
  if (typeof e?.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500)
    return reply.code(e.statusCode).send({ error: typeof e.code === 'string' ? e.code : CODES[e.statusCode] ?? 'bad_request', message: String(e.message ?? '') })
  request.log.error({ err }, 'listing action request failed')
  return reply.code(500).send({ error: 'listing_action_failed', message: 'The change could not be read or sent. Nothing was assumed; open the listing to check it.' })
}

const userOf = (request: FastifyRequest) => request.authUser?.id ?? null

const listingActionRoutes: FastifyPluginAsync = async fastify => {
  fastify.get<{ Params: { id: string } }>('/products/:id/listing-actions/state', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'no-store')
      return await readListingActionState(request.params.id, request.query as Record<string, unknown>)
    } catch (err) { return sendError(reply, request, err) }
  })

  for (const action of LISTING_ACTIONS) {
    fastify.post<{ Params: { id: string } }>(`/products/:id/listing-actions/${action}/preview`, async (request, reply) => {
      try {
        reply.header('Cache-Control', 'no-store')
        return await previewListingAction(request.params.id, action, request.body, userOf(request))
      } catch (err) { return sendError(reply, request, err) }
    })

    fastify.post<{ Params: { id: string } }>(`/products/:id/listing-actions/${action}/run`, async (request, reply) => {
      try {
        reply.header('Cache-Control', 'no-store')
        return await runListingAction(request.params.id, action, request.body, userOf(request))
      } catch (err) { return sendError(reply, request, err) }
    })
  }
}

export default listingActionRoutes
