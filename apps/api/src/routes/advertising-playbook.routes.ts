/**
 * ADS PLAYBOOK PB-2 — the Amazon Ads playbook, read: the same answers Claude's `ads-playbook` tool gives
 * (services/advertising/ads-playbook/read.ts), for the Control Room's Playbook section.
 *
 *   GET /api/advertising/automation/playbook?market=IT              every playbook row of the market
 *   GET /api/advertising/automation/playbook/effective?market=IT&productId|sku|categoryId=
 *                                                                     the playbook one scope follows, each part with its
 *                                                                     source, and the strategy in force beside it
 *   GET /api/advertising/automation/playbook/templates?templateId=  the templates (one with its whole doc)
 *   GET /api/advertising/automation/playbook/history?market=IT&productId|sku|categoryId=&limit=  or ?templateId=
 *                                                                     the recorded changes, newest first
 *   GET /api/advertising/automation/playbook/capture?market=IT&productToken=&campaignIds=a,b|portfolioId=|namePrefix=
 *       &competitorTokens=a,b                                        what a template captured from live campaigns
 *                                                                     would hold; nothing is saved
 *
 * ads.view, as every advertising read (permissions-manifest.ts). The playbook's money keys (budgets, bids, targets) are
 * stripped for a person without financials.adspend.view, as the strategy routes strip theirs. No Prisma here
 * (scripts/check-route-prisma-ratchet.mjs).
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { financialPayloadCopy } from '../lib/auth/field-filter.js'
import type { ResolvedPermissions } from '../lib/auth/rbac.js'
import { PLAYBOOK_MONEY } from '../services/advertising/ads-playbook/doc.js'
import { readPlaybook, type PlaybookViewName } from '../services/advertising/ads-playbook/read.js'

const NO_PERMISSIONS: ResolvedPermissions = { isOwner: false, permissions: new Set() }
/** A query value given once, as text; anything else (absent, empty, repeated) is not given. */
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
/** A comma-separated list given once; absent or empty is not given. */
const list = (value: unknown) => {
  const given = text(value)
  const items = given?.split(',').map((item) => item.trim()).filter(Boolean)
  return items?.length ? items : undefined
}

/** The playbook's money keys, stripped under the same switch as the response filter (field-filter.ts). */
function withoutHiddenMoney(request: FastifyRequest, payload: Record<string, unknown>): Record<string, unknown> {
  if (process.env.NEXUS_RBAC_MODE !== 'enforce' && process.env.NEXUS_WORKSPACES_ENABLED !== '1') return payload
  return financialPayloadCopy(payload, request.__rbacResolved ?? NO_PERMISSIONS, PLAYBOOK_MONEY)
}

const advertisingPlaybookRoutes: FastifyPluginAsync = async (fastify) => {
  const read = (view: PlaybookViewName) => async (request: FastifyRequest, reply: FastifyReply) => {
    const q = (request.query ?? {}) as Record<string, unknown>
    const limitText = text(q.limit)
    const limit = limitText === undefined ? undefined : Number(limitText)
    if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 100)) return reply.code(400).send({ error: 'limit must be a whole number from 1 to 100' })
    const campaignIds = list(q.campaignIds)
    if (campaignIds && campaignIds.length > 50) return reply.code(400).send({ error: 'campaignIds: at most 50 campaigns' })
    const out = await readPlaybook({
      view,
      channel: text(q.channel),
      market: text(q.market),
      productId: text(q.productId),
      sku: text(q.sku),
      categoryId: text(q.categoryId),
      templateId: text(q.templateId),
      campaignIds,
      portfolioId: text(q.portfolioId),
      namePrefix: text(q.namePrefix),
      productToken: text(q.productToken),
      competitorTokens: list(q.competitorTokens),
      limit,
    })
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    return withoutHiddenMoney(request, out.data)
  }
  fastify.get('/advertising/automation/playbook', read('rows'))
  fastify.get('/advertising/automation/playbook/effective', read('effective'))
  fastify.get('/advertising/automation/playbook/templates', read('templates'))
  fastify.get('/advertising/automation/playbook/history', read('history'))
  fastify.get('/advertising/automation/playbook/capture', read('capture'))
}

export default advertisingPlaybookRoutes
