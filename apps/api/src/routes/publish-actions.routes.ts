/**
 * Sheet publish parity, build shape v2 (Owner 2026-10-04), phase P2 — the waiting Action and Status values of listing
 * rows (`services/listings/publish-action.service.ts`; shared rules in `@nexus/shared/publish-actions`).
 *
 *   GET /api/products/:id/studio/publish-actions?channel&marketplace&accountId&aliasKey   (every filter optional)
 *       → { rows, readAt }: every listing row of the family — selling state, waiting values with who and when,
 *         options. New listings: with channel, marketplace and accountId all named (one destination; aliasKey '' unless
 *         named), every family member with NO listing there is a row too (`create`, a `new:` listing id). products.view
 *   PUT /api/products/:id/studio/publish-actions/send/:mode      partial | full | delete
 *   PUT /api/products/:id/studio/publish-actions/status/:target  active | inactive | ended | not_listed | none (clears)
 *       (a `new:` listing id starts the family's drafts on that destination first: `started` in the answer)
 *       body { listingIds?, expected?, allCoordinates? } → { applied, refused, conflicts }
 *       delete and ended: products.delete; every other value: products.publish
 *
 * Each value is its own registered path, so the permission manifest (which sees the route pattern, never the URL)
 * decides by path; the service checks again. Setting a value sends nothing: Publish does, after the review.
 * No database access here — the service owns it.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { SEND_MODES, type SendMode } from '@nexus/shared/publish-actions'
import { ALL_STATUS_TARGETS, type StatusTarget } from '@nexus/shared/listing-actions'
import {
  parsePublishActionBody, PublishActionError, readPublishActions, writePublishActions,
  type PublishActionDestinationFilter,
} from '../services/listings/publish-action.service.js'
import { WorkspaceScopeError } from '../services/pim/workspace-destination.js'
import { permissionCheckerFor } from './studio-matrix.routes.js'

const CODES: Record<number, string> = { 400: 'invalid_request', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 422: 'refused' }

function sendError(reply: FastifyReply, request: FastifyRequest, err: unknown) {
  if (err instanceof PublishActionError) return reply.code(err.statusCode).send({ error: err.code, message: err.message })
  if (err instanceof WorkspaceScopeError) return reply.code(err.statusCode).send({ error: CODES[err.statusCode] ?? 'refused', message: err.message })
  const e = err as { statusCode?: unknown; code?: unknown; message?: unknown }
  if (typeof e?.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500)
    return reply.code(e.statusCode).send({ error: typeof e.code === 'string' ? e.code : CODES[e.statusCode] ?? 'bad_request', message: String(e.message ?? '') })
  request.log.error({ err }, 'publish actions request failed')
  return reply.code(500).send({ error: 'publish_actions_failed', message: 'The waiting values could not be read or saved. Nothing was changed; reload the sheet to check them.' })
}

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined

function destinationOf(query: unknown): PublishActionDestinationFilter {
  const q = (query ?? {}) as Record<string, unknown>
  return {
    channel: text(q.channel), marketplace: text(q.marketplace) ?? text(q.market), accountId: text(q.accountId),
    // '' is the primary listing, so an empty aliasKey is a real filter; only an absent one is "any".
    ...(typeof q.aliasKey === 'string' ? { aliasKey: q.aliasKey } : {}),
  }
}

const actorOf = (request: FastifyRequest) => ({ userId: request.authUser?.id ?? null, can: permissionCheckerFor(request) })

const publishActionRoutes: FastifyPluginAsync = async fastify => {
  fastify.get<{ Params: { id: string } }>('/products/:id/studio/publish-actions', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'no-store')
      const destination = destinationOf(request.query)
      // New listings: one destination named exactly also reads the family members with no listing there.
      const newRows = !!(destination.channel && destination.marketplace && destination.accountId)
      return { rows: await readPublishActions(request.params.id, destination, { newRows }), readAt: new Date().toISOString() }
    } catch (err) { return sendError(reply, request, err) }
  })

  for (const mode of SEND_MODES) {
    fastify.put<{ Params: { id: string } }>(`/products/:id/studio/publish-actions/send/${mode}`, async (request, reply) => {
      try {
        reply.header('Cache-Control', 'no-store')
        const body = parsePublishActionBody(request.body)
        return await writePublishActions(request.params.id, { ...body, change: { column: 'send', mode: mode as SendMode } }, actorOf(request))
      } catch (err) { return sendError(reply, request, err) }
    })
  }

  for (const target of [...ALL_STATUS_TARGETS, 'none'] as const) {
    fastify.put<{ Params: { id: string } }>(`/products/:id/studio/publish-actions/status/${target}`, async (request, reply) => {
      try {
        reply.header('Cache-Control', 'no-store')
        const body = parsePublishActionBody(request.body)
        return await writePublishActions(request.params.id, { ...body, change: { column: 'status', target: target === 'none' ? null : target as StatusTarget } }, actorOf(request))
      } catch (err) { return sendError(reply, request, err) }
    })
  }
}

export default publishActionRoutes
