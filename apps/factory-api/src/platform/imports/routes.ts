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
// B-W2b-427: likely duplicates — on create, in an import's check, the list of them, and the merge (duplicates/).
import { checkMaterialContract, checkPartyContract, importDuplicatesContract, mergeContract, mergePreviewContract, scanContract } from './duplicates/contract'
import { mergeRecords, previewMerge } from './duplicates/merge'
import { checkMaterial, checkParty, importDuplicates, scanDuplicates } from './duplicates/service'

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

  // B-W2b-427 (PLT-178): likely duplicates; the merge is a person's decision (imports.duplicates.merge + the record's manage
  // permission over both, checked in the handler).
  app.get('/imports/:importId/duplicates', { schema: importDuplicatesContract }, async (request) => importDuplicates(request, request.params.importId))
  app.post('/duplicates/parties/check', { schema: checkPartyContract }, async (request) => checkParty(request, request.body))
  app.post('/duplicates/materials/check', { schema: checkMaterialContract }, async (request) => checkMaterial(request, request.body))
  app.get('/duplicates/parties', { schema: scanContract }, async (request) => scanDuplicates(request, { ...request.query, recordType: 'PARTY' }))
  app.get('/duplicates/materials', { schema: scanContract }, async (request) => scanDuplicates(request, { ...request.query, recordType: 'MATERIAL' }))
  app.get('/duplicates/:recordType/merge', { schema: mergePreviewContract }, async (request) => previewMerge(request, request.params.recordType, request.query.keptId, request.query.droppedId))
  app.post('/duplicates/:recordType/merge', { schema: mergeContract }, async (request) => mergeRecords(request, request.params.recordType, request.body, idempotencyKeyFrom(request)))
})
