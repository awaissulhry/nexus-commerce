import { defineManifest } from '../../../core/manifest'

/**
 * B-PR-33 — Production › Overview (production plan §5; 06-tree A.1; the Owner rule 2026-11-16: "One brand must not be able to see
 * anything related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well.").
 * Office only (a floor, portal or link session is refused by audience); workorders.view, and the handler walls every figure by
 * customer (B-PR-03's workOrderWhere, `record`): a person limited to some customers gets only theirs, and the figures that mix
 * customers (the work orders made before the one-customer rule) only reach a person of every customer.
 */
export const manifest = defineManifest({
  'GET /production/overview': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
})
