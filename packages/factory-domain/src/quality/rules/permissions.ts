import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Quality rules (B-W2b-118; QHS-154 alerts and escalation, QHS-300 separation of duties; design quality.settings SCR-260),
 * in the quality area. Office only.
 *
 *   rules.view      the Quality rules page: who may sign what (the four-eyes release, the hold release, the signing rules
 *                   that are fixed or locked, the separations every role keeps), the alert and escalation rules, and how
 *                   results are computed and counted. Checked over the company read (tenant-wide: any grant).
 *   alerts.manage   keep the quality alert and escalation rules (what tells whom, how fast, how) of a company, or of
 *                   every company with a grant over every company; send a test of a rule to oneself.
 *
 * Changing who may sign what and the result rules stays quality.settings.manage (B-W1-34, the Cr VI evidence rule's): a
 * looser rule also asks for the reason and a fresh code.
 */
export const QUALITY_RULES_DEFINITIONS = definePermissions('quality', {
  'rules.view': {
    risk: 'read',
    description: 'See the quality rules: who may sign what (four-eyes release, hold release, the fixed and locked signing rules, the separations of duties), the alert and escalation rules, and how results are computed.',
  },
  'alerts.manage': {
    risk: 'write',
    description: 'Keep the quality alert and escalation rules (what tells whom, how fast and how) and send a test of a rule to yourself.',
  },
})

export const QUALITY_RULES_VIEW = 'quality.rules.view' satisfies Permission
export const QUALITY_ALERTS_MANAGE = 'quality.alerts.manage' satisfies Permission

export const QUALITY_RULES_PERMISSIONS: readonly Permission[] = Object.freeze([QUALITY_RULES_VIEW, QUALITY_ALERTS_MANAGE])
