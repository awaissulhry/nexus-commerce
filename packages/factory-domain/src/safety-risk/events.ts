import { z } from 'zod'
import { defineEvent } from '../events/define'
import { DVR_SIGN_METHODS, DVR_SIGNER_ROLES, MEASURE_STATUSES } from '../safety/risk/rules'

/**
 * The risk assessment (B-W2b-122; QHS-230, QHS-234; design plant.risk "live: signature.collected → DocumentSeal; task.done
 * (measure) → plan"). apps/factory-api's modules/safety/risk emits them in the commands that make the change. Its own module
 * folder (the safety events file is B-W2b-120's), as plant-statutory and quality-amendments.
 *
 *   risk_assessment.changed           an assessment of a site was added, or its name, next review or note changed
 *   risk_assessment_version.changed   a version was frozen (its PDF, SHA-256 and time), signed by its last signer (with
 *                                     its certain date), withdrawn before that, or its seal was kept
 *   risk_signature.collected          one signer signed a version (the role and how), and whether it is complete now
 *   risk_measure.changed              a measure of the improvement plan was added, changed or moved to another state
 *
 * Reach the risk assessment of the office (safety.view over the record's company): ids, numbers, roles and states only;
 * never a person's name, never a cost, never the floor.
 */

const live = (fields: readonly string[]) => ({ permission: 'safety.view', fields }) as const
const day = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const ASSESSMENT_CHANGES = ['ADDED', 'EDITED'] as const
export const VERSION_CHANGES = ['FROZEN', 'SIGNED', 'WITHDRAWN', 'SEALED'] as const
export const MEASURE_CHANGES = ['ADDED', 'EDITED', 'MOVED'] as const

export const events = [
  defineEvent({
    type: 'risk_assessment.changed',
    context: 'safety-risk',
    description: 'A risk assessment (DVR) of a site or production unit was added, or its name, next review day or note changed.',
    payload: z.strictObject({ assessmentId: z.uuid(), change: z.enum(ASSESSMENT_CHANGES), nextReviewOn: day().nullable() }),
    live: live(['assessmentId', 'change']),
  }),
  defineEvent({
    type: 'risk_assessment_version.changed',
    context: 'safety-risk',
    description: "A version of a risk assessment was frozen (the consultant's PDF with its SHA-256 and the time), signed by its last signer (its certain date), withdrawn before that, or its sealed record was kept.",
    payload: z.strictObject({ assessmentId: z.uuid(), versionId: z.uuid(), versionNo: z.number().int().min(1), change: z.enum(VERSION_CHANGES), certainDateOn: day().nullable() }),
    live: live(['assessmentId', 'versionId', 'change']),
  }),
  defineEvent({
    type: 'risk_signature.collected',
    context: 'safety-risk',
    description: 'A signer signed a version of a risk assessment (the role and how: in the office or on paper), and whether every signer has signed now.',
    payload: z.strictObject({ assessmentId: z.uuid(), versionId: z.uuid(), role: z.enum(DVR_SIGNER_ROLES), method: z.enum(DVR_SIGN_METHODS), complete: z.boolean() }),
    live: live(['assessmentId', 'versionId', 'role', 'complete']),
  }),
  defineEvent({
    type: 'risk_measure.changed',
    context: 'safety-risk',
    description: 'A measure of the improvement plan was added, changed (owner, due date, cost, roles) or moved to another state.',
    payload: z.strictObject({ measureId: z.uuid(), assessmentId: z.uuid(), change: z.enum(MEASURE_CHANGES), status: z.enum(MEASURE_STATUSES) }),
    live: live(['measureId', 'assessmentId', 'change', 'status']),
  }),
] as const
