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
 *
 * ADS PLAYBOOK PB-3 — the writes, through the one writer Claude's set-ads-playbook uses (ads-playbook/write.ts):
 *
 *   POST /api/advertising/automation/playbook/preview   the change planned, nothing saved: every change from → to,
 *                                                         raise or lower by what it would make an enrolled product
 *                                                         spend, the recipes an enrollment makes; `mayRaise` says
 *                                                         whether this person may
 *   PUT  /api/advertising/automation/playbook           save it. `expectVersion` (the version read; 0 for a new one) is
 *                                                         required: 409 `version_moved` when it moved since. A raise
 *                                                         needs settings.security.manage and `code`, the person's fresh
 *                                                         authenticator code: 403 `mfa_required` (naming the raises),
 *                                                         400 `mfa_invalid`, 429 `mfa_locked`. Anything else saves at
 *                                                         once. The answer carries `undo`, the change that puts the
 *                                                         previous version back.
 *
 * Both take ads.automation.manage (the manifest's advertising /automation rule) and the ad-spend money a playbook holds
 * (financials.adspend.view, checked here): a person who may not see the money does not set it.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { financialPayloadCopy } from '../lib/auth/field-filter.js'
import { hasPermission, type ResolvedPermissions } from '../lib/auth/rbac.js'
import { PLAYBOOK_MONEY } from '../services/advertising/ads-playbook/doc.js'
import { readPlaybook, type PlaybookViewName } from '../services/advertising/ads-playbook/read.js'
import { applyPlaybookPlan, planPlaybookChange, PLAYBOOK_RAISE, undoArgsOf } from '../services/advertising/ads-playbook/write.js'
import { requestPrincipal, ToolAccessError, type UserPrincipal } from '../services/agents/call-tool.js'
import { mayRaise } from '../services/agents/claude-trust.service.js'

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

const NO_MONEY = 'Setting the ads playbook needs permission to see ad spend (financials.adspend.view): its budgets, bids and recipes are ad-spend money.'

/** The signed-in person who sets the playbook, or the refusal already sent (an API key has no person; no money, no write). */
async function writerOf(request: FastifyRequest, reply: FastifyReply): Promise<UserPrincipal | null> {
  let person: UserPrincipal
  try {
    person = await requestPrincipal(request)
  } catch (error) {
    if (!(error instanceof ToolAccessError)) throw error
    await reply.code(403).send({ error: 'A signed-in person sets the ads playbook.' })
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

  // PB-3 — the change planned, nothing saved: what the Playbook section shows before Save (and whether Save asks for the code).
  fastify.post('/advertising/automation/playbook/preview', async (request, reply) => {
    const person = await writerOf(request, reply)
    if (!person) return reply
    const { code: _code, ...body } = bodyOf(request)
    const planned = await planPlaybookChange(body)
    if ('error' in planned) return reply.code(planned.status).send({ error: planned.error, ...(planned.code ? { code: planned.code } : {}) })
    return { ...planned.plan.preview, mayRaise: hasPermission(person.permissions, F.settingsSecurityManage) }
  })

  // PB-3 — save it: at once, or a raise with the person's fresh authenticator code (the W1 rule).
  fastify.put('/advertising/automation/playbook', async (request, reply) => {
    const person = await writerOf(request, reply)
    if (!person) return reply
    const { code, ...body } = bodyOf(request)
    if (typeof body.expectVersion !== 'number') {
      return reply.code(400).send({ error: 'expectVersion: the version you read (0 when it does not exist yet), so a change saved meanwhile is never overwritten.' })
    }
    const planned = await planPlaybookChange(body)
    if ('error' in planned) return reply.code(planned.status).send({ error: planned.error, ...(planned.code ? { code: planned.code } : {}) })
    const { plan } = planned
    let stepUpAt: Date | null = null
    if (plan.direction === 'raise') {
      const refused = await mayRaise(
        { userId: person.userId, label: person.label, canManage: hasPermission(person.permissions, F.settingsSecurityManage) },
        code,
        PLAYBOOK_RAISE,
      )
      if (refused) {
        const { status, ...rest } = refused
        return reply.code(status).send({ ...rest, raises: plan.raises })
      }
      stepUpAt = new Date()
    }
    const out = await applyPlaybookPlan(plan, {
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
      id: out.id,
      version: out.version,
      direction: out.direction,
      changes: out.changes,
      summary: plan.preview.summary,
      liveEffect: plan.preview.liveEffect,
      ...(plan.preview.recipes ? { recipes: plan.preview.recipes } : {}),
      // The change that puts the previous version back (the Playbook section's Undo), as set-ads-playbook's own undo
      // writes it: previewed and saved through these same routes, so putting back a raise asks for the code.
      undo: undoArgsOf(out.before, out.after),
    }
  })
}

export default advertisingPlaybookRoutes
