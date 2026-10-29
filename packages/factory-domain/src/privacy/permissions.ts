import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * The privacy pack's permissions (apps/factory-api platform/privacy, B-W1-36; A2 SCR-086 Admin › Privacy & notices;
 * features PLT-208, GAP-004, GAP-005, GAP-009), in the privacy area. Each is checked with can() against the company.
 *
 * Publishing a notice version and storing a signed DPIA also ask for a fresh code (the API's requireStepUp): they change
 * what every worker must acknowledge and open or keep the floor's gate. The rest of privacy.manage (drafts, languages,
 * the record of processing activities, a signed paper acknowledgement) does not. Only privacy.manage sees by name who
 * has or has not acknowledged a notice; privacy.view sees the counts. Every person reads and acknowledges their own
 * company's staff notice, and every floor worker the worker notice, without these permissions.
 */
export const PRIVACY_DEFINITIONS = definePermissions('privacy', {
  view: {
    risk: 'read',
    description:
      "See the company's privacy duties: the notices (worker, staff and public) in their versions and languages, how many have acknowledged them, the DPIA, the record of processing activities, and whether the floor may start.",
  },
  manage: {
    risk: 'write',
    description:
      'Write notice versions and their languages (publishing one asks for a fresh code), record a signed paper acknowledgement, keep the DPIA (storing the signed one asks for a fresh code) and the record of processing activities, and see by name who has acknowledged a notice.',
  },
})

export const PRIVACY_VIEW = 'privacy.view' satisfies Permission
export const PRIVACY_MANAGE = 'privacy.manage' satisfies Permission
export const PRIVACY_PERMISSIONS: readonly Permission[] = Object.freeze([PRIVACY_VIEW, PRIVACY_MANAGE])
