import { fileURLToPath } from 'node:url'
import { defineRoutes } from '../../core/manifest'
import { idempotencyKeyFrom } from '../../core/command'
import { actOnRow, assignees, handledToday, snoozeRow } from './actions'
import { comingUp } from './coming-up'
import {
  acknowledgeContract,
  assignContract,
  assigneesContract,
  comingUpContract,
  flowContract,
  handledContract,
  layoutContract,
  nudgeContract,
  resolveContract,
  saveLayoutContract,
  snoozeContract,
  todayContract,
  waitingContract,
} from './contract'
import { flow } from './flow'
import { getLayout, saveLayout } from './layout'
import { manifest } from './manifest'
import { today } from './today'
import { nudge, waitingOnOthers } from './waiting'
// B-W2a-79: My numbers and the report pack (reports/; the definitions are loaded from reports/defs/ first).
import { libraryContract, numbersContract, reportAboutContract, reportResultsContract, reportScheduleContract } from './reports/contract'
import { myNumbers } from './reports/numbers'
import { loadReports } from './reports/registry'
import { library, reportAbout, reportResults, reportSchedule, type ResultsQuery } from './reports/run'

/**
 * Home › Today (B-W1-52; ANA-037; A2 SCR-029 "Today", SCR-031 W1 "Overview"): the needs-attention list computed from the
 * records' own states (ranked, why each row is mine, what waits on it, tiles per kind), the role's flow strip, and what
 * I wait for from others — read from the modules' records at the moment it is asked. What people do about an alert
 * (assign, resolve with a note, acknowledge), what I handled today and my arrangement of the page are stored
 * (factory-db insights.prisma; factory-domain insights/actions).
 */
export default defineRoutes('insights', manifest, async (app) => {
  app.get('/home/today', { schema: todayContract }, async (request) => today(request, request.query))

  app.get('/home/flow', { schema: flowContract }, async (request) => flow(request, request.query))

  app.get('/home/waiting-on-others', { schema: waitingContract }, async (request) => waitingOnOthers(request, request.query))

  app.get('/home/today/handled', { schema: handledContract }, async (request) => handledToday(request))

  app.get('/home/today/rows/:key/assignees', { schema: assigneesContract }, async (request) => assignees(request, request.params.key))

  app.post('/home/today/rows/:key/assign', { schema: assignContract }, async (request) => actOnRow(request, request.params.key, 'ASSIGN', request.body, idempotencyKeyFrom(request)))

  app.post('/home/today/rows/:key/resolve', { schema: resolveContract }, async (request) => actOnRow(request, request.params.key, 'RESOLVE', request.body, idempotencyKeyFrom(request)))

  app.post('/home/today/rows/:key/acknowledge', { schema: acknowledgeContract }, async (request) => actOnRow(request, request.params.key, 'ACKNOWLEDGE', request.body, idempotencyKeyFrom(request)))

  app.get('/home/today/layout', { schema: layoutContract }, async (request) => getLayout(request))

  app.put('/home/today/layout', { schema: saveLayoutContract }, async (request) => saveLayout(request, request.body, idempotencyKeyFrom(request)))

  // B-W2a-20: Today's Snooze, Waiting on others' Nudge, Coming up.
  app.post('/home/today/rows/:key/snooze', { schema: snoozeContract }, async (request) => snoozeRow(request, request.params.key, request.body, idempotencyKeyFrom(request)))

  app.post('/home/waiting-on-others/:key/nudge', { schema: nudgeContract }, async (request) => nudge(request, request.params.key, idempotencyKeyFrom(request)))

  app.get('/home/coming-up', { schema: comingUpContract }, async (request) => comingUp(request, request.query))

  // B-W2a-79: My numbers on Today and the report pack (src/ or dist/ holds reports/defs/).
  await loadReports(fileURLToPath(new URL('../../', import.meta.url)))
  app.get('/home/numbers', { schema: numbersContract }, async (request) => myNumbers(request))
  app.get('/reports', { schema: libraryContract }, async (request) => library(request))
  app.get('/reports/:key', { schema: reportAboutContract }, async (request) => reportAbout(request, request.params.key))
  app.get('/reports/:key/results', { schema: reportResultsContract }, async (request) => reportResults(request, request.params.key, request.query as ResultsQuery))
  app.get('/reports/:key/schedule', { schema: reportScheduleContract }, async (request) => reportSchedule(request, request.params.key))
})
