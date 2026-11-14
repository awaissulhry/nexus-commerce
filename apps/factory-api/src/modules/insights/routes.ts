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
// B-W2b-348: Sales reports (sales-reports/): the headline, the order intake, the backlog by promise week, the return reasons,
// quote speed (Sales › Quotes).
import { backlogContract, headlineContract, intakeContract, quoteSpeedContract, returnsContract } from './sales-reports/contract'
import { backlogAnswer, headlineAnswer, intakeAnswer, quoteSpeedAnswer, returnsAnswer } from './sales-reports/reads'
// B-W2b-428: the metric layer — the KPI library and its versions (kpis/), the facts and measures (facts/).
import { factsContract, measuresContract, rebuildContract } from './facts/contract'
import { factsAnswer, measuresAnswer, rebuildAnswer, type FactsQuery } from './facts/answers'
import { activateContract, deleteContract, draftContract, editContract, libraryContract as kpiLibraryContract, recordContract, retireContract, syncContract, valueContract } from './kpis/contract'
import { kpiLibrary, kpiRecord, kpiValueAnswer } from './kpis/library'
import { syncKpis } from './kpis/sync'
import { activateVersion, deleteDraft, draftVersion, editDraft, retireKpi } from './kpis/versions'
// B-W2b-429: the ready KPIs' drills (kpis/drills/).
import { leadDrillContract, leatherDrillContract, marginDrillContract, otifDrillContract, supplyDrillContract, wipDrillContract } from './kpis/drills/contract'
import { leadDrill } from './kpis/drills/lead-times'
import { leatherDrill } from './kpis/drills/leather-yield'
import { marginDrill } from './kpis/drills/margin'
import { otifDrill } from './kpis/drills/otif'
import { supplyDrill } from './kpis/drills/supply'
import { wipDrill } from './kpis/drills/wip'
// B-W2b-434: the dashboards (dashboards/).
import { boardsContract, byCompanyContract, layoutContract as dashboardLayoutContract, needsActionContract, numbersContract as dashboardNumbersContract, resetLayoutContract, saveLayoutContract as saveDashboardLayoutContract, trendsContract, wipContract } from './dashboards/contract'
import { getDashboardLayout, resetDashboardLayout, saveDashboardLayout } from './dashboards/layout'
import { byCompanyAnswer, numbersAnswer } from './dashboards/numbers'
import { dashboardsAnswer } from './dashboards/picker'
import { needsActionAnswer, trendsAnswer, wipAnswer } from './dashboards/sections'

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

  // B-W2b-348 (SAL-105, SAL-106, SAL-458; design sales.reports SCR-250 and Sales › Quotes sec quotes.speed): read only, office.
  app.get('/sales/reports/headline', { schema: headlineContract }, async (request) => headlineAnswer(request, request.query))
  app.get('/sales/reports/intake', { schema: intakeContract }, async (request) => intakeAnswer(request, request.query))
  app.get('/sales/reports/backlog', { schema: backlogContract }, async (request) => backlogAnswer(request, request.query))
  app.get('/sales/reports/returns', { schema: returnsContract }, async (request) => returnsAnswer(request, request.query))
  app.get('/sales/reports/quote-speed', { schema: quoteSpeedContract }, async (request) => quoteSpeedAnswer(request, request.query))

  // B-W2b-428 (ANA-012, ANA-028, ANA-069, ANA-070): the KPI library (read: home.kpis.view; write: home.kpis.manage), each value
  // also its measures' list permissions and grains; the facts and measures (the measure's permission and grain).
  app.get('/insights/kpis', { schema: kpiLibraryContract }, async (request) => kpiLibrary(request, request.query))
  // B-W2b-429 (ANA-013, ANA-014, ANA-015, ANA-020, ANA-021, ANA-023; follow-up KP2:01): each ready KPI's records with the
  // filters it needs (home.kpis.view; each drill also its KPI's measures' list permissions and grains). Before /:key.
  app.get('/insights/kpis/drills/otif', { schema: otifDrillContract }, async (request) => otifDrill(request, request.query))
  app.get('/insights/kpis/drills/lead-times', { schema: leadDrillContract }, async (request) => leadDrill(request, request.query))
  app.get('/insights/kpis/drills/wip', { schema: wipDrillContract }, async (request) => wipDrill(request, request.query))
  app.get('/insights/kpis/drills/leather-yield', { schema: leatherDrillContract }, async (request) => leatherDrill(request, request.query))
  app.get('/insights/kpis/drills/margin', { schema: marginDrillContract }, async (request) => marginDrill(request, request.query))
  app.get('/insights/kpis/drills/supply', { schema: supplyDrillContract }, async (request) => supplyDrill(request, request.query))
  app.post('/insights/kpis/sync', { schema: syncContract }, async (request) => syncKpis(request, idempotencyKeyFrom(request)))
  app.get('/insights/kpis/:key', { schema: recordContract }, async (request) => kpiRecord(request, request.params.key, request.query))
  app.get('/insights/kpis/:key/value', { schema: valueContract }, async (request) => kpiValueAnswer(request, request.params.key, request.query))
  app.post('/insights/kpis/:key/versions', { schema: draftContract }, async (request, reply) => reply.code(201).send(await draftVersion(request, request.params.key, request.body, idempotencyKeyFrom(request))))
  app.post('/insights/kpis/:key/retire', { schema: retireContract }, async (request) => retireKpi(request, request.params.key, request.body, idempotencyKeyFrom(request)))
  app.patch('/insights/kpis/versions/:id', { schema: editContract }, async (request) => editDraft(request, request.params.id, request.body, idempotencyKeyFrom(request)))
  app.post('/insights/kpis/versions/:id/activate', { schema: activateContract }, async (request) => activateVersion(request, request.params.id, request.body, idempotencyKeyFrom(request)))
  app.delete('/insights/kpis/versions/:id', { schema: deleteContract }, async (request) => deleteDraft(request, request.params.id, request.query.version, idempotencyKeyFrom(request)))
  app.get('/insights/measures', { schema: measuresContract }, async (request) => measuresAnswer(request))
  app.get('/insights/facts', { schema: factsContract }, async (request) => factsAnswer(request, request.query as FactsQuery))
  app.post('/insights/facts/rebuild', { schema: rebuildContract }, async (request) => rebuildAnswer(request, request.body, idempotencyKeyFrom(request)))

  // B-W2b-434 (ANA-002, ANA-003, ANA-004; design home.dashboards SCR-031 / SCR-103): the dashboards, office, home.kpis.view; every
  // number also asks its KPI's measures' list permissions and grains (kpiReading), a layout is the person's own.
  app.get('/insights/dashboards', { schema: boardsContract }, async (request) => dashboardsAnswer(request))
  app.get('/insights/dashboards/needs-action', { schema: needsActionContract }, async (request) => needsActionAnswer(request, request.query))
  app.get('/insights/dashboards/trends', { schema: trendsContract }, async (request) => trendsAnswer(request, request.query))
  app.get('/insights/dashboards/wip', { schema: wipContract }, async (request) => wipAnswer(request, request.query))
  app.get('/insights/dashboards/:board/numbers', { schema: dashboardNumbersContract }, async (request) => numbersAnswer(request, request.params.board, request.query))
  app.get('/insights/dashboards/:board/by-company', { schema: byCompanyContract }, async (request) => byCompanyAnswer(request, request.params.board, request.query))
  app.get('/insights/dashboards/:board/layout', { schema: dashboardLayoutContract }, async (request) => getDashboardLayout(request, request.params.board))
  app.put('/insights/dashboards/:board/layout', { schema: saveDashboardLayoutContract }, async (request) => saveDashboardLayout(request, request.params.board, request.body, idempotencyKeyFrom(request)))
  app.delete('/insights/dashboards/:board/layout', { schema: resetLayoutContract }, async (request) => resetDashboardLayout(request, request.params.board, request.query.version, idempotencyKeyFrom(request)))
})
