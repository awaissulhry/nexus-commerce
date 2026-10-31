import { defineManifest } from '../../../core/manifest'

/**
 * Kit staging (B-W2b-15; SCM-213). Office only, scoped by record: a kit is its work order's, so the handlers check the
 * work order's company and site with can(). Reading is inventory.stock.view (Picking & kits' own read); staging, checking
 * and opening again are inventory.issue (picking for the work order). Writes take an Idempotency-Key and the version read.
 */
export const manifest = defineManifest({
  'GET /inventory/kits/:workOrderId': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'POST /inventory/kits/:workOrderId/stage': { audiences: ['office'], permission: 'inventory.issue', scope: 'record' },
  'POST /inventory/kits/:workOrderId/complete': { audiences: ['office'], permission: 'inventory.issue', scope: 'record' },
  'POST /inventory/kits/:workOrderId/reopen': { audiences: ['office'], permission: 'inventory.issue', scope: 'record' },
})
