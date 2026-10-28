import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { archiveLocationContract, createLocationContract, listLocationsContract, moveLocationContract, updateLocationContract } from './contract'
import { archiveLocation, createLocation, listLocations, moveLocation, updateLocation } from './locations'
import { manifest } from './manifest'

/**
 * The locations of each site (B-W1-22; SCM-176, SCM-177, SCM-178): the tree per site, and create, rename, move and
 * archive (only when empty). The locations import is importer.ts (platform/imports registry).
 */
export default defineRoutes('inventory.locations', manifest, async (app) => {
  app.get('/inventory/locations', { schema: listLocationsContract }, async (request) => listLocations(request, request.query))

  app.post('/inventory/locations', { schema: createLocationContract }, async (request, reply) =>
    reply.code(201).send({ location: await createLocation(request, request.body, idempotencyKeyFrom(request)) }),
  )

  app.patch('/inventory/locations/:locationId', { schema: updateLocationContract }, async (request) => ({
    location: await updateLocation(request, request.params.locationId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/inventory/locations/:locationId/move', { schema: moveLocationContract }, async (request) => ({
    location: await moveLocation(request, request.params.locationId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/inventory/locations/:locationId/archive', { schema: archiveLocationContract }, async (request) => ({
    location: await archiveLocation(request, request.params.locationId, request.body, idempotencyKeyFrom(request)),
  }))
})
