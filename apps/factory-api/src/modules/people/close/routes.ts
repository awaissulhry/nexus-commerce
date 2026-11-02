import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { attendedContract, differencesContract, personMonthContract, reportContract } from '../reports/attendance/contract'
import { attendedAgainstProduction } from '../reports/attendance/production'
import { attendanceReport, personMonth, reportDifferences } from '../reports/attendance/report'
import { closeMonth, listMonths, monthPanel, openLul, sealMonth } from './close'
import { closeMonthContract, correctDayContract, dayCorrectionsContract, monthCorrectionsContract, monthPanelContract, monthsContract, openLulContract, sealContract } from './contract'
import { correctDay, dayCorrections, monthCorrections } from './corrections'
import { manifest } from './manifest'

/**
 * The month close and the LUL calendar (./close.ts), corrections of a closed day (./corrections.ts) and the attendance report
 * (../reports/attendance), B-W2b-48. Each write is one command with an Idempotency-Key.
 */
export default defineRoutes('people.close', manifest, async (app) => {
  app.get('/people/month-close', { schema: monthPanelContract }, async (request) => monthPanel(request, request.query))
  app.get('/people/month-close/months', { schema: monthsContract }, async (request) => listMonths(request, request.query))
  app.post('/people/month-close', { schema: closeMonthContract }, async (request) => closeMonth(request, request.body, idempotencyKeyFrom(request)))
  app.post('/people/month-close/:closeId/seal', { schema: sealContract }, async (request) => sealMonth(request, request.params.closeId, idempotencyKeyFrom(request)))
  app.post('/people/month-close/:closeId/lul/open', { schema: openLulContract }, async (request) => openLul(request, request.params.closeId, request.body, idempotencyKeyFrom(request)))
  app.get('/people/month-close/:closeId/corrections', { schema: monthCorrectionsContract }, async (request) => monthCorrections(request, request.params.closeId, request.query))

  app.get('/people/attendance/days/:dayId/corrections', { schema: dayCorrectionsContract }, async (request) => dayCorrections(request, request.params.dayId))
  app.post('/people/attendance/days/:dayId/corrections', { schema: correctDayContract }, async (request, reply) => {
    const answer = await correctDay(request, request.params.dayId, request.body, idempotencyKeyFrom(request))
    return reply.code(201).send(answer)
  })

  app.get('/people/reports/attendance', { schema: reportContract }, async (request) => attendanceReport(request, request.query))
  app.get('/people/reports/attendance/differences', { schema: differencesContract }, async (request) => reportDifferences(request, request.query))
  app.get('/people/reports/attendance/production', { schema: attendedContract }, async (request) => attendedAgainstProduction(request, request.query))
  app.get('/people/reports/attendance/people/:employeeId', { schema: personMonthContract }, async (request) => personMonth(request, request.params.employeeId, request.query))
})
