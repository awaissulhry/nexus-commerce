import type { FastifyRequest } from 'fastify'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { idempotencyKeyFrom, IDEMPOTENCY_KEY_HEADER } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { deviceCookieOf } from '../../../platform/auth/floor/cookies'
import { parseSiteToken } from '../../../platform/auth/floor/tokens'
import { AUTH_RATE_LIMITS } from '../../../platform/auth/sessions/office-auth'
import { overrideReport } from './apply'
import { checkContract, flagContract, flagsContract, lotGarmentsContract, overrideContract, workOrderComponentsContract } from './contract'
import { manifest } from './manifest'
import { checkBundle, flagOf, listFlags, lotGarments, workOrderComponents } from './views'

/**
 * Checks before a scan counts (B-W2b-46; MES-070, MES-097, MES-098, MES-114; design floor.operation "Checks before it
 * counts", "Scan what you used", pop-up "Team leader override"). The report itself stays POST /production/scans (and the
 * offline batch): it carries the lots scanned (`components`), and the site's checks hold it with the scans' 409. The
 * override sends the held report again with the team leader's badge or name, PIN and reason: it takes a secret, so it
 * has the floor sign-in's rate limit per enrolled device. Its Idempotency-Key, when sent, is the report's clientScanId.
 */
export default defineRoutes('production.guards', manifest, async (app) => {
  const limit = app.officeAuth?.rateLimits.floorSignIn ?? AUTH_RATE_LIMITS.floorSignIn
  const perDevice = { rateLimit: { max: limit.max, timeWindow: limit.timeWindowMs, keyGenerator: (request: FastifyRequest) => `guard-override:${parseSiteToken(deviceCookieOf(request))?.id ?? request.ip}` } }

  app.get('/production/guards/check', { schema: checkContract }, async (request) => checkBundle(request, request.query))

  app.post('/production/guards/override', { schema: overrideContract, config: perDevice }, async (request, reply) => {
    const header = idempotencyKeyFrom(request)
    if (header !== undefined && header !== request.body.report.clientScanId) {
      throw new ValidationError('The Idempotency-Key is the report’s clientScanId: send the same value, or no header.', [{ path: `headers/${IDEMPOTENCY_KEY_HEADER}`, message: 'Must equal body.report.clientScanId.' }])
    }
    const result = await overrideReport(request, request.body)
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.get('/production/guards/flags', { schema: flagsContract }, async (request) => listFlags(request, request.query))

  app.get('/production/guards/flags/:scanId', { schema: flagContract }, async (request) => flagOf(request, request.params.scanId))

  app.get('/production/guards/work-orders/:workOrderId/components', { schema: workOrderComponentsContract }, async (request) => workOrderComponents(request, request.params.workOrderId))

  app.get('/production/guards/lots/:lotId/garments', { schema: lotGarmentsContract }, async (request) => lotGarments(request, request.params.lotId))
})
