import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { setCustomerSupervisor, setOrderSupervisors, supervisorPickList } from './assign'
import { customerSupervisorContract, orderSupervisorsContract, pickListContract } from './contract'
import { manifest } from './manifest'

/**
 * The production supervisor (./manifest, B-PR-42a): the pick list, the customer's default and backup, an order's own (one or
 * many). The resolver other modules read is ./resolver (`supervisorOf`); the follows and the bell are B-PR-42b's worker.
 */
export default defineRoutes('production.supervisor', manifest, async (app) => {
  app.get('/production/supervisors', { schema: pickListContract }, async (request) => supervisorPickList(request, request.query))

  app.put('/production/brands/:partyId/supervisor', { schema: customerSupervisorContract }, async (request) => setCustomerSupervisor(request, request.params.partyId, request.body, idempotencyKeyFrom(request)))

  app.post('/production/orders/supervisor', { schema: orderSupervisorsContract }, async (request) => setOrderSupervisors(request, request.body, idempotencyKeyFrom(request)))
})
