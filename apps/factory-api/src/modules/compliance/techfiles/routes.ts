import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import {
  addItemContract,
  addRiskRowContract,
  announceLabReportContract,
  archiveFileContract,
  completeFileContract,
  completeLabReportContract,
  createFileContract,
  downloadPackContract,
  editFileContract,
  editItemContract,
  editRiskContract,
  editRiskRowContract,
  editTestContract,
  evidenceOptionsContract,
  getFileContract,
  getPackContract,
  getRiskContract,
  listFilesContract,
  listPacksContract,
  listTestsContract,
  newRiskContract,
  planTestContract,
  productionContract,
  recordTestContract,
  removeItemContract,
  removePackContract,
  removeRiskContract,
  removeRiskRowContract,
  removeTestContract,
  reopenFileContract,
  requestPackContract,
  sharePackContract,
  signRiskContract,
  testReportsContract,
  withdrawLinkContract,
} from './contract'
import { addItem, archiveFile, completeFile, createFile, editFile, editItem, evidenceOptions, getFile, listFiles, removeItem, reopenFile } from './files'
import { manifest } from './manifest'
import { downloadPack, getPack, listPacks, removePack, requestPack, sharePack, withdrawLink } from './packs'
import { productionOf } from './production'
import { testReports } from './reports'
import { addRow, editRevision, editRow, getRisk, newRevision, removeRevision, removeRow, signRevision } from './risk'
import { announceLabReport, completeLabReport, editTest, listTests, planTest, recordTest, removeTest } from './tests'

/**
 * Technical files (B-W2b-251; PRD-296, PRD-299, PRD-301, PRD-302, QHS-048, QHS-110): the Annex III checklist, the product risk
 * assessment, conformity to type per batch, production-control tests kept ten years and evidence packs for an authority or a
 * customer. The screens are B-W2b-269 (Compliance › Technical files, SCR-120). The pack's build is the worker's handler
 * (build.ts, listed in background.ts).
 */
export default defineRoutes('compliance.techfiles', manifest, async (app) => {
  const stepUpFor = (request: Parameters<typeof requireStepUp>[1]) => () => requireStepUp(officeAuthOf(app), request)

  app.get('/compliance/techfiles', { schema: listFilesContract }, async (request) => listFiles(request, request.query))
  app.post('/compliance/techfiles', { schema: createFileContract }, async (request) => createFile(request, request.body, idempotencyKeyFrom(request)))
  app.get('/compliance/techfiles/:fileId', { schema: getFileContract }, async (request) => getFile(request, request.params.fileId))
  app.patch('/compliance/techfiles/:fileId', { schema: editFileContract }, async (request) => editFile(request, request.params.fileId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/techfiles/:fileId/complete', { schema: completeFileContract }, async (request) => completeFile(request, request.params.fileId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/techfiles/:fileId/reopen', { schema: reopenFileContract }, async (request) => reopenFile(request, request.params.fileId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/techfiles/:fileId/archive', { schema: archiveFileContract }, async (request) => archiveFile(request, request.params.fileId, request.body, idempotencyKeyFrom(request)))
  app.get('/compliance/techfiles/:fileId/evidence-options', { schema: evidenceOptionsContract }, async (request) => evidenceOptions(request, request.params.fileId, request.query))
  app.post('/compliance/techfiles/:fileId/items', { schema: addItemContract }, async (request) => addItem(request, request.params.fileId, request.body, idempotencyKeyFrom(request)))
  app.patch('/compliance/techfiles/:fileId/items/:itemId', { schema: editItemContract }, async (request) => editItem(request, request.params.fileId, request.params.itemId, request.body, idempotencyKeyFrom(request)))
  app.delete('/compliance/techfiles/:fileId/items/:itemId', { schema: removeItemContract }, async (request) => removeItem(request, request.params.fileId, request.params.itemId, request.query.version, idempotencyKeyFrom(request)))

  app.get('/compliance/techfiles/:fileId/risk', { schema: getRiskContract }, async (request) => getRisk(request, request.params.fileId))
  app.post('/compliance/techfiles/:fileId/risk', { schema: newRiskContract }, async (request) => newRevision(request, request.params.fileId, request.body, idempotencyKeyFrom(request)))
  app.patch('/compliance/techfiles/:fileId/risk/:assessmentId', { schema: editRiskContract }, async (request) => editRevision(request, request.params.fileId, request.params.assessmentId, request.body, idempotencyKeyFrom(request)))
  app.delete('/compliance/techfiles/:fileId/risk/:assessmentId', { schema: removeRiskContract }, async (request) => removeRevision(request, request.params.fileId, request.params.assessmentId, request.query.version, idempotencyKeyFrom(request)))
  app.post('/compliance/techfiles/:fileId/risk/:assessmentId/rows', { schema: addRiskRowContract }, async (request) => addRow(request, request.params.fileId, request.params.assessmentId, request.body, idempotencyKeyFrom(request)))
  app.patch('/compliance/techfiles/:fileId/risk/:assessmentId/rows/:rowId', { schema: editRiskRowContract }, async (request) =>
    editRow(request, request.params.fileId, request.params.assessmentId, request.params.rowId, request.body, idempotencyKeyFrom(request)),
  )
  app.delete('/compliance/techfiles/:fileId/risk/:assessmentId/rows/:rowId', { schema: removeRiskRowContract }, async (request) =>
    removeRow(request, request.params.fileId, request.params.assessmentId, request.params.rowId, request.query.version, idempotencyKeyFrom(request)),
  )
  app.post('/compliance/techfiles/:fileId/risk/:assessmentId/sign', { schema: signRiskContract }, async (request) =>
    signRevision(request, request.params.fileId, request.params.assessmentId, request.body, { stepUp: stepUpFor(request), idempotencyKey: idempotencyKeyFrom(request) }),
  )

  app.get('/compliance/techfiles/:fileId/test-reports', { schema: testReportsContract }, async (request) => testReports(request, request.params.fileId))
  app.get('/compliance/techfiles/:fileId/production', { schema: productionContract }, async (request) => productionOf(request, request.params.fileId, request.query))
  app.get('/compliance/techfiles/:fileId/packs', { schema: listPacksContract }, async (request) => listPacks(request, request.params.fileId))
  app.post('/compliance/techfiles/:fileId/packs', { schema: requestPackContract }, async (request) => requestPack(request, request.params.fileId, request.body, idempotencyKeyFrom(request)))

  app.get('/compliance/production-tests', { schema: listTestsContract }, async (request) => listTests(request, request.query))
  app.post('/compliance/production-tests', { schema: planTestContract }, async (request) => planTest(request, request.body, idempotencyKeyFrom(request)))
  app.patch('/compliance/production-tests/:testId', { schema: editTestContract }, async (request) => editTest(request, request.params.testId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/production-tests/:testId/record', { schema: recordTestContract }, async (request) => recordTest(request, request.params.testId, request.body, idempotencyKeyFrom(request)))
  // B-W2b-278 (FU4:02): the lab report only through the test's own routes.
  app.post('/compliance/production-tests/:testId/report', { schema: announceLabReportContract }, async (request, reply) =>
    reply.code(201).send(await announceLabReport(request, request.params.testId, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/compliance/production-tests/:testId/report/:fileId/complete', { schema: completeLabReportContract }, async (request) =>
    completeLabReport(request, request.params.testId, request.params.fileId, idempotencyKeyFrom(request)),
  )
  app.delete('/compliance/production-tests/:testId', { schema: removeTestContract }, async (request) => removeTest(request, request.params.testId, request.query.version, idempotencyKeyFrom(request)))

  app.get('/compliance/evidence-packs/:packId', { schema: getPackContract }, async (request) => getPack(request, request.params.packId))
  app.get('/compliance/evidence-packs/:packId/download', { schema: downloadPackContract }, async (request) => downloadPack(request, request.params.packId, request.query.file ?? 'PDF'))
  app.delete('/compliance/evidence-packs/:packId', { schema: removePackContract }, async (request) => removePack(request, request.params.packId, request.query.version, idempotencyKeyFrom(request)))
  app.post('/compliance/evidence-packs/:packId/link', { schema: sharePackContract }, async (request) =>
    sharePack(request, request.params.packId, request.body, { stepUp: stepUpFor(request), idempotencyKey: idempotencyKeyFrom(request) }),
  )
  app.post('/compliance/evidence-packs/:packId/links/:linkId/withdraw', { schema: withdrawLinkContract }, async (request) => withdrawLink(request, request.params.packId, request.params.linkId, request.body, idempotencyKeyFrom(request)))
})
