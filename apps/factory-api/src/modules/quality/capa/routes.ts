import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { processFiles } from '../../../platform/files/service'
import { inlineDisposition } from '../../inventory/receipts/report'
import { addAction, cancelAction, doneAction, editAction, remindAction } from './actions'
import { cancelCapa, capaRecord, closeCapa, editCapa, moveCapa, openCapa } from './capa'
import {
  addActionContract,
  addSourcesContract,
  cancelActionContract,
  cancelContract,
  closeContract,
  countsContract,
  doneActionContract,
  editActionContract,
  editContract,
  escalateContract,
  getContract,
  listContract,
  makeReportContract,
  openContract,
  peopleContract,
  previewReportContract,
  remindActionContract,
  removeSourceContract,
  stageContract,
} from './contract'
import { manifest } from './manifest'
import { capaCounts, capaPeople, listCapas } from './reads'
import { makeReport, previewReport } from './report'
import { addSources, escalationPreview, removeSource } from './sources'

/**
 * Corrective actions, CAPA and 8D (B-W2b-108): the list, tiles and people (./reads.ts), the escalation preview and the
 * sources (./sources.ts), the record and its writes (./capa.ts), the actions (./actions.ts), the 8D report (./report.ts).
 * Reminders and escalation run in the scheduler's clustered cron (./reminders.ts, one line in background.ts).
 */
export default defineRoutes('quality.capa', manifest, async (app) => {
  app.get('/quality/capa', { schema: listContract }, async (request) => listCapas(request, request.query))
  app.get('/quality/capa/counts', { schema: countsContract }, async (request) => capaCounts(request))
  app.get('/quality/capa/people', { schema: peopleContract }, async (request) => capaPeople(request, request.query))
  app.get('/quality/capa/escalate', { schema: escalateContract }, async (request) => escalationPreview(request, request.query))
  app.post('/quality/capa', { schema: openContract }, async (request, reply) => reply.code(201).send(await openCapa(request, request.body, idempotencyKeyFrom(request))))
  app.get('/quality/capa/:capaId', { schema: getContract }, async (request) => capaRecord(request, request.params.capaId))
  app.patch('/quality/capa/:capaId', { schema: editContract }, async (request) => editCapa(request, request.params.capaId, request.body, idempotencyKeyFrom(request)))
  app.post('/quality/capa/:capaId/stage', { schema: stageContract }, async (request) => moveCapa(request, request.params.capaId, request.body, idempotencyKeyFrom(request)))
  app.post('/quality/capa/:capaId/close', { schema: closeContract }, async (request) => closeCapa(request, request.params.capaId, request.body, idempotencyKeyFrom(request)))
  app.post('/quality/capa/:capaId/cancel', { schema: cancelContract }, async (request) => cancelCapa(request, request.params.capaId, request.body, idempotencyKeyFrom(request)))
  app.post('/quality/capa/:capaId/sources', { schema: addSourcesContract }, async (request, reply) => reply.code(201).send(await addSources(request, request.params.capaId, request.body, idempotencyKeyFrom(request))))
  app.delete('/quality/capa/:capaId/sources/:sourceId', { schema: removeSourceContract }, async (request) => removeSource(request, request.params.capaId, request.params.sourceId, request.query, idempotencyKeyFrom(request)))
  app.post('/quality/capa/:capaId/actions', { schema: addActionContract }, async (request, reply) => reply.code(201).send(await addAction(request, request.params.capaId, request.body, idempotencyKeyFrom(request))))
  app.patch('/quality/capa/:capaId/actions/:actionId', { schema: editActionContract }, async (request) => editAction(request, request.params.capaId, request.params.actionId, request.body, idempotencyKeyFrom(request)))
  app.post('/quality/capa/:capaId/actions/:actionId/done', { schema: doneActionContract }, async (request) => doneAction(request, request.params.capaId, request.params.actionId, request.body, idempotencyKeyFrom(request)))
  app.post('/quality/capa/:capaId/actions/:actionId/cancel', { schema: cancelActionContract }, async (request) => cancelAction(request, request.params.capaId, request.params.actionId, request.body, idempotencyKeyFrom(request)))
  app.post('/quality/capa/:capaId/actions/:actionId/remind', { schema: remindActionContract }, async (request) => remindAction(request, request.params.capaId, request.params.actionId, request.body, idempotencyKeyFrom(request)))
  app.get('/quality/capa/:capaId/report', { schema: previewReportContract }, async (request, reply) => {
    const { pdf, fileName } = await previewReport(request, request.params.capaId, request.query)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })
  app.post('/quality/capa/:capaId/report', { schema: makeReportContract }, async (request, reply) => reply.code(201).send(await makeReport(processFiles(), request, request.params.capaId, request.body, idempotencyKeyFrom(request))))
})
