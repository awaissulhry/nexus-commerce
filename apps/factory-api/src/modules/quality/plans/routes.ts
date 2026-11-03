import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { addStarterPlans, approveVersion, createPlan, draftVersion, editPlan, retireVersion, saveVersion, submitVersion } from './commands'
import {
  addStarterContract,
  approveContract,
  checklistContract,
  createContract,
  draftContract,
  editContract,
  frozenContract,
  listContract,
  recordContract,
  retireContract,
  saveContract,
  starterContract,
  submitContract,
  versionContract,
} from './contract'
import { manifest } from './manifest'
import { listPlans, readChecklist, readFrozenVersion, readPlanRecord, readStarter, readVersionRecord } from './plans'

/**
 * Inspection plans (B-W2b-92; QHS-008, QHS-009, QHS-016): the reads in ./plans.ts, the writes in ./commands.ts, the rows
 * and views in ./store.ts. Approving a version is an e-signature: the office's step-up (a fresh 6-digit code) first.
 */
export default defineRoutes('quality.plans', manifest, async (app) => {
  app.get('/quality/plans', { schema: listContract }, async (request) => listPlans(request, request.query))

  app.post('/quality/plans', { schema: createContract }, async (request, reply) => reply.code(201).send(await createPlan(request, request.body, idempotencyKeyFrom(request))))

  app.get('/quality/plans/starter', { schema: starterContract }, async (request) => readStarter(request, request.query))

  app.post('/quality/plans/starter', { schema: addStarterContract }, async (request) => addStarterPlans(request, request.body, idempotencyKeyFrom(request)))

  app.get('/quality/plans/:planId', { schema: recordContract }, async (request) => readPlanRecord(request, request.params.planId))

  app.patch('/quality/plans/:planId', { schema: editContract }, async (request) => editPlan(request, request.params.planId, request.body, idempotencyKeyFrom(request)))

  app.post('/quality/plans/:planId/versions', { schema: draftContract }, async (request, reply) => reply.code(201).send(await draftVersion(request, request.params.planId, request.body, idempotencyKeyFrom(request))))

  app.get('/quality/plans/:planId/versions/:versionId', { schema: versionContract }, async (request) => readVersionRecord(request, request.params.planId, request.params.versionId, request.query))

  app.put('/quality/plans/:planId/versions/:versionId', { schema: saveContract }, async (request) => saveVersion(request, request.params.planId, request.params.versionId, request.body, idempotencyKeyFrom(request)))

  app.post('/quality/plans/:planId/versions/:versionId/submit', { schema: submitContract }, async (request) => submitVersion(request, request.params.planId, request.params.versionId, request.body, idempotencyKeyFrom(request)))

  app.post('/quality/plans/:planId/versions/:versionId/approve', { schema: approveContract }, async (request) => {
    requireStepUp(officeAuthOf(app), request)
    return approveVersion(request, request.params.planId, request.params.versionId, request.body, idempotencyKeyFrom(request))
  })

  app.post('/quality/plans/:planId/versions/:versionId/retire', { schema: retireContract }, async (request) => retireVersion(request, request.params.planId, request.params.versionId, request.body, idempotencyKeyFrom(request)))

  app.get('/quality/plans/:planId/versions/:versionId/checklist', { schema: checklistContract }, async (request) => readChecklist(request, request.params.planId, request.params.versionId, request.query))

  app.get('/quality/plan-versions/:versionId', { schema: frozenContract }, async (request) => readFrozenVersion(request, request.params.versionId, request.query))
})
