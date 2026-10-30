import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { processFiles } from '../files/service'
import {
  applyImportContract,
  cancelImportContract,
  createImportContract,
  errorsFileContract,
  getImportContract,
  importersContract,
  listImportsContract,
  listRowsContract,
} from './contract'
import { applyImport, cancelImport, errorsFile, getImport, listImporters, listImports, listRows, startImport } from './jobs'
import { manifest } from './manifest'
// B-W2a-41: every importer's template (templates/) and the guided first load (guided/).
import { templateContract } from './templates/contract'
import { templateFile, templateFor } from './templates/template'
import { firstLoadContract, markDoneContract } from './guided/contract'
import { markFirstLoadDone, readFirstLoad } from './guided/first-load'

/**
 * Imports with a dry run (platform part; plan A1 W0-22, feature PLT-176; screen SCR-017): the importers the caller may
 * use, start an import with its sheet, the jobs, a job, its planned rows, its error file, apply, cancel. The dry run
 * and the apply run in the worker (worker.ts); these routes only read and move jobs.
 */
export default defineRoutes('imports', manifest, async (app) => {
  app.get('/imports/importers', { schema: importersContract }, async (request) => {
    return { importers: listImporters(request) }
  })

  app.post('/imports', { schema: createImportContract }, async (request, reply) => {
    return reply.code(201).send(await startImport(processFiles(), request, request.body))
  })

  app.get('/imports', { schema: listImportsContract }, async (request) => {
    return { jobs: await listImports(request, request.query) }
  })

  app.get('/imports/:importId', { schema: getImportContract }, async (request) => {
    return { job: await getImport(request, request.params.importId) }
  })

  app.get('/imports/:importId/rows', { schema: listRowsContract }, async (request) => {
    return listRows(request, request.params.importId, request.query)
  })

  app.get('/imports/:importId/errors', { schema: errorsFileContract }, async (request, reply) => {
    const file = await errorsFile(request, request.params.importId)
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${file.name}"`).send(file.body)
  })

  app.post('/imports/:importId/apply', { schema: applyImportContract }, async (request) => {
    return { job: await applyImport(request, request.params.importId, request.body, idempotencyKeyFrom(request)) }
  })

  app.post('/imports/:importId/cancel', { schema: cancelImportContract }, async (request) => {
    return { job: await cancelImport(request, request.params.importId, request.body, idempotencyKeyFrom(request)) }
  })

  // B-W2a-41 (PLT-177): the template of any importer the caller may use, as CSV or Excel.
  app.get('/imports/importers/:importerKey/template', { schema: templateContract }, async (request, reply) => {
    const file = await templateFile(templateFor(request, request.params.importerKey, request.query.numberFormat ?? 'it'), request.query.format ?? 'csv')
    return reply.type(file.contentType).header('content-disposition', `attachment; filename="${file.name}"`).send(file.body)
  })

  // B-W2a-41 (PLT-185): the guided first load of a company, and a step's "Done".
  app.get('/imports/first-load', { schema: firstLoadContract }, async (request) => readFirstLoad(request, request.query.companyId))
  app.post('/imports/first-load/:step/done', { schema: markDoneContract }, async (request) => markFirstLoadDone(request, request.params.step, request.body, idempotencyKeyFrom(request)))
})
