import type { FastifyRequest } from 'fastify'
import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireFloorStepUp } from '../../../platform/auth/floor/step-up'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import {
  cancelContract,
  decideContract,
  getContract,
  listContract,
  openContract,
  putComponentContract,
  putCountersContract,
  putHideContract,
  putResultsContract,
  putRollContract,
  removeComponentContract,
  removeHideContract,
  removeRollContract,
  scanLotContract,
  scanReceiptContract,
} from './contract'
import { cancelIncoming, decideIncoming } from './decide'
import { manifest } from './manifest'
import { openIncoming, scanLot } from './open'
import { putHide, putResults, removeHide } from './record'
import { getIncoming, listIncoming } from './views'
// B-W2b-111: rolls (4-point), components, the counter, goods back from a workshop.
import { scanReceipt } from './receipt'
import { putComponent, putCounters, putRoll, removeComponent, removeRoll } from './units'

/**
 * The incoming inspection of a lot, hide by hide (B-W2b-98; QHS-025, QHS-028, QHS-034, MES-054): the list and a lot's
 * scan (./views.ts, ./open.ts), opening on the approved plan with its sample (./open.ts), the hides and the plan checks
 * (./record.ts), the decision and the cancellation (./decide.ts). Signing the decision is a signing act: the office's
 * fresh code (requireStepUp) or the floor's PIN (requireFloorStepUp), asked after every other check. The rules are
 * factory-domain quality/incoming.
 *
 * B-W2b-111 (QHS-032, QHS-033, QHS-036): fabric rolls by the 4-point system, component checks against spec and
 * certificate, the defect counter (./units.ts), goods back from a workshop (./receipt.ts; the decision releases them,
 * purchasing/subcontracting inspection.ts).
 */
export default defineRoutes('quality.incoming', manifest, async (app) => {
  const sign = (request: FastifyRequest) => () => (request.factoryContext?.audience === 'floor' ? requireFloorStepUp(officeAuthOf(app), request) : requireStepUp(officeAuthOf(app), request))

  app.get('/quality/incoming', { schema: listContract }, async (request) => listIncoming(request, request.query))

  app.get('/quality/incoming/lots/:lotId', { schema: scanLotContract }, async (request) => scanLot(request, request.params.lotId))

  app.post('/quality/incoming', { schema: openContract }, async (request, reply) => reply.code(201).send(await openIncoming(request, request.body, idempotencyKeyFrom(request))))

  app.get('/quality/incoming/receipts/:receiptId', { schema: scanReceiptContract }, async (request) => scanReceipt(request, request.params.receiptId))

  app.get('/quality/incoming/:inspectionId', { schema: getContract }, async (request) => getIncoming(request, request.params.inspectionId))

  app.put('/quality/incoming/:inspectionId/hides/:hideId', { schema: putHideContract }, async (request) => putHide(request, request.params.inspectionId, request.params.hideId, request.body, idempotencyKeyFrom(request)))

  app.delete('/quality/incoming/:inspectionId/hides/:hideId', { schema: removeHideContract }, async (request) => removeHide(request, request.params.inspectionId, request.params.hideId, request.query.version, idempotencyKeyFrom(request)))

  app.put('/quality/incoming/:inspectionId/results', { schema: putResultsContract }, async (request) => putResults(request, request.params.inspectionId, request.body, idempotencyKeyFrom(request)))

  app.put('/quality/incoming/:inspectionId/rolls', { schema: putRollContract }, async (request) => putRoll(request, request.params.inspectionId, request.body, idempotencyKeyFrom(request)))

  app.delete('/quality/incoming/:inspectionId/rolls/:rollResultId', { schema: removeRollContract }, async (request) => removeRoll(request, request.params.inspectionId, request.params.rollResultId, request.query.version, idempotencyKeyFrom(request)))

  app.put('/quality/incoming/:inspectionId/components/:seq', { schema: putComponentContract }, async (request) => putComponent(request, request.params.inspectionId, request.params.seq, request.body, idempotencyKeyFrom(request)))

  app.delete('/quality/incoming/:inspectionId/components/:seq', { schema: removeComponentContract }, async (request) => removeComponent(request, request.params.inspectionId, request.params.seq, request.query.version, idempotencyKeyFrom(request)))

  app.put('/quality/incoming/:inspectionId/counters', { schema: putCountersContract }, async (request) => putCounters(request, request.params.inspectionId, request.body, idempotencyKeyFrom(request)))

  app.post('/quality/incoming/:inspectionId/decide', { schema: decideContract }, async (request) =>
    decideIncoming(request, request.params.inspectionId, request.body, { sign: sign(request), idempotencyKey: idempotencyKeyFrom(request) }),
  )

  app.post('/quality/incoming/:inspectionId/cancel', { schema: cancelContract }, async (request) => cancelIncoming(request, request.params.inspectionId, request.body, idempotencyKeyFrom(request)))
})
