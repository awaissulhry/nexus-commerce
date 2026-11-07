import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { createMachineContract, listMachinesContract, machineCountsContract, machineRecordContract, retireMachineContract, updateMachineContract } from '../contract'
import {
  announceDocumentContract,
  attentionContract,
  changeStatusContract,
  completeDocumentContract,
  depthContract,
  documentsContract,
  downloadDocumentContract,
  historyContract,
  printTagsContract,
  removeDocumentContract,
  tagJobsContract,
  tagPrintersContract,
  wallContract,
} from './contract-depth'
import { announceDocument, completeDocument, downloadDocument, listDocuments, removeDocument } from './documents'
import { createMachine, listMachines, machineCounts, machineRecord, retireMachine, updateMachine } from './machines'
import { manifest } from './manifest'
import { machineDepth, machinesNeeding, statusWall } from './reads'
import { changeStatus, statusHistory } from './status'
import { printTags, tagJobs, tagPrinters } from './tags'

/** The machine and equipment register (B-W2a-35; ./machines.ts) and machines in depth (B-W2b-136). Each write is one command with an Idempotency-Key. */
export default defineRoutes('plant.machines', manifest, async (app) => {
  app.get('/plant/machines', { schema: listMachinesContract }, async (request) => listMachines(request, request.query))

  app.get('/plant/machines/counts', { schema: machineCountsContract }, async (request) => machineCounts(request, request.query))

  // B-W2b-136: the register's depth, the tiles as filters, the status wall (static paths before :machineId).
  app.get('/plant/machines/depth', { schema: depthContract }, async (request) => machineDepth(request, request.query))
  app.get('/plant/machines/attention', { schema: attentionContract }, async (request) => machinesNeeding(request, request.query))
  app.get('/plant/machines/wall', { schema: wallContract }, async (request) => statusWall(request, request.query))
  app.get('/plant/machines/tags/printers', { schema: tagPrintersContract }, async (request) => tagPrinters(request, request.query))
  app.post('/plant/machines/tags/print', { schema: printTagsContract }, async (request) => printTags(request, request.body, idempotencyKeyFrom(request)))
  app.get('/plant/machines/tags/jobs', { schema: tagJobsContract }, async (request) => tagJobs(request, request.query))

  app.get('/plant/machines/:machineId', { schema: machineRecordContract }, async (request) => machineRecord(request, request.params.machineId))

  app.post('/plant/machines', { schema: createMachineContract }, async (request, reply) => {
    const { replayed, ...answer } = await createMachine(request, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send(answer)
  })

  app.patch('/plant/machines/:machineId', { schema: updateMachineContract }, async (request) => updateMachine(request, request.params.machineId, request.body, idempotencyKeyFrom(request)))

  app.post('/plant/machines/:machineId/retire', { schema: retireMachineContract }, async (request) => retireMachine(request, request.params.machineId, request.body, idempotencyKeyFrom(request)))

  // B-W2b-136: Change status (a release from do-not-use asks the technician's fresh code), the history, Documents & CE.
  app.post('/plant/machines/:machineId/status', { schema: changeStatusContract }, async (request) =>
    changeStatus(request, request.params.machineId, request.body, () => requireStepUp(officeAuthOf(app), request), idempotencyKeyFrom(request)),
  )
  app.get('/plant/machines/:machineId/status-history', { schema: historyContract }, async (request) => statusHistory(request, request.params.machineId, request.query))
  app.get('/plant/machines/:machineId/documents', { schema: documentsContract }, async (request) => listDocuments(request, request.params.machineId))
  app.post('/plant/machines/:machineId/documents', { schema: announceDocumentContract }, async (request, reply) => reply.code(201).send(await announceDocument(request, request.params.machineId, request.body, idempotencyKeyFrom(request))))
  app.post('/plant/machines/:machineId/documents/:fileId/complete', { schema: completeDocumentContract }, async (request) => completeDocument(request, request.params.machineId, request.params.fileId, idempotencyKeyFrom(request)))
  app.get('/plant/machines/:machineId/documents/:fileId/download', { schema: downloadDocumentContract }, async (request) => downloadDocument(request, request.params.machineId, request.params.fileId))
  app.post('/plant/machines/:machineId/documents/:fileId/remove', { schema: removeDocumentContract }, async (request) => removeDocument(request, request.params.machineId, request.params.fileId, request.body, idempotencyKeyFrom(request)))
})
