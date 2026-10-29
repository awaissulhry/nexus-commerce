import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { announceReportContract, completeReportContract, listReportsContract, summaryContract, templateContract } from './contract'
import { manifest } from './manifest'
import { announceReport, completeReport, listReports } from './reports'
import { openingSummary } from './summary'
import { openingTemplateFile } from './template'

/**
 * Opening stock (B-W1-35): the import's template, the company's opening-stock reports (the existing chromium VI reports,
 * uploaded before the sheet that names them), and a site's opening stock: what was imported and what waits for release.
 * The dry run and the apply are the imports platform's (`POST /imports` with importer `inventory.opening`, then
 * `POST /imports/:importId/apply`); the importer is ./importer.ts, one line's posting ./post.ts.
 */
export default defineRoutes('inventory.opening', manifest, async (app) => {
  app.get('/inventory/opening/template', { schema: templateContract }, async (request, reply) => {
    const file = await openingTemplateFile(request.query.format ?? 'csv', request.query.numberFormat ?? 'it')
    return reply.type(file.contentType).header('content-disposition', `attachment; filename="${file.name}"`).send(file.body)
  })

  app.post('/inventory/opening/reports', { schema: announceReportContract }, async (request, reply) => reply.code(201).send(await announceReport(request, request.body, idempotencyKeyFrom(request))))

  app.post('/inventory/opening/reports/:fileId/complete', { schema: completeReportContract }, async (request) => completeReport(request, request.params.fileId, idempotencyKeyFrom(request)))

  app.get('/inventory/opening/reports', { schema: listReportsContract }, async (request) => listReports(request, request.query.companyId))

  app.get('/inventory/opening/summary', { schema: summaryContract }, async (request) => openingSummary(request, request.query.siteId))
})
