import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { readAreaCheck } from './area-check'
import {
  areaCheckContract,
  correctGradingContract,
  createGradeRuleContract,
  editGradeRuleContract,
  gradeMixContract,
  gradeRulesContract,
  gradingContract,
  measuresContract,
  recordMeasureContract,
} from './contract'
import { dashboardContract, photosContract, readHidePhotos, readLeatherDashboard } from './dashboard'
import { readGradeMix } from './grade-mix'
import { createGradeRule, editGradeRule, readGradeRules } from './grade-rules'
import { correctGrading, readGrading } from './grading'
import { manifest } from './manifest'
import { readMeasures, recordMeasure } from './measures'

/**
 * Hides as stock (B-W2b-94): an article's grades and usable shares (./grade-rules.ts), a hide's grade and shade group by
 * record with its thickness and defects (./grading.ts), a whole hide measured again against the tannery's area with the
 * stock corrected by an adjustment move (./measures.ts), a lot's area check with the claim it opens (./area-check.ts), and
 * the grade mix with the usable area, hides beside area (./grade-mix.ts).
 */
export default defineRoutes('inventory.hides', manifest, async (app) => {
  app.get('/product/materials/:materialId/grades', { schema: gradeRulesContract }, async (request) => readGradeRules(request, request.params.materialId))

  app.post('/product/materials/:materialId/grades', { schema: createGradeRuleContract }, async (request, reply) =>
    reply.code(201).send(await createGradeRule(request, request.params.materialId, request.body, idempotencyKeyFrom(request))),
  )

  app.patch('/product/materials/:materialId/grades/:ruleId', { schema: editGradeRuleContract }, async (request) =>
    editGradeRule(request, request.params.materialId, request.params.ruleId, request.body, idempotencyKeyFrom(request)),
  )

  app.get('/inventory/hides/:hideId/grading', { schema: gradingContract }, async (request) => readGrading(request, request.params.hideId))

  app.patch('/inventory/hides/:hideId/grading', { schema: correctGradingContract }, async (request) => correctGrading(request, request.params.hideId, request.body, idempotencyKeyFrom(request)))

  app.get('/inventory/hides/:hideId/measures', { schema: measuresContract }, async (request) => readMeasures(request, request.params.hideId))

  app.post('/inventory/hides/:hideId/measures', { schema: recordMeasureContract }, async (request, reply) =>
    reply.code(201).send(await recordMeasure(request, request.params.hideId, request.body, idempotencyKeyFrom(request))),
  )

  app.get('/inventory/lots/:lotId/area-check', { schema: areaCheckContract }, async (request) => readAreaCheck(request, request.params.lotId))

  app.get('/inventory/leather/grade-mix', { schema: gradeMixContract }, async (request) => readGradeMix(request, request.query))

  // B-W2b-131: the leather dashboard's own reads (what lies at subcontractors, what is on hold) and the hides' photos.
  app.get('/inventory/leather/dashboard', { schema: dashboardContract }, async (request) => readLeatherDashboard(request, request.query))

  app.get('/inventory/leather/photos', { schema: photosContract }, async (request) => readHidePhotos(request, request.query))
})
