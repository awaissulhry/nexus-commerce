import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Statutory periodic checks of machines (apps/factory-api modules/plant/statutory; B-W2b-124; QHS-205; D.Lgs. 81/2008
 * art. 71; design plant.preventive, plant.settings "Statutory check types"), in the plant area. Reading the plans, the
 * calendar and the check register needs plant.view. Keeping them needs plant.checks.manage, checked with can() against
 * the machine's company and site; the check types are the whole group's, so keeping them needs it over every company.
 *
 * A failed check "makes a job and can lock the machine in the same step": making the job asks plant.jobs.manage as well,
 * locking asks plant.report (Owner answer H1: anyone who reports may lock; only a technician signs safe). Office only.
 */
export const PLANT_CHECKS_DEFINITIONS = definePermissions('plant', {
  'checks.manage': {
    risk: 'write',
    description:
      "Keep the statutory periodic checks of machines: the check types with their legal basis, default interval, outside body and how long results are kept (the whole group's: over every company), each machine's check plans (interval, outside body, who looks after it, next due date, reminder; move a check with the reason, end a plan), and the check register: record a check's result with its report, correct a result with why (D.Lgs. 81/2008 art. 71: kept at least three years).",
  },
})

export const PLANT_CHECKS_MANAGE = 'plant.checks.manage' satisfies Permission

export const PLANT_CHECKS_PERMISSIONS: readonly Permission[] = Object.freeze([PLANT_CHECKS_MANAGE])
