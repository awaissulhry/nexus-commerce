import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { appClock } from '../../../platform/portal/tasks/clock'
import { counterBrandRequest, refuseBrandRequest } from './answer'
import { counterContract, impactContract, listContract, recordContract, refuseContract } from './contract'
import { manifest } from './manifest'
import { brandRequestImpact, brandRequestRecord, listBrandRequests } from './read'

/**
 * B-PR-26 — the factory answers its customers' requests (./manifest): the office's one read of every request (it feeds Home ›
 * Approvals' 'Customer request' source and review window; never a second answering page), the office impact, refuse with words,
 * counter. Accepting is the kind's own route (Sales' /sales/change-requests/:id/accept; B-PR-27a/b's POST …/:requestId/accept).
 */
export default defineRoutes('production.brand-requests', manifest, async (app) => {
  app.get('/production/brand-requests', { schema: listContract }, async (request) => listBrandRequests(request, request.query, appClock(app).now()))

  app.get('/production/brand-requests/:requestId', { schema: recordContract }, async (request) => brandRequestRecord(request, request.params.requestId, appClock(app).now()))

  app.get('/production/brand-requests/:requestId/impact', { schema: impactContract }, async (request) => brandRequestImpact(request, request.params.requestId, appClock(app).now()))

  app.post('/production/brand-requests/:requestId/refuse', { schema: refuseContract }, async (request) => refuseBrandRequest(request, request.params.requestId, request.body, idempotencyKeyFrom(request), appClock(app)))

  app.post('/production/brand-requests/:requestId/counter', { schema: counterContract }, async (request) => counterBrandRequest(request, request.params.requestId, request.body, idempotencyKeyFrom(request), appClock(app)))
})
