import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The leather and cut plan (apps/factory-api modules/planning/leather; B-W2b-132; PLN-106, PLN-108, PLN-109, PLN-114; design
 * planning.leather, SCR-252). Reading it is planning.view at the site (the planning module's). Changing a style's cutting
 * loss from what its cuts show, or dismissing that proposal with a reason, is this permission, checked with can() against
 * the site whose cuts the proposal rests on. Office only. A changed loss goes into the style's DRAFT revision only, so the
 * plan run and new quotes use it once that revision is released; a released revision and every work order made from it
 * never change. Nothing here names a cutter or carries money (the yield's value is the cost grain's).
 */
export const PLANNING_LEATHER_DEFINITIONS = definePermissions('planning', {
  'leather.manage': {
    risk: 'write',
    description:
      "Change a style's cutting loss to what its cuts show (written into the style's draft revision: the plan run and new quotes use it once that revision is released, a released order never changes), or dismiss the proposal with a reason.",
  },
})

export const PLANNING_LEATHER_MANAGE = 'planning.leather.manage' satisfies Permission

export const PLANNING_LEATHER_PERMISSIONS: readonly Permission[] = Object.freeze([PLANNING_LEATHER_MANAGE])
