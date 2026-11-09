import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  createDefectContract,
  createDispositionContract,
  deleteDefectContract,
  dispositionsContract,
  editDefectContract,
  editDispositionContract,
  libraryContract,
  pickerContract,
  standardDispositionsContract,
  starterContract,
} from './contract'
import { addStarter, createDefect, deleteDefect, editDefect, readLibrary, readPicker } from './defects'
import { addStandardDispositions, createDisposition, editDisposition, readDispositions } from './dispositions'
import { addStarterCauses, createCause, deleteCause, editCause, readCauses } from './causes'
import { addStarterGrades, createGrade, editGrade, readGrades } from './grades'
import { manifest } from './manifest'
import { readSeverityWords, saveSeverityWords } from './severity-words'
import { readCoverage, readVocabulary } from './vocabulary'
import {
  causesContract,
  coverageContract,
  createCauseContract,
  createGradeContract,
  deleteCauseContract,
  editCauseContract,
  editGradeContract,
  gradesContract,
  saveSeverityContract,
  severityContract,
  starterCausesContract,
  starterGradesContract,
  vocabularyContract,
} from './vocabulary-contract'

/**
 * The defect library (./defects.ts) and the disposition codes (./dispositions.ts) of B-W2a-26 (QHS-001, QHS-005); the
 * stock move a disposition posts is ./stock.ts (postDispositionInCommand, called by the NCR's decisions). B-W2b-90's
 * defect vocabulary: the severity classes (./severity-words.ts; B-W2b-213: the tenant's words per class and language), the cause codes (./causes.ts), the leather grades and hide
 * defects (./grades.ts) and the vocabulary in the person's language (./vocabulary.ts).
 */
export default defineRoutes('quality.defects', manifest, async (app) => {
  app.get('/quality/defects', { schema: libraryContract }, async (request) => readLibrary(request, request.query))

  app.get('/quality/defects/picker', { schema: pickerContract }, async (request) => readPicker(request, request.query))

  app.post('/quality/defects', { schema: createDefectContract }, async (request, reply) => reply.code(201).send(await createDefect(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/quality/defects/:defectId', { schema: editDefectContract }, async (request) => editDefect(request, request.params.defectId, request.body, idempotencyKeyFrom(request)))

  app.delete('/quality/defects/:defectId', { schema: deleteDefectContract }, async (request) => deleteDefect(request, request.params.defectId, request.query, idempotencyKeyFrom(request)))

  app.post('/quality/defects/starter', { schema: starterContract }, async (request) => addStarter(request, idempotencyKeyFrom(request)))

  app.get('/quality/dispositions', { schema: dispositionsContract }, async (request) => readDispositions(request))

  app.post('/quality/dispositions', { schema: createDispositionContract }, async (request, reply) => reply.code(201).send(await createDisposition(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/quality/dispositions/:dispositionId', { schema: editDispositionContract }, async (request) => editDisposition(request, request.params.dispositionId, request.body, idempotencyKeyFrom(request)))

  app.post('/quality/dispositions/standard', { schema: standardDispositionsContract }, async (request) => addStandardDispositions(request, idempotencyKeyFrom(request)))

  // ---- B-W2b-90: the defect vocabulary ------------------------------------------------------------------------------
  app.get('/quality/severity', { schema: severityContract }, async (request) => readSeverityWords(request))

  // B-W2b-213: the tenant's severity words (QualitySettings.severityTexts).
  app.put('/quality/severity', { schema: saveSeverityContract }, async (request) => saveSeverityWords(request, request.body, idempotencyKeyFrom(request)))

  app.get('/quality/causes', { schema: causesContract }, async (request) => readCauses(request, request.query))

  app.post('/quality/causes', { schema: createCauseContract }, async (request, reply) => reply.code(201).send(await createCause(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/quality/causes/:causeId', { schema: editCauseContract }, async (request) => editCause(request, request.params.causeId, request.body, idempotencyKeyFrom(request)))

  app.delete('/quality/causes/:causeId', { schema: deleteCauseContract }, async (request) => deleteCause(request, request.params.causeId, request.query, idempotencyKeyFrom(request)))

  app.post('/quality/causes/starter', { schema: starterCausesContract }, async (request) => addStarterCauses(request, idempotencyKeyFrom(request)))

  app.get('/quality/grades', { schema: gradesContract }, async (request) => readGrades(request, request.query))

  app.post('/quality/grades', { schema: createGradeContract }, async (request, reply) => reply.code(201).send(await createGrade(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/quality/grades/:gradeId', { schema: editGradeContract }, async (request) => editGrade(request, request.params.gradeId, request.body, idempotencyKeyFrom(request)))

  app.post('/quality/grades/starter', { schema: starterGradesContract }, async (request) => addStarterGrades(request, idempotencyKeyFrom(request)))

  app.get('/quality/vocabulary', { schema: vocabularyContract }, async (request) => readVocabulary(request, request.query))

  app.get('/quality/vocabulary/coverage', { schema: coverageContract }, async (request) => readCoverage(request))
})
