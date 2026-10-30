import { defineRoutes } from '../../../core/manifest'
import { officeDispatchContract, stationDispatchContract } from './contract'
import { officeDispatch, stationDispatch } from './dispatch'
import { manifest } from './manifest'

/**
 * The dispatch list per line or station (B-W2a-34; MES-021; design floor.mywork "Next" and "Then"): the published plan's
 * queue for a line, a work centre or a station, rush first, then due date, then sequence, each entry with where its work
 * stands from the floor's scans. The office reads any lane of its sites; a floor device its own station.
 */
export default defineRoutes('production.dispatch', manifest, async (app) => {
  app.get('/production/dispatch', { schema: officeDispatchContract }, async (request) => officeDispatch(request, request.query))
  app.get('/production/dispatch/station', { schema: stationDispatchContract }, async (request) => stationDispatch(request))
})
