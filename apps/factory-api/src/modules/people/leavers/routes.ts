import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { cancelLeavingContract, checkLeavingContract, leaverRecordContract, leavingPreviewContract, listLeaversContract, startLeavingContract, stepDoneContract, stepReopenContract, stepSkipContract } from './contract'
import { cancelLeaving, checkLeaving, leaverRecord, leavingPreview, listLeavers, moveStep, startLeaving } from './leavers'
import { manifest } from './manifest'

/** Leaver steps (B-W2b-26; ./leavers.ts, ./automatic.ts). Each write is one command with an Idempotency-Key. */
export default defineRoutes('people.leavers', manifest, async (app) => {
  app.get('/people/leavers', { schema: listLeaversContract }, async (request) => listLeavers(request, request.query))
  app.get('/people/leavers/:caseId', { schema: leaverRecordContract }, async (request) => leaverRecord(request, request.params.caseId))
  app.get('/people/employees/:employeeId/leaving/preview', { schema: leavingPreviewContract }, async (request) => leavingPreview(request, request.params.employeeId, request.query))
  app.post('/people/employees/:employeeId/leaving', { schema: startLeavingContract }, async (request, reply) => {
    const { replayed, ...answer } = await startLeaving(request, request.params.employeeId, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send(answer)
  })
  app.post('/people/leavers/:caseId/steps/:stepId/done', { schema: stepDoneContract }, async (request) => moveStep(request, request.params.caseId, request.params.stepId, 'DONE', request.body, idempotencyKeyFrom(request)))
  app.post('/people/leavers/:caseId/steps/:stepId/skip', { schema: stepSkipContract }, async (request) => moveStep(request, request.params.caseId, request.params.stepId, 'SKIP', request.body, idempotencyKeyFrom(request)))
  app.post('/people/leavers/:caseId/steps/:stepId/reopen', { schema: stepReopenContract }, async (request) => moveStep(request, request.params.caseId, request.params.stepId, 'REOPEN', request.body, idempotencyKeyFrom(request)))
  app.post('/people/leavers/:caseId/cancel', { schema: cancelLeavingContract }, async (request) => cancelLeaving(request, request.params.caseId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/leavers/:caseId/check', { schema: checkLeavingContract }, async (request) => checkLeaving(request, request.params.caseId, idempotencyKeyFrom(request)))
})
