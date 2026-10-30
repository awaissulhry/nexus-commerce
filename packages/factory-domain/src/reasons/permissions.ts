import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * The reason lists (apps/factory-api platform/reasons; B-W2a-18; PLT-116; design production.settings "Reason codes",
 * sales.settings return reasons). A list is the whole tenant's (every company and site picks from it): seeing the
 * editor (inactive codes, how often each is used) is reasons.view; keeping the lists is reasons.manage over every
 * company and site. Pickers read the active reasons with any office or floor session (GET /reasons). Nothing here names
 * a person or carries money.
 */
export const REASONS_DEFINITIONS = definePermissions('reasons', {
  view: {
    risk: 'read',
    description: 'See the reason lists as the editor shows them: every code with its words, icon and colour, the inactive ones, and how many records name each.',
  },
  manage: {
    risk: 'write',
    description: "Keep the reason lists of the whole group: add reasons, change their words in each language, icon, colour and order, ask for a note, set them inactive or active again, and add the standard reasons a list is missing.",
  },
})

export const REASONS_VIEW = 'reasons.view' satisfies Permission
export const REASONS_MANAGE = 'reasons.manage' satisfies Permission

export const REASONS_PERMISSIONS: readonly Permission[] = Object.freeze([REASONS_VIEW, REASONS_MANAGE])
