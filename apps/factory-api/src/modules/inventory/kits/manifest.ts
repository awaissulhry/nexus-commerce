import { defineManifest } from '../../../core/manifest'

/**
 * Kit staging (B-W2b-15; SCM-213). Office only, scoped by record: a kit is its work order's, so the handlers check the
 * work order's company and site with can(). Reading is inventory.stock.view (Picking & kits' own read); staging, checking
 * and opening again are inventory.issue (picking for the work order). Writes take an Idempotency-Key and the version read.
 * B-W2b-310 (follow-up FT2:01; design floor.pick sec:kit): a floor device at its own site stages the kit and checks it complete
 * on the tablet (WorkOrderKit's floor grants); reading and opening again stay the office's.
 */
export const manifest = defineManifest({
  'GET /inventory/kits/:workOrderId': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  // B-W2b-310: the floor too (the tablet's kit section).
  'POST /inventory/kits/:workOrderId/stage': { audiences: ['office', 'floor'], permission: 'inventory.issue', scope: 'record' },
  'POST /inventory/kits/:workOrderId/complete': { audiences: ['office', 'floor'], permission: 'inventory.issue', scope: 'record' },
  'POST /inventory/kits/:workOrderId/reopen': { audiences: ['office'], permission: 'inventory.issue', scope: 'record' },
})
