import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The points of measure, grade rules and measurement spec events (B-W2b-224; the code is factory-domain product/measures
 * and product/grading). A module folder of its own, as product-lifecycle and routing-depth (the event guard wants
 * `src/<module>/events.ts`). apps/factory-api's modules/product/{measures,grading} emit them in the command that makes the
 * change.
 *
 *   point_of_measure.changed          a point of the library added, changed, archived, restored, or its picture set
 *   grade_rule.changed                a grade rule added, changed, its steps saved, archived or restored
 *   style.measurement_spec_changed    a draft revision's measurement spec started, its cells or points changed, graded,
 *                                     approved, reopened or archived
 *
 * Live on the Sizes & measurements library for product.styles.view, on the style's spec for product.bom.view. Ids,
 * codes and what changed only: no person, no money.
 */
export const POM_CHANGES = ['CREATED', 'UPDATED', 'ARCHIVED', 'RESTORED', 'PICTURE'] as const
export const RULE_CHANGES = ['CREATED', 'UPDATED', 'STEPS', 'ARCHIVED', 'RESTORED'] as const
export const SPEC_CHANGES = ['STARTED', 'UPDATED', 'CELLS', 'POINTS', 'GRADED', 'APPROVED', 'REOPENED', 'ARCHIVED'] as const

export const events = [
  defineEvent({
    type: 'point_of_measure.changed',
    context: 'product-measures',
    description: 'A point of measure of the library was added, changed (name, how to measure, kind, zone, unit, default tolerance, body point), archived, restored, or its how-to picture set.',
    payload: z.strictObject({ pointOfMeasureId: z.uuid(), code: z.string(), change: z.enum(POM_CHANGES) }),
    live: { permission: 'product.styles.view', fields: ['pointOfMeasureId', 'code', 'change'] },
  }),
  defineEvent({
    type: 'grade_rule.changed',
    context: 'product-measures',
    description: 'A grade rule of a size scale was added, changed (name, code, base size, format), its steps saved, archived or restored.',
    payload: z.strictObject({ gradeRuleId: z.uuid(), code: z.string(), sizeScaleId: z.uuid(), change: z.enum(RULE_CHANGES) }),
    live: { permission: 'product.styles.view', fields: ['gradeRuleId', 'code', 'sizeScaleId', 'change'] },
  }),
  defineEvent({
    type: 'style.measurement_spec_changed',
    context: 'product-measures',
    description: "A draft revision's measurement spec was started, its base size, rule, cells or points changed, graded by a rule, approved, reopened or archived.",
    payload: z.strictObject({ styleId: z.uuid(), code: z.string(), revisionId: z.uuid(), revision: z.number().int(), specId: z.uuid(), change: z.enum(SPEC_CHANGES) }),
    live: { permission: 'product.bom.view', fields: ['styleId', 'code', 'revisionId', 'revision', 'specId', 'change'] },
  }),
] as const
