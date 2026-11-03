import { fileURLToPath } from 'node:url'
import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { calendarCounts, readCalendar } from './calendar'
import {
  calendarContract,
  cancelDeadlineContract,
  countsContract,
  createDeadlineContract,
  deadlineRecordContract,
  doneDeadlineContract,
  editDeadlineContract,
  ownersContract,
} from './contract'
import { addDeadline, cancelDeadline, deadlineOwners, deadlineRecord, editDeadline, markDone } from './deadlines'
import { manifest } from './manifest'
import { loadSources } from './registry'

/**
 * The safety calendar (B-W2b-120; ./calendar.ts reads every source of ./sources/, ./deadlines.ts keeps the typed
 * deadlines). The sources load when these routes register (a broken source stops the API at start). Each write is one
 * command with an Idempotency-Key; a repeated key answers from its receipt.
 */
export default defineRoutes('safety.calendar', manifest, async (app) => {
  await loadSources(fileURLToPath(new URL('../../../', import.meta.url)))

  app.get('/safety/calendar', { schema: calendarContract }, async (request) => readCalendar(request, request.query))
  app.get('/safety/calendar/counts', { schema: countsContract }, async (request) => calendarCounts(request, request.query))

  app.get('/safety/deadlines/owners', { schema: ownersContract }, async (request) => deadlineOwners(request, request.query))
  app.get('/safety/deadlines/:deadlineId', { schema: deadlineRecordContract }, async (request) => deadlineRecord(request, request.params.deadlineId))
  app.post('/safety/deadlines', { schema: createDeadlineContract }, async (request, reply) => {
    const answer = await addDeadline(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })
  app.patch('/safety/deadlines/:deadlineId', { schema: editDeadlineContract }, async (request) => editDeadline(request, request.params.deadlineId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/deadlines/:deadlineId/done', { schema: doneDeadlineContract }, async (request) => markDone(request, request.params.deadlineId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/deadlines/:deadlineId/cancel', { schema: cancelDeadlineContract }, async (request) => cancelDeadline(request, request.params.deadlineId, request.body, idempotencyKeyFrom(request)))
})
