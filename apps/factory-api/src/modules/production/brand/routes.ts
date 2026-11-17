import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { clearHealthContract, getHealthContract, raiseHealthContract } from './contract'
import { clearBrandHealth, getBrandHealth, raiseBrandHealth } from './health'
import { manifest } from './manifest'

/**
 * The customer's production state of its orders, steered by the office (./manifest). The keeper (./keeper, a worker handler and a
 * nightly cron, no route) keeps the stage, health and waiting-on; B-PR-35 adds the factory's raise of the health (./health).
 */
export default defineRoutes('production.brand', manifest, async (app) => {
  app.get('/production/brand-orders/:orderId/health', { schema: getHealthContract }, async (request) => getBrandHealth(request, request.params.orderId))

  app.put('/production/brand-orders/:orderId/health', { schema: raiseHealthContract }, async (request) => raiseBrandHealth(request, request.params.orderId, request.body, idempotencyKeyFrom(request)))

  app.delete('/production/brand-orders/:orderId/health', { schema: clearHealthContract }, async (request) => clearBrandHealth(request, request.params.orderId, request.query.version, idempotencyKeyFrom(request)))
})
