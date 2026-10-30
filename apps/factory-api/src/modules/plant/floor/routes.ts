import { defineRoutes } from '../../../core/manifest'
import { floorJobsContract, floorMachineContract, floorMachinesContract } from '../contract'
import { floorJobs } from '../jobs/jobs'
import { floorMachine, floorMachines } from './floor'
import { manifest } from './manifest'

/** The station's machine screens and the technician's My jobs (B-W2a-35; ./floor.ts, ../jobs/jobs.ts floorJobs). Reads only. */
export default defineRoutes('plant.floor', manifest, async (app) => {
  app.get('/plant/floor/machines', { schema: floorMachinesContract }, async (request) => floorMachines(request, request.query))

  app.get('/plant/floor/machines/:machineId', { schema: floorMachineContract }, async (request) => floorMachine(request, request.params.machineId))

  app.get('/plant/floor/jobs', { schema: floorJobsContract }, async (request) => floorJobs(request))
})
