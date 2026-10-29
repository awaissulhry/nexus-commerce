import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  addNoteContract,
  closeEntryContract,
  completeActionContract,
  createEntryContract,
  getEntryContract,
  informDistributorsContract,
  listEntriesContract,
  notifyAuthorityContract,
  traceContract,
  updateEntryContract,
} from './contract'
import { manifest } from './manifest'
import { addNote, closeEntry, completeAction, createEntry, editEntry, getEntry, informDistributors, listEntries, notifyAuthority, previewTrace } from './register'

/**
 * The PPE register of complaints, non-conformities and recalls (B-W1-43; QHS-118; Reg. (EU) 2016/425 art. 8(4), 8(8)):
 * the register (filters: company, kind, state, risk, style, period, text), an entry with its trace to the shipments and
 * customers that got the garments, a trace preview for the New entry modal, record, edit while OPEN, the corrective
 * action done, distributors informed, authority told, close with a reason, notes on the entry's thread. Other steps
 * open entries inside their own command with hook.ts `openRegisterEntryFor` (B-W1-45).
 */
export default defineRoutes('compliance.register', manifest, async (app) => {
  app.get('/compliance/register', { schema: listEntriesContract }, async (request) => listEntries(request, request.query))

  app.post('/compliance/register/trace', { schema: traceContract }, async (request) => previewTrace(request, request.body))

  app.get('/compliance/register/:entryId', { schema: getEntryContract }, async (request) => ({ entry: await getEntry(request, request.params.entryId) }))

  app.post('/compliance/register', { schema: createEntryContract }, async (request, reply) => {
    return reply.code(201).send({ entry: await createEntry(request, request.body, idempotencyKeyFrom(request)) })
  })

  app.patch('/compliance/register/:entryId', { schema: updateEntryContract }, async (request) => ({
    entry: await editEntry(request, request.params.entryId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/compliance/register/:entryId/corrective-action/complete', { schema: completeActionContract }, async (request) => ({
    entry: await completeAction(request, request.params.entryId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/compliance/register/:entryId/distributors-informed', { schema: informDistributorsContract }, async (request) => ({
    entry: await informDistributors(request, request.params.entryId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/compliance/register/:entryId/authority-notified', { schema: notifyAuthorityContract }, async (request) => ({
    entry: await notifyAuthority(request, request.params.entryId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/compliance/register/:entryId/close', { schema: closeEntryContract }, async (request) => ({
    entry: await closeEntry(request, request.params.entryId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/compliance/register/:entryId/notes', { schema: addNoteContract }, async (request, reply) => {
    return reply.code(201).send(await addNote(request, request.params.entryId, request.body, idempotencyKeyFrom(request)))
  })
})
