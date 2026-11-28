import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * Baskets on the floor (owb- order workflow, S5). Two server builders write this folder: server A (fl1/fl2: the basket read, the
 * home, moves and route edits) and server B (fl3/fl4: the leader's signals, the team home, the board, From the floor). Each keeps
 * its entries in its own marked block; whoever lands second merges by reading and keeps both blocks.
 */
export const manifest = defineManifest({
  // ---- server A (owb-fl1/fl2): the basket read, the home, the department pick, the quality photo, moves, route edits ----
  // One basket: the floor with production.scan at its device's site, the office with production.bundles.view in its grants; the
  // manifest names one permission per route, so the handler asks the right of each door (`SIGNED_IN`, as the departments read).
  'GET /production/baskets/:bundleId': { audiences: ['office', 'floor'], permission: SIGNED_IN, scope: 'record' },
  'GET /production/baskets/home': { audiences: ['floor'], permission: 'production.scan', scope: 'site' },
  // The phone's "where am I" (settle 2): the device's own open session, at its own site.
  'POST /floor/session/department': { audiences: ['floor'], permission: 'production.scan', scope: 'site' },
  // The quality step's photo: the scans' right at the device's own site (handlers check the work order with can()).
  'POST /production/baskets/:bundleId/checklist/:stepCode/photo': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'POST /production/baskets/:bundleId/checklist/:stepCode/photo/:fileId/complete': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  // ---- end server A ----
  // ---- server B (owb-fl3/fl4): flags, late, team, board, from the floor ----
  // Do this first and Will be late are the team leader's (floor.lead, `_owb-fl-common.md` § 1 D), at the device's own site.
  'POST /production/baskets/flags': { audiences: ['floor'], permission: 'floor.lead', scope: 'site' },
  'POST /production/baskets/late': { audiences: ['floor'], permission: 'floor.lead', scope: 'site' },
  // ---- end server B ----
})
