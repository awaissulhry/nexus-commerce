import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { addStarterAlertRules, createAlertRule, deleteAlertRule, editAlertRule, listAlertRules, testAlertRule } from './alert-rules'
import {
  alertRulesContract,
  createAlertRuleContract,
  deleteAlertRuleContract,
  editAlertRuleContract,
  rulesContract,
  saveDutiesContract,
  saveResultsContract,
  starterAlertRulesContract,
  testAlertRuleContract,
} from './contract'
import { getRules, saveDuties, saveResults } from './duties'
import { manifest } from './manifest'

/**
 * Quality rules (B-W2b-118; QHS-154, QHS-300; design quality.settings SCR-260): who may sign what and the result rules
 * (./duties.ts), the alert and escalation rules (./alert-rules.ts). When a rule fires is ./firing.ts (the worker's handler
 * and the scheduler's cron, listed in background.ts); the bell it rings is ./notices.ts (the notifications fan-out).
 */
export default defineRoutes('quality.rules', manifest, async (app) => {
  app.get('/quality/rules', { schema: rulesContract }, async (request) => getRules(request, request.query))

  app.put('/quality/rules/duties', { schema: saveDutiesContract }, async (request) =>
    saveDuties(request, request.body, { stepUp: () => requireStepUp(officeAuthOf(app), request), idempotencyKey: idempotencyKeyFrom(request) }),
  )

  app.put('/quality/rules/results', { schema: saveResultsContract }, async (request) => saveResults(request, request.body, idempotencyKeyFrom(request)))

  app.get('/quality/alert-rules', { schema: alertRulesContract }, async (request) => listAlertRules(request, request.query))

  app.post('/quality/alert-rules', { schema: createAlertRuleContract }, async (request, reply) => reply.code(201).send(await createAlertRule(request, request.body, idempotencyKeyFrom(request))))

  app.post('/quality/alert-rules/starter', { schema: starterAlertRulesContract }, async (request) => addStarterAlertRules(request, idempotencyKeyFrom(request)))

  app.patch('/quality/alert-rules/:ruleId', { schema: editAlertRuleContract }, async (request) => editAlertRule(request, request.params.ruleId, request.body, idempotencyKeyFrom(request)))

  app.delete('/quality/alert-rules/:ruleId', { schema: deleteAlertRuleContract }, async (request) => deleteAlertRule(request, request.params.ruleId, request.query, idempotencyKeyFrom(request)))

  app.post('/quality/alert-rules/:ruleId/test', { schema: testAlertRuleContract }, async (request) => testAlertRule(request, request.params.ruleId, idempotencyKeyFrom(request)))
})
