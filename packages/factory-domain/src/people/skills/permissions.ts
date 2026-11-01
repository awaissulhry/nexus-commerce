import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * People: skills and machine authorisations (apps/factory-api modules/people/skills; B-W2b-39; MES-241, MES-244, MES-246,
 * MES-024; design people.skills "Matrix", "Sign off a trainee", "Authorise a machine", people.employees › Skills &
 * training), in the people area. Each is checked with can() against the person's (or the skill's) company and site.
 *
 * A skill level is a qualification a person judges (MES-281: never computed), never a figure about one person's work:
 * nothing here ranks people, counts skills per person or sums them into a score (Statuto dei Lavoratori art. 4; AI Act
 * Annex III 4(b)).
 *
 *   people.skills.view            the skills, the matrix, a person's levels and authorisations, the qualification check
 *   people.skills.manage          the skills of the group or a company, the levels people hold, trainee periods and the
 *                                 trainee's sign-off (a signing act: the office's fresh code)
 *   people.authorisations.manage  authorise a person on a class of machine, change until when, revoke it
 */
export const PEOPLE_SKILLS_DEFINITIONS = definePermissions('people', {
  'skills.view': {
    risk: 'read',
    description:
      "See the skills, the skills matrix (the level each person holds in each operation or machine, trainees and their sign-off, the machines each person is authorised on) and the qualification check for an operation or a machine. A level is a qualification, never a figure about one person's work.",
  },
  'skills.manage': {
    risk: 'write',
    description:
      "Keep the skills (an operation, a class of machine or a general skill), set the level a person holds (a person's judgement: who assessed it is kept), give a trainee period, sign a trainee off (with a fresh code) and remove a skill no longer held.",
  },
  'authorisations.manage': {
    risk: 'write',
    description: 'Authorise a person to operate a class of machine (from a day, until a day or open), change until when, and revoke it with the reason.',
  },
})

export const PEOPLE_SKILLS_VIEW = 'people.skills.view' satisfies Permission
export const PEOPLE_SKILLS_MANAGE = 'people.skills.manage' satisfies Permission
export const PEOPLE_AUTHORISATIONS_MANAGE = 'people.authorisations.manage' satisfies Permission

export const PEOPLE_SKILLS_PERMISSIONS: readonly Permission[] = Object.freeze([PEOPLE_SKILLS_VIEW, PEOPLE_SKILLS_MANAGE, PEOPLE_AUTHORISATIONS_MANAGE])
