/**
 * Item ID control (docs/sheet-ids-sku-rows/A2-item-id-control.md, step I1) — the product sheet's eBay Item ID cell.
 *
 *   POST /api/listings/:id/channel-id/check   { externalId? }                                  → what eBay says (writes nothing)
 *   POST /api/listings/:id/channel-id/link    { externalId, expectedExternalId, expectedVersion } → link it (or Keep it)
 *   POST /api/listings/:id/channel-id/unlink  { expectedExternalId, expectedVersion }             → Nexus forgets it
 *
 * `:id` is the family's MAIN row listing (eBay: one item per family). The signed-in person acts (`request.authUser`),
 * not Claude's approval queue; the rules are the ones Claude's link-channel-id / unlink-channel-id use. Permission:
 * `listings.recover` (permissions-manifest.ts). Link and unlink honour an Idempotency-Key (`COMMAND_SCOPES`), so a
 * double press runs once. A refusal is a status with one plain sentence: 404 not found, 409 changed meanwhile (the
 * fence), 422 the rule refused it; nothing changed. No database access here — the services own it.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { IdentityFixRefusal } from '../services/identity/identity-fix.service.js'
import { checkSheetChannelId, linkSheetChannelId, unlinkSheetChannelId } from '../services/identity/channel-id.service.js'

const MAX_ID = 40
const STATUS: Record<IdentityFixRefusal['code'], number> = { not_found: 404, conflict: 409, refused: 422 }

class BadRequest extends Error {}

const record = (body: unknown): Record<string, unknown> =>
  body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}

function idText(value: unknown, name: string, required: boolean): string | null {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    if (required) throw new BadRequest(`${name} is required.`)
    return null
  }
  if (typeof value !== 'string') throw new BadRequest(`${name} must be text.`)
  const text = value.trim()
  if (text.length > MAX_ID) throw new BadRequest(`${name} has more than ${MAX_ID} characters.`)
  return text
}

function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new BadRequest('expectedVersion must be the listing version the sheet read (a whole number).')
  return value
}

export function parseCheckBody(body: unknown): { externalId: string | null } {
  return { externalId: idText(record(body).externalId, 'externalId', false) }
}

export function parseLinkBody(body: unknown): { externalId: string; expectedExternalId: string | null; expectedVersion: number } {
  const b = record(body)
  return { externalId: idText(b.externalId, 'externalId', true)!, expectedExternalId: idText(b.expectedExternalId, 'expectedExternalId', false), expectedVersion: version(b.expectedVersion) }
}

export function parseUnlinkBody(body: unknown): { expectedExternalId: string; expectedVersion: number } {
  const b = record(body)
  return { expectedExternalId: idText(b.expectedExternalId, 'expectedExternalId', true)!, expectedVersion: version(b.expectedVersion) }
}

function sendError(reply: FastifyReply, request: FastifyRequest, err: unknown) {
  if (err instanceof BadRequest) return reply.code(400).send({ error: 'invalid_request', message: err.message })
  if (err instanceof IdentityFixRefusal) return reply.code(STATUS[err.code] ?? 422).send({ error: err.code, message: err.message })
  request.log.error({ err }, 'channel id request failed')
  return reply.code(500).send({ error: 'channel_id_failed', message: 'The Item ID could not be checked or changed. Nothing was assumed; read the sheet again to see what Nexus holds.' })
}

const userOf = (request: FastifyRequest) => request.authUser?.id ?? null

const channelIdRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { id: string } }>('/listings/:id/channel-id/check', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'no-store')
      return await checkSheetChannelId(request.params.id, parseCheckBody(request.body))
    } catch (err) { return sendError(reply, request, err) }
  })

  fastify.post<{ Params: { id: string } }>('/listings/:id/channel-id/link', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'no-store')
      return await linkSheetChannelId(request.params.id, parseLinkBody(request.body), userOf(request))
    } catch (err) { return sendError(reply, request, err) }
  })

  fastify.post<{ Params: { id: string } }>('/listings/:id/channel-id/unlink', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'no-store')
      return await unlinkSheetChannelId(request.params.id, parseUnlinkBody(request.body), userOf(request))
    } catch (err) { return sendError(reply, request, err) }
  })
}

export default channelIdRoutes
