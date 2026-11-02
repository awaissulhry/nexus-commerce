import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireFloorStepUp } from '../../../platform/auth/floor/step-up'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { earningsByWorkerContract, earningsReportContract } from '../reports/earnings/contract'
import { earningsByWorker, earningsReport } from '../reports/earnings/report'
import {
  adjustContract,
  approveStatementContract,
  backContract,
  correctContract,
  countHeldContract,
  countsContract,
  createPeriodContract,
  employeeStatementsContract,
  entryContract,
  floorMineContract,
  heldListContract,
  heldRecordContract,
  labourCostContract,
  leadReviewContract,
  ledgerContract,
  lockContract,
  notPaidHeldContract,
  openStatementContract,
  periodContract,
  periodsContract,
  reopenContract,
  runContract,
  statementsContract,
} from './contract'
import { adjust, correctEntry, counts, entry, ledger } from './entries'
import { floorMine } from './floor'
import { countHeld, heldRecord, listHeld, notPaidHeld } from './held'
import { labourCost } from './labour-cost'
import { manifest } from './manifest'
import { backToPreview, createPeriod, listPeriods, lockPeriod, period, reopenPeriod, runPeriod, startReview } from './periods'
import { approveStatement, leadReviewStatement, listStatements, openStatement, statementsOfEmployee } from './statements'

/**
 * Earnings and pay periods (B-W2b-43; GATE-PIECE-PAY; c.c. arts. 2100-2101): the append-only earnings ledger, scans that pay
 * only while clocked in, held scans, waiting that does not cut pay, the monthly period previewed, reviewed and locked, the
 * worker statement, labour cost per piece and the earnings report. Nothing is paid outside a site's piece-pay window: the
 * switch ships OFF and goes off with the PERFORMANCE legal gate (B-W2b-34). The screens are B-W2b-62's and -64's; My day
 * (B-W2b-68) reads the floor route.
 */
export default defineRoutes('people.earnings', manifest, async (app) => {
  app.get('/people/pay-periods', { schema: periodsContract }, async (request) => listPeriods(request, request.query))
  app.post('/people/pay-periods', { schema: createPeriodContract }, async (request, reply) => {
    const answer = await createPeriod(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.created && !answer.replayed ? 201 : 200).send(answer)
  })
  app.get('/people/pay-periods/:periodId', { schema: periodContract }, async (request) => period(request, request.params.periodId))
  app.post('/people/pay-periods/:periodId/run', { schema: runContract }, async (request) => runPeriod(request, request.params.periodId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/pay-periods/:periodId/reopen', { schema: reopenContract }, async (request) => reopenPeriod(request, request.params.periodId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/pay-periods/:periodId/review', { schema: runContract }, async (request) => startReview(request, request.params.periodId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/pay-periods/:periodId/review/back', { schema: backContract }, async (request) => backToPreview(request, request.params.periodId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/pay-periods/:periodId/lock', { schema: lockContract }, async (request) => lockPeriod(request, request.params.periodId, request.body, idempotencyKeyFrom(request)))
  app.get('/people/pay-periods/:periodId/statements', { schema: statementsContract }, async (request) => listStatements(request, request.params.periodId))
  app.post('/people/statements/:statementId/open', { schema: openStatementContract }, async (request) => openStatement(request, request.params.statementId, request.body))
  app.post('/people/statements/:statementId/approve', { schema: approveStatementContract }, async (request) => approveStatement(request, request.params.statementId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/statements/:statementId/lead-review', { schema: leadReviewContract }, async (request) => leadReviewStatement(request, request.params.statementId, request.body, idempotencyKeyFrom(request)))
  app.get('/people/employees/:employeeId/statements', { schema: employeeStatementsContract }, async (request) => statementsOfEmployee(request, request.params.employeeId))
  app.get('/people/held-scans', { schema: heldListContract }, async (request) => listHeld(request, request.query))
  app.get('/people/held-scans/:heldScanId', { schema: heldRecordContract }, async (request) => heldRecord(request, request.params.heldScanId))
  app.post('/people/held-scans/:heldScanId/count', { schema: countHeldContract }, async (request) => countHeld(request, request.params.heldScanId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/held-scans/:heldScanId/not-paid', { schema: notPaidHeldContract }, async (request) => notPaidHeld(request, request.params.heldScanId, request.body, idempotencyKeyFrom(request)))
  app.get('/people/earnings/ledger', { schema: ledgerContract }, async (request) => ledger(request, request.query))
  app.get('/people/earnings/entries/:entryId', { schema: entryContract }, async (request) => entry(request, request.params.entryId))
  app.post('/people/earnings/entries/:entryId/correct', { schema: correctContract }, async (request) => correctEntry(request, request.params.entryId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/earnings/adjustments', { schema: adjustContract }, async (request, reply) => reply.code(201).send(await adjust(request, request.body, idempotencyKeyFrom(request))))
  app.get('/people/earnings/counts', { schema: countsContract }, async (request) => counts(request, request.query))
  app.get('/people/earnings/labour-cost', { schema: labourCostContract }, async (request) => labourCost(request, request.query))
  app.get('/people/earnings/floor/mine', { schema: floorMineContract }, async (request) => {
    requireFloorStepUp(officeAuthOf(app), request)
    return floorMine(request, request.query)
  })
  app.get('/people/reports/earnings', { schema: earningsReportContract }, async (request) => earningsReport(request, request.query))
  app.post('/people/reports/earnings/by-worker', { schema: earningsByWorkerContract }, async (request) => earningsByWorker(request, request.body))
})
