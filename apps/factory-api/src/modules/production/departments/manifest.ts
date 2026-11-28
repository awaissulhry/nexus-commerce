import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * The factory's departments (owb- order workflow, b3.3; PL-schema § 2): the company-wide list a basket visits (1 Pattern … 9
 * Assembly), read only here — S4 adds the manage routes in this folder (production.departments.manage). The one read takes either
 * right a page that shows it holds: the office's work orders (workorders.view) or products (product.styles.view), the floor's
 * floor.work. The manifest names one permission per route, so the handler asks them (`SIGNED_IN`, as the defect pickers).
 */
// owb-pd1 1.3: keeping them — production.departments.manage over the department's company (a department of the whole factory: a
// grant over every company), checked again by the handler (./manage.ts).
const manage = { audiences: ['office'], permission: 'production.departments.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /production/departments': { audiences: ['office', 'floor'], permission: SIGNED_IN, scope: 'tenant' },
  'POST /production/departments': manage,
  'PATCH /production/departments/:departmentId': manage,
  'POST /production/departments/:departmentId/close': manage,
  'POST /production/departments/:departmentId/open': manage,
})
