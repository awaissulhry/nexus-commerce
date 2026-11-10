import { dispositionOf } from '@nexus/factory-domain/files/preview/rules'
import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { listBatches, recordBatch, recordShipmentVersions, unrecordedBatches } from './batches'
import {
  batchesContract,
  checkContract,
  coverageContract,
  createContract,
  editContract,
  getContract,
  listContract,
  makePackContract,
  packContract,
  packFileContract,
  pdfContract,
  previewContract,
  recordBatchContract,
  recordShipmentContract,
  refreshContract,
  translationsContract,
  translationStateContract,
  unrecordedContract,
  withdrawContract,
} from './contract'
import { createDeclaration, editDeclaration, previewDeclaration, refreshDeclaration, withdrawDeclaration } from './generate'
import { manifest } from './manifest'
import { makePack, packPdf, packView, packZip } from './pack'
import { declarationPdf, declarationsCoverage, getDeclaration, listDeclarations } from './read'
import { checkTranslation, moveTranslation, startTranslations } from './translations'

/**
 * The DoC generator (B-W2b-257; PRD-292 every Annex IX point from its source, PRD-293 translations from the phrase library
 * checked by a second person, PRD-295 which revision went with which batch, PRD-300 the shipment compliance pack). A generated
 * DoC is a draft until GATE-PPE-TEXTS: the signed PDF uploaded through W1 (modules/product/compliance) stays the live route.
 * The screens are B-W2b-268 (Declarations & instructions, SCR-052).
 */
export default defineRoutes('compliance.declarations', manifest, async (app) => {
  app.get('/compliance/declarations', { schema: listContract }, async (request) => listDeclarations(request, request.query))
  app.get('/compliance/declarations/coverage', { schema: coverageContract }, async (request) => declarationsCoverage(request, request.query))
  app.get('/compliance/declarations/preview', { schema: previewContract }, async (request) => previewDeclaration(request, request.query))
  app.post('/compliance/declarations', { schema: createContract }, async (request, reply) => reply.code(201).send(await createDeclaration(request, request.body, idempotencyKeyFrom(request))))

  app.get('/compliance/declarations/batches', { schema: batchesContract }, async (request) => listBatches(request, request.query))
  app.post('/compliance/declarations/batches', { schema: recordBatchContract }, async (request, reply) => reply.code(201).send(await recordBatch(request, request.body, idempotencyKeyFrom(request))))
  app.get('/compliance/declarations/batches/unrecorded', { schema: unrecordedContract }, async (request) => unrecordedBatches(request))
  app.post('/compliance/declarations/shipments/:shipmentId/versions', { schema: recordShipmentContract }, async (request) => recordShipmentVersions(request, request.params.shipmentId, idempotencyKeyFrom(request)))

  app.get('/compliance/declarations/shipments/:shipmentId/pack', { schema: packContract }, async (request) => packView(request, request.params.shipmentId))
  app.post('/compliance/declarations/shipments/:shipmentId/pack', { schema: makePackContract }, async (request, reply) => {
    const { status, pack } = await makePack(request, request.params.shipmentId, request.body ?? {}, idempotencyKeyFrom(request))
    return reply.code(status).send({ pack })
  })
  app.get('/compliance/declarations/shipments/:shipmentId/pack/:documentId/pdf', { schema: packFileContract }, async (request, reply) => {
    const { pdf, fileName } = await packPdf(request, request.params.shipmentId, request.params.documentId)
    return reply.type('application/pdf').header('content-disposition', dispositionOf('inline', fileName)).header('cache-control', 'no-store').send(pdf)
  })
  app.get('/compliance/declarations/shipments/:shipmentId/pack/:documentId/zip', { schema: packFileContract }, async (request, reply) => {
    const { zip, fileName } = await packZip(request, request.params.shipmentId, request.params.documentId)
    return reply.type('application/zip').header('content-disposition', dispositionOf('download', fileName)).header('cache-control', 'no-store').send(zip)
  })

  app.get('/compliance/declarations/:documentId', { schema: getContract }, async (request) => getDeclaration(request, request.params.documentId))
  app.get('/compliance/declarations/:documentId/pdf', { schema: pdfContract }, async (request, reply) => {
    const { pdf, fileName } = await declarationPdf(request, request.params.documentId)
    return reply.type('application/pdf').header('content-disposition', dispositionOf('inline', fileName)).header('cache-control', 'no-store').send(pdf)
  })
  app.patch('/compliance/declarations/:documentId', { schema: editContract }, async (request) => editDeclaration(request, request.params.documentId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/declarations/:documentId/refresh', { schema: refreshContract }, async (request) => refreshDeclaration(request, request.params.documentId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/declarations/:documentId/withdraw', { schema: withdrawContract }, async (request) => withdrawDeclaration(request, request.params.documentId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/declarations/:documentId/translations', { schema: translationsContract }, async (request, reply) => reply.code(201).send(await startTranslations(request, request.params.documentId, request.body, idempotencyKeyFrom(request))))
  app.post('/compliance/declarations/:documentId/translation-state', { schema: translationStateContract }, async (request) => moveTranslation(request, request.params.documentId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/declarations/:documentId/check', { schema: checkContract }, async (request) => checkTranslation(request, request.params.documentId, request.body, idempotencyKeyFrom(request)))
})
