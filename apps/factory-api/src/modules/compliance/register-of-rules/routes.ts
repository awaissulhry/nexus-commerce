import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  addCertificatesContract,
  assessChangeContract,
  changeTaskContract,
  closeChangeContract,
  createEntryContract,
  deleteEntryContract,
  editEntryContract,
  getChangeContract,
  getEntryContract,
  listChangesContract,
  listEntriesContract,
  recordChangeContract,
} from './contract'
import { manifest } from './manifest'
import { createEntry, deleteEntry, editEntry, getEntry, listEntries } from './register'
import { addCertificates, assessChange, closeChange, getChange, listChanges, openImpactTask, recordChange } from './watch'

/**
 * The register of laws and standards in use and the harmonised-standard watch (B-W2b-249; PRD-273, PRD-274). The screen
 * is B-W2b-265 (Rules & markets › Regulations & standards with the change watch).
 */
export default defineRoutes('compliance.register-of-rules', manifest, async (app) => {
  app.get('/compliance/rules/standards', { schema: listEntriesContract }, async (request) => listEntries(request, request.query))
  app.post('/compliance/rules/standards', { schema: createEntryContract }, async (request) => createEntry(request, request.body, idempotencyKeyFrom(request)))
  app.get('/compliance/rules/standards/:standardId', { schema: getEntryContract }, async (request) => getEntry(request, request.params.standardId))
  app.patch('/compliance/rules/standards/:standardId', { schema: editEntryContract }, async (request) => editEntry(request, request.params.standardId, request.body, idempotencyKeyFrom(request)))
  app.delete('/compliance/rules/standards/:standardId', { schema: deleteEntryContract }, async (request) => deleteEntry(request, request.params.standardId, request.query.version, idempotencyKeyFrom(request)))
  app.post('/compliance/rules/standards/:standardId/changes', { schema: recordChangeContract }, async (request) => recordChange(request, request.params.standardId, request.body, idempotencyKeyFrom(request)))

  app.get('/compliance/rules/standard-changes', { schema: listChangesContract }, async (request) => listChanges(request, request.query))
  app.get('/compliance/rules/standard-changes/:changeId', { schema: getChangeContract }, async (request) => getChange(request, request.params.changeId))
  app.post('/compliance/rules/standard-changes/:changeId/assess', { schema: assessChangeContract }, async (request) => assessChange(request, request.params.changeId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/rules/standard-changes/:changeId/certificates', { schema: addCertificatesContract }, async (request) => addCertificates(request, request.params.changeId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/rules/standard-changes/:changeId/task', { schema: changeTaskContract }, async (request) => openImpactTask(request, request.params.changeId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/rules/standard-changes/:changeId/close', { schema: closeChangeContract }, async (request) => closeChange(request, request.params.changeId, request.body, idempotencyKeyFrom(request)))
})
