import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireFloorStepUp } from '../../../platform/auth/floor/step-up'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import {
  approveRequestContract,
  askRequestContract,
  assignContract,
  assignPreviewContract,
  cancelRequestContract,
  checkRequestContract,
  copyWeekContract,
  copyWeekPreviewContract,
  createRequestContract,
  editRequestContract,
  floorAnswerContract,
  listRequestsContract,
  myShiftsContract,
  publishContract,
  recordAnswerContract,
  requestPeopleContract,
  requestRecordContract,
  rosterContract,
  writeCellsContract,
} from './contract'
import { answerOnFloor, myShifts } from './floor'
import { manifest } from './manifest'
import { approveRequest, askRequest, cancelRequest, changePeople, checkRequest, createRequest, editRequest, listRequests, recordAnswer, requestRecord } from './overtime'
import { applyAssign, applyCopyWeek, previewAssign, previewCopyWeek, publishRoster, readRoster, writeCells } from './roster'

/** The roster (./roster.ts), planned overtime (./overtime.ts), the worker's own on the tablet (./floor.ts). Each write is one command with an Idempotency-Key. */
export default defineRoutes('people.shifts', manifest, async (app) => {
  app.get('/people/shifts/roster', { schema: rosterContract }, async (request) => readRoster(request, request.query))
  app.post('/people/shifts/roster/cells', { schema: writeCellsContract }, async (request) => writeCells(request, request.body, idempotencyKeyFrom(request)))
  app.post('/people/shifts/roster/assign/preview', { schema: assignPreviewContract }, async (request) => previewAssign(request, request.body))
  app.post('/people/shifts/roster/assign', { schema: assignContract }, async (request) => applyAssign(request, request.body, idempotencyKeyFrom(request)))
  app.post('/people/shifts/roster/copy-week/preview', { schema: copyWeekPreviewContract }, async (request) => previewCopyWeek(request, request.body))
  app.post('/people/shifts/roster/copy-week', { schema: copyWeekContract }, async (request) => applyCopyWeek(request, request.body, idempotencyKeyFrom(request)))
  app.post('/people/shifts/roster/publish', { schema: publishContract }, async (request) => publishRoster(request, request.body, idempotencyKeyFrom(request)))

  app.get('/people/overtime-requests', { schema: listRequestsContract }, async (request) => listRequests(request, request.query))
  app.post('/people/overtime-requests/check', { schema: checkRequestContract }, async (request) => checkRequest(request, request.body))
  app.get('/people/overtime-requests/:requestId', { schema: requestRecordContract }, async (request) => requestRecord(request, request.params.requestId))
  app.post('/people/overtime-requests', { schema: createRequestContract }, async (request, reply) => {
    const { replayed, ...answer } = await createRequest(request, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send(answer)
  })
  app.patch('/people/overtime-requests/:requestId', { schema: editRequestContract }, async (request) => editRequest(request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/overtime-requests/:requestId/people', { schema: requestPeopleContract }, async (request) => changePeople(request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/overtime-requests/:requestId/ask', { schema: askRequestContract }, async (request) => askRequest(request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/overtime-requests/:requestId/answers/:agreementId', { schema: recordAnswerContract }, async (request) => recordAnswer(request, request.params.requestId, request.params.agreementId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/overtime-requests/:requestId/approve', { schema: approveRequestContract }, async (request) => approveRequest(request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/overtime-requests/:requestId/cancel', { schema: cancelRequestContract }, async (request) => cancelRequest(request, request.params.requestId, request.body, idempotencyKeyFrom(request)))

  app.get('/people/floor/my-shifts', { schema: myShiftsContract }, async (request) => myShifts(request, request.query))
  app.post('/people/floor/overtime-asks/:agreementId/answer', { schema: floorAnswerContract }, async (request) =>
    answerOnFloor(request, request.params.agreementId, request.body, idempotencyKeyFrom(request), () => requireFloorStepUp(officeAuthOf(app), request)),
  )
})
