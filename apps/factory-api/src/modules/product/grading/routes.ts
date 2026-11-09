import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { applyGrade, previewGrade } from './apply'
import { applyGradeContract, createRuleContract, getRuleContract, listRulesContract, previewGradeContract, ruleStatusContract, ruleStepsContract, scaleRulesContract, updateRuleContract } from './contract'
import { createRule, getRule, listRules, saveSteps, scaleRules, setRuleStatus, updateRule } from './library'
import { manifest } from './manifest'

/**
 * Grade rules and grading (product module, B-W2b-224; PRD-049, PRD-051, PRD-052; design products.sizes "Grade rules" and
 * the Grade rule pop-up, the size scale's Grade rules tab, products.styles "Apply grade rule"): the increments per point
 * of measure between the sizes of a scale (one dimension, or size and fit), and a style's measurement spec graded from
 * its base size by a rule, typed values kept unless the person chooses to overwrite them.
 */
export default defineRoutes('product.grading', manifest, async (app) => {
  app.get('/product/grade-rules', { schema: listRulesContract }, async (request) => listRules(request, request.query))
  app.post('/product/grade-rules', { schema: createRuleContract }, async (request, reply) => reply.code(201).send({ rule: await createRule(request, request.body, idempotencyKeyFrom(request)) }))
  app.get('/product/grade-rules/:ruleId', { schema: getRuleContract }, async (request) => ({ rule: await getRule(request, request.params.ruleId) }))
  app.patch('/product/grade-rules/:ruleId', { schema: updateRuleContract }, async (request) => ({ rule: await updateRule(request, request.params.ruleId, request.body, idempotencyKeyFrom(request)) }))
  app.put('/product/grade-rules/:ruleId/steps', { schema: ruleStepsContract }, async (request) => ({ rule: await saveSteps(request, request.params.ruleId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/product/grade-rules/status', { schema: ruleStatusContract }, async (request) => setRuleStatus(request, request.body, idempotencyKeyFrom(request)))
  app.get('/product/size-scales/:scaleId/grade-rules', { schema: scaleRulesContract }, async (request) => scaleRules(request, request.params.scaleId))
  app.post('/product/styles/:styleId/revisions/:revisionId/measurement-spec/grade/preview', { schema: previewGradeContract }, async (request) => ({
    preview: await previewGrade(request, request.params.styleId, request.params.revisionId, request.body),
  }))
  app.post('/product/styles/:styleId/revisions/:revisionId/measurement-spec/grade', { schema: applyGradeContract }, async (request) =>
    applyGrade(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)),
  )
})
