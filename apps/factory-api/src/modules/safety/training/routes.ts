import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  applyClassContract,
  courseRecordContract,
  courseStatusContract,
  createCourseContract,
  createStandardContract,
  listCoursesContract,
  machineClassNeedsContract,
  previewClassContract,
  previewCourseContract,
  requirementsContract,
  roleSheetNeedsContract,
  saveCourseContract,
  standardListContract,
} from './contract'
import { addCourse, addStandardCourses, courseRecord, listCourses, previewCourse, saveCourse, setCourseStatus, standardList } from './courses'
import { manifest } from './manifest'
import { applyClassCourses, classNeeds, listRequirements, previewClassCourses, roleSheetNeeds } from './requirements'

/**
 * The course catalogue (./courses.ts) and who needs which course (./requirements.ts), B-W2b-133. Each write is one command
 * with an Idempotency-Key; a repeated key answers from its receipt.
 */
export default defineRoutes('safety.training', manifest, async (app) => {
  app.get('/safety/training/courses', { schema: listCoursesContract }, async (request) => listCourses(request, request.query))
  app.get('/safety/training/courses/standard', { schema: standardListContract }, async (request) => standardList(request, request.query))
  app.post('/safety/training/courses/standard', { schema: createStandardContract }, async (request, reply) => {
    const answer = await addStandardCourses(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send({ courses: answer.courses })
  })
  app.get('/safety/training/courses/:courseId', { schema: courseRecordContract }, async (request) => courseRecord(request, request.params.courseId))
  app.post('/safety/training/courses', { schema: createCourseContract }, async (request, reply) => {
    const answer = await addCourse(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send({ course: answer.course })
  })
  app.post('/safety/training/courses/:courseId/preview', { schema: previewCourseContract }, async (request) => previewCourse(request, request.params.courseId, request.body))
  app.patch('/safety/training/courses/:courseId', { schema: saveCourseContract }, async (request) => saveCourse(request, request.params.courseId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/training/courses/:courseId/archive', { schema: courseStatusContract }, async (request) => setCourseStatus(request, request.params.courseId, 'ARCHIVED', request.body, idempotencyKeyFrom(request)))
  app.post('/safety/training/courses/:courseId/restore', { schema: courseStatusContract }, async (request) => setCourseStatus(request, request.params.courseId, 'ACTIVE', request.body, idempotencyKeyFrom(request)))

  app.get('/safety/training/requirements', { schema: requirementsContract }, async (request) => listRequirements(request, request.query))
  app.get('/safety/training/requirements/role-sheets/:roleSheetId', { schema: roleSheetNeedsContract }, async (request) => roleSheetNeeds(request, request.params.roleSheetId))
  app.get('/safety/training/requirements/machine-classes/:machineClassId', { schema: machineClassNeedsContract }, async (request) => classNeeds(request, request.params.machineClassId))
  app.post('/safety/training/requirements/machine-classes/:machineClassId/preview', { schema: previewClassContract }, async (request) =>
    previewClassCourses(request, request.params.machineClassId, request.body),
  )
  app.put('/safety/training/requirements/machine-classes/:machineClassId', { schema: applyClassContract }, async (request) =>
    applyClassCourses(request, request.params.machineClassId, request.body, idempotencyKeyFrom(request)),
  )
})
