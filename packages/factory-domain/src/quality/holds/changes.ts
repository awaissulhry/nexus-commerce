/**
 * The kinds of change the B-W2a-26 events name (quality/events.ts declares the events; their payloads use these lists).
 *
 *   quality.defects_changed       CREATED | EDITED | RETIRED | REACTIVATED | DELETED | STARTER_ADDED
 *   quality.dispositions_changed  CREATED | EDITED | DEACTIVATED | REACTIVATED | STANDARD_ADDED
 *   quality.hold_changed          the fields of a hold that changed
 */
export const DEFECT_LIBRARY_CHANGES = ['CREATED', 'EDITED', 'RETIRED', 'REACTIVATED', 'DELETED', 'STARTER_ADDED'] as const
export type DefectLibraryChange = (typeof DEFECT_LIBRARY_CHANGES)[number]

export const DISPOSITION_CODE_CHANGES = ['CREATED', 'EDITED', 'DEACTIVATED', 'REACTIVATED', 'STANDARD_ADDED'] as const
export type DispositionCodeChange = (typeof DISPOSITION_CODE_CHANGES)[number]

export const HOLD_CHANGED_FIELDS = ['ownerId', 'expectedReleaseOn', 'note', 'reasonNote', 'quarantine'] as const
export type HoldChangedField = (typeof HOLD_CHANGED_FIELDS)[number]
