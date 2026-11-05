import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The safety course catalogue and the courses a type of machine asks (B-W2b-133; QHS-241, QHS-242; design people.skills
 * "Course catalogue", "Who needs what"). apps/factory-api's modules/safety/training emits them in the commands that make the
 * change. Their own module folder (the safety events file is B-W2b-120's), as safety-rolesheets.
 *
 *   safety_course.changed          a course was added (alone, or from the standard list), changed (which fields; how many
 *                                  people's dates the new refresher period would put elsewhere), archived or restored. The
 *                                  Skills page reads its catalogue again.
 *   training_requirement.changed   the courses a type of machine asks changed: which came, went or changed their days, and
 *                                  how many people are authorised on it. "Who needs what" reads again. (A role's courses
 *                                  change with role_sheet.changed.)
 *
 * Reach the safety pages of the office (safety.view): ids, counts and states only; never a name, never the floor.
 */

const live = (fields: readonly string[]) => ({ permission: 'safety.view', fields }) as const

export const COURSE_CHANGES = ['ADDED', 'EDITED', 'ARCHIVED', 'RESTORED'] as const

export const events = [
  defineEvent({
    type: 'safety_course.changed',
    context: 'safety-training',
    description: 'A safety course was added to the catalogue, changed (its hours, refresher period, in person, provider, legal basis or names), archived or restored.',
    payload: z.strictObject({
      courseId: z.uuid(),
      change: z.enum(COURSE_CHANGES),
      /** EDITED: the fields that changed. */
      fields: z.array(z.string()),
      /** EDITED with a new refresher period: how many people's dates it would put elsewhere (their records keep theirs). */
      datesThatWouldMove: z.number().int().min(0),
    }),
    live: live(['courseId', 'change']),
  }),
  defineEvent({
    type: 'training_requirement.changed',
    context: 'safety-training',
    description: 'The courses a type of machine asks of the people authorised on it changed: which came, went or changed their days.',
    payload: z.strictObject({
      machineClassId: z.uuid(),
      coursesAdded: z.array(z.uuid()),
      coursesRemoved: z.array(z.uuid()),
      coursesChanged: z.array(z.uuid()),
      /** People authorised on the type of machine now (a count). */
      people: z.number().int().min(0),
    }),
    live: live(['machineClassId']),
  }),
] as const
