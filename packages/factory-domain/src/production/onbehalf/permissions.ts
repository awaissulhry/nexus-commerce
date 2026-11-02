import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Scan on behalf (apps/factory-api modules/production/onbehalf; B-W2b-47; MES-099; design floor.supervisor "Scan on
 * behalf"): the team leader records a report for someone who could not scan, always with a reason. The report pays the
 * person it names, so this right is its own: held by the team leader's floor role, checked on their signed-in session at
 * the device's site. Several bundles at once (MES-100) stays production.scan. Nothing here carries money.
 */
export const PRODUCTION_ONBEHALF_DEFINITIONS = definePermissions('production', {
  'scan.behalf': {
    risk: 'write',
    description: "Record a bundle's report for someone who could not scan, with a reason, and take it back right after; the record says the team leader entered it.",
  },
})

export const PRODUCTION_SCAN_BEHALF = 'production.scan.behalf' satisfies Permission

export const PRODUCTION_ONBEHALF_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_SCAN_BEHALF])

/** What a floor role may hold of them (FLOOR_SHARED_PERMISSIONS). */
export const PRODUCTION_ONBEHALF_FLOOR_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_SCAN_BEHALF])
