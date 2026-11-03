import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { processFiles } from '../../../platform/files/service'
import { inlineDisposition } from '../../inventory/receipts/report'
import {
  announceReportContract,
  calendarContract,
  completeReportContract,
  countsContract,
  createPlanContract,
  createTypeContract,
  downloadReportContract,
  endPlanContract,
  keepPdfContract,
  listPlansContract,
  listResultsContract,
  listTypesContract,
  movePlanContract,
  planRecordContract,
  previewPdfContract,
  recordResultContract,
  resultJobContract,
  resultLockContract,
  resultRecordContract,
  updatePlanContract,
  updateTypeContract,
} from './contract'
import { manifest } from './manifest'
import { createPlan, endPlan, listPlans, movePlan, planRecord, updatePlan } from './plans'
import { checkCalendar, checkCounts, listResults } from './reads'
import { announceReport, completeReport, downloadReport, keepReport, previewReport } from './reports'
import { actOnResult, recordResult, resultRecord } from './results'
import { createCheckType, listCheckTypes, updateCheckType } from './types'

/**
 * Statutory periodic checks (B-W2b-124; ./types.ts, ./plans.ts, ./results.ts, ./reports.ts, ./reads.ts; the reminders'
 * cron ./reminders.ts). Each write is one command with an Idempotency-Key; a repeated key answers from its receipt.
 */
export default defineRoutes('plant.statutory', manifest, async (app) => {
  app.get('/plant/checks/types', { schema: listTypesContract }, async (request) => listCheckTypes(request, request.query))
  app.post('/plant/checks/types', { schema: createTypeContract }, async (request, reply) => {
    const answer = await createCheckType(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })
  app.patch('/plant/checks/types/:checkTypeId', { schema: updateTypeContract }, async (request) => updateCheckType(request, request.params.checkTypeId, request.body, idempotencyKeyFrom(request)))

  app.get('/plant/checks/counts', { schema: countsContract }, async (request) => checkCounts(request, request.query))
  app.get('/plant/checks/calendar', { schema: calendarContract }, async (request) => checkCalendar(request, request.query))

  app.get('/plant/checks/plans', { schema: listPlansContract }, async (request) => listPlans(request, request.query))
  app.get('/plant/checks/plans/:planId', { schema: planRecordContract }, async (request) => planRecord(request, request.params.planId))
  app.post('/plant/checks/plans', { schema: createPlanContract }, async (request, reply) => {
    const answer = await createPlan(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })
  app.patch('/plant/checks/plans/:planId', { schema: updatePlanContract }, async (request) => updatePlan(request, request.params.planId, request.body, idempotencyKeyFrom(request)))
  app.post('/plant/checks/plans/:planId/move', { schema: movePlanContract }, async (request) => movePlan(request, request.params.planId, request.body, idempotencyKeyFrom(request)))
  app.post('/plant/checks/plans/:planId/end', { schema: endPlanContract }, async (request) => endPlan(request, request.params.planId, request.body, idempotencyKeyFrom(request)))

  app.get('/plant/checks/results', { schema: listResultsContract }, async (request) => listResults(request, request.query))
  app.get('/plant/checks/results/:resultId', { schema: resultRecordContract }, async (request) => resultRecord(request, request.params.resultId))
  app.post('/plant/checks/results', { schema: recordResultContract }, async (request, reply) => {
    const answer = await recordResult(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })
  app.post('/plant/checks/results/:resultId/job', { schema: resultJobContract }, async (request, reply) => {
    const answer = await actOnResult(request, request.params.resultId, 'job', request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })
  app.post('/plant/checks/results/:resultId/lock', { schema: resultLockContract }, async (request, reply) => {
    const answer = await actOnResult(request, request.params.resultId, 'lock', request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })

  app.post('/plant/checks/results/:resultId/reports', { schema: announceReportContract }, async (request, reply) => reply.code(201).send(await announceReport(processFiles(), request, request.params.resultId, request.body, idempotencyKeyFrom(request))))
  app.post('/plant/checks/results/:resultId/reports/:fileId/complete', { schema: completeReportContract }, async (request) => completeReport(processFiles(), request, request.params.resultId, request.params.fileId, idempotencyKeyFrom(request)))
  app.get('/plant/checks/results/:resultId/reports/:fileId/download', { schema: downloadReportContract }, async (request) => downloadReport(processFiles(), request, request.params.resultId, request.params.fileId))
  app.get('/plant/checks/results/:resultId/pdf', { schema: previewPdfContract }, async (request, reply) => {
    const { pdf, fileName } = await previewReport(request, request.params.resultId, request.query)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })
  app.post('/plant/checks/results/:resultId/pdf', { schema: keepPdfContract }, async (request, reply) => reply.code(201).send(await keepReport(processFiles(), request, request.params.resultId, request.body, idempotencyKeyFrom(request))))
})
