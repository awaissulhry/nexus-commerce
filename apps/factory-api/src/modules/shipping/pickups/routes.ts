import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { bookPickupContract, getPickupContract, listPickupsContract, movePickupContract, pickupDraftContract } from './contract'
import { manifest } from './manifest'
import { bookPickup, getPickup, listPickups, movePickup, pickupDraft } from './pickups'

/**
 * Carrier pickups (B-W2b-395; LOG-048): the list (and what comes on a day), the "Book a pickup" pop-up's start, one pickup,
 * the booking (through Sendcloud, the TEST pickup of test mode, or kept as booked by phone) and the moves after it.
 */
export default defineRoutes('shipping.pickups', manifest, async (app) => {
  app.get('/shipping/pickups', { schema: listPickupsContract }, async (request) => listPickups(request, request.query))

  app.get('/shipping/pickups/draft', { schema: pickupDraftContract }, async (request) => pickupDraft(request, request.query))

  app.get('/shipping/pickups/:pickupId', { schema: getPickupContract }, async (request) => getPickup(request, request.params.pickupId))

  app.post('/shipping/pickups', { schema: bookPickupContract }, async (request, reply) => reply.code(201).send(await bookPickup(request, request.body, idempotencyKeyFrom(request))))

  app.post('/shipping/pickups/:pickupId/status', { schema: movePickupContract }, async (request) => movePickup(request, request.params.pickupId, request.body, idempotencyKeyFrom(request)))
})
