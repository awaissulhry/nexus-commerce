/**
 * MCP full control R16 (lead review) — a person sets an engine's per-business switch directly, from the Control Room
 * lever drawer: 100 % control without going through Claude.
 *
 *   POST /api/advertising/automation/engine-switch/:key   { mode, reason?, confirm? }
 *
 * ads.automation.manage (permissions-manifest.ts). Down is instant. Up never goes past what the server env allows, and
 * only with `confirm: true` (the page asks first). The env itself is never written. One audit row per move, the same
 * as Claude's approved moves (engine-switch.service.ts). An Idempotency-Key makes a double press one move
 * (command-idempotency.ts).
 */
import type { FastifyPluginAsync } from 'fastify'
import { CONTROL_ROOM_ENGINES, changeEngineSwitch } from '../services/automation/engine-switch.service.js'

const automationSwitchRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { key: string }; Body: { mode?: string; reason?: string | null; confirm?: boolean } }>(
    '/advertising/automation/engine-switch/:key',
    async (request, reply) => {
      const { key } = request.params
      if (!(CONTROL_ROOM_ENGINES as readonly string[]).includes(key)) return reply.code(404).send({ error: `There is no Control Room engine switch "${key}".` })
      const body = request.body ?? {}
      if (typeof body.mode !== 'string') return reply.code(400).send({ error: 'mode is required: OFF, OBSERVE, PROPOSE or AUTO' })
      const actor = (request as { authUser?: { id?: string } }).authUser?.id ?? null
      const out = await changeEngineSwitch(key, body.mode, actor, { reason: body.reason ?? null, confirmUp: body.confirm === true })
      if ('error' in out) return reply.code(out.status).send({ error: out.error })
      return out
    },
  )
}

export default automationSwitchRoutes
