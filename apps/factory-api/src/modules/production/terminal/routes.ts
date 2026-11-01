import type { FastifyRequest } from 'fastify'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import type { TimingKind } from '@nexus/factory-domain/production/terminal/rules'
import { idempotencyKeyFrom, IDEMPOTENCY_KEY_HEADER } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { deviceCookieOf } from '../../../platform/auth/floor/cookies'
import { parseSiteToken } from '../../../platform/auth/floor/tokens'
import { AUTH_RATE_LIMITS } from '../../../platform/auth/sessions/office-auth'
import { verifyOverride } from '../guards/override'
import { handBackContract, openContract, partialContract, pauseContract, resumeContract, startContract, startOverrideContract, stateContract, workOrderTimingContract } from './contract'
import { manifest } from './manifest'
import { timeOperation, type TimingInput } from './timing'
import { bundleState, openWork, workOrderTiming } from './views'

/**
 * Operation timing on the tablet (B-W2b-40; MES-087 start, MES-088 pause with a reason, MES-089 resume, MES-091 hand back,
 * MES-092 pieces done so far, MES-094 team operation, MES-117 open work paused at clock-out; design floor.operation
 * "Start, pause, finish", floor.clock "Open work", floor.signin "Continue …"). Each write is one command keyed
 * `<device>.<clientScanId>`: its Idempotency-Key, when sent, is the clientScanId (201 recorded; 200 a resend). Finishing
 * stays the scans' one tap (POST /production/scans; Owner answer F3). The override of a qualification hold at START takes
 * a secret (the team leader's PIN), so it has the floor sign-in's rate limit per enrolled device, as the scans' override.
 * Offline, the same actions queue as floor-sync kinds production.scan.start | pause | resume | handBack | partial.
 */
export default defineRoutes('production.terminal', manifest, async (app) => {
  const limit = app.officeAuth?.rateLimits.floorSignIn ?? AUTH_RATE_LIMITS.floorSignIn
  const perDevice = { rateLimit: { max: limit.max, timeWindow: limit.timeWindowMs, keyGenerator: (request: FastifyRequest) => `timing-override:${parseSiteToken(deviceCookieOf(request))?.id ?? request.ip}` } }

  /** The Idempotency-Key, when sent, names the action: it is its clientScanId. */
  const sameKey = (request: FastifyRequest, clientScanId: string) => {
    const header = idempotencyKeyFrom(request)
    if (header !== undefined && header !== clientScanId) {
      throw new ValidationError('The Idempotency-Key is the action’s clientScanId: send the same value, or no header.', [{ path: `headers/${IDEMPOTENCY_KEY_HEADER}`, message: 'Must equal body.clientScanId.' }])
    }
  }
  const act = async (request: FastifyRequest, action: TimingKind, body: TimingInput) => {
    sameKey(request, body.clientScanId)
    return timeOperation(request, action, body)
  }
  const send = <R extends { replayed: boolean }>(result: R) => {
    const { replayed, ...rest } = result
    return { status: replayed ? (200 as const) : (201 as const), body: rest }
  }

  app.get('/production/terminal/open', { schema: openContract }, async (request) => openWork(request))

  app.get('/production/terminal/state', { schema: stateContract }, async (request) => bundleState(request, request.query))

  app.post('/production/terminal/start', { schema: startContract }, async (request, reply) => {
    const out = send(await act(request, 'START', request.body))
    return reply.code(out.status).send(out.body)
  })

  app.post('/production/terminal/start/override', { schema: startOverrideContract, config: perDevice }, async (request, reply) => {
    sameKey(request, request.body.start.clientScanId)
    const override = await verifyOverride(request, { lead: request.body.lead, reasonCode: request.body.reasonCode, note: request.body.note })
    const out = send(await timeOperation(request, 'START', request.body.start, { override }))
    return reply.code(out.status).send(out.body)
  })

  app.post('/production/terminal/pause', { schema: pauseContract }, async (request, reply) => {
    const out = send(await act(request, 'PAUSE', request.body))
    return reply.code(out.status).send(out.body)
  })

  app.post('/production/terminal/resume', { schema: resumeContract }, async (request, reply) => {
    const out = send(await act(request, 'RESUME', request.body))
    return reply.code(out.status).send(out.body)
  })

  app.post('/production/terminal/hand-back', { schema: handBackContract }, async (request, reply) => {
    const out = send(await act(request, 'HAND_BACK', request.body))
    return reply.code(out.status).send(out.body)
  })

  app.post('/production/terminal/partial', { schema: partialContract }, async (request, reply) => {
    const out = send(await act(request, 'PARTIAL', request.body))
    return reply.code(out.status).send(out.body)
  })

  app.get('/production/terminal/work-orders/:workOrderId/timing', { schema: workOrderTimingContract }, async (request) => workOrderTiming(request, request.params.workOrderId))
})
