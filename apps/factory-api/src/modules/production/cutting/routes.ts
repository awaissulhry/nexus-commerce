import type { FastifyRequest } from 'fastify'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { idempotencyKeyFrom, IDEMPOTENCY_KEY_HEADER } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { deviceCookieOf } from '../../../platform/auth/floor/cookies'
import { parseSiteToken } from '../../../platform/auth/floor/tokens'
import { AUTH_RATE_LIMITS } from '../../../platform/auth/sessions/office-auth'
import {
  announceHidePhotoContract,
  completeHidePhotoContract,
  correctContract,
  cutAnywayContract,
  cutContract,
  cutLogContract,
  cutsListContract,
  cuttingViewContract,
  cuttingWorkOrdersContract,
  remnantContract,
  scanHideContract,
  undoContract,
} from './contract'
import { correctCut, cutAnyway, logCut, undoCut } from './cut'
import { manifest } from './manifest'
import { cutsList } from './office'
import { announceHidePhoto, completeHidePhoto } from './photos'
import { cutLog, cuttingView, cuttingWorkOrders, scanHide } from './views'

/**
 * The cutting log per hide (B-W1-40; MES-051, MES-056, MES-058, SCM-194, SCM-253; A2 SCR-094, SCR-071): the work orders
 * to cut for, a work order at the cutting table, a scanned hide, a cut (the scan issues a hide still in stock in the same
 * command), Hide done with its remnant back to stock, the undo of one's own last cut, and for the office the cut log of
 * a work order and the correction of an entry. Every write is one command (./cut.ts); a resent floor event (the same
 * client event id) answers 200 with the entry recorded before.
 *
 * B-W2b-103 (leather cutting rules): a cut is checked before the knife (./checks.ts: shade, the hide reserved, thickness, the
 * pieces' minimum grade); a warning no lead passed stops it (409 refusal/CUT_WARNING). "Cut anyway" sends the cut again with a
 * lead's badge or name, PIN and reason tile: it takes a secret, so it has the floor sign-in's rate limit per enrolled device,
 * and its Idempotency-Key (a floor write takes one) is the cut's clientEventId. The photo of the hide is uploaded first (./photos.ts).
 */
export default defineRoutes('production.cutting', manifest, async (app) => {
  const limit = app.officeAuth?.rateLimits.floorSignIn ?? AUTH_RATE_LIMITS.floorSignIn
  const perDevice = { rateLimit: { max: limit.max, timeWindow: limit.timeWindowMs, keyGenerator: (request: FastifyRequest) => `cut-anyway:${parseSiteToken(deviceCookieOf(request))?.id ?? request.ip}` } }

  app.get('/production/cutting/work-orders', { schema: cuttingWorkOrdersContract }, async (request) => cuttingWorkOrders(request, request.query))

  app.get('/production/cutting/work-orders/:workOrderId', { schema: cuttingViewContract }, async (request) => cuttingView(request, request.params.workOrderId))

  app.get('/production/cutting/hides', { schema: scanHideContract }, async (request) => scanHide(request, request.query))

  app.post('/production/cutting/work-orders/:workOrderId/cuts', { schema: cutContract }, async (request, reply) => {
    const result = await logCut(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.post('/production/cutting/work-orders/:workOrderId/hides/:hideId/remnant', { schema: remnantContract }, async (request, reply) => {
    const { remnant, note, clientEventId, occurredAt } = request.body
    const result = await logCut(
      request,
      request.params.workOrderId,
      { hideId: request.params.hideId, lines: [], done: { remnant }, note, clientEventId, ...(occurredAt ? { occurredAt } : {}) },
      idempotencyKeyFrom(request),
    )
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.post('/production/cutting/cuts/:cutLogId/undo', { schema: undoContract }, async (request, reply) =>
    reply.code(201).send(await undoCut(request, request.params.cutLogId, idempotencyKeyFrom(request))),
  )

  app.get('/production/cutting/work-orders/:workOrderId/cut-log', { schema: cutLogContract }, async (request) => cutLog(request, request.params.workOrderId))

  app.post('/production/cutting/cuts/:cutLogId/correct', { schema: correctContract }, async (request, reply) =>
    reply.code(201).send(await correctCut(request, request.params.cutLogId, request.body, idempotencyKeyFrom(request))),
  )

  // B-W2a-60: the cutting office's list of cuts (office.ts).
  app.get('/production/cutting/cuts', { schema: cutsListContract }, async (request) => cutsList(request, request.query))

  // B-W2b-103: "Cut anyway" with a lead's PIN, and the photo of the hide on the table.
  app.post('/production/cutting/work-orders/:workOrderId/cuts/anyway', { schema: cutAnywayContract, config: perDevice }, async (request, reply) => {
    const header = idempotencyKeyFrom(request)
    if (header !== undefined && header !== request.body.cut.clientEventId) {
      throw new ValidationError('The Idempotency-Key is the cut’s clientEventId: send the same value.', [{ path: `headers/${IDEMPOTENCY_KEY_HEADER}`, message: 'Must equal body.cut.clientEventId.' }])
    }
    const result = await cutAnyway(request, request.params.workOrderId, request.body, header)
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.post('/production/cutting/hides/:hideId/photos', { schema: announceHidePhotoContract }, async (request, reply) =>
    reply.code(201).send(await announceHidePhoto(request, request.params.hideId, request.body, idempotencyKeyFrom(request))),
  )

  app.post('/production/cutting/hides/:hideId/photos/:fileId/complete', { schema: completeHidePhotoContract }, async (request) =>
    completeHidePhoto(request, request.params.hideId, request.params.fileId, idempotencyKeyFrom(request)),
  )
})
