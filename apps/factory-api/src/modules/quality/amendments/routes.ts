import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { amendmentQueue, amendmentsOf, refuseAmendment, requestAmendment, signAmendment } from './amendments'
import {
  checkAmendmentsContract,
  incomingAmendmentsContract,
  inspectionAmendmentsContract,
  queueContract,
  refuseContract,
  requestCheckContract,
  requestIncomingContract,
  requestInspectionContract,
  signContract,
} from './contract'
import { manifest } from './manifest'

/**
 * Locked results with amendments (B-W2b-123; QHS-145): a signed record's corrections and what stands now
 * (./amendments.ts), per record kind; the queue of corrections waiting for a second signature; the second person's
 * signature (a fresh step-up code, asked after every other check) or refusal.
 */
export default defineRoutes('quality.amendments', manifest, async (app) => {
  app.get('/quality/inspections/:inspectionId/amendments', { schema: inspectionAmendmentsContract }, async (request) => amendmentsOf(request, 'Inspection', request.params.inspectionId))
  app.post('/quality/inspections/:inspectionId/amendments', { schema: requestInspectionContract }, async (request, reply) =>
    reply.code(201).send(await requestAmendment(request, 'Inspection', request.params.inspectionId, request.body, idempotencyKeyFrom(request))),
  )

  app.get('/quality/incoming/:inspectionId/amendments', { schema: incomingAmendmentsContract }, async (request) => amendmentsOf(request, 'IncomingInspection', request.params.inspectionId))
  app.post('/quality/incoming/:inspectionId/amendments', { schema: requestIncomingContract }, async (request, reply) =>
    reply.code(201).send(await requestAmendment(request, 'IncomingInspection', request.params.inspectionId, request.body, idempotencyKeyFrom(request))),
  )

  app.get('/quality/inprocess/checks/:checkId/amendments', { schema: checkAmendmentsContract }, async (request) => amendmentsOf(request, 'InProcessCheck', request.params.checkId))
  app.post('/quality/inprocess/checks/:checkId/amendments', { schema: requestCheckContract }, async (request, reply) =>
    reply.code(201).send(await requestAmendment(request, 'InProcessCheck', request.params.checkId, request.body, idempotencyKeyFrom(request))),
  )

  app.get('/quality/amendments', { schema: queueContract }, async (request) => amendmentQueue(request, request.query))

  app.post('/quality/amendments/:amendmentId/sign', { schema: signContract }, async (request, reply) =>
    reply.code(201).send(await signAmendment(request, request.params.amendmentId, { sign: () => requireStepUp(officeAuthOf(app), request), idempotencyKey: idempotencyKeyFrom(request) })),
  )

  app.post('/quality/amendments/:amendmentId/refuse', { schema: refuseContract }, async (request, reply) =>
    reply.code(201).send(await refuseAmendment(request, request.params.amendmentId, request.body, { idempotencyKey: idempotencyKeyFrom(request) })),
  )
})
