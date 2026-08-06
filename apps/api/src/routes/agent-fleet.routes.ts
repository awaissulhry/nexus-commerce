/**
 * NAF.A — fleet routes (docs/AGENT_FLEET.md Part 12 § A). Mounted under
 * /api/agent/fleet/* so the existing permissions-manifest entry for
 * `/api/agent/` (ai.view / ai.run) covers them with zero manifest changes
 * (plan D4). Thin by design — the services carry the logic and the tests.
 *
 * Read-only except: the halt toggle, the charter seed, and the manual
 * run-now (which deliberately ignores `enabled`, mirroring the existing
 * autonomous agents' Run-now).
 */
import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { isAiKillSwitchOn } from '../services/ai/providers/index.js'
import { executeCharter } from '../services/agent-fleet/agent-executor.js'
import {
  FLEET_CHARTERS,
  listCharters,
  seedCharters,
} from '../services/agent-fleet/charter-registry.js'
import { FLEET_GRAPH } from '../services/agent-fleet/fleet-graph.js'
import {
  getFleetState,
  haltFleet,
  resumeFleet,
} from '../services/agent-fleet/fleet-state.service.js'

const agentFleetRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/agent/fleet/charters', async () => {
    return { charters: await listCharters() }
  })

  fastify.get<{
    Querystring: { charterKey?: string; mode?: string; limit?: string }
  }>('/agent/fleet/runs', async (request) => {
    const { charterKey, mode, limit } = request.query
    const take = Math.min(Number(limit) || 50, 100)
    const runs = await prisma.agentRun.findMany({
      where: {
        mode: mode ? mode : { not: null }, // fleet runs are mode NOT NULL
        ...(charterKey ? { agentKey: charterKey } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
    })
    return { runs }
  })

  fastify.get<{
    Querystring: {
      status?: string
      domain?: string
      charterKey?: string
      limit?: string
    }
  }>('/agent/fleet/findings', async (request) => {
    const { status, domain, charterKey, limit } = request.query
    const take = Math.min(Number(limit) || 100, 200)
    const findings = await prisma.agentFinding.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(domain ? { domain } : {}),
        ...(charterKey ? { charterKey } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
    })
    return { findings }
  })

  fastify.get('/agent/fleet/plans', async () => {
    // Real query, empty table until Phase C — honest, not a stub.
    const plans = await prisma.agentPlan.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    return { plans }
  })

  fastify.get('/agent/fleet/graph', async () => {
    const charters = await listCharters()
    const byKey = new Map(charters.map((c) => [c.key, c]))
    return {
      nodes: FLEET_GRAPH.nodes.map((n) => {
        const c = byKey.get(n.key)
        return {
          ...n,
          enabled: c?.enabled ?? false,
          autonomyLevel: c?.autonomyLevel ?? 'OFF',
          degraded: c?.degraded ?? true,
        }
      }),
      edges: FLEET_GRAPH.edges,
    }
  })

  fastify.get('/agent/fleet/state', async () => {
    return getFleetState()
  })

  fastify.post<{ Body: { reason?: string } }>(
    '/agent/fleet/state/halt',
    async (request, reply) => {
      const reason = (request.body?.reason ?? '').trim()
      if (!reason) return reply.code(400).send({ error: 'reason is required' })
      return haltFleet(reason, 'operator')
    },
  )

  fastify.post('/agent/fleet/state/resume', async () => {
    return resumeFleet('operator')
  })

  fastify.post('/agent/fleet/charters/seed', async () => {
    return seedCharters()
  })

  fastify.post<{ Params: { key: string } }>(
    '/agent/fleet/run/:key',
    async (request, reply) => {
      const { key } = request.params
      if (isAiKillSwitchOn()) {
        return reply
          .code(503)
          .send({ error: 'AI is temporarily disabled (kill switch).' })
      }
      if (!FLEET_CHARTERS[key]) {
        return reply.code(404).send({ error: `unknown charter: ${key}` })
      }
      const result = await executeCharter(key, {
        trigger: 'manual',
        mode: 'ask',
        ignoreEnabled: true,
      })
      if (!result.ok && result.error) {
        return reply.code(500).send(result)
      }
      return result
    },
  )
}

export default agentFleetRoutes
