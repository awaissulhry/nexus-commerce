import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { AUTH_RATE_LIMITS } from '../../../platform/auth/sessions/office-auth'
import { listCodes, putCode } from './codes'
import {
  archiveLayoutContract,
  cancelContract,
  codesContract,
  createExportContract,
  createLayoutContract,
  exportContract,
  exportsContract,
  exportValuesContract,
  layoutsContract,
  linkDownloadContract,
  linkFilesContract,
  monthContract,
  openFileContract,
  patchLayoutContract,
  previewContract,
  putCodeContract,
  sendContract,
  showContract,
  withdrawContract,
} from './contract'
import { cancelExport, createExport, exportValues, getExport, listExports, openExportFile } from './exports'
import { archiveLayout, createLayout, listLayouts, patchLayout } from './layouts'
import { manifest } from './manifest'
import { monthView, previewMonth, showCheck } from './month'
import { downloadLinkFile, linkFiles, sendExport, withdrawLink } from './send'

/**
 * The payroll export (B-W2b-54): the month and its checks (./month.ts), the code mapping (./codes.ts), the layouts (./layouts.ts),
 * the exports and corrections (./exports.ts) and the secure link (./send.ts). Each write is one command with an
 * Idempotency-Key; the link's two routes are rate limited per address, as every link route.
 */
export default defineRoutes('people.payroll', manifest, async (app) => {
  const linkUse = app.officeAuth?.rateLimits.linkUse ?? AUTH_RATE_LIMITS.linkUse
  const limited = { rateLimit: { max: linkUse.max, timeWindow: linkUse.timeWindowMs } }

  app.get('/people/payroll/month', { schema: monthContract }, async (request) => monthView(request, request.query))
  app.post('/people/payroll/month/show', { schema: showContract }, async (request) => showCheck(request, request.body, idempotencyKeyFrom(request)))
  app.post('/people/payroll/preview', { schema: previewContract }, async (request) => previewMonth(request, request.body, idempotencyKeyFrom(request)))

  app.get('/people/payroll/codes', { schema: codesContract }, async (request) => listCodes(request, request.query))
  app.put('/people/payroll/codes', { schema: putCodeContract }, async (request) => putCode(request, request.body, idempotencyKeyFrom(request)))

  app.get('/people/payroll/layouts', { schema: layoutsContract }, async (request) => listLayouts(request, request.query))
  app.post('/people/payroll/layouts', { schema: createLayoutContract }, async (request, reply) => reply.code(201).send(await createLayout(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/people/payroll/layouts/:layoutId', { schema: patchLayoutContract }, async (request) => patchLayout(request, request.params.layoutId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/payroll/layouts/:layoutId/archive', { schema: archiveLayoutContract }, async (request) => archiveLayout(request, request.params.layoutId, request.body, idempotencyKeyFrom(request)))

  app.get('/people/payroll/exports', { schema: exportsContract }, async (request) => listExports(request, request.query))
  app.post('/people/payroll/exports', { schema: createExportContract }, async (request, reply) => reply.code(201).send(await createExport(request, request.body, idempotencyKeyFrom(request))))
  app.get('/people/payroll/exports/:exportId', { schema: exportContract }, async (request) => getExport(request, request.params.exportId))
  app.post('/people/payroll/exports/:exportId/cancel', { schema: cancelContract }, async (request) => cancelExport(request, request.params.exportId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/payroll/exports/:exportId/values', { schema: exportValuesContract }, async (request) => exportValues(request, request.params.exportId, idempotencyKeyFrom(request)))
  app.post('/people/payroll/exports/:exportId/files/:fileId/open', { schema: openFileContract }, async (request) => openExportFile(request, request.params.exportId, request.params.fileId, idempotencyKeyFrom(request)))
  app.post('/people/payroll/exports/:exportId/send', { schema: sendContract }, async (request, reply) => reply.code(201).send(await sendExport(request, request.params.exportId, request.body, idempotencyKeyFrom(request))))
  app.post('/people/payroll/exports/:exportId/links/:linkId/withdraw', { schema: withdrawContract }, async (request) => withdrawLink(request, request.params.exportId, request.params.linkId, request.body, idempotencyKeyFrom(request)))

  app.get('/people/payroll/link/files', { schema: linkFilesContract, config: limited }, async (request) => linkFiles(request))
  app.post('/people/payroll/link/files/:fileId/download', { schema: linkDownloadContract, config: limited }, async (request) => downloadLinkFile(request, request.params.fileId, idempotencyKeyFrom(request)))
})
