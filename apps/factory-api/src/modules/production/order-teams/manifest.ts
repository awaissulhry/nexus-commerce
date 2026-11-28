import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * Teams own the work (owb-ss5 step 5.1; _owb-ss-common L3): office only — the floor reads its team on the order through its own
 * routes, the portal never. An order's teams are read by whoever sees the order (orders.view) or gives its work
 * (production.teams.assign): one manifest permission per route, so the read says `signed-in` and its handler asks both, against
 * the order's company and customer. production.teams.assign gives them; whoever sees the order (sales) asks the production
 * managers with a task. The teams board of a site is the Teams page's (workorders.view, its nav row). Each record checked with
 * can() (`record`).
 */
export const manifest = defineManifest({
  'GET /production/orders/:orderId/teams': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'PUT /production/orders/:orderId/teams': { audiences: ['office'], permission: 'production.teams.assign', scope: 'record' },
  'POST /production/orders/:orderId/team-asks': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  'GET /production/teams/board': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
})
