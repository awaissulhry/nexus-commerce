import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Quality holds (apps/factory-api modules/quality/holds; B-W2a-26; QHS-074, MES-008; design quality.holds SCR-078,
 * production.workorders wo-hold), in the quality area. Each is checked with can() against the hold's company and site.
 * The design: warehouse and supervisors read, a supervisor or quality places a hold, only quality releases it (QHS-300).
 * Releasing is a signing act: the office's step-up (a fresh 6-digit code); never by the person who placed it, and for
 * held garments never by one who made them (the database checks the maker too).
 */
export const QUALITY_HOLDS_DEFINITIONS = definePermissions('quality', {
  'holds.view': {
    risk: 'read',
    description: 'See what is on hold — lots, hides, work orders, bundles, garment serials, shipments, parcels — with why, since when, who follows it up, the quarantine move and what must be true to release it.',
  },
  'holds.place': {
    risk: 'write',
    description: 'Put goods on hold with a reason (a work order also goes ON_HOLD: the floor refuses its work and shows the reason), and change a hold\'s owner, expected release and note.',
  },
  'holds.release': {
    risk: 'write',
    description: 'Release a hold with an e-signature when its conditions are met: never one placed by oneself, and never garments one made.',
  },
})

export const QUALITY_HOLDS_VIEW = 'quality.holds.view' satisfies Permission
export const QUALITY_HOLDS_PLACE = 'quality.holds.place' satisfies Permission
export const QUALITY_HOLDS_RELEASE = 'quality.holds.release' satisfies Permission

export const QUALITY_HOLDS_PERMISSIONS: readonly Permission[] = Object.freeze([QUALITY_HOLDS_VIEW, QUALITY_HOLDS_PLACE, QUALITY_HOLDS_RELEASE])
