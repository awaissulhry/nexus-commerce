import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { catalogueComposition } from '../../sales/portal-ordering/composition'
import { catalogueCompositionContract, styleChecksContract, switchContract, switchesContract, vocabularyContract } from './contract'
import { manifest } from './manifest'
import { styleChecks, vocabulary } from './read'
import { listSwitches, switchRule } from './switches'

/**
 * The textile, leather and origin checks (B-W2b-208; PRD-338 composition from the BOM, PRD-339 the animal-origin phrase,
 * PRD-340 the 80 % threshold, PRD-341 fibre names before purchase, PRD-342 the care label, PRD-344 Made in Italy, PRD-345
 * leather naming). The screens are B-W2b-270 (Labels & marking in depth: the builder's computed composition, the Rule
 * checks, the style's composition); the customer's catalogue page reads the fibres of a style here.
 */
export default defineRoutes('compliance.textile-rules', manifest, async (app) => {
  app.get('/compliance/textile-rules/styles/:styleId', { schema: styleChecksContract }, async (request) => ({ checks: await styleChecks(request, request.params.styleId, request.query) }))
  app.get('/compliance/textile-rules/switches', { schema: switchesContract }, async (request) => listSwitches(request))
  app.put('/compliance/textile-rules/switches/:rule', { schema: switchContract }, async (request) => switchRule(request, request.params.rule, request.body, idempotencyKeyFrom(request)))
  app.get('/compliance/textile-rules/vocabulary', { schema: vocabularyContract }, async (request) => ({ vocabulary: vocabulary(request) }))

  // PRD-341 (Reg. (EU) 1007/2011 art. 16(1)): the fibres in the customer's catalogue, before the order.
  app.get('/portal/catalogue/:styleId/composition', { schema: catalogueCompositionContract }, async (request) => ({ composition: await catalogueComposition(app, request, request.params.styleId, request.query) }))
})
