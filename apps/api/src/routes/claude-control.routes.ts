/**
 * MCP full control C5 — how far Claude may go in a business without a person, set by that business's people
 * (services/agents/claude-trust.service.ts). The web's Claude page (C9) reads and writes these.
 *
 *   GET  /api/claude/trust          every tool Claude is offered: its level, ceiling and limits; the business's brakes
 *   PUT  /api/claude/trust/:tool    { level?, limits?, code? } — raising a level or changing limits needs a fresh 2FA code
 *   GET  /api/claude/trust/:tool/simulate?days=30&level=auto&limits=<url-encoded JSON>
 *                                   Approvals grid — what that rule would have done with Claude's requests of the tool in
 *                                   the last days (max 90): RuleSimulation (services/agents/claude-rule-simulate.service.ts).
 *                                   Read-only; ai.view, like GET /claude/trust
 *   PUT  /api/claude/autonomy       { dailyAutoCap, code? } — raising the cap needs the code
 *   POST /api/claude/pause          { reason? } — at once; what waits to run by rule goes back to a person
 *   POST /api/claude/resume         { code }
 *   GET  /api/claude/activity       C8 — what Claude did here: ?from&to&tool&outcome&connectionId&cursor&limit
 *                                   (services/agents/claude-activity.service.ts), previews through the reader's money filter
 *   POST /api/claude/changes/:id/undo  C8 — Undo on the activity page: the click approves the inverse change, which then
 *                                   waits out the same undo window (services/agents/change-undo.service.ts); ai.run
 *
 * Reading needs ai.view. A brake is easy: Pause and lowering need only ai.run (anyone who may use Claude here). Resume
 * needs settings.security.manage; raising a level, changing limits or raising the cap are refused by the service
 * without settings.security.manage and a fresh 2FA code (permissions-manifest.ts; the business the workspace hook
 * verified). Claude has no tool for any of it: raising its own levels and limits is never for Claude.
 * Zero Prisma calls here: the service holds the rules.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { FEATURES as F } from '@nexus/shared/permissions'
import { hasPermission } from '../lib/auth/rbac.js'
import { actorLabel, requestPrincipal, storedOutputOf, ToolAccessError } from '../services/agents/call-tool.js'
import { simulateClaudeRule } from '../services/agents/claude-rule-simulate.service.js'
import { ActivityQueryError, claudeActivity } from '../services/agents/claude-activity.service.js'
import { undoChangeByClick } from '../services/agents/change-undo.service.js'
import {
  listClaudeRules,
  pauseAutoRuns,
  resumeAutoRuns,
  setClaudeRule,
  setDailyAutoCap,
  type TrustActor,
  type TrustRefusal,
} from '../services/agents/claude-trust.service.js'

type Body = Record<string, unknown> | undefined

/**
 * The signed-in person who changes a setting, and whether they may RAISE (settings.security.manage in this business):
 * the RBAC gate let them through with ai.run, which is all a brake needs.
 */
async function actorOf(request: FastifyRequest): Promise<TrustActor> {
  const principal = await requestPrincipal(request)
  const user = request.authUser
  return {
    userId: principal.userId,
    label: actorLabel({ id: user?.id, email: user?.email, displayName: user?.displayName ?? undefined }),
    canManage: hasPermission(principal.permissions, F.settingsSecurityManage),
  }
}

/** A refusal keeps the service's status and words. */
function answer<T extends { ok: true }>(reply: FastifyReply, out: T | TrustRefusal) {
  if (out.ok !== false) return out
  // The API's tsconfig is not strict: `ok` does not narrow the union by itself.
  const { status, ...body } = out as TrustRefusal
  return reply.code(status).send(body)
}

const body = (request: FastifyRequest): Record<string, unknown> => {
  const value = request.body as Body
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

const claudeControlRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
  })

  fastify.get('/claude/trust', async () => listClaudeRules())

  // Approvals grid — "would have run N of the last M; you rejected K". The reader's money filter for the examples; a
  // caller who is not a person (an API key) gets the counts and no example text.
  fastify.get<{ Params: { tool: string }; Querystring: { days?: string; level?: string; limits?: string } }>(
    '/claude/trust/:tool/simulate',
    async (request, reply) => {
      const { days, level, limits } = request.query ?? {}
      let storedOutput: (toolName: string, value: unknown) => unknown | null = () => null
      try {
        storedOutput = storedOutputOf(await requestPrincipal(request))
      } catch (error) {
        if (!(error instanceof ToolAccessError)) throw error
      }
      const out = await simulateClaudeRule(request.params.tool, { days, level, limits }, storedOutput)
      if (out.ok) return out.simulation
      const { status, error } = out as Extract<typeof out, { ok: false }>
      return reply.code(status).send({ error })
    },
  )

  fastify.put<{ Params: { tool: string } }>('/claude/trust/:tool', async (request, reply) => {
    const { level, limits, code } = body(request)
    return answer(reply, await setClaudeRule(await actorOf(request), request.params.tool, { level, limits, code }))
  })

  fastify.put('/claude/autonomy', async (request, reply) => {
    const { dailyAutoCap, code } = body(request)
    return answer(reply, await setDailyAutoCap(await actorOf(request), { dailyAutoCap, code }))
  })

  fastify.post('/claude/pause', async (request) => {
    const { reason } = body(request)
    return pauseAutoRuns(await actorOf(request), typeof reason === 'string' ? reason : undefined)
  })

  fastify.post('/claude/resume', async (request, reply) => {
    return answer(reply, await resumeAutoRuns(await actorOf(request), body(request).code))
  })

  // C8 — the person's click is the approval: the inverse change, as them, parked for the same undo window. W1-3 — an
  // inverse that raises (the undo of an ads strategy lowering) takes the person's authenticator code (`code`).
  fastify.post<{ Params: { id: string } }>('/claude/changes/:id/undo', async (request, reply) => {
    const out = await undoChangeByClick(await requestPrincipal(request), request.params.id, body(request).code)
    if (out.ok !== false) return out
    const { status, ...refusal } = out as Extract<typeof out, { ok: false }>
    return reply.code(status).send(refusal)
  })

  // C8 — the reader's own money filter: a preview of a tool they may not use is hidden, money they may not see stripped.
  fastify.get('/claude/activity', async (request, reply) => {
    try {
      return await claudeActivity((request.query ?? {}) as never, storedOutputOf(await requestPrincipal(request)))
    } catch (error) {
      if (error instanceof ActivityQueryError) return reply.code(400).send({ error: error.message })
      throw error
    }
  })
}

export default claudeControlRoutes
