import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * The factory's departments (owb- order workflow, b3.3; PL-schema § 2): the company-wide list a basket visits (1 Pattern … 9
 * Assembly), read only here — S4 adds the manage routes in this folder (production.departments.manage). The one read takes either
 * right a page that shows it holds: the office's work orders (workorders.view) or products (product.styles.view), the floor's
 * floor.work. The manifest names one permission per route, so the handler asks them (`SIGNED_IN`, as the defect pickers).
 */
export const manifest = defineManifest({
  'GET /production/departments': { audiences: ['office', 'floor'], permission: SIGNED_IN, scope: 'tenant' },
})
