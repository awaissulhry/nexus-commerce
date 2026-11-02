import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  approveEntryContract,
  approveTimesheetContract,
  entriesContract,
  entryCountsContract,
  entryDetailContract,
  prepareTimesheetsContract,
  rejectEntryContract,
  reopenEntryContract,
  sendBackContract,
  timesheetDetailContract,
  timesheetsContract,
} from './contract'
import { approveEntry, entryCounts, entryDetail, listEntries, rejectEntry, reopenEntry } from './entries'
import { manifest } from './manifest'
import { approveAsHr, approveAsLead, listTimesheets, prepareMonth, sendBack, timesheetDetail } from './timesheets'

/**
 * Overtime worked (./entries.ts; computed by ./sync.ts, the worker's handler is ./jobs.ts) and timesheets (./timesheets.ts),
 * B-W2b-42. Each write is one command with an Idempotency-Key.
 */
export default defineRoutes('people.overtime', manifest, async (app) => {
  app.get('/people/overtime/entries', { schema: entriesContract }, async (request) => listEntries(request, request.query))
  app.get('/people/overtime/counts', { schema: entryCountsContract }, async (request) => entryCounts(request, request.query))
  app.get('/people/overtime/entries/:entryId', { schema: entryDetailContract }, async (request) => entryDetail(request, request.params.entryId))
  app.post('/people/overtime/entries/:entryId/approve', { schema: approveEntryContract }, async (request) => approveEntry(request, request.params.entryId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/overtime/entries/:entryId/reject', { schema: rejectEntryContract }, async (request) => rejectEntry(request, request.params.entryId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/overtime/entries/:entryId/reopen', { schema: reopenEntryContract }, async (request) => reopenEntry(request, request.params.entryId, request.body, idempotencyKeyFrom(request)))

  app.get('/people/timesheets', { schema: timesheetsContract }, async (request) => listTimesheets(request, request.query))
  app.post('/people/timesheets/prepare', { schema: prepareTimesheetsContract }, async (request) => prepareMonth(request, request.body, idempotencyKeyFrom(request)))
  app.get('/people/timesheets/:timesheetId', { schema: timesheetDetailContract }, async (request) => timesheetDetail(request, request.params.timesheetId))
  app.post('/people/timesheets/:timesheetId/lead-approve', { schema: approveTimesheetContract }, async (request) => approveAsLead(request, request.params.timesheetId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/timesheets/:timesheetId/hr-approve', { schema: approveTimesheetContract }, async (request) => approveAsHr(request, request.params.timesheetId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/timesheets/:timesheetId/send-back', { schema: sendBackContract }, async (request) => sendBack(request, request.params.timesheetId, request.body, idempotencyKeyFrom(request)))
})
