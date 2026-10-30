import { defineRoutes } from '../../../core/manifest'
import { plantPlacesContract, plantTechniciansContract } from '../contract'
import { manifest } from './manifest'
import { plantPlaces, plantTechnicians } from './office'

/** The plant screens' pickers (B-W2a-53; ./office.ts). Reads only. */
export default defineRoutes('plant.office', manifest, async (app) => {
  app.get('/plant/places', { schema: plantPlacesContract }, async (request) => plantPlaces(request))

  app.get('/plant/technicians', { schema: plantTechniciansContract }, async (request) => plantTechnicians(request, request.query.siteId))
})
