/**
 * The kinds of change the B-W2a-47 events name (quality/events.ts declares the events; their payloads use these lists).
 *
 *   ncr.changed               the fields of the NCR that changed (its content, owner, containment due time, links,
 *                             its PPE register entry)
 *   ncr.containment_changed   ADDED | CHANGED | DONE | CANCELLED
 *   ncr.decision_changed      ADDED | CHANGED | REMOVED | APPROVED | CARRIED_OUT
 */
export const NCR_CHANGED_FIELDS = [
  'title',
  'description',
  'source',
  'foundAt',
  'foundOn',
  'foundBy',
  'quantityAffected',
  'quantitySuspect',
  'uom',
  'defectCodeId',
  'severity',
  'zone',
  'styleId',
  'colourwayId',
  'size',
  'serial',
  'workOrderId',
  'itemId',
  'lotId',
  'supplierId',
  'ownerId',
  'containmentDueAt',
  'links',
  'register',
] as const
export type NcrChangedField = (typeof NCR_CHANGED_FIELDS)[number]

export const CONTAINMENT_CHANGES = ['ADDED', 'CHANGED', 'DONE', 'CANCELLED'] as const
export type ContainmentChange = (typeof CONTAINMENT_CHANGES)[number]

export const DECISION_CHANGES = ['ADDED', 'CHANGED', 'REMOVED', 'APPROVED', 'CARRIED_OUT'] as const
export type DecisionChange = (typeof DECISION_CHANGES)[number]
