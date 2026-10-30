/**
 * What changed the site's working plan (B-W2a-34; the planning.schedule_changed event and the audit actions):
 *
 *   PLACED            a slot was placed (from the tray, or a new one)
 *   MOVED             a slot moved in time or to another lane, or its garments, reason or note changed
 *   REMOVED           a slot went back to the tray
 *   PLACED_BY_DUE_DATE  the tray's work orders were placed by backward scheduling ("Place all by due date")
 *   ALLOCATED         a work order's line or its parts on other lanes changed (the allocation board)
 */
export const SCHEDULE_CHANGES = ['PLACED', 'MOVED', 'REMOVED', 'PLACED_BY_DUE_DATE', 'ALLOCATED'] as const
export type ScheduleChange = (typeof SCHEDULE_CHANGES)[number]
