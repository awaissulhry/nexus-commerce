import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { availabilityContract, listReservationsContract, releaseContract, reservationRecordContract, reserveContract } from './contract'
import { manifest } from './manifest'
import { availability, listReservations, reservationRecord } from './read'
import { release, reserve } from './reserve'

/**
 * Reservations (B-W2a-11; SCM-205 reserve to an order, SCM-209 reserve leather by area, SCM-210 release): stock of a
 * site held for one work order or one order line, only from what is available (on hand − held − reserved), released
 * with the reason; an issue to the work order counts against its own (modules/inventory/issue).
 */
export default defineRoutes('inventory.reservations', manifest, async (app) => {
  app.get('/inventory/reservations', { schema: listReservationsContract }, async (request) => listReservations(request, { ...request.query, statuses: request.query.status }))
  app.get('/inventory/reservations/availability', { schema: availabilityContract }, async (request) => availability(request, request.query))
  app.get('/inventory/reservations/:reservationId', { schema: reservationRecordContract }, async (request) => reservationRecord(request, request.params.reservationId))
  app.post('/inventory/reservations', { schema: reserveContract }, async (request, reply) => reply.code(201).send(await reserve(request, request.body, idempotencyKeyFrom(request))))
  app.post('/inventory/reservations/release', { schema: releaseContract }, async (request) => release(request, request.body, idempotencyKeyFrom(request)))
})
