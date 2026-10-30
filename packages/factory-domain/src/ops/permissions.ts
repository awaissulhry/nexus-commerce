import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * Security & health in the Office (apps/factory-api platform/admin/security; B-W2a-36; PLT-045, PLT-214; design
 * admin.security, SCR-166). Tenant-wide: the page is about the whole group, not one company.
 *
 *   security.view           read the page: is everything working, the sign-in rules, the backups and restore drills, the
 *                           protection in place; the attention rows of All settings that are about them
 *   security.drills.record  record a restore drill (a backup restored somewhere other than production, its key records
 *                           compared by checksum) with its evidence file, and read this database's fingerprint for one
 *
 * Not step-up: a drill is evidence and widens nobody's rights. The two-factor rule of a role is roles.manage (a step-up
 * permission already): the page changes it through its own route with the never-lock-out rules.
 */
export const SECURITY_DEFINITIONS = definePermissions('security', {
  view: {
    risk: 'read',
    description: 'See whether every part of the factory works, the sign-in rules, the backups and restore drills, and the protection in place.',
  },
  'drills.record': {
    risk: 'write',
    description: "Record a restore drill: a backup restored somewhere other than production, its key records compared by checksum, with its evidence file.",
  },
})

export const SECURITY_VIEW = 'security.view' satisfies Permission
export const SECURITY_DRILLS_RECORD = 'security.drills.record' satisfies Permission

export const SECURITY_PERMISSIONS: readonly Permission[] = Object.freeze([SECURITY_VIEW, SECURITY_DRILLS_RECORD])
