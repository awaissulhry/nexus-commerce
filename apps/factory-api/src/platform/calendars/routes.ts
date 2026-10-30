import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { archiveCalendar, createCalendar, editCalendar, getCalendar, listCalendars, loadHolidays, removeDays, setDays } from './calendars'
import {
  archiveCalendarContract,
  archivePatternContract,
  createCalendarContract,
  createPatternContract,
  editCalendarContract,
  editPatternContract,
  getCalendarContract,
  getPatternContract,
  listCalendarsContract,
  listPatternsContract,
  loadHolidaysContract,
  nextWorkingDayContract,
  removeDaysContract,
  saveSegmentsContract,
  setDaysContract,
  supplierClosedDaysContract,
  supplierOrderByContract,
  workingMinutesContract,
  workingTimeContract,
} from './contract'
import { manifest } from './manifest'
import { archivePattern, createPattern, editPattern, getPattern, listPatterns, saveSegments } from './patterns'
import { nextWorkingDay, supplierClosedDays, supplierOrderBy, workingMinutes, workingTime } from './questions'

/**
 * Business calendars and shift patterns (B-W2a-08; design planning.settings, admin.org, Purchasing › Supplier):
 *   GET   /calendars                                 the calendars the caller sees (scope, company, site, supplier)
 *   POST  /calendars                                 a calendar for a company, site, line, workshop or supplier
 *   GET   /calendars/:id                             one calendar, its days (from, to) and the calendars above it
 *   PATCH /calendars/:id                             name, working week, shift pattern
 *   POST  /calendars/:id/archive                     archived (the owner may get a new calendar)
 *   POST  /calendars/:id/days                        a holiday, closure or working day from a date to a date
 *   POST  /calendars/:id/days/remove                 the days from a date to a date taken back
 *   POST  /calendars/:id/holidays                    a year of a public holiday list (IT) loaded
 *   GET   /calendars/working-time                    days, working days and minutes of a company, site, line or workshop
 *   GET   /calendars/working-minutes                 working minutes between two times
 *   GET   /calendars/next-working-day                the next (or Nth, or previous) working day
 *   GET   /calendars/supplier-closed-days            a supplier's closed days
 *   GET   /calendars/supplier-order-by               need date − lead time across the supplier's closed days
 *   GET   /shift-patterns, /shift-patterns/:id       the patterns with their shifts, breaks and minutes
 *   POST  /shift-patterns                            a pattern with its shifts and breaks
 *   PATCH /shift-patterns/:id                        name, description
 *   PUT   /shift-patterns/:id/segments               its shifts and breaks, all at once
 *   POST  /shift-patterns/:id/archive                archived (while no active calendar uses it)
 */
export default defineRoutes('calendars', manifest, async (app) => {
  app.get('/calendars', { schema: listCalendarsContract }, async (request) => ({ calendars: await listCalendars(request, request.query) }))
  app.post('/calendars', { schema: createCalendarContract }, async (request, reply) => reply.code(201).send({ calendar: await createCalendar(request, request.body, idempotencyKeyFrom(request)) }))

  app.get('/calendars/working-time', { schema: workingTimeContract }, async (request) => workingTime(request, request.query))
  app.get('/calendars/working-minutes', { schema: workingMinutesContract }, async (request) => workingMinutes(request, request.query))
  app.get('/calendars/next-working-day', { schema: nextWorkingDayContract }, async (request) => nextWorkingDay(request, request.query))
  app.get('/calendars/supplier-closed-days', { schema: supplierClosedDaysContract }, async (request) => supplierClosedDays(request, request.query))
  app.get('/calendars/supplier-order-by', { schema: supplierOrderByContract }, async (request) => supplierOrderBy(request, request.query))

  app.get('/calendars/:calendarId', { schema: getCalendarContract }, async (request) => getCalendar(request, request.params.calendarId, request.query))
  app.patch('/calendars/:calendarId', { schema: editCalendarContract }, async (request) => ({ calendar: await editCalendar(request, request.params.calendarId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/calendars/:calendarId/archive', { schema: archiveCalendarContract }, async (request) => ({
    calendar: await archiveCalendar(request, request.params.calendarId, request.body, idempotencyKeyFrom(request)),
  }))
  app.post('/calendars/:calendarId/days', { schema: setDaysContract }, async (request) => setDays(request, request.params.calendarId, request.body, idempotencyKeyFrom(request)))
  app.post('/calendars/:calendarId/days/remove', { schema: removeDaysContract }, async (request) => removeDays(request, request.params.calendarId, request.body, idempotencyKeyFrom(request)))
  app.post('/calendars/:calendarId/holidays', { schema: loadHolidaysContract }, async (request) => loadHolidays(request, request.params.calendarId, request.body, idempotencyKeyFrom(request)))

  app.get('/shift-patterns', { schema: listPatternsContract }, async (request) => ({ patterns: await listPatterns(request, request.query) }))
  app.post('/shift-patterns', { schema: createPatternContract }, async (request, reply) => reply.code(201).send({ pattern: await createPattern(request, request.body, idempotencyKeyFrom(request)) }))
  app.get('/shift-patterns/:patternId', { schema: getPatternContract }, async (request) => getPattern(request, request.params.patternId))
  app.patch('/shift-patterns/:patternId', { schema: editPatternContract }, async (request) => ({ pattern: await editPattern(request, request.params.patternId, request.body, idempotencyKeyFrom(request)) }))
  app.put('/shift-patterns/:patternId/segments', { schema: saveSegmentsContract }, async (request) => ({
    pattern: await saveSegments(request, request.params.patternId, request.body, idempotencyKeyFrom(request)),
  }))
  app.post('/shift-patterns/:patternId/archive', { schema: archivePatternContract }, async (request) => ({
    pattern: await archivePattern(request, request.params.patternId, request.body, idempotencyKeyFrom(request)),
  }))
})
