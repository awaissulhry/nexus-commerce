import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { requireStepUp } from '../../platform/auth/office/account'
import { officeAuthOf } from '../../platform/auth/sessions/office-auth'
import {
  cancelExportContract,
  createExportContract,
  downloadExportFileContract,
  getExportContract,
  intrastatContract,
  liftContract,
  listExportsContract,
  listLocksContract,
  lockContract,
  periodContract,
  periodsContract,
} from './contract'
import { cancelExport, createExport, downloadExportFile, exportRecord, listExports } from './exports'
import { liftLock, listLocks, lockMonth } from './locks'
import { manifest } from './manifest'
import { intrastatRows, periodWorkspace, yearOfPeriods } from './period'
// B-W2b-201: accountant access (the portal's room and the office's invite).
import { accountantsContract, changeAccountantContract, endAccountantContract, guestDownloadContract, guestOverviewContract, guestPeriodContract, guestZipContract, inviteAccountantContract } from './guest/contract'
import { accountants, changeAccountant, endAccountant, inviteAccountant } from './guest/office'
import { guestDownload, guestOverview, guestPeriod, guestZip } from './guest/portal'

/**
 * Numbered accounting exports, Intrastat data and file, the year-end stock pack and the period lock (B-W2a-39; FIN-046,
 * LOG-098, LOG-100; design finance.accounting, SCR-156; the wizard's screens are B-W2a-51):
 *   GET   /accounting/exports                               the batches (history): number, period, contents, files,
 *                                                           made by, documents changed since
 *   POST  /accounting/exports                               a month's numbered batch (or a re-export of its changes)
 *   GET   /accounting/exports/:id                           one batch: checks, manifest, files, lock, what may be done
 *   POST  /accounting/exports/:id/cancel                    a draft abandoned, with the reason
 *   GET   /accounting/exports/:id/files/:fileId/download    a file of a batch (its package's grain): a 60-second link
 *   GET   /accounting/periods?companyId&year                the twelve months: lock and batches of each (1 · Period)
 *   GET   /accounting/periods/:month?companyId&packages     the wizard's month: checks, contents, review, next number
 *   GET   /accounting/intrastat?companyId&month             the month's EU sale rows, their flags and fixes, the file's rows
 *   GET   /accounting/locks                                 the period locks
 *   POST  /accounting/locks                                 a month locked SOFT or HARD (typed phrase), or locked again
 *   POST  /accounting/locks/:id/lift                        a lock lifted with a reason (a hard one: accounting.unlock,
 *                                                           step-up)
 * Formats are Nexus's DEFAULT layout until the accountant names theirs (Q7, Q30): nothing is sent or filed anywhere.
 */
export default defineRoutes('accounting', manifest, async (app) => {
  app.get('/accounting/exports', { schema: listExportsContract }, async (request) => listExports(request, request.query))

  app.post('/accounting/exports', { schema: createExportContract }, async (request, reply) =>
    reply.code(201).send({ export: await createExport(request, request.body, idempotencyKeyFrom(request)) }),
  )

  app.get('/accounting/exports/:exportId', { schema: getExportContract }, async (request) => ({ export: await exportRecord(request, request.params.exportId) }))

  app.post('/accounting/exports/:exportId/cancel', { schema: cancelExportContract }, async (request) => ({
    export: await cancelExport(request, request.params.exportId, request.body, idempotencyKeyFrom(request)),
  }))

  app.get('/accounting/exports/:exportId/files/:fileId/download', { schema: downloadExportFileContract }, async (request) =>
    downloadExportFile(request, request.params.exportId, request.params.fileId),
  )

  app.get('/accounting/periods', { schema: periodsContract }, async (request) => yearOfPeriods(request, request.query))

  app.get('/accounting/periods/:month', { schema: periodContract }, async (request) => periodWorkspace(request, request.params.month, request.query))

  app.get('/accounting/intrastat', { schema: intrastatContract }, async (request) => intrastatRows(request, request.query))

  app.get('/accounting/locks', { schema: listLocksContract }, async (request) => listLocks(request, request.query))

  app.post('/accounting/locks', { schema: lockContract }, async (request) => lockMonth(request, request.body, idempotencyKeyFrom(request)))

  app.post('/accounting/locks/:lockId/lift', { schema: liftContract }, async (request) => ({
    lock: await liftLock(request, request.params.lockId, request.body, () => requireStepUp(officeAuthOf(app), request), idempotencyKeyFrom(request)),
  }))

  // B-W2b-201: accountant access (guest/): the portal's room — files only, every download in the audit log — and the
  // office's half on Finance › Close (give, change, end; step-up).
  app.get('/portal/accounting', { schema: guestOverviewContract }, async (request) => guestOverview(app, request))
  app.get('/portal/accounting/periods/:period', { schema: guestPeriodContract }, async (request) => guestPeriod(app, request, request.params.period))
  app.post('/portal/accounting/files/:fileId/download', { schema: guestDownloadContract }, async (request) => guestDownload(app, request, request.params.fileId, request.body, idempotencyKeyFrom(request)))
  app.post('/portal/accounting/zip', { schema: guestZipContract }, async (request, reply) => guestZip(app, request, reply, request.body))
  app.get('/accounting/accountants', { schema: accountantsContract }, async (request) => accountants(app, request, request.query.companyId))
  app.post('/accounting/accountants', { schema: inviteAccountantContract }, async (request, reply) => reply.code(201).send(await inviteAccountant(app, request, request.body, idempotencyKeyFrom(request))))
  app.patch('/accounting/accountants/:userId', { schema: changeAccountantContract }, async (request) => changeAccountant(app, request, request.params.userId, request.body, idempotencyKeyFrom(request)))
  app.post('/accounting/accountants/:userId/end', { schema: endAccountantContract }, async (request) => endAccountant(app, request, request.params.userId, request.body, idempotencyKeyFrom(request)))
})
