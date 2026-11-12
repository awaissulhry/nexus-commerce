import { defineManifest } from '../../../core/manifest'

/**
 * The pick list by bin (B-W2b-298; SCM-212): the pickers' read (inventory.issue), the office and a floor device at its own
 * site (can() pins it, row-level security too). Read only.
 */
export const manifest = defineManifest({
  'GET /inventory/pick-lists/work-orders/:workOrderId': { audiences: ['office', 'floor'], permission: 'inventory.issue', scope: 'record' },
  'GET /inventory/pick-lists/walk': { audiences: ['office', 'floor'], permission: 'inventory.issue', scope: 'record' },
})
