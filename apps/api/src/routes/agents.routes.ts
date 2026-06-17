/**
 * ACP.0 — Agent Control Plane routes (thin slice).
 *
 *   POST /api/agent/run    — run the products copilot (read-only) end-to-end
 *   GET  /api/agent/runs   — recent AgentRun audit rows (observability seed)
 *   GET  /api/agent/tools  — the code tool registry
 *
 * Unadvertised at this stage; Phase 2 surfaces it as the /products copilot.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import {
  runAgent,
  invokeTool,
  runChat,
} from '../services/agents/agent-runtime.service.js'
import {
  listToolPolicies,
  setToolPolicy,
  seedToolPolicies,
} from '../services/agents/tool-policy.service.js'
import {
  listApprovals,
  decideApproval,
  requestApproval,
} from '../services/agents/approval-gate.service.js'
import {
  runAutonomousAgent,
  getAgentOverview,
  setAgentEnabled,
} from '../services/agents/autonomous-agent.service.js'

const agentRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: {
      agentKey?: string
      input?: string
      entityType?: string
      entityId?: string
    }
  }>('/agent/run', async (request, reply) => {
    const input = (request.body?.input ?? '').trim()
    if (!input) return reply.code(400).send({ error: 'input is required' })
    const out = await runAgent({
      agentKey: request.body?.agentKey ?? 'products-copilot',
      input,
      entityType: request.body?.entityType ?? null,
      entityId: request.body?.entityId ?? null,
    })
    if (!out.ok) {
      return reply
        .code(out.error?.includes('kill switch') ? 503 : 500)
        .send(out)
    }
    return out
  })

  // ACP.2a — read-only products copilot (model-driven tool-use loop).
  fastify.post<{
    Body: {
      agentKey?: string
      messages?: { role: 'user' | 'assistant'; content: string }[]
      pageContext?: {
        route?: string
        productId?: string
        entityType?: string
        entityId?: string
      }
    }
  }>('/agent/chat', async (request, reply) => {
    const messages = request.body?.messages
    if (!Array.isArray(messages) || messages.length === 0)
      return reply.code(400).send({ error: 'messages[] is required' })
    const out = await runChat({
      agentKey: request.body?.agentKey,
      messages,
      pageContext: request.body?.pageContext,
    })
    if (!out.ok)
      return reply
        .code(out.error?.includes('kill switch') ? 503 : 500)
        .send(out)
    return out
  })

  // Recent AgentRun audit rows — slim projection for the Control Center
  // activity feed (full input/output/steps omitted). Optional agentKey filter.
  fastify.get<{ Querystring: { limit?: string; agentKey?: string } }>(
    '/agent/runs',
    async (request) => {
      const limit = Math.min(
        Math.max(parseInt(request.query?.limit ?? '20', 10) || 20, 1),
        100,
      )
      const agentKey = request.query?.agentKey
      const rows = await prisma.agentRun.findMany({
        where: agentKey ? { agentKey } : {},
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          agentKey: true,
          trigger: true,
          status: true,
          ok: true,
          costUSD: true,
          model: true,
          provider: true,
          latencyMs: true,
          errorMessage: true,
          createdAt: true,
        },
      })
      return { rows }
    },
  )

  // Effective tool policy (code defaults merged with operator overrides).
  fastify.get('/agent/tools', async () => ({ tools: await listToolPolicies() }))

  // Operator policy edit (respects the always-ask hard floor).
  fastify.put<{
    Params: { name: string }
    Body: {
      riskTier?: string
      enabled?: boolean
      requiresApproval?: boolean
      rateLimitPerHour?: number | null
      dailyBudgetUSD?: number | null
    }
  }>('/agent/tools/:name', async (request, reply) => {
    const r = await setToolPolicy(request.params.name, request.body ?? {})
    if (!r.ok) return reply.code(400).send(r)
    return { ok: true, tools: await listToolPolicies() }
  })

  // Invoke a single tool directly (testing + the Phase 2 copilot loop).
  fastify.post<{ Params: { name: string }; Body: Record<string, unknown> }>(
    '/agent/tools/:name/invoke',
    async (request) => invokeTool(request.params.name, request.body ?? {}, {}),
  )

  // Seed the editable AgentTool policy rows from the code registry.
  fastify.post('/agent/tools/seed', async () => seedToolPolicies())

  // ── ACP.3a — governed-action approval gate ──────────────────────────
  fastify.get<{ Querystring: { status?: string } }>(
    '/agent/approvals',
    async (request) => ({
      approvals: await listApprovals(request.query?.status),
    }),
  )

  // Request approval for a mutating action (copilot button / testing).
  fastify.post<{
    Body: { toolName?: string; args?: Record<string, unknown> }
  }>('/agent/actions/request', async (request, reply) => {
    const toolName = request.body?.toolName
    if (!toolName) return reply.code(400).send({ error: 'toolName is required' })
    return requestApproval(toolName, request.body?.args ?? {}, {})
  })

  fastify.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/agent/approvals/:id/approve',
    async (request, reply) => {
      const r = await decideApproval(
        request.params.id,
        'approve',
        null,
        request.body?.reason,
      )
      if (!r.ok && r.error === 'approval not found')
        return reply.code(404).send(r)
      return r
    },
  )

  fastify.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/agent/approvals/:id/reject',
    async (request, reply) => {
      const r = await decideApproval(
        request.params.id,
        'reject',
        null,
        request.body?.reason,
      )
      if (!r.ok && r.error === 'approval not found')
        return reply.code(404).send(r)
      return r
    },
  )

  // ── ACP.4a/5a — autonomous agents + Control Center ──────────────────
  // Each autonomous agent with its enable state, last run, and how many
  // proposals it currently has waiting in the approval inbox.
  fastify.get('/agent/agents', async () => ({
    agents: await getAgentOverview(),
  }))

  // Toggle an agent's SCHEDULED runs (manual "Run now" always works).
  fastify.put<{ Params: { key: string }; Body: { enabled?: boolean } }>(
    '/agent/agents/:key',
    async (request, reply) => {
      const r = await setAgentEnabled(
        request.params.key,
        request.body?.enabled === true,
      )
      if (!r.ok) return reply.code(404).send(r)
      return { ...r, agents: await getAgentOverview() }
    },
  )

  // Run an autonomous agent now (operator-triggered). It scans + queues
  // proposals; nothing is applied without an approval.
  fastify.post<{ Params: { key: string }; Body: { maxItems?: number } }>(
    '/agent/agents/:key/run',
    async (request, reply) => {
      const r = await runAutonomousAgent(request.params.key, 'manual', {
        maxItems: request.body?.maxItems,
      })
      if (!r.ok && r.error?.startsWith('unknown agent'))
        return reply.code(404).send(r)
      return r
    },
  )
}

export default agentRoutes
