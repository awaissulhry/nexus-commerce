import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * The permission of cost in depth (B-W2b-423; FIN-017, FIN-018, FIN-019, FIN-022), in the costing area, office only. The
 * roll-up, an option's cost, a made-to-measure unit's cost and a mass update's preview are costing.view (figures only with
 * their grain); an option's typed cost delta is B-W2b-418's costing.sheets.manage (an input the components read).
 *
 *   massUpdate.apply   apply a mass cost update shown in its preview: the materials' new standard prices and a new draft
 *                      version of every affected cost sheet series. Never an approved or frozen version, never a posted cost.
 *                      A fresh code (step-up: the money settings line of Admin › Security), and the right to keep the cost
 *                      sheets and the standard prices of every company it touches.
 */
export const COST_DEPTH_DEFINITIONS = definePermissions('costing', {
  'massUpdate.apply': {
    risk: 'stepUp',
    description:
      "Apply a mass cost update after its preview: the materials' new standard prices and a new draft version of every cost sheet series that takes them (approved and frozen versions and posted costs never change). Asks a fresh code, and the right to keep cost sheets and standard prices in every company it touches.",
  },
})

export const COSTING_MASS_UPDATE_APPLY = 'costing.massUpdate.apply' satisfies Permission

export const COST_DEPTH_PERMISSIONS: readonly Permission[] = Object.freeze([COSTING_MASS_UPDATE_APPLY])

/** The role templates that get it (owner: every()): finance, who keeps the costing. */
export const COST_DEPTH_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: [COSTING_MASS_UPDATE_APPLY],
})
