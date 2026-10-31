import type { FastifyRequest } from 'fastify'
import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireFloorStepUp } from '../../../platform/auth/floor/step-up'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import {
  benchHoldContract,
  benchWorkOrdersContract,
  cancelInspectionContract,
  decideInspectionContract,
  evidenceContract,
  getInspectionContract,
  getReleaseContract,
  getRuleContract,
  listInspectionsContract,
  listReleasesContract,
  openInspectionContract,
  putDefectsContract,
  releaseContract,
  reverseContract,
  saveRuleContract,
  updateInspectionContract,
  workOrderFinalContract,
} from './contract'
import { benchWorkOrders } from './bench'
import { holdAtBench } from './bench-hold'
import { evidenceTrail } from './evidence'
import { cancelInspection, decideInspection, getInspection, openInspection, putDefects, updateInspection } from './inspections'
import { listInspections } from './lists'
import { manifest } from './manifest'
import { getRelease, listReleases, releaseGarments, workOrderFinal } from './releases'
import { reverseRelease } from './reversals'
import { getReleaseRule, saveReleaseRule } from './rule'

/**
 * The final inspection and release by an inspector who is not a maker (B-W1-45): the work order's final state, the
 * inspections (./inspections.ts), the releases with four eyes as a setting (./releases.ts, ./rule.ts), the reversal
 * (./reversals.ts), the lists with the on-hold filters (./lists.ts, ./releases.ts) and the evidence trail (./evidence.ts).
 * Signing a result and a release is a signing act: the office's fresh code (requireStepUp) or the floor's PIN
 * (requireFloorStepUp), asked after every other check.
 */
export default defineRoutes('quality.final', manifest, async (app) => {
  const sign = (request: FastifyRequest) => () => (request.factoryContext?.audience === 'floor' ? requireFloorStepUp(officeAuthOf(app), request) : requireStepUp(officeAuthOf(app), request))
  const flag = (value: 'true' | 'false' | undefined) => value === 'true'

  app.get('/quality/final/work-orders', { schema: benchWorkOrdersContract }, async (request) => benchWorkOrders(request, request.query))

  app.get('/quality/final/work-orders/:workOrderId', { schema: workOrderFinalContract }, async (request) => workOrderFinal(request, request.params.workOrderId))

  app.post('/quality/final/work-orders/:workOrderId/hold', { schema: benchHoldContract }, async (request, reply) =>
    reply.code(201).send(await holdAtBench(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request))),
  )

  app.get('/quality/inspections', { schema: listInspectionsContract }, async (request) =>
    listInspections(request, { ...request.query, onHold: flag(request.query.onHold), waitingRelease: flag(request.query.waitingRelease) }),
  )

  app.post('/quality/inspections', { schema: openInspectionContract }, async (request, reply) => reply.code(201).send(await openInspection(request, request.body, idempotencyKeyFrom(request))))

  app.get('/quality/inspections/:inspectionId', { schema: getInspectionContract }, async (request) => getInspection(request, request.params.inspectionId))

  app.patch('/quality/inspections/:inspectionId', { schema: updateInspectionContract }, async (request) => updateInspection(request, request.params.inspectionId, request.body, idempotencyKeyFrom(request)))

  app.put('/quality/inspections/:inspectionId/defects', { schema: putDefectsContract }, async (request) => putDefects(request, request.params.inspectionId, request.body, idempotencyKeyFrom(request)))

  app.post('/quality/inspections/:inspectionId/decide', { schema: decideInspectionContract }, async (request) =>
    decideInspection(request, request.params.inspectionId, request.body, { sign: sign(request), idempotencyKey: idempotencyKeyFrom(request) }),
  )

  app.post('/quality/inspections/:inspectionId/cancel', { schema: cancelInspectionContract }, async (request) => cancelInspection(request, request.params.inspectionId, request.body, idempotencyKeyFrom(request)))

  app.post('/quality/releases', { schema: releaseContract }, async (request, reply) => reply.code(201).send(await releaseGarments(request, request.body, { sign: sign(request), idempotencyKey: idempotencyKeyFrom(request) })))

  app.get('/quality/releases', { schema: listReleasesContract }, async (request) => listReleases(request, { ...request.query, reversed: flag(request.query.reversed), onHold: flag(request.query.onHold) }))

  app.get('/quality/releases/:releaseId', { schema: getReleaseContract }, async (request) => getRelease(request, request.params.releaseId))

  app.post('/quality/releases/:releaseId/reverse', { schema: reverseContract }, async (request, reply) => reply.code(201).send(await reverseRelease(request, request.params.releaseId, request.body, idempotencyKeyFrom(request))))

  app.get('/quality/release-rule', { schema: getRuleContract }, async (request) => getReleaseRule(request, request.query))

  app.put('/quality/release-rule', { schema: saveRuleContract }, async (request) =>
    saveReleaseRule(request, request.body, { stepUp: () => requireStepUp(officeAuthOf(app), request), idempotencyKey: idempotencyKeyFrom(request) }),
  )

  app.get('/quality/evidence', { schema: evidenceContract }, async (request) => evidenceTrail(request, request.query))
})
