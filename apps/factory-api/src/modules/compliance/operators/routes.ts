import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { createOperatorContract, editOperatorContract, getOperatorContract, listOperatorsContract, resolveOperatorsContract } from './contract'
import { manifest } from './manifest'
import { createOperator, editOperator, getOperator, listOperators, resolveForStyle } from './operators'

/**
 * Economic operators per style and market (B-W2b-249; PRD-298): manufacturer, authorised representative, importer,
 * distributor, fulfilment, with the name and postal address as printed. The screen is B-W2b-265 (Rules & markets ›
 * Operators); labels, DoCs and the public DoC page's sender read who applies with `resolve`.
 */
export default defineRoutes('compliance.operators', manifest, async (app) => {
  app.get('/compliance/rules/operators', { schema: listOperatorsContract }, async (request) => listOperators(request, request.query))
  app.get('/compliance/rules/operators/resolve', { schema: resolveOperatorsContract }, async (request) => resolveForStyle(request, request.query))
  app.post('/compliance/rules/operators', { schema: createOperatorContract }, async (request) => createOperator(request, request.body, idempotencyKeyFrom(request)))
  app.get('/compliance/rules/operators/:operatorId', { schema: getOperatorContract }, async (request) => getOperator(request, request.params.operatorId))
  app.patch('/compliance/rules/operators/:operatorId', { schema: editOperatorContract }, async (request) => editOperator(request, request.params.operatorId, request.body, idempotencyKeyFrom(request)))
})
