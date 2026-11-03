import { z } from 'zod'
import { defineEvent } from '../events/define'
import { PLAN_STAGES } from '../quality/plans/rules'

/**
 * Inspection plans (B-W2b-92; QHS-008, QHS-009, QHS-016; design quality.plans "Live: plan.version_approved → Plans grid").
 * apps/factory-api's modules/quality/plans emits them in the commands that make the change. Its own module folder: the
 * quality events file is other steps' (B-W2b-90, -93 …).
 *
 *   inspection_plan.changed           a plan was made or changed (name, owner, where it applies), a version drafted,
 *                                     saved, sent for approval or retired
 *   inspection_plan.version_approved  a second person approved a draft: it is in force for new records, frozen with its
 *                                     checks; the version in force before it is retired in the same command
 *
 * Reach the office's Plans grid and plan record (quality.plans.view). Never the floor: a record keeps the version it
 * opened with, so nothing on a bench changes. Ids, codes, numbers and states only, never a person.
 */

const live = { permission: 'quality.plans.view', fields: ['planId', 'code', 'change', 'versionId', 'number'] } as const

export const PLAN_CHANGES = ['CREATED', 'EDITED', 'VERSION_DRAFTED', 'VERSION_SAVED', 'SUBMITTED', 'VERSION_RETIRED'] as const
export type PlanChange = (typeof PLAN_CHANGES)[number]

export const events = [
  defineEvent({
    type: 'inspection_plan.changed',
    context: 'quality-plans',
    description: "An inspection plan was made or changed (name, owner, where it applies), or one of its versions was drafted, saved, sent for approval or retired.",
    payload: z.strictObject({
      planId: z.uuid(),
      code: z.string(),
      stage: z.enum(PLAN_STAGES),
      change: z.enum(PLAN_CHANGES),
      versionId: z.uuid().nullable(),
      number: z.number().int().min(1).nullable(),
    }),
    live,
  }),
  defineEvent({
    type: 'inspection_plan.version_approved',
    context: 'quality-plans',
    description: 'A second person approved a draft version of an inspection plan: new records run on it, frozen with its checks; the version in force before it was retired.',
    payload: z.strictObject({
      planId: z.uuid(),
      code: z.string(),
      stage: z.enum(PLAN_STAGES),
      versionId: z.uuid(),
      number: z.number().int().min(1),
      retiredVersionId: z.uuid().nullable(),
    }),
    live: { permission: 'quality.plans.view', fields: ['planId', 'code', 'versionId', 'number'] },
  }),
] as const
