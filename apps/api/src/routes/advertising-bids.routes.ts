/**
 * Bid page (BAPI, 2026-10-10) — the bids, each with its one owner (services/advertising/bid-rows.service.ts).
 *
 *   GET /api/advertising/bids?market=&productId=&campaignId=&adGroupId=&owner=&status=
 *       → { rows: BidRow[], totals }
 *
 *   scope    market, portfolioId (the campaign's; Amazon's id), productId (its line), campaignId, adGroupId, and (scope
 *            filter, 2026-10-12) portfolioIds, productIds, campaignIds, adGroupIds: comma-separated, at most 500 each; a
 *            singular is a list of one merged with its plural; OR inside a list, AND across lists. The rows and the
 *            totals follow it (bid-delivery.ts bidScopeWhere).
 *   owner    a kind (BRAIN · RULE · PLAN · PERSON · ENGINE · NONE, any case) or an owner's id (a rule's id, brain,
 *            auto-bid, you): narrows the rows, never the totals
 *   status   live (default: the target, its ad group and its campaign enabled) · all (everything not archived)
 *
 *   GET /api/advertising/bids/suggested?adGroupId=  (or campaignId=)
 *       → { fetchedAt, rows: [{ targetId, low, mid, high, theme }], unavailable }
 *       Amazon's own suggested bid per keyword and target (services/advertising/bid-suggested.service.ts): low / mid / high
 *       in cents, null where Amazon gave none, never Nexus's own median; `unavailable` says why in words. Kept 6 hours per
 *       ad group in the process.
 *
 *   GET /api/advertising/bids/cursor?<the query of /bids>
 *       → { latestChangeAt, waiting, sent }
 *       The page's live cursor (services/advertising/bid-delivery.ts): the newest move of a bid change in scope and how many
 *       bids have their newest change Waiting or Sent. The page polls it (5 s while something is Waiting / Sent, 60 s
 *       otherwise) and reads the rows again only when it moved. `owner` is taken and does not narrow it.
 *
 * All three are reads that need ads.view only: permissions-manifest.ts maps every GET under /api/advertising to ads.view
 * before its /bid rule (which asks ads.bids.edit of the writes under these paths). The money keys (bids, the ceiling, the brain's aim, a change's from → to, spend, ACoS, the 7-day line:
 * BID_ROWS_MONEY; the suggested low / mid / high: SUGGESTED_MONEY) are stripped for a person without
 * financials.adspend.view, under the same switch as the response filter (field-filter.ts), and the rows are then ordered
 * by campaign and words, not by spend (the order would give the ranking away). The cursor carries no money. The workspace
 * is the request's (the global workspace hook): another business's campaign, ad group or product is a 404. The answers
 * are `no-store` (the suggested bids' 6 hours are the server's own cache). No Prisma here
 * (scripts/check-route-prisma-ratchet.mjs).
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { FIELDS } from '@nexus/shared/permissions'
import { financialPayloadCopy } from '../lib/auth/field-filter.js'
import type { ResolvedPermissions } from '../lib/auth/rbac.js'
import { ID_LIST } from '../services/advertising/ads-scope-lists.js'
import { BID_ROWS_MONEY, readBidRows } from '../services/advertising/bid-rows.service.js'
import { readBidCursor } from '../services/advertising/bid-delivery.js'
import { SUGGESTED_MONEY, readSuggestedBids } from '../services/advertising/bid-suggested.service.js'

const id = z.string().trim().min(1).max(64)
const BIDS_QUERY = z.object({
  market: z.string().trim().toUpperCase().min(2).max(20).optional(),
  portfolioId: id.optional(),
  productId: id.optional(),
  campaignId: id.optional(),
  adGroupId: id.optional(),
  portfolioIds: ID_LIST.optional(),
  productIds: ID_LIST.optional(),
  campaignIds: ID_LIST.optional(),
  adGroupIds: ID_LIST.optional(),
  owner: z.string().trim().min(1).max(64).optional(),
  status: z.enum(['live', 'all']).default('live'),
}).strict()

const SUGGESTED_QUERY = z.object({ adGroupId: id.optional(), campaignId: id.optional() }).strict()
  .refine((q) => !!(q.adGroupId || q.campaignId), { message: 'give adGroupId or campaignId', path: ['adGroupId'] })

const NO_PERMISSIONS: ResolvedPermissions = { isOwner: false, permissions: new Set() }

/** The switch the response filter strips money under (field-filter.ts). */
const moneyFiltered = () => process.env.NEXUS_RBAC_MODE === 'enforce' || process.env.NEXUS_WORKSPACES_ENABLED === '1'

/** The person sees ad spend: no filter, the owner, all financials, or ad spend. */
function seesAdSpend(request: FastifyRequest): boolean {
  if (!moneyFiltered()) return true
  const resolved = request.__rbacResolved ?? NO_PERMISSIONS
  return resolved.isOwner || resolved.permissions.has(FIELDS.financialsView) || resolved.permissions.has(FIELDS.financialsAdspendView)
}

/** The answer's money keys, stripped under the same switch as the response filter (field-filter.ts). */
function withoutHiddenMoney<T>(request: FastifyRequest, payload: T, money: Readonly<Record<string, string>> = BID_ROWS_MONEY): T {
  if (!moneyFiltered()) return payload
  return financialPayloadCopy(payload, request.__rbacResolved ?? NO_PERMISSIONS, money)
}

/** A query this read does not take, in words (the first issue). */
function badQuery(error: z.ZodError): { error: string } {
  const issue = error.issues[0]
  return { error: issue ? `${issue.path.join('.') || 'query'}: ${issue.message}` : 'the query is not one this read takes' }
}

const advertisingBidsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/advertising/bids', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const parsed = BIDS_QUERY.safeParse(request.query ?? {})
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return reply.code(400).send({ error: issue ? `${issue.path.join('.') || 'query'}: ${issue.message}` : 'the query is not one this read takes' })
    }
    // Without ad spend the rows are not ordered by it either: the order would give the ranking away.
    const out = await readBidRows({ ...parsed.data, order: seesAdSpend(request) ? 'spend' : 'name' })
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    return withoutHiddenMoney(request, { rows: out.rows, totals: out.totals })
  })

  fastify.get('/advertising/bids/suggested', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const parsed = SUGGESTED_QUERY.safeParse(request.query ?? {})
    if (!parsed.success) return reply.code(400).send(badQuery(parsed.error))
    const out = await readSuggestedBids(parsed.data)
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    return withoutHiddenMoney(request, out.answer, SUGGESTED_MONEY)
  })

  fastify.get('/advertising/bids/cursor', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const parsed = BIDS_QUERY.safeParse(request.query ?? {})
    if (!parsed.success) return reply.code(400).send(badQuery(parsed.error))
    const out = await readBidCursor(parsed.data)
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    return out.cursor
  })
}

export default advertisingBidsRoutes
