import { defineManifest } from '../../../core/manifest'

/**
 * Efficiency (B-W2b-44; MES-247, MES-250, MES-251, ANA-016, ANA-017; design people.efficiency SCR-161), office only, checked
 * per site with can() (`record`). The figures are per line and per operation, under people.efficiency.view; a decision of the
 * standard review is people.efficiency.review. One person's figures are people.figures.view plus the site's PERFORMANCE legal
 * gate, the worker and HR only (B-W2b-27; Owner answer H3).
 */
export const manifest = defineManifest({
  'GET /people/efficiency': { audiences: ['office'], permission: 'people.efficiency.view', scope: 'record' },
  'GET /people/efficiency/trend': { audiences: ['office'], permission: 'people.efficiency.view', scope: 'record' },
  'GET /people/efficiency/operations': { audiences: ['office'], permission: 'people.efficiency.view', scope: 'record' },
  'GET /people/efficiency/operations/:routingOperationId': { audiences: ['office'], permission: 'people.efficiency.view', scope: 'record' },
  'GET /people/efficiency/cycle-time': { audiences: ['office'], permission: 'people.efficiency.view', scope: 'record' },
  'GET /people/efficiency/review': { audiences: ['office'], permission: 'people.efficiency.view', scope: 'record' },
  'POST /people/efficiency/review/:routingOperationId/decide': { audiences: ['office'], permission: 'people.efficiency.review', scope: 'record' },
  // B-W2b-89: People settings › Standard review, the company's two numbers (read with .view or .review over every site).
  'GET /people/efficiency/review/rule': { audiences: ['office'], permission: 'people.efficiency.view', scope: 'record' },
  'PUT /people/efficiency/review/rule': { audiences: ['office'], permission: 'people.efficiency.review', scope: 'record' },
  'POST /people/efficiency/people/:employeeId/figures': { audiences: ['office'], permission: 'people.figures.view', scope: 'record' },
})
