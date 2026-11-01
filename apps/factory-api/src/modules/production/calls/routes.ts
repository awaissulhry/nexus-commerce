import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { answerCall, nameOutcome } from './answer'
import {
  boardContract,
  byHourContract,
  callRecordContract,
  cancelContract,
  countsContract,
  createTypeContract,
  detailsContract,
  listCallsContract,
  listTypesContract,
  onTheWayContract,
  outcomeContract,
  seenContract,
  sendContract,
  solveContract,
  stationCancelContract,
  stationSolveContract,
  stationStateContract,
  updateTypeContract,
} from './contract'
import { manifest } from './manifest'
import { callCounts, callRecordOf, callsByHourOf, lineBoard, listCalls } from './reads'
import { addDetails, closeAtStation, sendCall, stationState } from './station'
import { createType, listTypes, updateType } from './types'

/**
 * Help calls (B-W2b-35; ./station.ts, ./answer.ts, ./reads.ts, ./types.ts). Each write is one command with an
 * Idempotency-Key; a repeated key answers from its receipt. A call sent from the station is keyed by the tablet's own
 * client event id (`<device>.<client event id>`), so a resent queued call is made once.
 */
export default defineRoutes('production.calls', manifest, async (app) => {
  // ---- the station (floor.help) ----
  app.get('/production/calls/station', { schema: stationStateContract }, async (request) => stationState(request))

  app.post('/production/calls/station', { schema: sendContract }, async (request, reply) => {
    const answer = await sendCall(request, request.body)
    return reply.code(answer.replayed || answer.existing ? 200 : 201).send(answer)
  })

  app.post('/production/calls/station/:callId/details', { schema: detailsContract }, async (request) => addDetails(request, request.params.callId, request.body, idempotencyKeyFrom(request)))

  app.post('/production/calls/station/:callId/solve', { schema: stationSolveContract }, async (request) => closeAtStation(request, request.params.callId, 'SOLVED', request.body, idempotencyKeyFrom(request)))

  app.post('/production/calls/station/:callId/cancel', { schema: stationCancelContract }, async (request) => closeAtStation(request, request.params.callId, 'CANCELLED', request.body, idempotencyKeyFrom(request)))

  // ---- the line view and the line TV ----
  app.get('/production/calls/board', { schema: boardContract }, async (request) => lineBoard(request, request.query))

  // ---- answering ----
  app.post('/production/calls/:callId/seen', { schema: seenContract }, async (request) => answerCall(request, request.params.callId, 'SEEN', request.body, idempotencyKeyFrom(request)))

  app.post('/production/calls/:callId/on-the-way', { schema: onTheWayContract }, async (request) => answerCall(request, request.params.callId, 'ON_THE_WAY', request.body, idempotencyKeyFrom(request)))

  app.post('/production/calls/:callId/solve', { schema: solveContract }, async (request) => answerCall(request, request.params.callId, 'SOLVED', request.body, idempotencyKeyFrom(request)))

  app.post('/production/calls/:callId/cancel', { schema: cancelContract }, async (request) => answerCall(request, request.params.callId, 'CANCELLED', request.body, idempotencyKeyFrom(request)))

  app.post('/production/calls/:callId/outcome', { schema: outcomeContract }, async (request) => nameOutcome(request, request.params.callId, request.body, idempotencyKeyFrom(request)))

  // ---- the office ----
  app.get('/production/calls', { schema: listCallsContract }, async (request) => listCalls(request, request.query))

  app.get('/production/calls/counts', { schema: countsContract }, async (request) => callCounts(request, request.query))

  app.get('/production/calls/by-hour', { schema: byHourContract }, async (request) => callsByHourOf(request, request.query))

  app.get('/production/calls/types', { schema: listTypesContract }, async (request) => listTypes(request, request.query))

  app.post('/production/calls/types', { schema: createTypeContract }, async (request, reply) => {
    const answer = await createType(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })

  app.patch('/production/calls/types/:typeId', { schema: updateTypeContract }, async (request) => updateType(request, request.params.typeId, request.body, idempotencyKeyFrom(request)))

  app.get('/production/calls/:callId', { schema: callRecordContract }, async (request) => callRecordOf(request, request.params.callId))
})
