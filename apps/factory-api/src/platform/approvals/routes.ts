import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireStepUp, StepUpRequiredError } from '../auth/office/account'
import { officeSessionOf } from '../auth/sessions/authenticator'
import {
  approveContract,
  askContract,
  createRuleContract,
  getRuleContract,
  getTaskContract,
  historyContract,
  kindsContract,
  listRulesContract,
  listTasksContract,
  rejectContract,
  testRuleContract,
  updateRuleContract,
  withdrawContract,
} from './contract'
import { manifest } from './manifest'
import { createRule, getRule, listKinds, listRules, testRule, updateRule } from './rules'
import { approveTask, askForApproval, getTask, listTasks, recordHistory, rejectTask, withdrawTask } from './tasks'

/**
 * The session's step-up for a signed yes (PLT-105): a code from the authenticator app on this office session in the last 5
 * minutes, else 403 `stepUp` (a session that is no office sign-in, a test's included, has none).
 */
function freshStepUpAt(app: FastifyInstance, request: FastifyRequest): Date {
  const auth = app.officeAuth
  if (!auth) throw new StepUpRequiredError()
  let stepUpAt: Date | null
  try {
    stepUpAt = officeSessionOf(request).stepUpAt
  } catch {
    throw new StepUpRequiredError()
  }
  requireStepUp(auth, request)
  if (!stepUpAt) throw new StepUpRequiredError()
  return stepUpAt
}

/**
 * One approval engine (B-W2b-282): the kinds and their facts, the approval rules (list, one, new — always off —, change and
 * switch, test), the requests (the inbox with its tiles, one request, approve, reject, withdraw), asking from the generic
 * route, and a record's approval history. The engine's seams for modules are ./engine.ts (askApproval, withdrawPending,
 * historyLine); the kinds are ./kinds.
 */
export default defineRoutes('approvals', manifest, async (app) => {
  app.get('/approvals/kinds', { schema: kindsContract }, async (request) => listKinds(request))

  app.get('/approvals/rules', { schema: listRulesContract }, async (request) => listRules(request, request.query))

  app.post('/approvals/rules', { schema: createRuleContract }, async (request, reply) => reply.code(201).send(await createRule(request, request.body, idempotencyKeyFrom(request))))

  app.post('/approvals/rules/test', { schema: testRuleContract }, async (request) => testRule(request, request.body))

  app.get('/approvals/rules/:id', { schema: getRuleContract }, async (request) => getRule(request, request.params.id))

  app.put('/approvals/rules/:id', { schema: updateRuleContract }, async (request) => updateRule(request, request.params.id, request.body, idempotencyKeyFrom(request)))

  app.get('/approvals/tasks', { schema: listTasksContract }, async (request) => listTasks(request, request.query))

  app.get('/approvals/tasks/:id', { schema: getTaskContract }, async (request) => getTask(request, request.params.id))

  // A signed request asks a fresh step-up (PLT-105): the session's, at most 5 minutes old, recorded with the yes.
  app.post('/approvals/tasks/:id/approve', { schema: approveContract }, async (request) =>
    approveTask(
      request,
      request.params.id,
      request.body,
      () => freshStepUpAt(app, request),
      idempotencyKeyFrom(request),
    ),
  )

  app.post('/approvals/tasks/:id/reject', { schema: rejectContract }, async (request) => rejectTask(request, request.params.id, request.body, idempotencyKeyFrom(request)))

  app.post('/approvals/tasks/:id/withdraw', { schema: withdrawContract }, async (request) => withdrawTask(request, request.params.id, request.body, idempotencyKeyFrom(request)))

  app.post('/approvals/requests', { schema: askContract }, async (request, reply) => {
    const answer = await askForApproval(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.status).send(answer.body)
  })

  app.get('/approvals/history/:recordType/:recordId', { schema: historyContract }, async (request) => recordHistory(request, request.params.recordType, request.params.recordId, request.query))
})
