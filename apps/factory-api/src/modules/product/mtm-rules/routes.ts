import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { checkMeasures } from './check'
import { checkContract, getRulesContract, lineScaleContract, putRulesContract, switchRulesContract } from './contract'
import { manifest } from './manifest'
import { setLineScale } from './scale'
import { getRules, putRules, switchRules } from './template'

/**
 * Made-to-measure rules (product module, B-W2b-248; PRD-017, PRD-201, PRD-202, PRD-203, PRD-204): per measurement template
 * its plausibility rules, base size rule and alteration limits (read, saved whole, turned on or off: built off, GATE-MTM),
 * the one check of a rider's measures against a template or a style (./check.ts), and a draft BOM line marked to scale
 * (./scale.ts). The measurement link (B-W2b-171) runs the same rule check when a rider sends measures
 * (modules/sales/measure-link/checks.ts). No screen: the template and rider-profile pages (B-W1-17, B-W1-18) wait behind
 * GATE-MTM.
 */
export default defineRoutes('product.mtm-rules', manifest, async (app) => {
  app.get('/product/measurement-templates/:templateId/mtm-rules', { schema: getRulesContract }, async (request) => ({ rules: await getRules(request, request.params.templateId) }))
  app.put('/product/measurement-templates/:templateId/mtm-rules', { schema: putRulesContract }, async (request) => ({ rules: await putRules(request, request.params.templateId, request.body, idempotencyKeyFrom(request)) }))
  app.put('/product/measurement-templates/:templateId/mtm-rules/switch', { schema: switchRulesContract }, async (request) => ({ rules: await switchRules(request, request.params.templateId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/product/made-to-measure/check', { schema: checkContract }, async (request) => ({ check: await checkMeasures(request, request.body) }))
  app.put('/product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/mtm-scale', { schema: lineScaleContract }, async (request) =>
    setLineScale(request, request.params.styleId, request.params.revisionId, request.params.lineId, request.body, idempotencyKeyFrom(request)),
  )
})
