/**
 * KAPI-B (2026-10-10, Bid page "keyword Auto + goal + max bid") — one keyword's Auto / Manual
 * (services/advertising/bid-mode.service.ts).
 *
 *   POST /api/advertising/bids/:targetId/mode   { mode: 'AUTO' | 'MANUAL' }
 *       → { targetId, campaignId, mode, before, changed, holdId, ended[], undo: { mode }, words }
 *
 *   MANUAL   a person's hold with no end: the bid brain leaves the keyword until he switches it back
 *   AUTO     hand back: his holds of the keyword end, the bid brain runs it again from its next tick
 *   undo     the same route with `undo.mode` puts it back
 *
 * ads.bids.edit (permissions-manifest.ts, named on its own). 404 a keyword not in this business (the request's workspace,
 * the global workspace hook) · 409 a campaign the bid brain does not run, or Auto while the campaign's pinned bids, a hold
 * on the whole campaign or the Owner's lock of the keyword's bid keeps it Manual (each said with what lifts it) · 400 a
 * body that is not one mode. Nothing is sent to Amazon. Answers are not cached. No Prisma here
 * (scripts/check-route-prisma-ratchet.mjs).
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { BID_MODES, setBidMode } from '../services/advertising/bid-mode.service.js'

const PARAMS = z.object({ targetId: z.string().trim().min(1).max(64) })
const BODY = z.object({ mode: z.enum(BID_MODES) }).strict()

/** The signed-in person (`user:<id>`), as the other Bid page writes name him. */
function personActor(request: FastifyRequest): string {
  const user = (request as { authUser?: { id?: string } }).authUser?.id
  if (user) return `user:${user}`
  const header = request.headers['x-actor-id']
  return typeof header === 'string' && header ? `user:${header}` : 'user:anonymous'
}

const advertisingBidModeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/advertising/bids/:targetId/mode', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const params = PARAMS.safeParse(request.params ?? {})
    const body = BODY.safeParse(request.body ?? {})
    if (!params.success || !body.success) {
      const issue = (params.success ? null : params.error.issues[0]) ?? (body.success ? null : body.error.issues[0])
      return reply.code(400).send({ error: issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'the body is { mode: "AUTO" | "MANUAL" }' })
    }
    const out = await setBidMode(params.data.targetId, body.data.mode, personActor(request))
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    return out.data
  })
}

export default advertisingBidModeRoutes
