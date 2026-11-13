import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { accidentLog, reportRevisions, reviseAccident } from './accidents'
import {
  changeContract,
  countsContract,
  eraseContract,
  eraseInjuryContract,
  fileContract,
  getContract,
  listContract,
  logContract,
  openInjuryContract,
  openPhotoContract,
  photoContract,
  photoDoneContract,
  portalPhotoContract,
  portalPhotoDoneContract,
  portalSendContract,
  portalStatusContract,
  publicPhotoContract,
  publicPhotoDoneContract,
  publicSendContract,
  publicStatusContract,
  recordContract,
  recordInjuryContract,
  reviseContract,
  revisionsContract,
  seenContract,
  statusContract,
} from './contract'
import { announceOfficePhoto, completeOfficePhoto, openPhoto } from './files'
import { eraseInjury, openInjury, recordInjury } from './injury'
import { manifest } from './manifest'
import { changeReport, eraseReporter, fileReport, getReport, listReports, markSeen, moveReport, recordReport, reportCounts } from './office'
import { portalPhoto, portalPhotoDone, portalStatus, publicPhoto, publicPhotoDone, publicStatus, sendPortalReport, sendPublicReport } from './outside'

/**
 * Product-safety reports and the accident log of B-W2b-351 (SAL-414 the intake from the public DoC page, the portal or the
 * office; SAL-415 serial, photos and injury kept apart; SAL-423 the accident log for GPSR notices): the office's list, tiles,
 * record and steps (./office.ts), whether someone was hurt for the product-safety role (./injury.ts), the accident log
 * (./accidents.ts), photos (./files.ts), and the doors from outside, OFF until GATE-PRIVACY (./outside.ts). The intake every
 * door shares, with the SAFETY case each report opens: ./intake.ts. Screens: B-W2b-357.
 */

/** Public sends a minute per address on top of the abuse guard (a person sends one, with a retry or two). */
const SEND_RATE = { max: 10, timeWindow: 60_000 } as const
/** Public photos a minute per address (a report takes a few). */
const PHOTO_RATE = { max: 30, timeWindow: 60_000 } as const

export default defineRoutes('sales.safety-reports', manifest, async (app) => {
  app.get('/sales/safety-reports', { schema: listContract }, async (request) => listReports(request, request.query))
  app.get('/sales/safety-reports/counts', { schema: countsContract }, async (request) => reportCounts(request))
  app.get('/sales/safety-reports/accident-log', { schema: logContract }, async (request) => accidentLog(request, request.query))
  app.post('/sales/safety-reports', { schema: recordContract }, async (request, reply) => reply.code(201).send(await recordReport(request, request.body, idempotencyKeyFrom(request))))

  app.get('/sales/safety-reports/:reportId', { schema: getContract }, async (request) => getReport(request, request.params.reportId))
  app.patch('/sales/safety-reports/:reportId', { schema: changeContract }, async (request) => changeReport(request, request.params.reportId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/safety-reports/:reportId/seen', { schema: seenContract }, async (request) => markSeen(request, request.params.reportId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/safety-reports/:reportId/status', { schema: statusContract }, async (request) => moveReport(request, request.params.reportId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/safety-reports/:reportId/register-entry', { schema: fileContract }, async (request) => fileReport(request, request.params.reportId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/safety-reports/:reportId/reporter/erase', { schema: eraseContract }, async (request) => eraseReporter(request, request.params.reportId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/safety-reports/:reportId/injury/open', { schema: openInjuryContract }, async (request) => openInjury(request, request.params.reportId, idempotencyKeyFrom(request)))
  app.post('/sales/safety-reports/:reportId/injury', { schema: recordInjuryContract }, async (request) => recordInjury(request, request.params.reportId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/safety-reports/:reportId/injury/erase', { schema: eraseInjuryContract }, async (request) => eraseInjury(request, request.params.reportId, request.body, idempotencyKeyFrom(request)))

  app.get('/sales/safety-reports/:reportId/accident-log', { schema: revisionsContract }, async (request) => reportRevisions(request, request.params.reportId))
  app.post('/sales/safety-reports/:reportId/accident-log', { schema: reviseContract }, async (request, reply) => reply.code(201).send(await reviseAccident(request, request.params.reportId, request.body, idempotencyKeyFrom(request))))

  app.post('/sales/safety-reports/:reportId/photos', { schema: photoContract }, async (request, reply) => reply.code(201).send(await announceOfficePhoto(request, request.params.reportId, request.body, idempotencyKeyFrom(request))))
  app.post('/sales/safety-reports/:reportId/photos/:fileId/complete', { schema: photoDoneContract }, async (request) => completeOfficePhoto(request, request.params.reportId, request.params.fileId, idempotencyKeyFrom(request)))
  app.post('/sales/safety-reports/:reportId/photos/:fileId/open', { schema: openPhotoContract }, async (request) => openPhoto(request, request.params.reportId, request.params.fileId, idempotencyKeyFrom(request)))

  app.get('/portal/safety-reports/status', { schema: portalStatusContract }, async (request) => portalStatus(app, request))
  app.post('/portal/safety-reports', { schema: portalSendContract }, async (request, reply) => reply.code(201).send(await sendPortalReport(app, request, request.body, idempotencyKeyFrom(request))))
  app.post('/portal/safety-reports/:reportId/photos', { schema: portalPhotoContract }, async (request, reply) => reply.code(201).send(await portalPhoto(app, request, request.params.reportId, request.body, idempotencyKeyFrom(request))))
  app.post('/portal/safety-reports/:reportId/photos/:fileId/complete', { schema: portalPhotoDoneContract }, async (request) => portalPhotoDone(app, request, request.params.reportId, request.params.fileId, idempotencyKeyFrom(request)))

  app.get('/public/safety-reports/status', { schema: publicStatusContract }, async () => publicStatus())
  app.post('/public/safety-reports', { schema: publicSendContract, config: { rateLimit: SEND_RATE } }, async (request, reply) => reply.code(201).send(await sendPublicReport(app, request, reply, request.body, idempotencyKeyFrom(request))))
  app.post('/public/safety-reports/photos', { schema: publicPhotoContract, config: { rateLimit: PHOTO_RATE } }, async (request, reply) => reply.code(201).send(await publicPhoto(app, request, request.body, idempotencyKeyFrom(request))))
  app.post('/public/safety-reports/photos/:fileId/complete', { schema: publicPhotoDoneContract, config: { rateLimit: PHOTO_RATE } }, async (request) => publicPhotoDone(app, request, request.params.fileId, request.body, idempotencyKeyFrom(request)))
})
