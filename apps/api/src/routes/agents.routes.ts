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
import { runAgent, invokeTool } from '../services/agents/agent-runtime.service.js'
import {
  listToolPolicies,
  setToolPolicy,
  seedToolPolicies,
} from '../services/agents/tool-policy.service.js'

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

  fastify.get<{ Querystring: { limit?: string } }>(
    '/agent/runs',
    async (request) => {
      const limit = Math.min(
        Math.max(parseInt(request.query?.limit ?? '20', 10) || 20, 1),
        100,
      )
      const rows = await prisma.agentRun.findMany({
        orderBy: { createdAt: 'desc' },
        take: limit,
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
}

export default agentRoutes
