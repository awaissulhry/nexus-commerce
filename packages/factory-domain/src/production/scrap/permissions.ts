import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Scrap and its replacement (apps/factory-api modules/production/scrap; features MES-129, MES-130; design
 * production.scrap "Scrap & rework" with "Replace scrapped quantity"), in the production area, office only. Checked
 * with can() against the work order's company and site. The value of scrap is the cost grain (money.cost): without it
 * the answers carry no value. No figure is per person (Statuto dei Lavoratori art. 4): scrap is listed per work order,
 * bundle, operation and station.
 */
export const PRODUCTION_SCRAP_DEFINITIONS = definePermissions('production', {
  'scrap.view': {
    risk: 'read',
    description:
      'See the scrap and rework of the sites: every scrapped piece with its reason and the lot, hide and area it held, the rework orders, and the replacements (recuts to cut, order reductions to approve); its value only with the cost grain.',
  },
  scrap: {
    risk: 'write',
    description:
      'Post material scrapped for a work order out of stock by lot (an area of a hide for leather), ask for a replacement of scrapped garments (a recut, or a lower order quantity that another person approves), mark a recut done with the cut that cut it, and cancel a replacement with the reason.',
  },
  'scrap.approve': {
    risk: 'write',
    description: "Approve or refuse lowering an order's quantity by its scrapped garments (never one's own request; a refusal says why).",
  },
})

export const PRODUCTION_SCRAP_VIEW = 'production.scrap.view' satisfies Permission
export const PRODUCTION_SCRAP = 'production.scrap' satisfies Permission
export const PRODUCTION_SCRAP_APPROVE = 'production.scrap.approve' satisfies Permission

export const PRODUCTION_SCRAP_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_SCRAP_VIEW, PRODUCTION_SCRAP, PRODUCTION_SCRAP_APPROVE])
