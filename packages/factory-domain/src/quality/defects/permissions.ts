import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The defect library and the disposition codes (apps/factory-api modules/quality/defects; B-W2a-26; QHS-001, QHS-005;
 * design quality.defects SCR-079 "Defects & dispositions"), in the quality area. Both are tenant-wide (one library for
 * every company and site): reading needs quality.defects.view over any company, keeping them quality.defects.manage over
 * every company. The pickers of the office and the floor read the active defects with any session (GET
 * /quality/defects/picker). An approval amount is the cost grain: seen and set only with money.cost.
 */
export const QUALITY_DEFECTS_DEFINITIONS = definePermissions('quality', {
  'defects.view': {
    risk: 'read',
    description: 'See the defect library (categories and defects with their class, zone, stages and how often each is used) and the disposition codes with the stock move and follow-up each makes.',
  },
  'defects.manage': {
    risk: 'write',
    description: 'Keep the defect library and the disposition codes of the whole group: add, rename, retire and delete unused codes, set their pictures, classes, zones, stages and approval rules.',
  },
})

export const QUALITY_DEFECTS_VIEW = 'quality.defects.view' satisfies Permission
export const QUALITY_DEFECTS_MANAGE = 'quality.defects.manage' satisfies Permission

export const QUALITY_DEFECTS_PERMISSIONS: readonly Permission[] = Object.freeze([QUALITY_DEFECTS_VIEW, QUALITY_DEFECTS_MANAGE])
