/**
 * ADS AUTONOMY W1-2 — the Amazon Ads strategy, read: the same answers Claude's `ads-strategy` tool gives
 * (services/advertising/ads-strategy/read.ts), for the Control Room's Strategy tab (W1-4).
 *
 *   GET /api/advertising/automation/strategy?market=IT              every strategy row of the market, and the older
 *                                                                     settings at the same grains
 *   GET /api/advertising/automation/strategy/effective?market=IT&productId|sku|categoryId|campaignId|adGroupId=
 *                                                                     every number in force for one scope, with its source
 *   GET /api/advertising/automation/strategy/history?market=IT&productId|sku|categoryId=&limit=
 *                                                                     the recorded changes, newest first
 *
 * ads.view, as every advertising read (permissions-manifest.ts). The strategy's money keys (targets, bids, caps, spend
 * thresholds) are stripped for a person without financials.adspend.view, as the response filter strips the shared
 * registry's — they are not all in that registry (`minBidCents` names an ordinary campaign column elsewhere). No
 * Prisma here (scripts/check-route-prisma-ratchet.mjs); writes come with W1-3.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { financialPayloadCopy } from '../lib/auth/field-filter.js'
import type { ResolvedPermissions } from '../lib/auth/rbac.js'
import { STRATEGY_MONEY } from '../services/advertising/ads-strategy/fields.js'
import { readStrategy, type StrategyViewName } from '../services/advertising/ads-strategy/read.js'

const NO_PERMISSIONS: ResolvedPermissions = { isOwner: false, permissions: new Set() }
/** A query value given once, as text; anything else (absent, empty, repeated) is not given. */
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

/** The strategy's own money keys, stripped under the same switch as the response filter (field-filter.ts). */
function withoutHiddenMoney(request: FastifyRequest, payload: Record<string, unknown>): Record<string, unknown> {
  if (process.env.NEXUS_RBAC_MODE !== 'enforce' && process.env.NEXUS_WORKSPACES_ENABLED !== '1') return payload
  return financialPayloadCopy(payload, request.__rbacResolved ?? NO_PERMISSIONS, STRATEGY_MONEY)
}

const advertisingStrategyRoutes: FastifyPluginAsync = async (fastify) => {
  const read = (view: StrategyViewName) => async (request: FastifyRequest, reply: FastifyReply) => {
    const q = (request.query ?? {}) as Record<string, unknown>
    const limitText = text(q.limit)
    const limit = limitText === undefined ? undefined : Number(limitText)
    if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 100)) return reply.code(400).send({ error: 'limit must be a whole number from 1 to 100' })
    const out = await readStrategy({
      view,
      channel: text(q.channel),
      market: text(q.market),
      productId: text(q.productId),
      sku: text(q.sku),
      categoryId: text(q.categoryId),
      campaignId: text(q.campaignId),
      adGroupId: text(q.adGroupId),
      limit,
    })
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    return withoutHiddenMoney(request, out.data)
  }
  fastify.get('/advertising/automation/strategy', read('rows'))
  fastify.get('/advertising/automation/strategy/effective', read('effective'))
  fastify.get('/advertising/automation/strategy/history', read('history'))
}

export default advertisingStrategyRoutes
