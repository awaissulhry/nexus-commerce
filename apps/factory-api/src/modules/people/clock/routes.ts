import type { FastifyRequest } from 'fastify'
import { defineRoutes } from '../../../core/manifest'
import { deviceCookieOf } from '../../../platform/auth/floor/cookies'
import { parseSiteToken } from '../../../platform/auth/floor/tokens'
import { AUTH_RATE_LIMITS, officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { floorClock, floorClockState, scanClock, tabletClock } from './clock'
import { floorClockContract, floorStateContract, scanClockContract, tabletClockContract } from './contract'
import { manifest } from './manifest'

/**
 * Clock in and out (B-W2b-33; MES-223 clock in and out, MES-224 breaks, MES-239 forgot badge, MES-199 offline; design
 * floor.clock SCR-170; the automatic clock-out MES-227 is the scheduler's cron `people.autoClockOut`, auto.ts):
 *
 *   GET  /people/clock/floor   the signed-in worker's "Your time today": state, minutes so far, the shift, the next
 *                              fixed break or the break reminder, the automatic clock-out time, the buttons
 *   POST /people/clock/floor   the signed-in worker clocks: {clientEventId, action?} (no action: what a badge scan does)
 *   POST /people/clock/scan    the tablet's clock (signed in or not): {clientEventId, badgeCode | workerId + pin,
 *                              action?, occurredAt? (a badge scanned offline), sentAt?}
 *   GET  /people/clock/tablet  B-W2b-67: whether the tablet's site clocks at all (the ATTENDANCE gate; the device token)
 * The signed-in worker's actions kept offline go through POST /floor/sync (kind `people.clock.record`).
 * 201 when recorded; 200 when the tablet sent the same event before or the badge was scanned again within a minute.
 */
export default defineRoutes('people.clock', manifest, async (app) => {
  const limits = app.officeAuth?.rateLimits ?? AUTH_RATE_LIMITS
  const perDevice = {
    rateLimit: { max: limits.floorSignIn.max, timeWindow: limits.floorSignIn.timeWindowMs, keyGenerator: (request: FastifyRequest) => `floor-clock:${parseSiteToken(deviceCookieOf(request))?.id ?? request.ip}` },
  }

  app.get('/people/clock/floor', { schema: floorStateContract }, async (request) => floorClockState(request))

  app.post('/people/clock/floor', { schema: floorClockContract }, async (request, reply) => {
    const { created, answer } = await floorClock(request, request.body)
    return reply.code(created ? 201 : 200).send(answer)
  })

  app.get('/people/clock/tablet', { schema: tabletClockContract, config: perDevice }, async (request) => tabletClock(officeAuthOf(app), request))

  app.post('/people/clock/scan', { schema: scanClockContract, config: perDevice }, async (request, reply) => {
    const { created, answer } = await scanClock(officeAuthOf(app), request, request.body)
    return reply.code(created ? 201 : 200).send(answer)
  })
})
