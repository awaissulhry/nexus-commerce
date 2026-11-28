import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * Baskets on the floor (owb- order workflow, S5). Two server builders write this folder: server A (fl1/fl2: the basket read, the
 * home, moves and route edits) and server B (fl3/fl4: the leader's signals, the team home, the board, From the floor). Each keeps
 * its entries in its own marked block; whoever lands second merges by reading and keeps both blocks.
 */
export const manifest = defineManifest({
  // ---- server B (owb-fl3/fl4): flags, late, team, board, from the floor ----
  // Do this first and Will be late are the team leader's (floor.lead, `_owb-fl-common.md` § 1 D), at the device's own site.
  'POST /production/baskets/flags': { audiences: ['floor'], permission: 'floor.lead', scope: 'site' },
  'POST /production/baskets/late': { audiences: ['floor'], permission: 'floor.lead', scope: 'site' },
  // owb-fl4: the Baskets board (office workorders.view; floor floor.lead: one route, both rights, the handler asks them), the
  // leader's team home, From the floor (workorders.view) and the office's answer to a late warning (orders.manage).
  'GET /production/baskets/board': { audiences: ['office', 'floor'], permission: SIGNED_IN, scope: 'record' },
  'GET /production/baskets/team': { audiences: ['floor'], permission: 'floor.lead', scope: 'site' },
  'GET /production/baskets/from-the-floor': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'POST /production/baskets/late/:id/answer': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  // ---- end server B ----
})
