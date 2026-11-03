import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * AQL profiles and the AQL calculator (apps/factory-api modules/quality/aql; B-W2b-93; QHS-020, QHS-021; design
 * quality.plans "AQL profiles", "AQL calculator", SCR-077), in the quality area. A profile is a company's: each is
 * checked with can() against its company. Applying a profile to an inspection, and an inspection's Sample & AQL read,
 * are the final inspection's own permissions (quality.inspections.record | view, B-W1-45), office and bench alike.
 */
export const QUALITY_AQL_DEFINITIONS = definePermissions('quality', {
  'aql.view': {
    risk: 'read',
    description: "See the AQL profiles (inspection level, critical always 0, major and minor AQLs), the customers and styles they are assigned to, which profile applies to a customer and a style, and the AQL calculator (ISO 2859-1).",
  },
  'aql.manage': {
    risk: 'write',
    description: "Keep a company's AQL profiles (add, change, retire, set the default; critical stays locked at 0) and assign them to customers and styles.",
  },
})

export const QUALITY_AQL_VIEW = 'quality.aql.view' satisfies Permission
export const QUALITY_AQL_MANAGE = 'quality.aql.manage' satisfies Permission

export const QUALITY_AQL_PERMISSIONS: readonly Permission[] = Object.freeze([QUALITY_AQL_VIEW, QUALITY_AQL_MANAGE])
