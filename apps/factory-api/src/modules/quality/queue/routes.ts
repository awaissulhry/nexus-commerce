import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { offlineContract, queueContract, recordContract, scanContract, startContract } from './contract'
import { manifest } from './manifest'
import { offlinePack } from './offline'
import { readQueue } from './queue'
import { recordOnline } from './record'
import { resolveScan, startFromScan } from './scan'

/**
 * My inspections (B-W2b-106): the inspector queue (./queue.ts), scan to start (./scan.ts), what a tablet keeps for offline
 * (./offline.ts) and the online try of a queued write under the tablet's client id (./record.ts; the floor-sync kinds
 * quality.final.record | quality.incoming.record | quality.inprocess.results apply the same function). The rules and words
 * are factory-domain quality/queue.
 */
export default defineRoutes('quality.queue', manifest, async (app) => {
  app.get('/quality/queue', { schema: queueContract }, async (request) => readQueue(request, request.query))

  app.get('/quality/queue/scan', { schema: scanContract }, async (request) => resolveScan(request, request.query))

  app.post('/quality/queue/scan', { schema: startContract }, async (request, reply) => {
    const answer = await startFromScan(request, request.body, idempotencyKeyFrom(request))
    return answer.started ? reply.code(201).send(answer) : reply.code(200).send(answer)
  })

  app.post('/quality/queue/record', { schema: recordContract }, async (request) => recordOnline(request, request.body))

  app.get('/quality/queue/offline', { schema: offlineContract }, async (request) => offlinePack(request))
})
