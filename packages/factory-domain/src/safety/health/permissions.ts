import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Safety at work: health surveillance (apps/factory-api modules/safety/health; B-W2b-135; QHS-252, QHS-253, QHS-254, QHS-256;
 * design plant.health SCR-212; D.Lgs. 81/2008 art. 41; GDPR art. 9), in the safety area. Checked with can() against the
 * person's company and site (a plan: its role sheet's). The company holds the doctor's fitness JUDGEMENT only, never a
 * diagnosis. No floor role, no partner and no link holds any of these; the read-only role holds none (every one is a write
 * risk on purpose: each read of protected data is recorded).
 *
 *   safety.health.view     protected (GDPR art. 9): the due list with names, the visits, the fitness judgements (outcome, task
 *                          limits, expiry), the visit list for the doctor and the judgement's copy, each view recorded in the
 *                          protected view log (who looked, at whose record, when); the page's tiles. HR and the occupational
 *                          doctor.
 *   safety.health.manage   plan the visits (from the plans, or one by hand), book them (day and place), move, cancel or mark
 *                          one done; record a judgement with the doctor's copy; void a wrong one. HR and the occupational doctor.
 *   safety.health.plans    keep the plans per role as the doctor set them: how often (1 to 60 months), the doctor, the
 *                          end-of-employment visit. Whether a role needs visits comes from its role sheet. No person in a plan.
 *                          The safety officer and the occupational doctor. Reading the plans is safety.view (no person).
 *   safety.health.views    "Who looked": the protected view log of the health records (viewer, time, what) and the fitness
 *                          yes/no checks. HR and the data protection officer (a custom role).
 *
 * "Authorise a machine" (People › Skills, people.authorisations.manage) reads fit yes or no only, never the outcome's words or
 * the task limits (modules/safety/health/fitness.ts).
 */
export const SAFETY_HEALTH_DEFINITIONS = definePermissions('safety', {
  'health.view': {
    risk: 'write',
    description:
      'Protected data (GDPR art. 9): see who is due which health surveillance visit, the visits and the fitness judgements (outcome, task limits, expiry: never a diagnosis), print the visit list for the doctor and open a judgement’s copy; each view is recorded with who looked and when.',
  },
  'health.manage': {
    risk: 'write',
    description:
      'Keep the health surveillance visits and the fitness judgements: plan visits from the plans per role or one by hand, book them with the day and place, move, cancel or mark one done, record the doctor’s judgement (outcome and task limits only) with its copy, void a wrong one.',
  },
  'health.plans': {
    risk: 'write',
    description: 'Keep the health surveillance plans per role as the occupational doctor set them: how often a visit is due, the doctor, whether the end of the employment asks a visit. Whether a role needs visits comes from its role sheet.',
  },
  'health.views': {
    risk: 'write',
    description: 'See who looked at the protected health records (the view log: who, when, what) and who checked a person’s fitness yes or no: for HR and the data protection officer.',
  },
})

export const SAFETY_HEALTH_VIEW = 'safety.health.view' satisfies Permission
export const SAFETY_HEALTH_MANAGE = 'safety.health.manage' satisfies Permission
export const SAFETY_HEALTH_PLANS = 'safety.health.plans' satisfies Permission
export const SAFETY_HEALTH_VIEWS = 'safety.health.views' satisfies Permission

export const SAFETY_HEALTH_PERMISSIONS: readonly Permission[] = Object.freeze([SAFETY_HEALTH_VIEW, SAFETY_HEALTH_MANAGE, SAFETY_HEALTH_PLANS, SAFETY_HEALTH_VIEWS])
