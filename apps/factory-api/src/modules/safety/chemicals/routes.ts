import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  addSheetContract,
  announceSheetContract,
  archiveContract,
  cabinetContract,
  cabinetsContract,
  choicesContract,
  completeSheetContract,
  countsContract,
  createContract,
  editContract,
  floorPackContract,
  floorSheetDownloadContract,
  libraryContract,
  listContract,
  recordContract,
  restoreContract,
  sheetDownloadContract,
} from './contract'
import { floorPack, floorSheetDownload } from './floor'
import { manifest } from './manifest'
import { cabinetSheet, chemicalChoices, chemicalCounts, chemicalRecord, downloadSheet, listCabinets, listChemicals, sheetLibrary } from './reads'
import { addChemical, addSheet, announceSheet, completeSheet, editChemical, setChemicalStatus } from './writes'

/**
 * The chemical register, the safety data sheet library and the cabinet QR (B-W2b-143; ./reads.ts, ./writes.ts, ./floor.ts).
 * Each write is one command with an Idempotency-Key; a repeated key answers from its receipt.
 */
export default defineRoutes('safety.chemicals', manifest, async (app) => {
  app.get('/safety/chemicals', { schema: listContract }, async (request) => listChemicals(request, request.query))
  app.get('/safety/chemicals/counts', { schema: countsContract }, async (request) => chemicalCounts(request, request.query))
  app.get('/safety/chemicals/data-sheets', { schema: libraryContract }, async (request) => sheetLibrary(request, request.query))
  app.get('/safety/chemicals/cabinets', { schema: cabinetsContract }, async (request) => listCabinets(request, request.query))
  app.get('/safety/chemicals/cabinets/:siteId/:code', { schema: cabinetContract }, async (request) => cabinetSheet(request, request.params.siteId, request.params.code))
  app.get('/safety/chemicals/choices', { schema: choicesContract }, async (request) => chemicalChoices(request, request.query))
  app.get('/safety/chemicals/:chemicalId', { schema: recordContract }, async (request) => chemicalRecord(request, request.params.chemicalId))
  app.post('/safety/chemicals', { schema: createContract }, async (request, reply) => {
    const answer = await addChemical(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })
  app.patch('/safety/chemicals/:chemicalId', { schema: editContract }, async (request) => editChemical(request, request.params.chemicalId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/chemicals/:chemicalId/archive', { schema: archiveContract }, async (request) => setChemicalStatus(request, request.params.chemicalId, 'ARCHIVED', request.body, idempotencyKeyFrom(request)))
  app.post('/safety/chemicals/:chemicalId/restore', { schema: restoreContract }, async (request) => setChemicalStatus(request, request.params.chemicalId, 'ACTIVE', request.body, idempotencyKeyFrom(request)))
  app.post('/safety/chemicals/:chemicalId/data-sheets/upload', { schema: announceSheetContract }, async (request, reply) => reply.code(201).send(await announceSheet(request, request.params.chemicalId, request.body, idempotencyKeyFrom(request))))
  app.post('/safety/chemicals/:chemicalId/data-sheets/upload/:fileId/complete', { schema: completeSheetContract }, async (request) => completeSheet(request, request.params.chemicalId, request.params.fileId, idempotencyKeyFrom(request)))
  app.post('/safety/chemicals/:chemicalId/data-sheets', { schema: addSheetContract }, async (request, reply) => {
    const answer = await addSheet(request, request.params.chemicalId, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })
  app.get('/safety/chemicals/:chemicalId/data-sheets/:sheetId/download', { schema: sheetDownloadContract }, async (request) => downloadSheet(request, request.params.chemicalId, request.params.sheetId))

  app.get('/safety/floor/chemicals', { schema: floorPackContract }, async (request) => floorPack(request))
  app.get('/safety/floor/data-sheets/:sheetId/download', { schema: floorSheetDownloadContract }, async (request) => floorSheetDownload(request, request.params.sheetId))
})
