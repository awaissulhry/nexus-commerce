import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { processFiles } from '../../../platform/files/service'
import { registerLinkRenewer } from '../../../platform/links/renew'
import { deleteAfterContract, makeLinkContract, measurePageContract, noticeContract, openPhotoContract, photoContract, photoDoneContract, photoPreviewContract, sendContract, sentContract } from './contract'
import { announceMeasurePhoto, completeMeasurePhoto, measurePage, previewMeasurePhoto, readNotice, renewMeasureLink, sendMeasurements } from './link'
import { manifest } from './manifest'
import { measurementsSent, openMeasurementPhoto, sendMeasureLink, setPhotosDeleteAfter } from './office'

/**
 * Measurements by link (B-W2b-171; SAL-096 the measurement form link, SAL-286 measurement photos; design links.measure,
 * SCR-195): the rider's page (./link.ts) and the office's side (./office.ts); the photos' retention is the scheduler's
 * (./retention.ts, background.ts).
 */

// B-W2b-163's "Ask for a new link" for a dead measurement link (module scope: once per process, as the platform's own map).
registerLinkRenewer('MEASUREMENTS', 'MeasurementProfile', renewMeasureLink)

export default defineRoutes('measure-link', manifest, async (app) => {
  // ---- the link ----------------------------------------------------------------------------------------------------------
  app.get('/link/measure', { schema: measurePageContract }, async (request) => measurePage(app, request, request.query.language))
  app.post('/link/measure/notice', { schema: noticeContract }, async (request) => readNotice(request, request.body))
  app.post('/link/measure/photos', { schema: photoContract }, async (request, reply) => reply.code(201).send(await announceMeasurePhoto(processFiles(), request, request.body, idempotencyKeyFrom(request))))
  app.post('/link/measure/photos/:fileId/complete', { schema: photoDoneContract }, async (request) => completeMeasurePhoto(processFiles(), request, request.params.fileId, idempotencyKeyFrom(request)))
  app.get('/link/measure/photos/:fileId/preview', { schema: photoPreviewContract }, async (request) => previewMeasurePhoto(processFiles(), request, request.params.fileId))
  app.post('/link/measure', { schema: sendContract }, async (request, reply) => reply.code(201).send(await sendMeasurements(processFiles(), app, request, request.body)))

  // ---- the office --------------------------------------------------------------------------------------------------------
  app.post('/sales/measure-links', { schema: makeLinkContract }, async (request, reply) => reply.code(201).send(await sendMeasureLink(request, request.body)))
  app.get('/sales/measurement-profiles/:profileId/sent', { schema: sentContract }, async (request) => measurementsSent(request, request.params.profileId))
  app.post('/sales/measurement-profiles/:profileId/photos/:fileId/open', { schema: openPhotoContract }, async (request) => openMeasurementPhoto(processFiles(), request, request.params.profileId, request.params.fileId))
  app.post('/sales/measurement-profiles/:profileId/photos-delete-after', { schema: deleteAfterContract }, async (request) => setPhotosDeleteAfter(request, request.params.profileId, request.body))
})
