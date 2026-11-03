import { defineRoutes } from '../../../core/manifest'
import { floorJobsContract, floorMachineContract, floorMachinesContract } from '../contract'
import { floorJobs } from '../jobs/jobs'
import { floorMachine, floorMachines } from './floor'
import { manifest } from './manifest'
// B-W2b-96
import { idempotencyKeyFrom } from '../../../core/command'
import { confirmJob } from '../jobs/confirm'
import { confirmJobContract, floorAcknowledgeContract, floorDownloadContract, floorRequestContract, onTheWayContract, stationRequestsContract, technicianQueueContract, worksAgainContract } from '../requests/contract-depth'
import { stepRequest } from '../requests/depth'
import { floorDownload } from '../requests/files'
import { floorRequest, stationRequests, technicianQueue } from './progress'

/** The station's machine screens and the technician's My jobs (B-W2a-35; ./floor.ts, ../jobs/jobs.ts floorJobs); B-W2b-96: a request's progress from the floor (./progress.ts, ../requests/depth.ts). */
export default defineRoutes('plant.floor', manifest, async (app) => {
  app.get('/plant/floor/machines', { schema: floorMachinesContract }, async (request) => floorMachines(request, request.query))

  app.get('/plant/floor/machines/:machineId', { schema: floorMachineContract }, async (request) => floorMachine(request, request.params.machineId))

  app.get('/plant/floor/jobs', { schema: floorJobsContract }, async (request) => floorJobs(request))

  // ---- B-W2b-96 -------------------------------------------------------------------------------------------------------
  app.get('/plant/floor/requests', { schema: stationRequestsContract }, async (request) => stationRequests(request))
  app.get('/plant/floor/requests/:requestId', { schema: floorRequestContract }, async (request) => floorRequest(request, request.params.requestId))
  app.get('/plant/floor/queue', { schema: technicianQueueContract }, async (request) => technicianQueue(request))
  app.post('/plant/floor/requests/:requestId/acknowledge', { schema: floorAcknowledgeContract }, async (request) => stepRequest(request, request.params.requestId, 'ACKNOWLEDGE', request.body, idempotencyKeyFrom(request)))
  app.post('/plant/floor/requests/:requestId/on-the-way', { schema: onTheWayContract }, async (request) => stepRequest(request, request.params.requestId, 'ON_THE_WAY', request.body, idempotencyKeyFrom(request)))
  app.post('/plant/floor/requests/:requestId/works', { schema: worksAgainContract }, async (request) => stepRequest(request, request.params.requestId, 'WORKS_AGAIN', request.body, idempotencyKeyFrom(request)))
  app.post('/plant/floor/jobs/:jobId/confirm', { schema: confirmJobContract }, async (request) => confirmJob(request, request.params.jobId, request.body, idempotencyKeyFrom(request)))
  app.get('/plant/floor/files/:fileId/download', { schema: floorDownloadContract }, async (request) => floorDownload(request, request.params.fileId))
})
