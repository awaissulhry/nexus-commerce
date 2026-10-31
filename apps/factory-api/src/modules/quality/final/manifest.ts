import { defineManifest } from '../../../core/manifest'

/**
 * The final inspection and release by an inspector who is not a maker (B-W1-45; QHS-050, QHS-051, QHS-058, QHS-073,
 * PLT-097; Owner answers Q1, Q2, Q3; A2 SCR-075, SCR-076, SCR-097): the bench's work orders, a work order's final state, inspections (open,
 * record, sign, cancel) and releases for the office and the site's floor devices (their own site only: can() pins them,
 * row-level security too); the lists, one release, the reversal, the four-eyes rule and the evidence trail for the office.
 * Handlers check each work order with can() over its company and site (`record`); lists use scopeWhere().
 */
export const manifest = defineManifest({
  'GET /quality/final/work-orders': { audiences: ['office', 'floor'], permission: 'quality.inspections.view', scope: 'record' },
  'GET /quality/final/work-orders/:workOrderId': { audiences: ['office', 'floor'], permission: 'quality.inspections.view', scope: 'record' },
  'GET /quality/inspections': { audiences: ['office'], permission: 'quality.inspections.view', scope: 'record' },
  // W2a (B-W2a-67; design qi-assign): the office assigns an open inspection to its inspector (./assign.ts).
  'GET /quality/inspections/inspectors': { audiences: ['office'], permission: 'quality.inspections.record', scope: 'record' },
  'POST /quality/inspections/assign': { audiences: ['office'], permission: 'quality.inspections.record', scope: 'record' },
  'POST /quality/inspections': { audiences: ['office', 'floor'], permission: 'quality.inspections.record', scope: 'record' },
  'GET /quality/inspections/:inspectionId': { audiences: ['office', 'floor'], permission: 'quality.inspections.view', scope: 'record' },
  'PATCH /quality/inspections/:inspectionId': { audiences: ['office', 'floor'], permission: 'quality.inspections.record', scope: 'record' },
  'PUT /quality/inspections/:inspectionId/defects': { audiences: ['office', 'floor'], permission: 'quality.inspections.record', scope: 'record' },
  'POST /quality/inspections/:inspectionId/decide': { audiences: ['office', 'floor'], permission: 'quality.inspections.record', scope: 'record' },
  'POST /quality/inspections/:inspectionId/cancel': { audiences: ['office', 'floor'], permission: 'quality.inspections.record', scope: 'record' },
  'POST /quality/releases': { audiences: ['office', 'floor'], permission: 'quality.garments.release', scope: 'record' },
  // B-W2a-75: Hold lot at the bench (the office places holds on Quality › Holds).
  'POST /quality/final/work-orders/:workOrderId/hold': { audiences: ['floor'], permission: 'quality.inspections.record', scope: 'record' },
  'GET /quality/releases': { audiences: ['office'], permission: 'quality.inspections.view', scope: 'record' },
  'GET /quality/releases/:releaseId': { audiences: ['office'], permission: 'quality.inspections.view', scope: 'record' },
  'POST /quality/releases/:releaseId/reverse': { audiences: ['office'], permission: 'quality.garments.reverse', scope: 'record' },
  // B-W2b-17: by when open inspections are due (office; quality.inspections.record over each one, checked in the handler).
  'POST /quality/inspections/due': { audiences: ['office'], permission: 'quality.inspections.record', scope: 'record' },
  'GET /quality/release-rule': { audiences: ['office'], permission: 'quality.inspections.view', scope: 'record' },
  'PUT /quality/release-rule': { audiences: ['office'], permission: 'quality.settings.manage', scope: 'record' },
  'GET /quality/evidence': { audiences: ['office'], permission: 'quality.inspections.view', scope: 'record' },
})
