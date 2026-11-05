import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { exitVisit, markExitVisit } from '../../people/leavers/visit-step'
import {
  announceCopyContract,
  bookVisitsContract,
  cancelVisitContract,
  completeCopyContract,
  doneVisitContract,
  editPlanContract,
  exitVisitContract,
  exitVisitStepContract,
  fitnessContract,
  frameContract,
  judgementListContract,
  moveVisitContract,
  openCopyContract,
  openJudgementContract,
  openVisitContract,
  planVisitsContract,
  plansContract,
  proposalsContract,
  recordJudgementContract,
  showJudgementsContract,
  unbookVisitContract,
  viewsContract,
  visitListContract,
  visitPrintContract,
  voidJudgementContract,
} from './contract'
import { checkFitness } from './fitness'
import { editPlan, healthFrame, listPlans } from './frame'
import { announceCopy, completeCopy, listJudgements, recordJudgement, voidJudgement } from './judgements'
import { manifest } from './manifest'
import { listVisits, openCopy, openJudgement, openVisit, printVisits, showJudgements } from './protected'
import { healthViews } from './views'
import { bookVisits, moveVisit, planVisits, proposeVisits } from './visits'

/**
 * Health surveillance (B-W2b-135; ./frame.ts, ./visits.ts, ./judgements.ts, ./protected.ts, ./views.ts, ./fitness.ts; the leaver's
 * step ../../people/leavers/visit-step.ts, registered here so the leavers' routes file stays B-W2b-26's). Each write is one command
 * with an Idempotency-Key (a repeated key answers from its receipt: ids and versions only). The recorded reads (…/list, …/print,
 * …/proposals, …/open, …/show, the copy's open) write the view log, then read: they take no key (each opening is a view of its own).
 */
export default defineRoutes('safety.health', manifest, async (app) => {
  app.get('/safety/health', { schema: frameContract }, async (request) => healthFrame(request, request.query))
  app.get('/safety/health/plans', { schema: plansContract }, async (request) => listPlans(request, request.query))
  app.patch('/safety/health/plans/:planId', { schema: editPlanContract }, async (request) => editPlan(request, request.params.planId, request.body, idempotencyKeyFrom(request)))

  app.post('/safety/health/visits/list', { schema: visitListContract }, async (request) => listVisits(request, request.body))
  app.post('/safety/health/visits/print', { schema: visitPrintContract }, async (request) => printVisits(request, request.body))
  app.post('/safety/health/visits/proposals', { schema: proposalsContract }, async (request) => proposeVisits(request, request.body))
  app.post('/safety/health/visits/plan', { schema: planVisitsContract }, async (request, reply) => {
    const answer = await planVisits(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })
  app.post('/safety/health/visits/book', { schema: bookVisitsContract }, async (request) => bookVisits(request, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/health/visits/:visitId/open', { schema: openVisitContract }, async (request) => openVisit(request, request.params.visitId))
  app.post('/safety/health/visits/:visitId/unbook', { schema: unbookVisitContract }, async (request) => moveVisit(request, request.params.visitId, request.body, { kind: 'unbook' }, idempotencyKeyFrom(request)))
  app.patch('/safety/health/visits/:visitId', { schema: moveVisitContract }, async (request) => moveVisit(request, request.params.visitId, request.body, { kind: 'move', dueOn: request.body.dueOn }, idempotencyKeyFrom(request)))
  app.post('/safety/health/visits/:visitId/cancel', { schema: cancelVisitContract }, async (request) => moveVisit(request, request.params.visitId, request.body, { kind: 'cancel', reason: request.body.reason }, idempotencyKeyFrom(request)))
  app.post('/safety/health/visits/:visitId/done', { schema: doneVisitContract }, async (request) => moveVisit(request, request.params.visitId, request.body, { kind: 'done', doneOn: request.body.doneOn }, idempotencyKeyFrom(request)))

  app.get('/safety/health/judgements', { schema: judgementListContract }, async (request) => listJudgements(request, request.query))
  app.post('/safety/health/judgements', { schema: recordJudgementContract }, async (request, reply) => {
    const answer = await recordJudgement(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })
  app.post('/safety/health/judgements/show', { schema: showJudgementsContract }, async (request) => showJudgements(request, request.body))
  app.post('/safety/health/judgements/:judgementId/open', { schema: openJudgementContract }, async (request) => openJudgement(request, request.params.judgementId))
  app.post('/safety/health/judgements/:judgementId/void', { schema: voidJudgementContract }, async (request) => voidJudgement(request, request.params.judgementId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/health/judgements/:judgementId/copy', { schema: announceCopyContract }, async (request, reply) => reply.code(201).send(await announceCopy(request, request.params.judgementId, request.body, idempotencyKeyFrom(request))))
  app.post('/safety/health/judgements/:judgementId/copy/:fileId/complete', { schema: completeCopyContract }, async (request) => completeCopy(request, request.params.judgementId, request.params.fileId, idempotencyKeyFrom(request)))
  app.post('/safety/health/judgements/:judgementId/copy/:fileId/open', { schema: openCopyContract }, async (request) => openCopy(request, request.params.judgementId, request.params.fileId))

  app.get('/safety/health/views', { schema: viewsContract }, async (request) => healthViews(request, request.query))
  app.post('/safety/health/people/:employeeId/fitness', { schema: fitnessContract }, async (request) => checkFitness(request, request.params.employeeId))

  app.post('/people/leavers/:caseId/exit-visit/open', { schema: exitVisitContract }, async (request) => exitVisit(request, request.params.caseId))
  app.post('/people/leavers/:caseId/steps/:stepId/exit-visit', { schema: exitVisitStepContract }, async (request) => markExitVisit(request, request.params.caseId, request.params.stepId, request.body, idempotencyKeyFrom(request)))
})
