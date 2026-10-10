/**
 * Ads brain page A1 — the brain's read views over HTTP: the same answers Claude's `ads-brain` and `bid-brain` tools
 * give, through the same code (services/advertising/brain/read-view.ts: the input, the money keys and the dispatch).
 *
 *   GET /api/advertising/automation/brain/views/:view       an ads-brain view — map, clashes, setup, money, terms, state,
 *                                                            hours, negatives, harvest, report, structure, bidding, retire,
 *                                                            proof — with the tool's arguments as query (market, productId,
 *                                                            campaignId, days, state, status, limit, day, weeks, since)
 *   GET /api/advertising/automation/brain/bid-brain/:view   a bid-brain view — why, what-if, diff, calibration,
 *                                                            hour-factors, probes — with the tool's arguments as query
 *                                                            (market, campaignId, targetId, productId, targetAcosPct,
 *                                                            bandLoPct, bandHiPct, days, limit)
 *
 *   GET /api/advertising/automation/brain/switchboard        A3 — what is on, in one answer: the server switches (by name),
 *                                                            the account dial and halt, the engine board, the brain's kills
 *                                                            and each enrolled product's levers — level, source, lock, and
 *                                                            whether the brain acts, asks, watches or does nothing now (query
 *                                                            market, productId; brain/switchboard.ts)
 *
 *   GET /api/advertising/automation/brain/requests           A5 — the requests that wait on the brain (query market,
 *                                                            productId): asked by the brain, or of it, with when they expire
 *                                                            or run and whether approving takes a code
 *                                                            (brain/requests-read.ts); previews filtered for the reader
 *
 * The reads are read only: nothing is asked, saved or sent.
 *
 * A5 — the writes never change anything directly. Each asks the approval gate for the same tool Claude uses
 * (requestApproval: a request through the page's door, `via: 'app'`, dry-run as this person — their permissions and ai.run)
 * and answers 202 with the request:
 *
 *   POST …/brain/control                     set-ads-brain (enroll, set-level, lock, unlock, exclude, include, set-value, leave)
 *   POST …/brain/kill                        set-brain-kill-switch: op kill runs AT ONCE on the person's click, like the halt
 *                                            (still a request, recorded and undoable: decideApproval runs it now, 200);
 *                                            op end is a request that needs the approver's code
 *   POST …/brain/bid-brain/enrollment        set-bid-brain-enrollment
 *   POST …/brain/hours/apply                 apply-brain-hourly-plan
 *   POST …/brain/harvest/apply               apply-brain-harvest
 *   POST …/brain/retire                      retire-ads-writers
 *   POST …/brain/requests/:approvalId/decide approve or reject a request the requests list holds (else 404), through the
 *                                            Approvals page's own path (decideFleetApproval: the 20-second undo window; a
 *                                            request that raises takes settings.security.manage and the code)
 *
 * Body: the tool's own arguments (anything else is dropped), and optionally `approve: true` with `code` — the same person
 * asks and approves in one click (decideFleetApproval). `approve` and `code` are never stored with the request. The answer:
 * { approvalId, status, expiresAt, executeAfter?, tool, preview (filtered), needsCode, stepUp?, approve? }; a failed approve
 * leaves the request waiting. 400 the tool's refusal or wrong arguments · 403 no signed-in person or a missing permission ·
 * 409 already decided. Idempotency-Key honoured (COMMAND_SCOPES). The writes need ads.automation.manage (the manifest). ads.view, named in the permission manifest. The workspace is the request's
 * (the global workspace hook): another business's ids read as not found. The views' money keys are stripped for a person
 * without financials.adspend.view, under the same switch as the response filter (field-filter.ts), as the playbook
 * routes strip theirs. Answers are never cached (Cache-Control: no-store): a brain view is decided at the time it is read.
 *
 * Errors: an unknown view 404 naming the views; arguments the view does not take 400; a refusal in words 404 when it
 * names something not in this business (a product, a campaign, a keyword), else 400. No Prisma here
 * (scripts/check-route-prisma-ratchet.mjs).
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { financialPayloadCopy } from '../lib/auth/field-filter.js'
import type { ResolvedPermissions } from '../lib/auth/rbac.js'
import {
  BID_BRAIN_MONEY, BID_BRAIN_VIEW_INPUT, BID_BRAIN_VIEWS, BRAIN_MAP_VIEWS, BRAIN_VIEW_INPUT, BRAIN_VIEW_MONEY,
  readBidBrainView, readBrainView, readRefusalStatus, type ViewAnswer,
} from '../services/advertising/brain/read-view.js'
import { brainSwitchboard } from '../services/advertising/brain/switchboard.js'
import { brainRequests, isBrainRequest } from '../services/advertising/brain/requests-read.js'
import { missingPermissions, permissionMessage, requestPrincipal, storedOutputOf, ToolAccessError, type UserPrincipal } from '../services/agents/call-tool.js'
import { decideApproval, requestApproval } from '../services/agents/approval-gate.service.js'
import { getTool } from '../services/agents/tool-registry.js'
import { decideFleetApproval } from '../services/agent-fleet/approval-inbox.service.js'

/** The scope of the requests list: one market and/or one product, both optional. */
const REQUESTS_QUERY = z.object({
  market: z.string().trim().toUpperCase().min(2).max(20).optional(),
  productId: z.string().trim().min(1).max(64).optional(),
})

/** A decision on a request: approve (with the code when it raises) or reject (the person's words optional). */
const DECIDE_BODY = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().max(500).optional(),
  code: z.string().trim().max(16).optional(),
})

const bodyOf = (request: FastifyRequest): Record<string, unknown> => {
  const value = request.body as Record<string, unknown> | undefined
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** The signed-in person behind the request, or the refusal already sent (an API key has no person: no request, no decision). */
async function personOf(request: FastifyRequest, reply: FastifyReply): Promise<UserPrincipal | null> {
  try {
    return await requestPrincipal(request)
  } catch (error) {
    if (!(error instanceof ToolAccessError)) throw error
    await reply.code(error.statusCode).send({ error: error.message, code: error.code })
    return null
  }
}

/** A refused decision's HTTP status: its own (a code problem), 403 forbidden, else 409 (gone, decided, taken). */
const decideStatus = (out: { code?: string; httpStatus?: number }) => out.httpStatus ?? (out.code === 'forbidden' ? 403 : out.code ? 400 : 409)

/** The switchboard's scope: one market and/or one product, both optional. */
const SWITCHBOARD_QUERY = z.object({
  market: z.string().trim().toUpperCase().min(2).max(20).optional(),
  productId: z.string().trim().min(1).max(64).optional(),
})

const NO_PERMISSIONS: ResolvedPermissions = { isOwner: false, permissions: new Set() }

/** A view's money keys, stripped under the same switch as the response filter (field-filter.ts). */
function withoutHiddenMoney(request: FastifyRequest, payload: unknown, money: Readonly<Record<string, string>>): unknown {
  if (process.env.NEXUS_RBAC_MODE !== 'enforce' && process.env.NEXUS_WORKSPACES_ENABLED !== '1') return payload
  return financialPayloadCopy(payload, request.__rbacResolved ?? NO_PERMISSIONS, money)
}

/** The first problem of a query the view does not take, in words. */
const problemOf = (error: z.ZodError) => {
  const issue = error.issues[0]
  return issue ? `${issue.path.join('.') || 'query'}: ${issue.message}` : 'the query is not one this view takes'
}

const advertisingBrainRoutes: FastifyPluginAsync = async (fastify) => {
  /** One read: the view checked, the query parsed with the tool's own input, the answer without hidden money. */
  const read = <S extends z.ZodTypeAny>(views: readonly string[], input: S, money: Readonly<Record<string, string>>, answer: (args: z.output<S>) => Promise<ViewAnswer>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Cache-Control', 'no-store')
      const { view } = request.params as { view: string }
      if (!views.includes(view)) return reply.code(404).send({ error: `There is no view ${view}: the views are ${views.join(', ')}.`, views })
      const query = (request.query ?? {}) as Record<string, unknown>
      const parsed = input.safeParse({ ...query, view })
      if (!parsed.success) return reply.code(400).send({ error: problemOf(parsed.error) })
      const out = await answer(parsed.data)
      if ('error' in out) return reply.code(readRefusalStatus(out.error)).send({ error: out.error })
      return withoutHiddenMoney(request, out.data, money)
    }

  fastify.get('/advertising/automation/brain/views/:view', read(BRAIN_MAP_VIEWS, BRAIN_VIEW_INPUT, BRAIN_VIEW_MONEY, readBrainView))
  fastify.get('/advertising/automation/brain/bid-brain/:view', read(BID_BRAIN_VIEWS, BID_BRAIN_VIEW_INPUT, BID_BRAIN_MONEY, readBidBrainView))

  // A5 row 17 — the requests that wait on the brain; each preview as this person may see it (nothing of a tool they may not use).
  fastify.get('/advertising/automation/brain/requests', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const parsed = REQUESTS_QUERY.safeParse(request.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: problemOf(parsed.error) })
    const out = await brainRequests(parsed.data)
    if ('error' in out) return reply.code(readRefusalStatus(out.error)).send({ error: out.error })
    let see: ((tool: string, value: unknown) => unknown | null) | null = null
    try { see = storedOutputOf(await requestPrincipal(request)) } catch (error) { if (!(error instanceof ToolAccessError)) throw error }
    return withoutHiddenMoney(request, { ...out.data, requests: out.data.requests.map((r) => ({ ...r, preview: see ? see(r.tool, r.preview) : null })) }, BRAIN_VIEW_MONEY)
  })

  /**
   * A5 rows 19–24 — ask the gate for a brain tool as this person; `atOnce` (op kill) approves and runs it now as the same
   * person. Otherwise `approve: true` approves it in the same click through the Approvals page's path (the undo window,
   * the code when it raises). The request waits when the approve is refused.
   */
  const ask = (tool: string, atOnce: (body: Record<string, unknown>) => boolean = () => false) => async (request: FastifyRequest, reply: FastifyReply) => {
    const person = await personOf(request, reply)
    if (!person) return
    const def = getTool(tool)
    if (!def) return reply.code(404).send({ error: `unknown tool: ${tool}` })
    const missing = missingPermissions(person, def)
    if (missing.length) return reply.code(403).send({ error: permissionMessage(tool, missing), code: 'forbidden' })
    const body = bodyOf(request)
    // Only the tool's own arguments are asked for and stored: `approve` and `code` never are.
    const shape = (def.input as unknown as { shape?: Record<string, unknown> }).shape ?? {}
    const args = Object.fromEntries(Object.entries(body).filter(([key]) => key in shape && key !== 'approve' && key !== 'code'))
    const asked = await requestApproval(tool, args, person)
    if (!asked.ok || asked.mode !== 'queued' || !asked.approvalId) return reply.code(400).send({ error: asked.error ?? `Not queued: ${tool} answered without a request.` })
    const stepUp = (asked.preview as { stepUp?: unknown } | undefined)?.stepUp ?? null
    const base = { approvalId: asked.approvalId, tool, expiresAt: asked.expiresAt?.toISOString() ?? null, preview: asked.preview, needsCode: !!stepUp, ...(stepUp ? { stepUp } : {}) }
    if (atOnce(args)) {
      const ran = await decideApproval(asked.approvalId, 'approve', person)
      if (ran.ok) return reply.code(200).send(withoutHiddenMoney(request, { ...base, status: 'executed', result: ran.result, undo: 'Recorded: undo-change (or the activity page\'s Undo) asks for the opposite.' }, BRAIN_VIEW_MONEY))
      return reply.code(202).send(withoutHiddenMoney(request, { ...base, status: 'pending', approve: { ok: false, error: ran.error ?? 'it did not run' } }, BRAIN_VIEW_MONEY))
    }
    if (body.approve === true) {
      const out = await decideFleetApproval({ id: asked.approvalId, decision: 'approve', actor: person, code: body.code, reason: typeof args.why === 'string' ? args.why : undefined })
      const approve = { ok: out.ok, ...(out.code ? { code: out.code } : {}), ...(out.error ? { error: out.error } : {}) }
      return reply.code(202).send(withoutHiddenMoney(request, { ...base, status: out.ok ? 'scheduled' : 'pending', ...(out.executeAfter ? { executeAfter: out.executeAfter } : {}), approve }, BRAIN_VIEW_MONEY))
    }
    return reply.code(202).send(withoutHiddenMoney(request, { ...base, status: 'pending' }, BRAIN_VIEW_MONEY))
  }
  fastify.post('/advertising/automation/brain/control', ask('set-ads-brain'))
  // Lead decision — a kill runs at once on a person's click, like the halt; ending one goes through approval and the code.
  fastify.post('/advertising/automation/brain/kill', ask('set-brain-kill-switch', (args) => args.op === 'kill'))
  fastify.post('/advertising/automation/brain/bid-brain/enrollment', ask('set-bid-brain-enrollment'))
  fastify.post('/advertising/automation/brain/hours/apply', ask('apply-brain-hourly-plan'))
  fastify.post('/advertising/automation/brain/harvest/apply', ask('apply-brain-harvest'))
  fastify.post('/advertising/automation/brain/retire', ask('retire-ads-writers'))

  // A5 row 25 — decide a request the brain's list holds (structure builds and every other brain request), else 404.
  fastify.post('/advertising/automation/brain/requests/:approvalId/decide', async (request, reply) => {
    const person = await personOf(request, reply)
    if (!person) return
    const parsed = DECIDE_BODY.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: problemOf(parsed.error) })
    const { approvalId } = request.params as { approvalId: string }
    if (!(await isBrainRequest(approvalId))) return reply.code(404).send({ error: 'No request of the ads brain waits with this id (GET …/brain/requests lists them).' })
    const out = await decideFleetApproval({ id: approvalId, decision: parsed.data.decision, actor: person, code: parsed.data.code, reason: parsed.data.reason })
    if (!out.ok) return reply.code(decideStatus(out)).send(out)
    return withoutHiddenMoney(request, { approvalId, ...out }, BRAIN_VIEW_MONEY)
  })

  // A3 — the switchboard. A lock's value is ad-spend money (BRAIN_VIEW_MONEY), hidden as on every brain view.
  fastify.get('/advertising/automation/brain/switchboard', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const parsed = SWITCHBOARD_QUERY.safeParse(request.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: problemOf(parsed.error) })
    const out = await brainSwitchboard(parsed.data)
    if ('error' in out) return reply.code(readRefusalStatus(out.error)).send({ error: out.error })
    return withoutHiddenMoney(request, out.data, BRAIN_VIEW_MONEY)
  })
}

export default advertisingBrainRoutes
