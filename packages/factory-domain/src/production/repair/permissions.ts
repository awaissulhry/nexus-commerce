import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The repair station and second quality (B-W2b-126; MES-132, MES-133; design floor.mywork "repair queue", production.scrap
 * "Downgrade to second quality"), in the production area. Checked with can() against the work order's company and site; a
 * floor device works at its own site only (can() pins it, row-level security too).
 *
 *   production.repair     the repair queue of the site on the floor and the scans in and out at a repair station (a rework's
 *                         repair minutes, per rework, never per person, kept apart from piece pay)
 *   production.downgrade  the office sends scrapped garments to second quality with a reason instead of scrap (they go into
 *                         stock as the SKU or a second-quality item), and withdraws a wrong downgrade with the reason
 *
 * Reading the downgrades and the repair facts in the office is production.scrap.view (../scrap/permissions). Nothing here
 * carries money (a downgrade's stock value is the stock ledger's, cost grain), and no figure is per person.
 */
export const PRODUCTION_REPAIR_DEFINITIONS = definePermissions('production', {
  repair: {
    risk: 'write',
    description:
      'See the repair queue of the site (bundles sent back to be repaired, oldest first) and scan a bundle in and out at a repair station: scanning it out finishes the rework with how many came out good and how many were scrapped. The repair minutes are kept per rework, never per person (a floor device: at its own site).',
  },
  downgrade: {
    risk: 'write',
    description:
      "Send scrapped garments of a work order to second quality with a reason instead of scrap: they go into a place of the site as the SKU or a second-quality item, valued at its standard cost (ESPR: no destruction of unsold apparel); withdraw a wrong downgrade with the reason (its stock comes out again).",
  },
})

export const PRODUCTION_REPAIR = 'production.repair' satisfies Permission
export const PRODUCTION_DOWNGRADE = 'production.downgrade' satisfies Permission

export const PRODUCTION_REPAIR_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_REPAIR, PRODUCTION_DOWNGRADE])

/** What a floor role may hold of them (FLOOR_SHARED_PERMISSIONS): the repair station's queue and scans at its own site. */
export const PRODUCTION_REPAIR_FLOOR_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_REPAIR])
