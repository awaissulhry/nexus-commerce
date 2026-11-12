import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { processFiles } from '../../../platform/files/service'
import {
  addLineContract,
  answerContract,
  changeLineContract,
  estimatesContract,
  historyContract,
  intakeContract,
  linkOpenFileContract,
  linkPageContract,
  linkPhotoContract,
  linkPhotoDoneContract,
  linkRecordContract,
  linkSubmitContract,
  newEstimateContract,
  officePhotoContract,
  officePhotoDoneContract,
  portalAnswerContract,
  portalListContract,
  portalOpenFileContract,
  portalPhotoContract,
  portalPhotoDoneContract,
  portalRepairContract,
  portalRequestContract,
  removeLineContract,
  sendContract,
  termsContract,
  withdrawContract,
} from './contract'
import { addLine, changeEstimate, changeLine, createEstimate, getEstimates, recordAnswer, removeLine, sendEstimate, withdrawEstimate } from './estimates'
import { announceOfficePhoto, completeOfficePhoto, garmentHistory, getIntake } from './intake'
import { linkOpenRepairFile, linkRepairPage, linkRepairPhoto, linkRepairPhotoDone, linkRepairRecord, linkSubmitRepair } from './link'
import { manifest } from './manifest'
import { portalAnswerEstimate, portalOpenRepairFile, portalRepair, portalRepairPhoto, portalRepairPhotoDone, portalRepairs, portalRequestRepair } from './portal'

/**
 * Repairs and alterations in depth (B-W2b-342): the office's intake, damage photos, the garment's history and the estimate
 * (./intake.ts, ./estimates.ts), the customer's repair requests, photos and estimate answer in the portal (./portal.ts) and
 * by a claim link (./link.ts). The repair order itself, its stages, safety check and way back stay B-W2a-57's
 * (modules/sales/repairs); its stage route asks ./estimates.ts `estimateHoldInCommand` before approving or starting work.
 */
export default defineRoutes('sales.repairs-depth', manifest, async (app) => {
  // ---- the office --------------------------------------------------------------------------------------------------------
  app.get('/sales/repairs/history', { schema: historyContract }, async (request) => garmentHistory(request, request.query))
  app.get('/sales/repairs/:repairId/intake', { schema: intakeContract }, async (request) => getIntake(request, request.params.repairId))
  app.post('/sales/repairs/:repairId/photos', { schema: officePhotoContract }, async (request, reply) => reply.code(201).send(await announceOfficePhoto(processFiles(), request, request.params.repairId, request.body, idempotencyKeyFrom(request))))
  app.post('/sales/repairs/:repairId/photos/:fileId/complete', { schema: officePhotoDoneContract }, async (request) => completeOfficePhoto(processFiles(), request, request.params.repairId, request.params.fileId, idempotencyKeyFrom(request)))
  app.get('/sales/repairs/:repairId/estimates', { schema: estimatesContract }, async (request) => getEstimates(request, request.params.repairId))
  app.post('/sales/repairs/:repairId/estimates', { schema: newEstimateContract }, async (request, reply) => reply.code(201).send(await createEstimate(request, request.params.repairId, request.body, idempotencyKeyFrom(request))))
  app.patch('/sales/repairs/estimates/:estimateId', { schema: termsContract }, async (request) => changeEstimate(request, request.params.estimateId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/repairs/estimates/:estimateId/lines', { schema: addLineContract }, async (request, reply) => reply.code(201).send(await addLine(request, request.params.estimateId, request.body, idempotencyKeyFrom(request))))
  app.patch('/sales/repairs/estimates/:estimateId/lines/:lineId', { schema: changeLineContract }, async (request) => changeLine(request, request.params.estimateId, request.params.lineId, request.body, idempotencyKeyFrom(request)))
  app.delete('/sales/repairs/estimates/:estimateId/lines/:lineId', { schema: removeLineContract }, async (request) => removeLine(request, request.params.estimateId, request.params.lineId, request.query, idempotencyKeyFrom(request)))
  app.post('/sales/repairs/estimates/:estimateId/send', { schema: sendContract }, async (request) => sendEstimate(request, request.params.estimateId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/repairs/estimates/:estimateId/answer', { schema: answerContract }, async (request) => recordAnswer(request, request.params.estimateId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/repairs/estimates/:estimateId/withdraw', { schema: withdrawContract }, async (request) => withdrawEstimate(request, request.params.estimateId, request.body, idempotencyKeyFrom(request)))

  // ---- the portal --------------------------------------------------------------------------------------------------------
  app.get('/portal/repairs', { schema: portalListContract }, async (request) => portalRepairs(app, request))
  app.post('/portal/repairs', { schema: portalRequestContract }, async (request, reply) => reply.code(201).send(await portalRequestRepair(app, request, request.body, idempotencyKeyFrom(request))))
  app.post('/portal/repairs/files/:fileId/open', { schema: portalOpenFileContract }, async (request) => portalOpenRepairFile(processFiles(), app, request, request.params.fileId, request.body, idempotencyKeyFrom(request)))
  app.get('/portal/repairs/:repairId', { schema: portalRepairContract }, async (request) => portalRepair(app, request, request.params.repairId))
  app.post('/portal/repairs/:repairId/photos', { schema: portalPhotoContract }, async (request, reply) => reply.code(201).send(await portalRepairPhoto(processFiles(), app, request, request.params.repairId, request.body, idempotencyKeyFrom(request))))
  app.post('/portal/repairs/:repairId/photos/:fileId/complete', { schema: portalPhotoDoneContract }, async (request) => portalRepairPhotoDone(processFiles(), app, request, request.params.repairId, request.params.fileId, idempotencyKeyFrom(request)))
  app.post('/portal/repairs/:repairId/estimate/answer', { schema: portalAnswerContract }, async (request) => portalAnswerEstimate(app, request, request.params.repairId, request.body, idempotencyKeyFrom(request)))

  // ---- the claim link ----------------------------------------------------------------------------------------------------
  app.get('/link/claim/repair', { schema: linkPageContract }, async (request) => linkRepairPage(app, request))
  app.post('/link/claim/repair', { schema: linkSubmitContract }, async (request, reply) => reply.code(201).send(await linkSubmitRepair(app, request, request.body)))
  app.get('/link/claim/repair/:repairId', { schema: linkRecordContract }, async (request) => linkRepairRecord(app, request, request.params.repairId))
  app.post('/link/claim/repair/photos', { schema: linkPhotoContract }, async (request, reply) => reply.code(201).send(await linkRepairPhoto(processFiles(), request, request.body, idempotencyKeyFrom(request))))
  app.post('/link/claim/repair/photos/:fileId/complete', { schema: linkPhotoDoneContract }, async (request) => linkRepairPhotoDone(processFiles(), request, request.params.fileId, idempotencyKeyFrom(request)))
  app.post('/link/claim/repair/files/:fileId/open', { schema: linkOpenFileContract }, async (request) => linkOpenRepairFile(processFiles(), app, request, request.params.fileId, request.body))
})
