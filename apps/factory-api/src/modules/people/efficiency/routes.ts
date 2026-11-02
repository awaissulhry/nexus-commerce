import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { cycleTimeContract, decideContract, operationDetailContract, operationsContract, overviewContract, personFiguresContract, reviewQueueContract, trendContract } from './contract'
import { overview, trend } from './lines'
import { manifest } from './manifest'
import { cycleTime, listOperations, operationDetail } from './operations'
import { personFigures } from './person'
import { decide, reviewQueue } from './review'

/**
 * Efficiency (B-W2b-44): line figures (./lines.ts), planned against actual and cycle time per operation (./operations.ts),
 * the standard review (./review.ts), one person's figures behind the legal gate (./person.ts).
 */
export default defineRoutes('people.efficiency', manifest, async (app) => {
  app.get('/people/efficiency', { schema: overviewContract }, async (request) => overview(request, request.query))
  app.get('/people/efficiency/trend', { schema: trendContract }, async (request) => trend(request, request.query))
  app.get('/people/efficiency/operations', { schema: operationsContract }, async (request) => listOperations(request, request.query))
  app.get('/people/efficiency/operations/:routingOperationId', { schema: operationDetailContract }, async (request) => operationDetail(request, request.params.routingOperationId, request.query))
  app.get('/people/efficiency/cycle-time', { schema: cycleTimeContract }, async (request) => cycleTime(request, request.query))
  app.get('/people/efficiency/review', { schema: reviewQueueContract }, async (request) => reviewQueue(request, request.query))
  app.post('/people/efficiency/review/:routingOperationId/decide', { schema: decideContract }, async (request) => decide(request, request.params.routingOperationId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/efficiency/people/:employeeId/figures', { schema: personFiguresContract }, async (request) => personFigures(request, request.params.employeeId, request.body, idempotencyKeyFrom(request)))
})
