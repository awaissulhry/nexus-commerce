import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { testAccount } from '../connections/test'
import { dismissErrorContract, getErrorContract, listErrorsContract, reconnectAccountContract, retryErrorContract, testAccountContract } from './contract'
import { dismissError, getError, listErrors, retryError } from './errors'
import { manifest } from './manifest'

/**
 * Integration health (B-W2b-415; PLT-196, PLT-201):
 *   GET  /integrations/errors                         the error queue (view open | retried | dismissed | all), newest failure first
 *   GET  /integrations/errors/:itemId                 one failed message: what failed in its source's words, who retried or dismissed it
 *   POST /integrations/errors/:itemId/retry           sent again once (held ones answer 409 in words)
 *   POST /integrations/errors/:itemId/dismiss         nothing more is done; kept with who, when and why
 *   POST /integrations/accounts/:accountId/test       one harmless call through the gateway (connections/test.ts)
 *   POST /integrations/accounts/:accountId/reconnect  its circuit closed, then the same test call
 */
export default defineRoutes('admin-integration-health', manifest, async (app) => {
  app.get('/integrations/errors', { schema: listErrorsContract }, async (request) =>
    listErrors(request, { view: request.query.view, source: request.query.source, before: request.query.before, limit: request.query.limit }),
  )
  app.get('/integrations/errors/:itemId', { schema: getErrorContract }, async (request) => getError(request, request.params.itemId))
  app.post('/integrations/errors/:itemId/retry', { schema: retryErrorContract }, async (request) => ({ item: await retryError(request, request.params.itemId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/integrations/errors/:itemId/dismiss', { schema: dismissErrorContract }, async (request) => ({ item: await dismissError(request, request.params.itemId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/integrations/accounts/:accountId/test', { schema: testAccountContract }, async (request) => ({ test: await testAccount(request, request.params.accountId, { reconnect: false }) }))
  app.post('/integrations/accounts/:accountId/reconnect', { schema: reconnectAccountContract }, async (request) => ({
    test: await testAccount(request, request.params.accountId, { reconnect: true, idempotencyKey: idempotencyKeyFrom(request) }),
  }))
})
