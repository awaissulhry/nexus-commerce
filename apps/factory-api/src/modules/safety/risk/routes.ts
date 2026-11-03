import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { processFiles } from '../../../platform/files/service'
import { inlineDisposition } from '../../inventory/receipts/report'
import { addAssessment, assessmentRecord, editAssessment, listAssessments, riskCounts } from './assessments'
import {
  assessmentRecordContract,
  countsContract,
  createAssessmentContract,
  createMeasureContract,
  editAssessmentContract,
  editMeasureContract,
  freezeVersionContract,
  keepSealContract,
  listAssessmentsContract,
  listMeasuresContract,
  measureRecordContract,
  moveMeasureContract,
  ownersContract,
  paperSignatureContract,
  previewSealContract,
  signVersionContract,
  withdrawVersionContract,
} from './contract'
import { manifest } from './manifest'
import { addMeasure, editMeasure, listMeasures, measureOwners, measureRecord, moveMeasure } from './measures'
import { keepSeal, previewSeal } from './seal'
import { freezeVersion, recordPaperSignature, signVersion, withdrawVersion } from './versions'

/**
 * The risk assessment, the DVR (B-W2b-122; ./assessments.ts, ./versions.ts, ./seal.ts, ./measures.ts). Each write is one
 * command with an Idempotency-Key; a repeated key answers from its receipt.
 */
export default defineRoutes('safety.risk', manifest, async (app) => {
  app.get('/safety/risk/assessments', { schema: listAssessmentsContract }, async (request) => listAssessments(request, request.query))
  app.get('/safety/risk/counts', { schema: countsContract }, async (request) => riskCounts(request, request.query))
  app.get('/safety/risk/assessments/:assessmentId', { schema: assessmentRecordContract }, async (request) => assessmentRecord(request, request.params.assessmentId))
  app.post('/safety/risk/assessments', { schema: createAssessmentContract }, async (request, reply) => {
    const answer = await addAssessment(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send({ assessment: answer.assessment })
  })
  app.patch('/safety/risk/assessments/:assessmentId', { schema: editAssessmentContract }, async (request) => editAssessment(request, request.params.assessmentId, request.body, idempotencyKeyFrom(request)))

  app.post('/safety/risk/assessments/:assessmentId/versions', { schema: freezeVersionContract }, async (request, reply) => {
    const answer = await freezeVersion(request, request.params.assessmentId, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send({ version: answer.version })
  })
  app.post('/safety/risk/versions/:versionId/withdraw', { schema: withdrawVersionContract }, async (request) => withdrawVersion(request, request.params.versionId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/risk/versions/:versionId/sign', { schema: signVersionContract }, async (request) => {
    const answer = await signVersion(request, request.params.versionId, request.body, { files: processFiles(), stepUp: () => requireStepUp(officeAuthOf(app), request), idempotencyKey: idempotencyKeyFrom(request) })
    return { version: answer.version, complete: answer.complete, sealed: answer.sealed }
  })
  app.post('/safety/risk/versions/:versionId/signatures', { schema: paperSignatureContract }, async (request, reply) => {
    const answer = await recordPaperSignature(request, request.params.versionId, request.body, { files: processFiles(), idempotencyKey: idempotencyKeyFrom(request) })
    return reply.code(answer.replayed ? 200 : 201).send({ version: answer.version, complete: answer.complete, sealed: answer.sealed })
  })
  app.get('/safety/risk/versions/:versionId/seal', { schema: previewSealContract }, async (request, reply) => {
    const { pdf, fileName } = await previewSeal(request, request.params.versionId, request.query)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })
  app.post('/safety/risk/versions/:versionId/seal', { schema: keepSealContract }, async (request, reply) =>
    reply.code(201).send(await keepSeal(processFiles(), request, request.params.versionId, { language: request.body.language, idempotencyKey: idempotencyKeyFrom(request) })),
  )

  app.get('/safety/risk/measures', { schema: listMeasuresContract }, async (request) => listMeasures(request, request.query))
  app.get('/safety/risk/measures/:measureId', { schema: measureRecordContract }, async (request) => measureRecord(request, request.params.measureId))
  app.get('/safety/risk/owners', { schema: ownersContract }, async (request) => measureOwners(request, request.query))
  app.post('/safety/risk/measures', { schema: createMeasureContract }, async (request, reply) => {
    const answer = await addMeasure(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send({ measure: answer.measure })
  })
  app.patch('/safety/risk/measures/:measureId', { schema: editMeasureContract }, async (request) => editMeasure(request, request.params.measureId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/risk/measures/:measureId/status', { schema: moveMeasureContract }, async (request) => moveMeasure(request, request.params.measureId, request.body, idempotencyKeyFrom(request)))
})
