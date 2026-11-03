import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Inspection triggers (apps/factory-api modules/quality/triggers; B-W2b-101; QHS-010 plan assignment and triggers, QHS-011
 * inspection frequency; design quality.plans "When inspections are created"), in the quality area. A rule is a company's:
 * each is checked with can() against its company.
 *
 *   view     the company's rules in order (when, for what, which plan, how often), what each opened lately, the preview of
 *            a rule ("would have created 14 inspections in the last month") and which plan the rules pick for a lot, a
 *            workshop's receipt or a work order's operation
 *   manage   new rules, a rule's event, chips, plan and frequency, switching a rule off or on, deleting one, the order
 */
export const QUALITY_TRIGGERS_DEFINITIONS = definePermissions('quality', {
  'triggers.view': {
    risk: 'read',
    description: 'See the rules that open inspections by themselves (when, for what, which plan, how often) in their order, what each opened lately, and preview how many inspections a rule would have opened in the last month.',
  },
  'triggers.manage': {
    risk: 'write',
    description: 'Keep the rules that open inspections by themselves: add, change, switch off, delete and reorder them (the plan they name must have an approved version).',
  },
})

export const QUALITY_TRIGGERS_VIEW = 'quality.triggers.view' satisfies Permission
export const QUALITY_TRIGGERS_MANAGE = 'quality.triggers.manage' satisfies Permission

export const QUALITY_TRIGGERS_PERMISSIONS: readonly Permission[] = Object.freeze([QUALITY_TRIGGERS_VIEW, QUALITY_TRIGGERS_MANAGE])
