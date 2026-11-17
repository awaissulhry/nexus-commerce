import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { clearHealthContract, customerUrgencyContract, getHealthContract, raiseHealthContract, setBackUrgencyContract, unlockUrgencyContract } from './contract'
import { clearBrandHealth, getBrandHealth, raiseBrandHealth } from './health'
import { manifest } from './manifest'
import { customerUrgencyCard, setBackUrgency, unlockUrgency } from './urgency'

/**
 * The customer's production state of its orders, steered by the office (./manifest). The keeper (./keeper, a worker handler and a
 * nightly cron, no route) keeps the stage, health and waiting-on; B-PR-35 adds the factory's raise of the health (./health); B-PR-22b
 * the customer's urgency as the office steers it (./urgency).
 */
export default defineRoutes('production.brand', manifest, async (app) => {
  app.get('/production/brand-orders/:orderId/health', { schema: getHealthContract }, async (request) => getBrandHealth(request, request.params.orderId))

  app.put('/production/brand-orders/:orderId/health', { schema: raiseHealthContract }, async (request) => raiseBrandHealth(request, request.params.orderId, request.body, idempotencyKeyFrom(request)))

  app.delete('/production/brand-orders/:orderId/health', { schema: clearHealthContract }, async (request) => clearBrandHealth(request, request.params.orderId, request.query.version, idempotencyKeyFrom(request)))

  // B-PR-22b: the customer's urgency as the office steers it (./urgency.ts).
  app.get('/production/brands/:partyId/urgency', { schema: customerUrgencyContract }, async (request) => customerUrgencyCard(request, request.params.partyId))

  app.post('/production/brand-orders/urgency/regular', { schema: setBackUrgencyContract }, async (request) => setBackUrgency(officeAuthOf(app), request, request.body, idempotencyKeyFrom(request)))

  app.post('/production/brand-orders/urgency/unlock', { schema: unlockUrgencyContract }, async (request) => unlockUrgency(officeAuthOf(app), request, request.body, idempotencyKeyFrom(request)))
})
