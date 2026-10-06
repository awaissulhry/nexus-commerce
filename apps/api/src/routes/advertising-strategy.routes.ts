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
 * Prisma here (scripts/check-route-prisma-ratchet.mjs).
 *
 * ADS AUTONOMY W1-3 — the writes, through the one writer Claude's set-ads-strategy uses (ads-strategy/write.ts):
 *
 *   POST /api/advertising/automation/strategy/preview   the change planned, nothing saved: every field from → to with the
 *                                                         value in force, raise or lower, the campaigns whose own target
 *                                                         wins, the live effect; `mayRaise` says whether this person may
 *   PUT  /api/advertising/automation/strategy           save it. `expectVersion` (the version read; 0 for a new row) is
 *                                                         required: 409 `version_moved` when the row moved since. A raise
 *                                                         needs settings.security.manage and `code`, the person's fresh
 *                                                         authenticator code: 403 `mfa_required` (naming the raises),
 *                                                         400 `mfa_invalid`, 429 `mfa_locked`. A lowering saves at once.
 *
 * Both take ads.automation.manage (the manifest's advertising /automation rule) and the ad-spend money the strategy holds
 * (financials.adspend.view, checked here): a person who may not see the money does not set it.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { financialPayloadCopy } from '../lib/auth/field-filter.js'
import { hasPermission, type ResolvedPermissions } from '../lib/auth/rbac.js'
import { STRATEGY_MONEY } from '../services/advertising/ads-strategy/fields.js'
import { readStrategy, type StrategyViewName } from '../services/advertising/ads-strategy/read.js'
import { applyStrategyPlan, planStrategyChange, STRATEGY_RAISE } from '../services/advertising/ads-strategy/write.js'
import { requestPrincipal, ToolAccessError, type UserPrincipal } from '../services/agents/call-tool.js'
import { mayRaise } from '../services/agents/claude-trust.service.js'

const NO_PERMISSIONS: ResolvedPermissions = { isOwner: false, permissions: new Set() }
/** A query value given once, as text; anything else (absent, empty, repeated) is not given. */
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

/** The strategy's own money keys, stripped under the same switch as the response filter (field-filter.ts). */
function withoutHiddenMoney(request: FastifyRequest, payload: Record<string, unknown>): Record<string, unknown> {
  if (process.env.NEXUS_RBAC_MODE !== 'enforce' && process.env.NEXUS_WORKSPACES_ENABLED !== '1') return payload
  return financialPayloadCopy(payload, request.__rbacResolved ?? NO_PERMISSIONS, STRATEGY_MONEY)
}

const NO_MONEY = 'Setting the ads strategy needs permission to see ad spend (financials.adspend.view): its targets, bids and caps are ad-spend money.'

/** The signed-in person who sets the strategy, or the refusal already sent (an API key has no person; no money, no write). */
async function writerOf(request: FastifyRequest, reply: FastifyReply): Promise<UserPrincipal | null> {
  let person: UserPrincipal
  try {
    person = await requestPrincipal(request)
  } catch (error) {
    if (!(error instanceof ToolAccessError)) throw error
    await reply.code(403).send({ error: 'A signed-in person sets the ads strategy.' })
    return null
  }
  if (!hasPermission(person.permissions, FIELDS.financialsAdspendView)) {
    await reply.code(403).send({ error: NO_MONEY, code: 'forbidden' })
    return null
  }
  return person
}

const bodyOf = (request: FastifyRequest): Record<string, unknown> => {
  const value = request.body as Record<string, unknown> | undefined
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
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

  // W1-3 — the change planned, nothing saved: what the Strategy tab shows before Save (and whether Save asks for the code).
  fastify.post('/advertising/automation/strategy/preview', async (request, reply) => {
    const person = await writerOf(request, reply)
    if (!person) return reply
    const { code: _code, ...body } = bodyOf(request)
    const planned = await planStrategyChange(body)
    if ('error' in planned) return reply.code(planned.status).send({ error: planned.error, ...(planned.code ? { code: planned.code } : {}) })
    return { ...planned.plan.preview, mayRaise: hasPermission(person.permissions, F.settingsSecurityManage) }
  })

  // W1-3 — save it: a lowering at once; a raise with the person's fresh authenticator code (Owner decision 2026-10-06).
  fastify.put('/advertising/automation/strategy', async (request, reply) => {
    const person = await writerOf(request, reply)
    if (!person) return reply
    const { code, ...body } = bodyOf(request)
    if (typeof body.expectVersion !== 'number') {
      return reply.code(400).send({ error: 'expectVersion: the version you read (0 when the row does not exist yet), so a change saved meanwhile is never overwritten.' })
    }
    const planned = await planStrategyChange(body)
    if ('error' in planned) return reply.code(planned.status).send({ error: planned.error, ...(planned.code ? { code: planned.code } : {}) })
    const { plan } = planned
    let stepUpAt: Date | null = null
    if (plan.direction === 'raise') {
      const refused = await mayRaise(
        { userId: person.userId, label: person.label, canManage: hasPermission(person.permissions, F.settingsSecurityManage) },
        code,
        STRATEGY_RAISE,
      )
      if (refused) {
        const { status, ...rest } = refused
        return reply.code(status).send({ ...rest, raises: plan.raises })
      }
      stepUpAt = new Date()
    }
    const out = await applyStrategyPlan(plan, {
      via: 'screen',
      actor: person.label,
      actorUserId: person.userId,
      approvalId: null,
      stepUpAt,
      updatedBy: `user:${person.userId}`,
    })
    if ('error' in out) return reply.code(out.status).send({ error: out.error, code: out.code })
    return {
      ok: true,
      strategyId: out.strategyId,
      version: out.version,
      direction: out.direction,
      changes: out.changes,
      summary: plan.preview.summary,
      liveEffect: plan.preview.liveEffect,
    }
  })
}

export default advertisingStrategyRoutes
