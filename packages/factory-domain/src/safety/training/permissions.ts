import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Safety at work: the course catalogue and who needs which course (apps/factory-api modules/safety/training; B-W2b-133;
 * QHS-241, QHS-242; design people.skills "Course catalogue", "Who needs what", the pop-up "Course"; D.Lgs. 81/2008 art. 37),
 * in the safety area. Reading is safety.view (../organisation/permissions.ts); a course of one company is checked with can()
 * against that company, a course of the whole group asks a grant over every company.
 *
 *   safety.training.manage   keep the course catalogue: add a course (its type, hours, refresher period and hours, in
 *                            person or not, provider, legal basis), start from the standard list (the hours and periods
 *                            typed from the company's own programme), change one after reading whose dates it would move,
 *                            archive a course no role or machine type asks any more, restore it; and keep the courses a
 *                            type of machine asks of the people authorised on it, after reading what it changes for them.
 *
 * The courses a ROLE asks are the role sheet's (safety.rolesheets.manage, modules/safety/rolesheets): one owner each.
 */
export const SAFETY_TRAINING_DEFINITIONS = definePermissions('safety', {
  'training.manage': {
    risk: 'write',
    description:
      'Keep the safety course catalogue (type, hours, refresher period, in person, provider, legal basis; start from the standard list with your own hours and periods; archive a course nobody is asked for) and the courses a type of machine asks of the people authorised on it, each after reading what it changes for people.',
  },
})

export const SAFETY_TRAINING_MANAGE = 'safety.training.manage' satisfies Permission

export const SAFETY_TRAINING_PERMISSIONS: readonly Permission[] = Object.freeze([SAFETY_TRAINING_MANAGE])
