import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  addProcessesContract,
  bundleProcessesContract,
  cancelProcessContract,
  cancelTrolleyContract,
  doneProcessContract,
  listProcessesContract,
  listTrolleysContract,
  loadTrolleyContract,
  openTrolleysContract,
  receiveTrolleyContract,
  scanTrolleyContract,
  sendTrolleyContract,
  startProcessContract,
  trolleyRecordContract,
  unloadTrolleyContract,
} from './contract'
import { manifest } from './manifest'
import { addProcesses, bundleProcesses, listProcesses, moveProcess } from './secondary'
import { cancelTrolley, listTrolleys, loadTrolley, openTrolleys, receiveTrolley, scanTrolley, sendTrolley, trolleyRecord, unloadTrolley } from './trolleys'

/**
 * After the cut, on the way to sewing (B-W2b-117; MES-047 secondary processes, MES-048 cut issue to sewing): a bundle's secondary
 * processes (./secondary.ts) and the trolleys that take bundles to a sewing line (./trolleys.ts). Every write is ONE command; a
 * repeated Idempotency-Key answers from its receipt. Recut tickets (MES-044) are in ../rework.
 */
export default defineRoutes('production.cutissue', manifest, async (app) => {
  app.get('/production/secondary-processes', { schema: listProcessesContract }, async (request) => listProcesses(request, request.query))
  app.get('/production/secondary-processes/bundle', { schema: bundleProcessesContract }, async (request) => bundleProcesses(request, request.query))
  app.post('/production/secondary-processes', { schema: addProcessesContract }, async (request, reply) => reply.code(201).send(await addProcesses(request, request.body, idempotencyKeyFrom(request))))
  app.post('/production/secondary-processes/:processId/start', { schema: startProcessContract }, async (request) => moveProcess(request, request.params.processId, 'start', request.body, idempotencyKeyFrom(request)))
  app.post('/production/secondary-processes/:processId/done', { schema: doneProcessContract }, async (request) => moveProcess(request, request.params.processId, 'done', request.body, idempotencyKeyFrom(request)))
  app.post('/production/secondary-processes/:processId/cancel', { schema: cancelProcessContract }, async (request) => moveProcess(request, request.params.processId, 'cancel', request.body, idempotencyKeyFrom(request)))

  app.get('/production/trolleys', { schema: listTrolleysContract }, async (request) => listTrolleys(request, request.query))
  app.get('/production/trolleys/open', { schema: openTrolleysContract }, async (request) => openTrolleys(request, request.query))
  app.get('/production/trolleys/scan', { schema: scanTrolleyContract }, async (request) => scanTrolley(request, request.query))
  app.get('/production/trolleys/:issueId', { schema: trolleyRecordContract }, async (request) => trolleyRecord(request, request.params.issueId))
  app.post('/production/trolleys/load', { schema: loadTrolleyContract }, async (request) => loadTrolley(request, request.body, idempotencyKeyFrom(request)))
  app.post('/production/trolleys/unload', { schema: unloadTrolleyContract }, async (request) => unloadTrolley(request, request.body, idempotencyKeyFrom(request)))
  app.post('/production/trolleys/send', { schema: sendTrolleyContract }, async (request) => sendTrolley(request, request.body, idempotencyKeyFrom(request)))
  app.post('/production/trolleys/receive', { schema: receiveTrolleyContract }, async (request) => receiveTrolley(request, request.body, idempotencyKeyFrom(request)))
  app.post('/production/trolleys/:issueId/cancel', { schema: cancelTrolleyContract }, async (request) => cancelTrolley(request, request.params.issueId, request.body, idempotencyKeyFrom(request)))
})
