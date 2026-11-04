import { defineManifest } from '../../../core/manifest'

/**
 * The course catalogue and who needs which course (B-W2b-133; QHS-241, QHS-242; design people.skills "Course catalogue",
 * "Who needs what", the pop-up "Course"). Office only; safety.view reads, safety.training.manage keeps the catalogue and the
 * courses a type of machine asks. Handlers check each record with can() against its company and site (`record`): a course
 * of the whole group and a machine type's courses ask a grant over every company to change.
 */
const view = { audiences: ['office'], permission: 'safety.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'safety.training.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /safety/training/courses': view,
  'GET /safety/training/courses/standard': manage,
  'POST /safety/training/courses/standard': manage,
  'GET /safety/training/courses/:courseId': view,
  'POST /safety/training/courses': manage,
  'POST /safety/training/courses/:courseId/preview': manage,
  'PATCH /safety/training/courses/:courseId': manage,
  'POST /safety/training/courses/:courseId/archive': manage,
  'POST /safety/training/courses/:courseId/restore': manage,
  'GET /safety/training/requirements': view,
  'GET /safety/training/requirements/role-sheets/:roleSheetId': view,
  'GET /safety/training/requirements/machine-classes/:machineClassId': view,
  'POST /safety/training/requirements/machine-classes/:machineClassId/preview': manage,
  'PUT /safety/training/requirements/machine-classes/:machineClassId': manage,
})
