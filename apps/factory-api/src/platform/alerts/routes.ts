import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { acknowledgeAlert, alertCounts, assignAlert, bulkAcknowledge, getAlert, listAlerts, resolveAlert, snoozeAlert } from './alerts'
import {
  acknowledgeContract,
  alertCountsContract,
  assignContract,
  bulkAcknowledgeContract,
  createRuleContract,
  getAlertContract,
  getRuleContract,
  listAlertsContract,
  listRulesContract,
  resolveContract,
  ruleTimersContract,
  snoozeContract,
  testRuleContract,
  updateRuleContract,
} from './contract'
import { manifest } from './manifest'
import { createRule, getRule, listRules, ruleTimers, testRule, updateRule } from './rules'

/**
 * Exception rules and stored alerts (B-W2a-33; ANA-036, PLT-100): the alerts with their tiles, one alert, acknowledge
 * (one, or the selection), assign, snooze, resolve with a note; the rules, one rule, a new one, a change, a dry run, a
 * DATE rule's timers. The engine (scheduler and worker) is ./engine.ts; the date timers are platform/timers.
 */
export default defineRoutes('alerts', manifest, async (app) => {
  app.get('/alerts', { schema: listAlertsContract }, async (request) => listAlerts(request, request.query))

  app.get('/alerts/counts', { schema: alertCountsContract }, async (request) => alertCounts(request, request.query))

  app.post('/alerts/acknowledge', { schema: bulkAcknowledgeContract }, async (request) => bulkAcknowledge(request, request.body, idempotencyKeyFrom(request)))

  app.get('/alerts/rules', { schema: listRulesContract }, async (request) => listRules(request, request.query))

  app.post('/alerts/rules', { schema: createRuleContract }, async (request, reply) => reply.code(201).send(await createRule(request, request.body, idempotencyKeyFrom(request))))

  app.get('/alerts/rules/:id', { schema: getRuleContract }, async (request) => getRule(request, request.params.id))

  app.put('/alerts/rules/:id', { schema: updateRuleContract }, async (request) => updateRule(request, request.params.id, request.body, idempotencyKeyFrom(request)))

  app.post('/alerts/rules/:id/test', { schema: testRuleContract }, async (request) => testRule(request, request.params.id, request.body))

  app.get('/alerts/rules/:id/timers', { schema: ruleTimersContract }, async (request) => ruleTimers(request, request.params.id))

  app.get('/alerts/:id', { schema: getAlertContract }, async (request) => getAlert(request, request.params.id))

  app.post('/alerts/:id/acknowledge', { schema: acknowledgeContract }, async (request) => acknowledgeAlert(request, request.params.id, request.body, idempotencyKeyFrom(request)))

  app.post('/alerts/:id/assign', { schema: assignContract }, async (request) => assignAlert(request, request.params.id, request.body, idempotencyKeyFrom(request)))

  app.post('/alerts/:id/snooze', { schema: snoozeContract }, async (request) => snoozeAlert(request, request.params.id, request.body, idempotencyKeyFrom(request)))

  app.post('/alerts/:id/resolve', { schema: resolveContract }, async (request) => resolveAlert(request, request.params.id, request.body, idempotencyKeyFrom(request)))
})
