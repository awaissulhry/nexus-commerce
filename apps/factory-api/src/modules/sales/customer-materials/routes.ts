import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { listCustomerMaterialsContract, planCustomerMaterialsContract, recountCustomerMaterialsContract } from './contract'
import { manifest } from './manifest'
import { listCustomerMaterials, planCustomerMaterials, recountCustomerMaterials } from './materials'

/** Customer-supplied materials of an order (B-W2b-309): ./materials.ts. */
export default defineRoutes('sales.customer-materials', manifest, async (app) => {
  app.get('/sales/orders/:orderId/customer-materials', { schema: listCustomerMaterialsContract }, async (request) => listCustomerMaterials(request, request.params.orderId))
  app.post('/sales/orders/:orderId/customer-materials/plan', { schema: planCustomerMaterialsContract }, async (request) => planCustomerMaterials(request, request.params.orderId, idempotencyKeyFrom(request)))
  app.post('/sales/orders/:orderId/customer-materials/recount', { schema: recountCustomerMaterialsContract }, async (request) => recountCustomerMaterials(request, request.params.orderId, idempotencyKeyFrom(request)))
})
