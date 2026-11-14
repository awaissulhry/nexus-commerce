import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { archiveOverheadRuleContract, createOverheadRuleContract, inForceContract, listOverheadRulesContract, overheadRuleContract, updateOverheadRuleContract } from './contract'
import { manifest } from './manifest'
import { archiveOverheadRule, createOverheadRule, listOverheadRules, overheadInForce, overheadRuleRecord, updateOverheadRule } from './overhead-rules'

/**
 * Overhead absorption rules (B-W2b-419; FIN-007; design finance.settings › Costing): the rules per company (or every company),
 * basis, kind of work centre and whole months; the rules in force for a company's work of a kind on a day and the overhead
 * they absorb; add a rule (ending the one before it), correct, end or archive one. Every answer says the rules are
 * UNVERIFIED (GATE-ACCOUNTANT) and change no posted cost. A repeated Idempotency-Key answers from its receipt.
 */
export default defineRoutes('costing.overhead-rules', manifest, async (app) => {
  app.get('/costing/overhead-rules', { schema: listOverheadRulesContract }, async (request) => listOverheadRules(request, request.query))

  app.get('/costing/overhead-rules/in-force', { schema: inForceContract }, async (request) => overheadInForce(request, request.query))

  app.get('/costing/overhead-rules/:ruleId', { schema: overheadRuleContract }, async (request) => overheadRuleRecord(request, request.params.ruleId))

  app.post('/costing/overhead-rules', { schema: createOverheadRuleContract }, async (request, reply) => reply.code(201).send(await createOverheadRule(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/costing/overhead-rules/:ruleId', { schema: updateOverheadRuleContract }, async (request) => updateOverheadRule(request, request.params.ruleId, request.body, idempotencyKeyFrom(request)))

  app.post('/costing/overhead-rules/:ruleId/archive', { schema: archiveOverheadRuleContract }, async (request) => archiveOverheadRule(request, request.params.ruleId, request.body, idempotencyKeyFrom(request)))
})
