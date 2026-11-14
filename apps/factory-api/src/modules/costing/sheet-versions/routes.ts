import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { submitVersion, takeBackVersion } from './approval'
import { compareVersions, saveWhatIf, whatIfPreview } from './compare'
import {
  compareContract,
  createVersionContract,
  listVersionsContract,
  removeVersionContract,
  saveWhatIfContract,
  submitVersionContract,
  takeBackContract,
  updateVersionContract,
  versionRecordContract,
  whatIfContract,
} from './contract'
import { manifest } from './manifest'
import { createVersion, listVersions, removeVersion, updateVersion, versionRecord } from './versions'

/**
 * Cost sheet versions (B-W2b-420; FIN-014, FIN-015): a style's versions per company and season, one version, a new draft
 * (from the components or a copy of the series), a draft edited or deleted, sent for its yes (a COST_SHEET request of the
 * approval engine), an approved version taken back, two versions compared, a what-if shown or saved as a new draft. Every
 * write takes an Idempotency-Key (a repeat answers from its receipt) and the row's version; every refusal is a 409
 * `refusal/<CODE>` with its words.
 */
export default defineRoutes('costing.sheet-versions', manifest, async (app) => {
  app.get('/costing/cost-sheets', { schema: listVersionsContract }, async (request) => listVersions(request, request.query))
  app.get('/costing/cost-sheets/compare', { schema: compareContract }, async (request) => compareVersions(request, request.query))
  app.get('/costing/cost-sheets/:sheetId', { schema: versionRecordContract }, async (request) => versionRecord(request, request.params.sheetId))
  app.post('/costing/cost-sheets', { schema: createVersionContract }, async (request, reply) => reply.code(201).send(await createVersion(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/costing/cost-sheets/:sheetId', { schema: updateVersionContract }, async (request) => updateVersion(request, request.params.sheetId, request.body, idempotencyKeyFrom(request)))
  app.delete('/costing/cost-sheets/:sheetId', { schema: removeVersionContract }, async (request) => {
    await removeVersion(request, request.params.sheetId, request.query.version, idempotencyKeyFrom(request))
    return { id: request.params.sheetId, removed: true as const }
  })
  app.post('/costing/cost-sheets/:sheetId/submit', { schema: submitVersionContract }, async (request) => submitVersion(request, request.params.sheetId, request.body, idempotencyKeyFrom(request)))
  app.post('/costing/cost-sheets/:sheetId/take-back', { schema: takeBackContract }, async (request) => takeBackVersion(request, request.params.sheetId, request.body, idempotencyKeyFrom(request)))
  app.post('/costing/cost-sheets/:sheetId/what-if', { schema: whatIfContract }, async (request) => whatIfPreview(request, request.params.sheetId, request.body))
  app.post('/costing/cost-sheets/:sheetId/what-if/save', { schema: saveWhatIfContract }, async (request, reply) => reply.code(201).send(await saveWhatIf(request, request.params.sheetId, request.body, idempotencyKeyFrom(request))))
})
