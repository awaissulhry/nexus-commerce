import { defineManifest } from '../../../core/manifest'

/**
 * A comment or a photo from the floor (B-W2b-47; MES-101, COL-017; design floor.operation "Photo or comment"): the scans'
 * permission at the device's own site (handlers check the work order with can()). The tablet holds no right on threads or
 * files itself: after these checks the note and the files go through as the tenant's system caller, for that work order only.
 */
export const manifest = defineManifest({
  'GET /production/floor-notes/tiles': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'POST /production/floor-notes/work-orders/:workOrderId': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'POST /production/floor-notes/work-orders/:workOrderId/files': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'POST /production/floor-notes/work-orders/:workOrderId/files/:fileId/complete': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  // B-OF-034 (order files tab): the office's open asks for files this tablet answers (its site, its worker's team or floor role, a
  // step of its work); read through the system after these checks, never a worker named.
  'GET /production/floor-notes/asks': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
})
