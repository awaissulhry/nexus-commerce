/**
 * Bid page (2026-10-10) — the bid rules over HTTP (services/advertising/bid-rules/):
 *
 *   GET  /api/advertising/bid-rules?market=                every bid rule, the brain first as the pseudo-row `id: 'brain'`:
 *                                                          { market, rules: BidRuleRow[], totals }. A row's holds are
 *                                                          { kind, label, reason } (chip, tooltip); its runs say nextRunAt,
 *                                                          firstRunAt / thenRunAt and the schedule in words; scope.counts
 *                                                          are the true totals (the ref lists stop at 100)
 *   GET  /api/advertising/bid-rules/:id/history?days=&market=&limit=
 *                                                          one rule's (or the brain's) changes, newest first, each with its
 *                                                          keyword, ad group, campaign, portfolio, from → to, who, delivery and
 *                                                          `changeId` for POST /api/advertising/changes/:changeId/undo
 *   POST /api/advertising/bid-rules/preview                what a rule body (saved — `ruleId` — or not) would change now:
 *                                                          { wouldChange, brainInputs, locked, holds, sample: [{ target,
 *                                                          adGroup, campaign, fromCents, toCents, held, heldBy }], … }.
 *                                                          Writes nothing.
 *   POST /api/advertising/bid-rules/:id/archive            archive (replaces delete): runs and changes kept, inert, reversible
 *   POST /api/advertising/bid-rules/:id/unarchive          back among the rules at Off
 *   POST /api/advertising/bid-rules/:id/asks/undo          R4 — undo approved asks of the rule { suggestionIds: string[] }
 *                                                          (1–200): each put back AS THE RULE (never a person's bid: no hold,
 *                                                          not "You"), then waiting again unless too old or the rule is
 *                                                          archived: { results: [{ suggestionId, restored, reopened, reason }],
 *                                                          undone, reopened } (bid-rules/ask-undo.ts). A refusal is per ask.
 *
 * Reads and the preview need ads.view; archive and unarchive ads.automation.manage; the asks' undo ads.bids.edit
 * (lib/auth/permissions-manifest.ts).
 * Money keys (BID_RULES_MONEY: bids, spend, sales, ACoS) are stripped for a person without financials.adspend.view, under
 * the same switch as the response filter (field-filter.ts). The workspace is the request's: another business's rule id
 * reads as not found (404). Answers are never cached. No Prisma here (scripts/check-route-prisma-ratchet.mjs).
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { financialPayloadCopy } from '../lib/auth/field-filter.js'
import type { ResolvedPermissions } from '../lib/auth/rbac.js'
import type { AdsActor } from '../services/advertising/ads-mutation.service.js'
import { BID_RULES_MONEY, bidRuleHistory, listBidRules } from '../services/advertising/bid-rules/read.js'
import { previewBidRuleBody, type PreviewBody } from '../services/advertising/bid-rules/preview.js'
import { setBidRuleArchived } from '../services/advertising/bid-rules/write.js'
import { undoApprovedAsks } from '../services/advertising/bid-rules/ask-undo.js'

const MARKET = z.string().trim().min(2).max(20).optional()
const LIST_QUERY = z.object({ market: MARKET })
const HISTORY_QUERY = z.object({
  market: MARKET,
  days: z.coerce.number().int().min(1).max(90).default(7),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})
const ID = z.string().trim().min(1).max(64)
const PREVIEW_BODY = z.object({
  ruleId: ID.optional(),
  actions: z.array(z.unknown()).optional(),
  conditions: z.unknown().optional(),
  scopeMarketplace: z.string().trim().max(20).nullable().optional(),
  scopePortfolioId: z.string().trim().max(64).nullable().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

const UNDO_BODY = z.object({ suggestionIds: z.array(ID).min(1).max(200) })

const NO_PERMISSIONS: ResolvedPermissions = { isOwner: false, permissions: new Set() }

/** The answer without the money keys this person may not see (the switch the response filter uses). */
function withoutHiddenMoney(request: FastifyRequest, payload: unknown): unknown {
  if (process.env.NEXUS_RBAC_MODE !== 'enforce' && process.env.NEXUS_WORKSPACES_ENABLED !== '1') return payload
  return financialPayloadCopy(payload, request.__rbacResolved ?? NO_PERMISSIONS, BID_RULES_MONEY)
}

const problemOf = (error: z.ZodError) => {
  const issue = error.issues[0]
  return issue ? `${issue.path.join('.') || 'query'}: ${issue.message}` : 'not a request this route takes'
}

/** Who archives: the signed-in person, else the `x-actor-id` header, else anonymous (as the rule routes record it). */
function personActor(request: FastifyRequest): AdsActor {
  const user = (request as { authUser?: { id?: string } }).authUser?.id
  if (user) return `user:${user}` as AdsActor
  const header = request.headers['x-actor-id']
  return (typeof header === 'string' && header ? `user:${header}` : 'user:anonymous') as AdsActor
}

const advertisingBidRulesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/advertising/bid-rules', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const parsed = LIST_QUERY.safeParse(request.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: problemOf(parsed.error) })
    return withoutHiddenMoney(request, await listBidRules({ market: parsed.data.market ?? null }))
  })

  fastify.get('/advertising/bid-rules/:id/history', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { id } = request.params as { id: string }
    const parsed = HISTORY_QUERY.safeParse(request.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: problemOf(parsed.error) })
    const out = await bidRuleHistory(id, { days: parsed.data.days, limit: parsed.data.limit, market: parsed.data.market ?? null })
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    return withoutHiddenMoney(request, out.data)
  })

  fastify.post('/advertising/bid-rules/preview', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const parsed = PREVIEW_BODY.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: problemOf(parsed.error) })
    const out = await previewBidRuleBody(parsed.data as PreviewBody)
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    return withoutHiddenMoney(request, out.data)
  })

  const archive = (archived: boolean) => async (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
    reply.header('Cache-Control', 'no-store')
    const { id } = request.params as { id: string }
    const out = await setBidRuleArchived(id, archived, personActor(request))
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    return out.data
  }
  fastify.post('/advertising/bid-rules/:id/archive', archive(true))
  fastify.post('/advertising/bid-rules/:id/unarchive', archive(false))

  fastify.post('/advertising/bid-rules/:id/asks/undo', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { id } = request.params as { id: string }
    const parsed = UNDO_BODY.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: problemOf(parsed.error) })
    const out = await undoApprovedAsks(id, parsed.data.suggestionIds, personActor(request))
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    return out.data
  })
}

export default advertisingBidRulesRoutes
