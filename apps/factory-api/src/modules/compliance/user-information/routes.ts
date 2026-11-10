import { dispositionOf } from '@nexus/factory-domain/files/preview/rules'
import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  batchesContract,
  checkContract,
  createContract,
  editContract,
  getContract,
  packsContract,
  pdfContract,
  previewContract,
  refreshContract,
  translationsContract,
  translationStateContract,
  withdrawContract,
} from './contract'
import { createLeaflet, editLeaflet, previewLeaflet, refreshLeaflet, withdrawLeaflet } from './generate'
import { manifest } from './manifest'
import { getLeaflet, leafletBatches, leafletPacks, leafletPdf } from './read'
import { checkTranslation, moveTranslation, startTranslations } from './translations'

/**
 * The user information builder (B-W2b-258; PRD-350 the leaflet from Annex II 1.4 sections filled from the records, PRD-351
 * language packs per market from the phrase library, PRD-352 the version per batch, PRD-353 the protector position and fit,
 * PRD-354 the compatible spare protectors). A generated leaflet is a draft until GATE-PPE-TEXTS: the signed leaflet uploaded
 * through W1 (modules/product/compliance) stays the live route, and W1 packs it. The screens are B-W2b-268 (Declarations &
 * instructions, SCR-052).
 */
export default defineRoutes('compliance.user-information', manifest, async (app) => {
  app.get('/compliance/user-information/preview', { schema: previewContract }, async (request) => previewLeaflet(request, request.query))
  app.post('/compliance/user-information', { schema: createContract }, async (request, reply) => reply.code(201).send(await createLeaflet(request, request.body, idempotencyKeyFrom(request))))
  app.get('/compliance/user-information/packs', { schema: packsContract }, async (request) => leafletPacks(request, request.query))
  app.get('/compliance/user-information/batches', { schema: batchesContract }, async (request) => leafletBatches(request, request.query))

  app.get('/compliance/user-information/:documentId', { schema: getContract }, async (request) => getLeaflet(request, request.params.documentId))
  app.get('/compliance/user-information/:documentId/pdf', { schema: pdfContract }, async (request, reply) => {
    const { pdf, fileName } = await leafletPdf(request, request.params.documentId)
    return reply.type('application/pdf').header('content-disposition', dispositionOf('inline', fileName)).header('cache-control', 'no-store').send(pdf)
  })
  app.patch('/compliance/user-information/:documentId', { schema: editContract }, async (request) => editLeaflet(request, request.params.documentId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/user-information/:documentId/refresh', { schema: refreshContract }, async (request) => refreshLeaflet(request, request.params.documentId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/user-information/:documentId/withdraw', { schema: withdrawContract }, async (request) => withdrawLeaflet(request, request.params.documentId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/user-information/:documentId/translations', { schema: translationsContract }, async (request, reply) => reply.code(201).send(await startTranslations(request, request.params.documentId, request.body, idempotencyKeyFrom(request))))
  app.post('/compliance/user-information/:documentId/translation-state', { schema: translationStateContract }, async (request) => moveTranslation(request, request.params.documentId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/user-information/:documentId/check', { schema: checkContract }, async (request) => checkTranslation(request, request.params.documentId, request.body, idempotencyKeyFrom(request)))
})
