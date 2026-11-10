import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  createRuleContract,
  createSubstanceContract,
  createVersionContract,
  editRuleContract,
  editSubstanceContract,
  editVersionContract,
  evaluateMaterialsContract,
  getRuleContract,
  getSubstanceContract,
  listRulesContract,
  listSubstancesContract,
  listVersionsContract,
  loadStarterContract,
  materialEvaluationContract,
  styleEvaluationContract,
  switchRuleContract,
} from './contract'
import { evaluateMaterials, materialEvaluation, styleEvaluation } from './evaluation'
import { createSubstance, editSubstance, getSubstance, listSubstances, loadStarter } from './list'
import { manifest } from './manifest'
import { createRule, editRule, getRule, listRules, switchRule } from './rule-book'
import { createVersion, editVersion, listVersions } from './versions'

const flag = (value: 'true' | 'false' | undefined): boolean | undefined => (value === undefined ? undefined : value === 'true')

/**
 * Restricted substances and their rules (B-W2b-250; PRD-318, PRD-320 … PRD-326, PRD-329): the substance list with the
 * starter list and two imports (platform/imports: compliance.substances, compliance.substanceRules), the rules with their
 * switch, the Candidate List versions, and the evaluator per material (written into its compliance profile) and per style
 * (with the SVHC roll-up per component). The screens are B-W2b-267 (Compliance › Tests & substances: Substance list,
 * Material profiles).
 */
export default defineRoutes('compliance.substances', manifest, async (app) => {
  app.get('/compliance/substances', { schema: listSubstancesContract }, async (request) => listSubstances(request, request.query))
  app.post('/compliance/substances', { schema: createSubstanceContract }, async (request) => createSubstance(request, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/substances/starter', { schema: loadStarterContract }, async (request) => loadStarter(request, idempotencyKeyFrom(request)))

  app.get('/compliance/substances/rules', { schema: listRulesContract }, async (request) => listRules(request, { ...request.query, switchedOn: flag(request.query.switchedOn) }))
  app.post('/compliance/substances/rules', { schema: createRuleContract }, async (request) => createRule(request, request.body, idempotencyKeyFrom(request)))
  app.get('/compliance/substances/rules/:ruleId', { schema: getRuleContract }, async (request) => getRule(request, request.params.ruleId))
  app.patch('/compliance/substances/rules/:ruleId', { schema: editRuleContract }, async (request) => editRule(request, request.params.ruleId, request.body, idempotencyKeyFrom(request)))
  app.put('/compliance/substances/rules/:ruleId/switch', { schema: switchRuleContract }, async (request) => switchRule(request, request.params.ruleId, request.body, idempotencyKeyFrom(request)))

  app.get('/compliance/substances/svhc-versions', { schema: listVersionsContract }, async (request) => listVersions(request))
  app.post('/compliance/substances/svhc-versions', { schema: createVersionContract }, async (request) => createVersion(request, request.body, idempotencyKeyFrom(request)))
  app.patch('/compliance/substances/svhc-versions/:versionId', { schema: editVersionContract }, async (request) => editVersion(request, request.params.versionId, request.body, idempotencyKeyFrom(request)))

  app.get('/compliance/substances/materials/:materialId/evaluation', { schema: materialEvaluationContract }, async (request) => materialEvaluation(request, request.params.materialId, request.query))
  app.post('/compliance/substances/materials/evaluate', { schema: evaluateMaterialsContract }, async (request) => evaluateMaterials(request, request.body, idempotencyKeyFrom(request)))
  app.get('/compliance/substances/styles/:styleId/evaluation', { schema: styleEvaluationContract }, async (request) => styleEvaluation(request, request.params.styleId, request.query))

  app.get('/compliance/substances/:substanceId', { schema: getSubstanceContract }, async (request) => getSubstance(request, request.params.substanceId))
  app.patch('/compliance/substances/:substanceId', { schema: editSubstanceContract }, async (request) => editSubstance(request, request.params.substanceId, request.body, idempotencyKeyFrom(request)))
})
