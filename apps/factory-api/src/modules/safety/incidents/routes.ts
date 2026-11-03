import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { addAction, cancelAction, doneAction, editAction, makeAction } from './actions'
import {
  addActionContract,
  addFilingContract,
  addPersonContract,
  announcePhotoContract,
  announceReceiptContract,
  cancelActionContract,
  cancelContract,
  completePhotoContract,
  completeReceiptContract,
  countsContract,
  doneActionContract,
  downloadPhotoContract,
  editActionContract,
  editContract,
  editFilingContract,
  editPersonContract,
  fileFilingContract,
  floorIncidentContract,
  floorReportContract,
  floorStartContract,
  listContract,
  makeActionContract,
  neededContract,
  openFilingsContract,
  openPeopleContract,
  openReceiptContract,
  recordContract,
  removePersonContract,
  reportContract,
  rulesContract,
  seenContract,
  showPeopleContract,
  versionContract,
} from './contract'
import { announceFloorPhoto, announcePhoto, announceReceipt, completeFloorPhoto, completePhoto, completeReceipt, downloadPhoto } from './files'
import { addFiling, editFiling, fileFiling, setNeeded } from './filings'
import { cancelIncident, closeIncident, editIncident, markSeen, reopenIncident } from './lifecycle'
import { manifest } from './manifest'
import { addPerson, editPerson, removePerson } from './people'
import { openFilings, openPeople, openReceipt, showPeople } from './protected'
import { floorIncident, floorStart, incidentCounts, incidentRecord, incidentRules, listIncidents } from './reads'
import { reportFromFloor, reportFromOffice } from './report'

/**
 * Incidents, near misses and hazards (B-W2b-125; ./reads.ts, ./report.ts, ./lifecycle.ts, ./actions.ts, ./people.ts,
 * ./protected.ts, ./filings.ts, ./files.ts). Each write is one command with an Idempotency-Key (a floor write needs one); a
 * repeated key answers from its receipt. The …/open routes write the view log, then read: they take no key (each opening is a
 * view of its own).
 */
export default defineRoutes('safety.incidents', manifest, async (app) => {
  app.get('/safety/incidents', { schema: listContract }, async (request) => listIncidents(request, request.query))
  app.get('/safety/incidents/counts', { schema: countsContract }, async (request) => incidentCounts(request, request.query))
  app.get('/safety/incidents/rules', { schema: rulesContract }, async (request) => incidentRules(request))
  app.get('/safety/incidents/:incidentId', { schema: recordContract }, async (request) => incidentRecord(request, request.params.incidentId))
  app.post('/safety/incidents', { schema: reportContract }, async (request, reply) => {
    const answer = await reportFromOffice(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })
  app.patch('/safety/incidents/:incidentId', { schema: editContract }, async (request) => editIncident(request, request.params.incidentId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/incidents/:incidentId/seen', { schema: seenContract }, async (request) => markSeen(request, request.params.incidentId, idempotencyKeyFrom(request)))
  app.post('/safety/incidents/:incidentId/close', { schema: versionContract }, async (request) => closeIncident(request, request.params.incidentId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/incidents/:incidentId/reopen', { schema: versionContract }, async (request) => reopenIncident(request, request.params.incidentId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/incidents/:incidentId/cancel', { schema: cancelContract }, async (request) => cancelIncident(request, request.params.incidentId, request.body, idempotencyKeyFrom(request)))

  app.post('/safety/incidents/:incidentId/photos', { schema: announcePhotoContract }, async (request, reply) => reply.code(201).send(await announcePhoto(request, request.params.incidentId, request.body, idempotencyKeyFrom(request))))
  app.post('/safety/incidents/:incidentId/photos/:fileId/complete', { schema: completePhotoContract }, async (request) => completePhoto(request, request.params.incidentId, request.params.fileId, idempotencyKeyFrom(request)))
  app.get('/safety/incidents/:incidentId/photos/:fileId/download', { schema: downloadPhotoContract }, async (request) => downloadPhoto(request, request.params.incidentId, request.params.fileId))

  app.post('/safety/incidents/:incidentId/actions', { schema: addActionContract }, async (request, reply) => {
    const answer = await addAction(request, request.params.incidentId, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })
  app.post('/safety/incidents/:incidentId/actions/:actionId/make', { schema: makeActionContract }, async (request) => makeAction(request, request.params.incidentId, request.params.actionId, request.body, idempotencyKeyFrom(request)))
  app.patch('/safety/incidents/:incidentId/actions/:actionId', { schema: editActionContract }, async (request) => editAction(request, request.params.incidentId, request.params.actionId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/incidents/:incidentId/actions/:actionId/done', { schema: doneActionContract }, async (request) => doneAction(request, request.params.incidentId, request.params.actionId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/incidents/:incidentId/actions/:actionId/cancel', { schema: cancelActionContract }, async (request) => cancelAction(request, request.params.incidentId, request.params.actionId, request.body, idempotencyKeyFrom(request)))

  app.post('/safety/incidents/:incidentId/people/open', { schema: openPeopleContract }, async (request) => openPeople(request, request.params.incidentId))
  app.post('/safety/incidents/people', { schema: showPeopleContract }, async (request) => showPeople(request, request.body))
  app.post('/safety/incidents/:incidentId/people', { schema: addPersonContract }, async (request, reply) => {
    const answer = await addPerson(request, request.params.incidentId, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })
  app.patch('/safety/incidents/:incidentId/people/:personId', { schema: editPersonContract }, async (request) => editPerson(request, request.params.incidentId, request.params.personId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/incidents/:incidentId/people/:personId/remove', { schema: removePersonContract }, async (request) => removePerson(request, request.params.incidentId, request.params.personId, request.body, idempotencyKeyFrom(request)))

  app.post('/safety/incidents/:incidentId/filings/open', { schema: openFilingsContract }, async (request) => openFilings(request, request.params.incidentId))
  app.post('/safety/incidents/:incidentId/filings', { schema: addFilingContract }, async (request, reply) => {
    const answer = await addFiling(request, request.params.incidentId, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })
  app.patch('/safety/incidents/:incidentId/filings/:filingId', { schema: editFilingContract }, async (request) => editFiling(request, request.params.incidentId, request.params.filingId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/incidents/:incidentId/filings/:filingId/file', { schema: fileFilingContract }, async (request) => fileFiling(request, request.params.incidentId, request.params.filingId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/incidents/:incidentId/filings/:filingId/not-needed', { schema: neededContract }, async (request) => setNeeded(request, request.params.incidentId, request.params.filingId, false, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/incidents/:incidentId/filings/:filingId/needed', { schema: neededContract }, async (request) => setNeeded(request, request.params.incidentId, request.params.filingId, true, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/incidents/:incidentId/filings/:filingId/receipt', { schema: announceReceiptContract }, async (request, reply) => reply.code(201).send(await announceReceipt(request, request.params.incidentId, request.params.filingId, request.body, idempotencyKeyFrom(request))))
  app.post('/safety/incidents/:incidentId/filings/:filingId/receipt/:fileId/complete', { schema: completeReceiptContract }, async (request) => completeReceipt(request, request.params.incidentId, request.params.filingId, request.params.fileId, idempotencyKeyFrom(request)))
  app.post('/safety/incidents/:incidentId/filings/:filingId/receipt/:fileId/open', { schema: openReceiptContract }, async (request) => openReceipt(request, request.params.incidentId, request.params.filingId, request.params.fileId))

  app.get('/safety/floor/incidents/start', { schema: floorStartContract }, async (request) => floorStart(request))
  app.post('/safety/floor/incidents', { schema: floorReportContract }, async (request, reply) => {
    const answer = await reportFromFloor(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })
  app.get('/safety/floor/incidents/:incidentId', { schema: floorIncidentContract }, async (request) => floorIncident(request, request.params.incidentId))
  app.post('/safety/floor/incidents/:incidentId/photos', { schema: announcePhotoContract }, async (request, reply) => reply.code(201).send(await announceFloorPhoto(request, request.params.incidentId, request.body, idempotencyKeyFrom(request))))
  app.post('/safety/floor/incidents/:incidentId/photos/:fileId/complete', { schema: completePhotoContract }, async (request) => completeFloorPhoto(request, request.params.incidentId, request.params.fileId, idempotencyKeyFrom(request)))
})
