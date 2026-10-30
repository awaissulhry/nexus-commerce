import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { downloadExportContract, getExportContract, listExportsContract, requestExportContract } from './contract'
import { downloadExport, getExport, listExports, requestExport } from './jobs'
import { manifest } from './manifest'

/**
 * The export of a list (B-W2a-23; PLT-179; design shell.lists Export ▾, pop:export-job):
 *   POST /exports                    the view on screen (its address terms and visible columns), QUEUED for the worker
 *   GET  /exports?listKey=           the person's latest exports (of one list)
 *   GET  /exports/:id                one of them: its state, progress, the columns left out, the file
 *   GET  /exports/:id/download       the file: a presigned GET (60 s, an attachment)
 */
export default defineRoutes('exports', manifest, async (app) => {
  app.post('/exports', { schema: requestExportContract }, async (request, reply) => reply.code(201).send({ job: await requestExport(request, request.body, idempotencyKeyFrom(request)) }))
  app.get('/exports', { schema: listExportsContract }, async (request) => ({ jobs: await listExports(request, request.query.listKey) }))
  app.get('/exports/:exportId', { schema: getExportContract }, async (request) => ({ job: await getExport(request, request.params.exportId) }))
  app.get('/exports/:exportId/download', { schema: downloadExportContract }, async (request) => ({ download: await downloadExport(request, request.params.exportId) }))
})
