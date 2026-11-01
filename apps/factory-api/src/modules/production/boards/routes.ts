import type { FastifyRequest } from 'fastify'
import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { deviceCookieOf } from '../../../platform/auth/floor/cookies'
import { parseSiteToken } from '../../../platform/auth/floor/tokens'
import { AUTH_RATE_LIMITS, officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { displayContract, heatmapContract, hourlyContract, reasonContract, setTargetsContract, targetsContract, tvContract } from './contract'
import { manifest } from './manifest'
import { displayBoard, hourlyBoard, tvBoard, wipHeatmap } from './reads'
import { giveReason, lineTargets, setTargets } from './targets'

/**
 * Line targets and boards (B-W2b-50; ./targets.ts, ./reads.ts, ./facts.ts). Each write is one command with an
 * Idempotency-Key; a repeated key answers from its receipt. The display's board takes the device token: its own rate limit
 * per enrolled device (a plant's TVs and tablets may share one address), as the floor's device routes do.
 */
export default defineRoutes('production.boards', manifest, async (app) => {
  app.get('/production/boards/targets', { schema: targetsContract }, async (request) => lineTargets(request, request.query))

  app.put('/production/boards/targets', { schema: setTargetsContract }, async (request) => {
    const { replayed: _replayed, ...answer } = await setTargets(request, request.body, idempotencyKeyFrom(request))
    return answer
  })

  app.post('/production/boards/targets/:targetId/reason', { schema: reasonContract }, async (request) => {
    const { replayed: _replayed, ...answer } = await giveReason(request, request.params.targetId, request.body, idempotencyKeyFrom(request))
    return answer
  })

  app.get('/production/boards/hourly', { schema: hourlyContract }, async (request) => hourlyBoard(request, request.query))

  app.get('/production/boards/heatmap', { schema: heatmapContract }, async (request) => wipHeatmap(request, request.query))

  app.get('/production/boards/tv', { schema: tvContract }, async (request) => tvBoard(request, request.query))

  const limits = app.officeAuth?.rateLimits ?? AUTH_RATE_LIMITS
  app.get(
    '/production/boards/display',
    {
      schema: displayContract,
      config: { rateLimit: { max: limits.floorSignIn.max, timeWindow: limits.floorSignIn.timeWindowMs, keyGenerator: (request: FastifyRequest) => `floor-board:${parseSiteToken(deviceCookieOf(request))?.id ?? request.ip}` } },
    },
    async (request) => displayBoard(officeAuthOf(app), request),
  )
})
