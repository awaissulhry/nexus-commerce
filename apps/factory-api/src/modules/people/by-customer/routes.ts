import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { everyCustomer, giveToCustomer, peopleByCustomer, setExtraRight } from './by-customer'
import { everyCustomerContract, extraRightContract, giveToCustomerContract, peopleByCustomerContract } from './contract'
import { manifest } from './manifest'

/** owb-of2: People by customer (./by-customer.ts) — the pool of office people per customer and the extra rights. */
export default defineRoutes('people.by-customer', manifest, async (app) => {
  app.get('/people/by-customer', { schema: peopleByCustomerContract }, async (request) => peopleByCustomer(request))
  // The extra rights before /:partyId/:userId (a static segment wins anyway; kept first to read clearly).
  app.put('/people/by-customer/extra/:userId', { schema: extraRightContract }, async (request) => setExtraRight(app, request, request.params.userId, request.body))
  app.put('/people/by-customer/:partyId/:userId', { schema: giveToCustomerContract }, async (request) => giveToCustomer(request, request.params.partyId, request.params.userId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/by-customer/every-customer', { schema: everyCustomerContract }, async (request) => everyCustomer(request, request.body, idempotencyKeyFrom(request)))
})
