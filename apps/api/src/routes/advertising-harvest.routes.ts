/**
 * Keyword Harvest page (2026-10-10, lane HCORE) — the ONE harvest engine over HTTP (services/advertising/harvest/), every
 * harvest action of the page on one route file. Contract: ~/nexus-archive/2026-10-10-ads-pages/02-harvest/HCORE-API.md.
 *
 *   GET  /api/advertising/harvest/candidates            the terms that sell, one row per term × product × market, with
 *                                                       their sources, destination, start bid, state, owner, skip, waiting
 *   GET  /api/advertising/harvest/destinations          the product's portfolio → campaign → ad group tree (held, suggested)
 *   POST /api/advertising/harvest/preview               the change set step by step (writes nothing), with its planHash
 *   POST /api/advertising/harvest/apply                 ONE apply-harvest request (an approval, never a direct write);
 *                                                       `approve: true` approves it in the same click
 *   POST /api/advertising/harvest/skip | unskip         hide terms 7 d / 30 d / for good, and back (Nexus only, at once)
 *   POST /api/advertising/harvest/waiting/decide        approve / reject harvest requests (the Approvals page's own path)
 *   GET  /api/advertising/harvest/history               every actor's harvests, judged, with undo availability
 *   POST /api/advertising/harvest/undo                  ONE apply-harvest request (op undo): blocks lifted, keywords paused
 *   GET  /api/advertising/harvest/rules                 the harvest rules in the Bid page's row shape (the brain first)
 *   GET  /api/advertising/harvest/rules/:id/history     one rule's (or the brain's) harvests
 *   POST /api/advertising/harvest/rules/preview         what a rule would harvest now (writes nothing)
 *   POST /api/advertising/harvest/rules/:id/archive | unarchive
 *   POST /api/advertising/harvest/rules/mode            the mode of many rules at once (the level dial's own path)
 *   GET  /api/advertising/harvest/sources               the ad groups that feed terms, their rules, pause and 30 days
 *   POST /api/advertising/harvest/sources/assign | detach | pause | resume
 *
 * Reads need ads.view; the requests ads.campaigns.manage (the tool's own permissions are checked again by the gate); rules
 * and sources writes ads.automation.manage (lib/auth/permissions-manifest.ts). Money keys (HARVEST_MONEY) are stripped
 * for a person without financials.adspend.view, under the response filter's switch. Answers are never cached. The
 * workspace is the request's. No Prisma here (scripts/check-route-prisma-ratchet.mjs).
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { financialPayloadCopy } from '../lib/auth/field-filter.js'
import type { ResolvedPermissions } from '../lib/auth/rbac.js'
import type { AdsActor } from '../services/advertising/ads-mutation.service.js'
import { requestPrincipal, ToolAccessError, type UserPrincipal } from '../services/agents/call-tool.js'
import {
  HARVEST_MONEY, ITEM_INPUT, MAX_ITEMS, NEW_CAMPAIGN_INPUT, NEW_PORTFOLIO_INPUT,
  assignSources, decideHarvestRequests, detachSources, harvestCandidates, harvestDestinations, harvestHistory,
  harvestRuleHistory, harvestSources, listHarvestRules, marketsOf, pauseSources, previewChangeSet, previewHarvestRule, requestHarvestTool,
  resumeSources, setHarvestRuleArchived, setHarvestRulesMode, skipCandidates, unknownHarvests, unskipCandidates,
} from '../services/advertising/harvest/index.js'

const NO_PERMISSIONS: ResolvedPermissions = { isOwner: false, permissions: new Set() }
const ID = z.string().trim().min(1).max(64)
const IDS = z.array(ID).min(1).max(500)
const MARKET = z.string().trim().min(2).max(200)

const CANDIDATES_QUERY = z.object({
  market: MARKET,
  productId: ID.optional(), portfolioId: ID.optional(), campaignId: ID.optional(), adGroupId: ID.optional(),
  state: z.string().trim().max(400).optional(), owner: z.enum(['BRAIN', 'RULE', 'PERSON', 'NONE', 'brain', 'rule', 'person', 'none']).optional(),
  kind: z.enum(['keyword', 'asin']).optional(), q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(), pageSize: z.coerce.number().int().min(1).max(500).optional(),
  sort: z.string().trim().max(20).optional(),
})
const DESTINATIONS_QUERY = z.object({ market: MARKET.optional(), productId: ID.optional(), candidateId: z.string().trim().min(5).max(300).optional(), match: z.enum(['EXACT', 'PHRASE']).optional() })
const PREVIEW_BODY = z.object({
  items: z.array(ITEM_INPUT).min(1).max(MAX_ITEMS),
  newCampaigns: z.array(NEW_CAMPAIGN_INPUT).max(20).optional(),
  newPortfolios: z.array(NEW_PORTFOLIO_INPUT).max(10).optional(),
})
const APPLY_BODY = PREVIEW_BODY.extend({ planHash: z.string().trim().min(8).max(64), why: z.string().trim().max(300).optional(), approve: z.boolean().optional(), code: z.string().trim().max(16).optional() })
const SKIP_BODY = z.object({ ids: z.array(z.string().trim().min(5).max(300)).min(1).max(5000), days: z.union([z.literal(7), z.literal(30), z.null()]) })
const UNSKIP_BODY = z.object({ ids: z.array(z.string().trim().min(5).max(300)).min(1).max(5000) })
/** R6 (release review) — every decision is its own request's: many are decided in one call, one by one (a page of 2,000). */
const MAX_DECISIONS = 2000
const DECIDE_BODY = z.object({ decisions: z.array(z.object({ approvalId: ID, decide: z.enum(['approve', 'reject']), code: z.string().trim().max(16).optional() })).min(1).max(MAX_DECISIONS), reason: z.string().trim().max(500).optional() })
const HISTORY_QUERY = z.object({ market: MARKET, productId: ID.optional(), days: z.coerce.number().int().min(1).max(365).optional(), actor: z.string().trim().max(10).optional(), verdict: z.enum(['better', 'worse', 'too-early', 'none']).optional() })
const UNDO_BODY = z.object({ harvestIds: z.array(ID).min(1).max(200), why: z.string().trim().max(300).optional(), approve: z.boolean().optional(), code: z.string().trim().max(16).optional() })
const RULES_QUERY = z.object({ market: z.string().trim().min(2).max(20).optional() })
const RULE_HISTORY_QUERY = z.object({ market: z.string().trim().min(2).max(20).optional(), days: z.coerce.number().int().min(1).max(90).default(7), limit: z.coerce.number().int().min(1).max(500).default(200) })
const RULE_PREVIEW_BODY = z.object({
  ruleId: ID.optional(), actions: z.array(z.unknown()).optional(),
  scopeMarketplace: z.string().trim().max(20).nullable().optional(), scopePortfolioId: z.string().trim().max(64).nullable().optional(),
  scopeCampaignId: z.string().trim().max(64).nullable().optional(), scopeProductId: z.string().trim().max(64).nullable().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})
/** RS4 — `belt` (an Undo): the builder rule's own Manual/Automate to put back (null: it had none); absent = the mode's own. */
/** Delta review D1 — `marked` (an Undo, from `before`): whether the rule had its harvest Auto mark; false never sets one. */
const MODE_BODY = z.object({ ids: IDS, mode: z.enum(['OFF', 'WATCH', 'ASK', 'AUTO']), belt: z.enum(['manual', 'automate']).nullable().optional(), marked: z.boolean().optional() })
const SOURCES_QUERY = z.object({ market: z.string().trim().min(2).max(20) })
const ASSIGN_BODY = z.object({ ruleId: ID, adGroupIds: IDS })
const DETACH_BODY = z.object({ ruleId: ID.optional(), adGroupIds: IDS })
const PAUSE_BODY = z.object({ adGroupIds: IDS, reason: z.string().trim().max(300).optional() })
const RESUME_BODY = z.object({ adGroupIds: IDS })

/**
 * A refused request body. R6 (release review) — a list past its cap says so in a way the page splits on: `code:
 * 'too_many'`, the `max` one request takes and the list it is about (`path`). One apply or undo is one change set of at
 * most that many.
 */
function badRequest(error: z.ZodError): { error: string; code?: 'too_many'; max?: number; path?: string } {
  const big = error.issues.find((i) => i.code === 'too_big' && ((i as { origin?: unknown }).origin === 'array' || (i as { type?: unknown }).type === 'array'))
  if (big) {
    const max = Number((big as { maximum?: unknown }).maximum)
    return { error: `At most ${max} in one request (${big.path.join('.')}): split it into requests of ${max}.`, code: 'too_many', max, path: big.path.join('.') }
  }
  return { error: problemOf(error) }
}

const problemOf = (error: z.ZodError) => {
  const issue = error.issues[0]
  return issue ? `${issue.path.join('.') || 'request'}: ${issue.message}` : 'not a request this route takes'
}

/** The answer without the money keys this person may not see (the switch the response filter uses). */
function withoutHiddenMoney(request: FastifyRequest, payload: unknown): unknown {
  if (process.env.NEXUS_RBAC_MODE !== 'enforce' && process.env.NEXUS_WORKSPACES_ENABLED !== '1') return payload
  return financialPayloadCopy(payload, request.__rbacResolved ?? NO_PERMISSIONS, HARVEST_MONEY)
}

/** The signed-in person (an API key has no person: no request, no decision), or the refusal already sent. */
async function personOf(request: FastifyRequest, reply: FastifyReply): Promise<UserPrincipal | null> {
  try {
    return await requestPrincipal(request)
  } catch (error) {
    if (!(error instanceof ToolAccessError)) throw error
    await reply.code(error.statusCode).send({ error: error.message, code: error.code })
    return null
  }
}

/**
 * L6 (HCORE review) — who changes a rule, a source or a skip: the signed-in person only (the session; never a header a
 * caller could set). No person: 403, nothing changes.
 */
async function actorOf(request: FastifyRequest, reply: FastifyReply): Promise<AdsActor | null> {
  const person = await personOf(request, reply)
  return person ? (`user:${person.userId}` as AdsActor) : null
}

const advertisingHarvestRoutes: FastifyPluginAsync = async (fastify) => {
  /** One handler: no-store, the body or query parsed, the answer (or its refusal) without hidden money. */
  const handle = <S extends z.ZodTypeAny>(schema: S, from: 'query' | 'body', run: (input: z.output<S>, request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Cache-Control', 'no-store')
      const parsed = schema.safeParse((from === 'query' ? request.query : request.body) ?? {})
      if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
      const out = await run(parsed.data, request, reply)
      if (reply.sent) return reply
      if (out && typeof out === 'object' && 'error' in out && 'status' in out) return reply.code((out as { status: number }).status).send({ error: (out as { error: string }).error })
      return withoutHiddenMoney(request, out && typeof out === 'object' && 'data' in out ? (out as { data: unknown }).data : out)
    }

  const candidatesQuery = (q: z.output<typeof CANDIDATES_QUERY>) => ({
    ...q, owner: q.owner?.toUpperCase() ?? null,
    state: q.state ? q.state.split(',').map((s) => s.trim()).filter(Boolean) : null,
  })
  fastify.get('/advertising/harvest/candidates', handle(CANDIDATES_QUERY, 'query', (q) => harvestCandidates(candidatesQuery(q))))
  fastify.get('/advertising/harvest/destinations', handle(DESTINATIONS_QUERY, 'query', async (q) => {
    if (!q.candidateId && (!q.market || !q.productId)) return { error: 'market and productId (or candidateId): name the product', status: 400 }
    return harvestDestinations({ market: q.market ?? '', productId: q.productId ?? null, candidateId: q.candidateId ?? null, match: q.match ?? null })
  }))

  fastify.post('/advertising/harvest/preview', handle(PREVIEW_BODY, 'body', async (body, request, reply) => {
    const person = await personOf(request, reply)
    if (!person) return null
    const out = await previewChangeSet(body, { actor: 'PERSON', who: { actor: `user:${person.userId}`, manual: true, confirmOwnLimits: true, changeSetId: null, reason: 'harvest preview' } })
    return 'error' in out ? out : { data: out.data }
  }))
  fastify.post('/advertising/harvest/apply', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const parsed = APPLY_BODY.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const person = await personOf(request, reply)
    if (!person) return reply
    const { approve, code, ...args } = parsed.data
    const out = await requestHarvestTool({ op: 'harvest', ...args }, person, { approve, code })
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    return reply.code(202).send(withoutHiddenMoney(request, out.data))
  })
  fastify.post('/advertising/harvest/skip', handle(SKIP_BODY, 'body', async (body, request, reply) => {
    const actor = await actorOf(request, reply)
    return actor ? skipCandidates(body.ids, body.days, actor) : null
  }))
  fastify.post('/advertising/harvest/unskip', handle(UNSKIP_BODY, 'body', async (body, request, reply) => {
    const actor = await actorOf(request, reply)
    return actor ? unskipCandidates(body.ids) : null
  }))
  fastify.post('/advertising/harvest/waiting/decide', handle(DECIDE_BODY, 'body', async (body, request, reply) => {
    const person = await personOf(request, reply)
    if (!person) return null
    return decideHarvestRequests(body.decisions, person, body.reason)
  }))
  fastify.get('/advertising/harvest/history', handle(HISTORY_QUERY, 'query', async (q) => {
    const markets = await marketsOf(q.market)
    if ('error' in markets) return { error: markets.error, status: 400 }
    return harvestHistory({ market: markets, productId: q.productId ?? null, days: q.days, actor: q.actor ?? null, verdict: q.verdict ?? null })
  }))
  fastify.post('/advertising/harvest/undo', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const parsed = UNDO_BODY.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const person = await personOf(request, reply)
    if (!person) return reply
    // L3 — a harvest of another business (or none) reads as not found, nothing is asked.
    const unknown = await unknownHarvests(parsed.data.harvestIds)
    if (unknown.length) return reply.code(404).send({ error: `Harvest ${unknown[0]} was not found in this business: nothing was asked.` })
    const { approve, code, ...args } = parsed.data
    const out = await requestHarvestTool({ op: 'undo', ...args }, person, { approve, code })
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    return reply.code(202).send(withoutHiddenMoney(request, out.data))
  })

  fastify.get('/advertising/harvest/rules', handle(RULES_QUERY, 'query', (q) => listHarvestRules({ market: q.market ?? null })))
  fastify.get('/advertising/harvest/rules/:id/history', handle(RULE_HISTORY_QUERY, 'query', (q, request) => harvestRuleHistory((request.params as { id: string }).id, q)))
  fastify.post('/advertising/harvest/rules/preview', handle(RULE_PREVIEW_BODY, 'body', (body) => previewHarvestRule(body)))
  fastify.post('/advertising/harvest/rules/mode', handle(MODE_BODY, 'body', async (body, request, reply) => {
    const actor = await actorOf(request, reply)
    return actor ? setHarvestRulesMode(body.ids, body.mode, actor, { ...(body.belt !== undefined ? { belt: body.belt } : {}), ...(body.marked !== undefined ? { marked: body.marked } : {}) }) : null
  }))
  const archive = (archived: boolean) => handle(z.object({}).passthrough(), 'body', async (_b, request, reply) => {
    const actor = await actorOf(request, reply)
    return actor ? setHarvestRuleArchived((request.params as { id: string }).id, archived, actor) : null
  })
  fastify.post('/advertising/harvest/rules/:id/archive', archive(true))
  fastify.post('/advertising/harvest/rules/:id/unarchive', archive(false))

  fastify.get('/advertising/harvest/sources', handle(SOURCES_QUERY, 'query', (q) => harvestSources(q)))
  fastify.post('/advertising/harvest/sources/assign', handle(ASSIGN_BODY, 'body', async (body, request, reply) => {
    const actor = await actorOf(request, reply)
    if (!actor) return null
    const out = await assignSources(body.ruleId, body.adGroupIds, actor)
    return out.ok ? out : { error: out.error ?? 'refused', status: /^No harvest rule/.test(out.error ?? '') ? 404 : 400 }
  }))
  fastify.post('/advertising/harvest/sources/detach', handle(DETACH_BODY, 'body', async (body, request, reply) => {
    const actor = await actorOf(request, reply)
    return actor ? detachSources(body.ruleId ?? null, body.adGroupIds, actor) : null
  }))
  fastify.post('/advertising/harvest/sources/pause', handle(PAUSE_BODY, 'body', async (body, request, reply) => {
    const actor = await actorOf(request, reply)
    return actor ? pauseSources(body.adGroupIds, actor, body.reason ?? null) : null
  }))
  fastify.post('/advertising/harvest/sources/resume', handle(RESUME_BODY, 'body', async (body, request, reply) => {
    const actor = await actorOf(request, reply)
    return actor ? resumeSources(body.adGroupIds) : null
  }))
}


export default advertisingHarvestRoutes
