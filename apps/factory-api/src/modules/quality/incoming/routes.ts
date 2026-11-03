import type { FastifyRequest } from 'fastify'
import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireFloorStepUp } from '../../../platform/auth/floor/step-up'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { cancelContract, decideContract, getContract, listContract, openContract, putHideContract, putResultsContract, removeHideContract, scanLotContract } from './contract'
import { cancelIncoming, decideIncoming } from './decide'
import { manifest } from './manifest'
import { openIncoming, scanLot } from './open'
import { putHide, putResults, removeHide } from './record'
import { getIncoming, listIncoming } from './views'

/**
 * The incoming inspection of a lot, hide by hide (B-W2b-98; QHS-025, QHS-028, QHS-034, MES-054): the list and a lot's
 * scan (./views.ts, ./open.ts), opening on the approved plan with its sample (./open.ts), the hides and the plan checks
 * (./record.ts), the decision and the cancellation (./decide.ts). Signing the decision is a signing act: the office's
 * fresh code (requireStepUp) or the floor's PIN (requireFloorStepUp), asked after every other check. The rules are
 * factory-domain quality/incoming.
 */
export default defineRoutes('quality.incoming', manifest, async (app) => {
  const sign = (request: FastifyRequest) => () => (request.factoryContext?.audience === 'floor' ? requireFloorStepUp(officeAuthOf(app), request) : requireStepUp(officeAuthOf(app), request))

  app.get('/quality/incoming', { schema: listContract }, async (request) => listIncoming(request, request.query))

  app.get('/quality/incoming/lots/:lotId', { schema: scanLotContract }, async (request) => scanLot(request, request.params.lotId))

  app.post('/quality/incoming', { schema: openContract }, async (request, reply) => reply.code(201).send(await openIncoming(request, request.body, idempotencyKeyFrom(request))))

  app.get('/quality/incoming/:inspectionId', { schema: getContract }, async (request) => getIncoming(request, request.params.inspectionId))

  app.put('/quality/incoming/:inspectionId/hides/:hideId', { schema: putHideContract }, async (request) => putHide(request, request.params.inspectionId, request.params.hideId, request.body, idempotencyKeyFrom(request)))

  app.delete('/quality/incoming/:inspectionId/hides/:hideId', { schema: removeHideContract }, async (request) => removeHide(request, request.params.inspectionId, request.params.hideId, request.query.version, idempotencyKeyFrom(request)))

  app.put('/quality/incoming/:inspectionId/results', { schema: putResultsContract }, async (request) => putResults(request, request.params.inspectionId, request.body, idempotencyKeyFrom(request)))

  app.post('/quality/incoming/:inspectionId/decide', { schema: decideContract }, async (request) =>
    decideIncoming(request, request.params.inspectionId, request.body, { sign: sign(request), idempotencyKey: idempotencyKeyFrom(request) }),
  )

  app.post('/quality/incoming/:inspectionId/cancel', { schema: cancelContract }, async (request) => cancelIncoming(request, request.params.inspectionId, request.body, idempotencyKeyFrom(request)))
})
