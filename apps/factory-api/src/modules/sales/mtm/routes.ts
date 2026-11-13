import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  getProfileContract,
  listProfilesContract,
  listWorksheetsContract,
  makeWorksheetContract,
  newProfileContract,
  newRevisionContract,
  openWorksheetContract,
  orderUnitsContract,
  repeatContract,
  repeatReadContract,
  reviewContract,
} from './contract'
import { manifest } from './manifest'
import { getProfile, listProfiles, recordProfile, recordRevision } from './profiles'
import { orderUnits, repeatFacts, repeatOrder } from './repeat'
import { reviewProfile } from './review'
import { listWorksheets, makeWorksheet, openWorksheet } from './worksheet'
// B-W2b-371: the office's and the fittings' photos, where a template is used.
import {
  announceFittingPhotoContract,
  announceProfilePhotoContract,
  completeFittingPhotoContract,
  completeProfilePhotoContract,
  dateFittingPhotoContract,
  dateProfilePhotoContract,
  listPhotosContract,
  openPhotoContract,
} from './photos/contract'
import { announceFittingPhoto, announceProfilePhoto, completeFittingPhoto, completeProfilePhoto, dateFittingPhoto, dateProfilePhoto, listPhotos, openMtmPhoto } from './photos/photos'
import { whereUsedContract } from './where-used/contract'
import { templateWhereUsed } from './where-used/where-used'

/**
 * The made-to-measure office (sales module, B-W2b-358; B-W1-17 and B-W1-18, deferred on 10-28, come back with it; SAL-276,
 * SAL-291, SAL-292, SAL-300, SAL-303; design sales.mtm, SCR-036, drawn by B-W2b-362): rider profiles with their revisions, who
 * measured and where (./profiles.ts), the factory review (./review.ts), a repeat order from the newest profile and an order's
 * units (./repeat.ts), the worksheet and order form PDF (./worksheet.ts). The quote's made-to-measure lines are quotes/mtm-line.ts
 * (routes in quotes/routes.ts), the templates product/measures/templates-write.ts, the line rule ./line-check.ts (one line of
 * sales/line-checks), an order waiting for the review ./order-gate.ts and ./orders.ts. Built switched OFF per template (Owner
 * 11-10, GATE-MTM): no unit is quoted or ordered while a template's made-to-measure rules are off.
 */
export default defineRoutes('sales.mtm', manifest, async (app) => {
  app.get('/sales/mtm/profiles', { schema: listProfilesContract }, async (request) => listProfiles(request, request.query))
  app.get('/sales/mtm/profiles/:profileId', { schema: getProfileContract }, async (request) => ({ profile: await getProfile(request, request.params.profileId) }))
  app.post('/sales/mtm/profiles', { schema: newProfileContract }, async (request, reply) => reply.code(201).send(await recordProfile(request, request.body, idempotencyKeyFrom(request))))
  app.post('/sales/mtm/profiles/:profileId/revisions', { schema: newRevisionContract }, async (request, reply) => reply.code(201).send(await recordRevision(request, request.params.profileId, request.body, idempotencyKeyFrom(request))))
  app.post('/sales/mtm/profiles/:profileId/review', { schema: reviewContract }, async (request) => reviewProfile(request, request.params.profileId, request.body))
  app.get('/sales/mtm/profiles/:profileId/repeat', { schema: repeatReadContract }, async (request) => repeatFacts(request, request.params.profileId))
  app.post('/sales/mtm/profiles/:profileId/repeat', { schema: repeatContract }, async (request, reply) => reply.code(201).send(await repeatOrder(request, request.params.profileId, request.body, idempotencyKeyFrom(request))))
  app.get('/sales/mtm/profiles/:profileId/worksheets', { schema: listWorksheetsContract }, async (request) => listWorksheets(request, request.params.profileId))
  app.post('/sales/mtm/profiles/:profileId/worksheets', { schema: makeWorksheetContract }, async (request) => makeWorksheet(request, request.params.profileId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/mtm/profiles/:profileId/worksheets/:documentId/open', { schema: openWorksheetContract }, async (request) => openWorksheet(request, request.params.profileId, request.params.documentId, idempotencyKeyFrom(request)))
  app.get('/sales/orders/:orderId/made-to-measure', { schema: orderUnitsContract }, async (request) => orderUnits(request, request.params.orderId))
  // B-W2b-371 (XF2:01, XF2:04)
  app.get('/sales/mtm/profiles/:profileId/photos', { schema: listPhotosContract }, async (request) => listPhotos(request, request.params.profileId))
  app.post('/sales/mtm/profiles/:profileId/photos', { schema: announceProfilePhotoContract }, async (request, reply) => reply.code(201).send(await announceProfilePhoto(request, request.params.profileId, request.body, idempotencyKeyFrom(request))))
  app.post('/sales/mtm/profiles/:profileId/photos/:fileId/complete', { schema: completeProfilePhotoContract }, async (request) => completeProfilePhoto(request, request.params.profileId, request.params.fileId, idempotencyKeyFrom(request)))
  app.put('/sales/mtm/profiles/:profileId/photos/:fileId/delete-after', { schema: dateProfilePhotoContract }, async (request) => dateProfilePhoto(request, request.params.profileId, request.params.fileId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/fittings/results/:resultId/photos', { schema: announceFittingPhotoContract }, async (request, reply) => reply.code(201).send(await announceFittingPhoto(request, request.params.resultId, request.body, idempotencyKeyFrom(request))))
  app.post('/sales/fittings/results/:resultId/photos/:fileId/complete', { schema: completeFittingPhotoContract }, async (request) => completeFittingPhoto(request, request.params.resultId, request.params.fileId, idempotencyKeyFrom(request)))
  app.put('/sales/fittings/results/:resultId/photos/:fileId/delete-after', { schema: dateFittingPhotoContract }, async (request) => dateFittingPhoto(request, request.params.resultId, request.params.fileId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/mtm/photos/:fileId/open', { schema: openPhotoContract }, async (request) => openMtmPhoto(request, request.params.fileId, idempotencyKeyFrom(request)))
  app.get('/product/measurement-templates/:templateId/where-used', { schema: whereUsedContract }, async (request) => templateWhereUsed(request, request.params.templateId))
})
