import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { abcOfSite } from './abc'
import {
  abcContract,
  binContract,
  binDoneContract,
  changeScheduleContract,
  createScheduleContract,
  dueSchedulesContract,
  finishContract,
  frozenContract,
  listSchedulesContract,
  saveSeparationContract,
  scanContract,
  separationContract,
  startScheduleContract,
  toCountContract,
} from './contract'
import { frozenLines } from './freeze'
import { manifest } from './manifest'
import { binDone, binOf, finishBin, scanUnit, toCount } from './scans'
import { changeSchedule, createSchedule, dueSchedules, listSchedules, startSchedule } from './schedules'
import { getSeparation, saveSeparation } from './separation'

/**
 * Counts in depth (B-W2b-299): count schedules and the Due counts (./schedules.ts, ./abc.ts; a count closing moves them:
 * ./close.ts), the frozen lines (./freeze.ts), counting by scanning every unit (./scans.ts), the separation switches of the
 * warehouse rules (./separation.ts). The freeze at the start, the yes of kind COUNT_VARIANCE at the submit and the closing of
 * the schedules at the apply are the counts' own commands' (../counts/counts.ts calls ./variance.ts and ./close.ts).
 */
export default defineRoutes('inventory.counts-depth', manifest, async (app) => {
  app.get('/inventory/count-schedules', { schema: listSchedulesContract }, async (request) => listSchedules(request, request.query))

  app.get('/inventory/count-schedules/due', { schema: dueSchedulesContract }, async (request) => dueSchedules(request, request.query))

  app.get('/inventory/count-schedules/abc', { schema: abcContract }, async (request) => abcOfSite(request, request.query))

  app.post('/inventory/count-schedules', { schema: createScheduleContract }, async (request, reply) => reply.code(201).send(await createSchedule(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/inventory/count-schedules/:scheduleId', { schema: changeScheduleContract }, async (request) => changeSchedule(request, request.params.scheduleId, request.body, idempotencyKeyFrom(request)))

  app.post('/inventory/count-schedules/:scheduleId/start', { schema: startScheduleContract }, async (request, reply) => reply.code(201).send(await startSchedule(request, request.params.scheduleId, request.body, idempotencyKeyFrom(request))))

  app.get('/inventory/stock-counts/frozen', { schema: frozenContract }, async (request) => frozenLines(request, request.query))

  app.get('/inventory/stock-counts/to-count', { schema: toCountContract }, async (request) => toCount(request, request.query))

  app.get('/inventory/stock-counts/bin', { schema: binContract }, async (request) => binOf(request, request.query))

  app.post('/inventory/stock-counts/:countId/scans', { schema: scanContract }, async (request, reply) => reply.code(201).send(await scanUnit(request, request.params.countId, request.body, idempotencyKeyFrom(request))))

  app.get('/inventory/stock-counts/:countId/bins/:locationId', { schema: binDoneContract }, async (request) => binDone(request, request.params.countId, request.params.locationId))

  app.post('/inventory/stock-counts/:countId/bins/:locationId/finish', { schema: finishContract }, async (request) => finishBin(request, request.params.countId, request.params.locationId, request.body, idempotencyKeyFrom(request)))

  app.get('/inventory/rules/separation-of-duties', { schema: separationContract }, async (request) => getSeparation(request, request.query))

  app.put('/inventory/rules/separation-of-duties', { schema: saveSeparationContract }, async (request) =>
    saveSeparation(request, request.body, { stepUp: () => requireStepUp(officeAuthOf(app), request), idempotencyKey: idempotencyKeyFrom(request) }),
  )
})
