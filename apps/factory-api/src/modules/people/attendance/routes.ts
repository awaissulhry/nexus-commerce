import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { addStandardCodes, createCode, editCode, listCodes, setCodeState } from './codes'
import {
  acceptAnomalyContract,
  approveDayContract,
  approveDaysContract,
  codeStateContract,
  countsContract,
  createCodeContract,
  dayAbsenceContract,
  dayDetailContract,
  editCodeContract,
  employeeDaysContract,
  fixDayContract,
  listCodesContract,
  listDaysContract,
  manualEntryContract,
  reopenDayContract,
  rollCallContract,
  saveSettingsContract,
  settingsContract,
  standardCodesContract,
  whoIsInContract,
} from './contract'
import { acceptAnomaly, approveDay, approveDays, dayCounts, dayDetail, employeeDays, listDays, reopenDay } from './days'
import { fixDay, manualEntry, setDayAbsence } from './entries'
import { manifest } from './manifest'
import { rollCall, whoIsIn } from './presence'
import { readSettings, saveSettings } from './settings'

/**
 * Attendance days (B-W2b-37): the days and their tiles (./days.ts), manual entries and fixes (./entries.ts), absence
 * codes (./codes.ts), rounding and grace (./settings.ts), who is in now and the roll call (./presence.ts). The handler
 * and the cron that compute the days are ./jobs.ts. Each write is one command with an Idempotency-Key.
 */
export default defineRoutes('people.attendance', manifest, async (app) => {
  app.get('/people/attendance/days', { schema: listDaysContract }, async (request) => listDays(request, request.query))
  app.get('/people/attendance/counts', { schema: countsContract }, async (request) => dayCounts(request, request.query))
  app.get('/people/attendance/days/:dayId', { schema: dayDetailContract }, async (request) => dayDetail(request, request.params.dayId))
  app.get('/people/employees/:employeeId/attendance', { schema: employeeDaysContract }, async (request) => employeeDays(request, request.params.employeeId, request.query))

  app.post('/people/attendance/entries', { schema: manualEntryContract }, async (request, reply) => {
    const { created, answer } = await manualEntry(request, request.body, idempotencyKeyFrom(request))
    return reply.code(created ? 201 : 200).send(answer)
  })
  app.post('/people/attendance/days/:dayId/fix', { schema: fixDayContract }, async (request) => fixDay(request, request.params.dayId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/attendance/days/:dayId/absence', { schema: dayAbsenceContract }, async (request) => setDayAbsence(request, request.params.dayId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/attendance/days/approve', { schema: approveDaysContract }, async (request) => approveDays(request, request.body, idempotencyKeyFrom(request)))
  app.post('/people/attendance/days/:dayId/approve', { schema: approveDayContract }, async (request) => approveDay(request, request.params.dayId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/attendance/days/:dayId/reopen', { schema: reopenDayContract }, async (request) => reopenDay(request, request.params.dayId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/attendance/anomalies/:anomalyId/accept', { schema: acceptAnomalyContract }, async (request) => acceptAnomaly(request, request.params.anomalyId, request.body, idempotencyKeyFrom(request)))

  app.get('/people/attendance/absence-codes', { schema: listCodesContract }, async (request) => listCodes(request, request.query))
  app.post('/people/attendance/absence-codes', { schema: createCodeContract }, async (request, reply) => {
    const { created, answer } = await createCode(request, request.body, idempotencyKeyFrom(request))
    return reply.code(created ? 201 : 200).send(answer)
  })
  app.post('/people/attendance/absence-codes/standard', { schema: standardCodesContract }, async (request) => addStandardCodes(request, request.body, idempotencyKeyFrom(request)))
  app.patch('/people/attendance/absence-codes/:codeId', { schema: editCodeContract }, async (request) => editCode(request, request.params.codeId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/attendance/absence-codes/:codeId/archive', { schema: codeStateContract }, async (request) => setCodeState(request, request.params.codeId, request.body, 'ARCHIVED', idempotencyKeyFrom(request)))
  app.post('/people/attendance/absence-codes/:codeId/restore', { schema: codeStateContract }, async (request) => setCodeState(request, request.params.codeId, request.body, 'ACTIVE', idempotencyKeyFrom(request)))

  app.get('/people/attendance/settings', { schema: settingsContract }, async (request) => readSettings(request, request.query))
  app.put('/people/attendance/settings', { schema: saveSettingsContract }, async (request) => saveSettings(request, request.body, idempotencyKeyFrom(request)))

  app.get('/people/attendance/who-is-in', { schema: whoIsInContract }, async (request) => whoIsIn(request, request.query))
  app.post('/people/attendance/roll-call', { schema: rollCallContract }, async (request) => rollCall(request, request.body, idempotencyKeyFrom(request)))
})
