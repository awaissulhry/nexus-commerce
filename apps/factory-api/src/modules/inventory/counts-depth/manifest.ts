import { defineManifest } from '../../../core/manifest'

/**
 * Counts in depth (B-W2b-299; SCM-226 … SCM-229, SCM-293). Count schedules and the frozen lines are the office's (read with
 * inventory.counts.view, planned with inventory.counts.manage); counting by scan is the office's phone and a floor device at
 * its own site (inventory.counts.scan; can() pins a floor session to its site, row-level security too; a tablet's write needs
 * its Idempotency-Key); the separation switches are the warehouse rules' (read with inventory.stock.view, changed with
 * inventory.rules.manage over the company, a looser rule with a fresh code). Every check of the record is the handler's.
 */
const view = { audiences: ['office'], permission: 'inventory.counts.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'inventory.counts.manage', scope: 'record' } as const
const scan = { audiences: ['office', 'floor'], permission: 'inventory.counts.scan', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /inventory/count-schedules': view,
  'GET /inventory/count-schedules/due': view,
  'GET /inventory/count-schedules/abc': view,
  'POST /inventory/count-schedules': manage,
  'PATCH /inventory/count-schedules/:scheduleId': manage,
  'POST /inventory/count-schedules/:scheduleId/start': manage,
  'GET /inventory/stock-counts/frozen': view,
  'GET /inventory/stock-counts/to-count': scan,
  'GET /inventory/stock-counts/bin': scan,
  'POST /inventory/stock-counts/:countId/scans': scan,
  'GET /inventory/stock-counts/:countId/bins/:locationId': scan,
  'POST /inventory/stock-counts/:countId/bins/:locationId/finish': scan,
  'GET /inventory/rules/separation-of-duties': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'PUT /inventory/rules/separation-of-duties': { audiences: ['office'], permission: 'inventory.rules.manage', scope: 'record' },
})
