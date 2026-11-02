import type { FastifyRequest } from 'fastify'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { idempotencyKeyFrom, IDEMPOTENCY_KEY_HEADER } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { deviceCookieOf } from '../../../platform/auth/floor/cookies'
import { parseSiteToken } from '../../../platform/auth/floor/tokens'
import { AUTH_RATE_LIMITS } from '../../../platform/auth/sessions/office-auth'
import { verifyOverride } from '../guards/override'
import { onBehalfContract, onBehalfOverrideContract, optionsContract, severalContract } from './contract'
import { manifest } from './manifest'
import { onBehalfOptions, reportOnBehalf } from './report'
import { finishSeveral } from './several'

/**
 * More on the tablet (B-W2b-47): the team leader's scan on behalf (MES-099) and several bundles at once (MES-100). An entry's
 * Idempotency-Key, when sent, is its clientScanId (201 recorded; 200 a resend). A held entry goes on to the override route:
 * ANOTHER team leader signs (four eyes): it takes a secret, so it has the floor sign-in's rate limit per enrolled device.
 * Offline, an entry queues as production.scan.onBehalf; the override and the stack route stay online.
 */
export default defineRoutes('production.onbehalf', manifest, async (app) => {
  const limit = app.officeAuth?.rateLimits.floorSignIn ?? AUTH_RATE_LIMITS.floorSignIn
  const perDevice = { rateLimit: { max: limit.max, timeWindow: limit.timeWindowMs, keyGenerator: (request: FastifyRequest) => `behalf-override:${parseSiteToken(deviceCookieOf(request))?.id ?? request.ip}` } }

  const sameKey = (request: FastifyRequest, clientScanId: string) => {
    const header = idempotencyKeyFrom(request)
    if (header !== undefined && header !== clientScanId) {
      throw new ValidationError('The Idempotency-Key is the entry’s clientScanId: send the same value, or no header.', [{ path: `headers/${IDEMPOTENCY_KEY_HEADER}`, message: 'Must equal the clientScanId.' }])
    }
  }

  app.get('/production/on-behalf/options', { schema: optionsContract }, async (request) => onBehalfOptions(request))

  app.post('/production/on-behalf/report', { schema: onBehalfContract }, async (request, reply) => {
    sameKey(request, request.body.clientScanId)
    const result = await reportOnBehalf(request, request.body)
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.post('/production/on-behalf/override', { schema: onBehalfOverrideContract, config: perDevice }, async (request, reply) => {
    sameKey(request, request.body.report.clientScanId)
    const override = await verifyOverride(request, { lead: request.body.lead, reasonCode: request.body.overrideReasonCode, note: request.body.overrideNote })
    const result = await reportOnBehalf(request, request.body.report, { override })
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.post('/production/several-bundles/finish', { schema: severalContract }, async (request) => finishSeveral(request, request.body))
})
