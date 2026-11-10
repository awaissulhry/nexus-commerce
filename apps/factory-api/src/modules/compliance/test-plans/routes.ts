import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { announceReportContract, createPlanContract, dueLotsContract, editPlanContract, listPlansContract, lotDueContract, recordResultContract, switchPlanContract } from './contract'
import { announceReport, dueLots, lotDue, recordSubstanceResult } from './lots'
import { manifest } from './manifest'
import { createPlan, editPlan, listPlans, switchPlan } from './plans'

const flag = (value: 'true' | 'false' | undefined): boolean | undefined => (value === undefined ? undefined : value === 'true')

/**
 * Test plan rules (B-W2b-256; PRD-309): which test, how often, for which material and market; the tests due on a lot (as
 * W1's chromium VI test appears on it) and the lots with tests still due; a substance test's report and result judged
 * against its rule's limit (the material evaluated again in the same command). Nothing is ordered from a lab. The screens
 * are B-W2b-267 (Compliance › Material tests) and the lot page.
 */
export default defineRoutes('compliance.testPlans', manifest, async (app) => {
  app.get('/compliance/test-plans', { schema: listPlansContract }, async (request) => listPlans(request, { ...request.query, switchedOn: flag(request.query.switchedOn) }))
  app.post('/compliance/test-plans', { schema: createPlanContract }, async (request) => createPlan(request, request.body, idempotencyKeyFrom(request)))
  app.patch('/compliance/test-plans/:planId', { schema: editPlanContract }, async (request) => editPlan(request, request.params.planId, request.body, idempotencyKeyFrom(request)))
  app.put('/compliance/test-plans/:planId/switch', { schema: switchPlanContract }, async (request) => switchPlan(request, request.params.planId, request.body, idempotencyKeyFrom(request)))
  app.get('/compliance/test-plans/due', { schema: dueLotsContract }, async (request) => dueLots(request, request.query))
  app.get('/compliance/test-plans/lots/:lotId', { schema: lotDueContract }, async (request) => lotDue(request, request.params.lotId))
  app.post('/compliance/test-plans/lots/:lotId/report', { schema: announceReportContract }, async (request, reply) =>
    reply.code(201).send(await announceReport(request, request.params.lotId, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/compliance/test-plans/lots/:lotId/results', { schema: recordResultContract }, async (request, reply) =>
    reply.code(201).send(await recordSubstanceResult(request, request.params.lotId, request.body, idempotencyKeyFrom(request))),
  )
})
