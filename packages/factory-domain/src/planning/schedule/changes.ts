/**
 * What changed the site's working plan (B-W2a-34; the planning.schedule_changed event and the audit actions):
 *
 *   PLACED            a slot was placed (from the tray, or a new one)
 *   MOVED             a slot moved in time or to another lane, or its garments, reason or note changed
 *   REMOVED           a slot went back to the tray
 *   PLACED_BY_DUE_DATE  the tray's work orders were placed by backward scheduling ("Place all by due date")
 *   ALLOCATED         a work order's line or its parts on other lanes changed (the allocation board)
 *
 * B-W2b-312 (PLN-139, PLN-130, PLN-141, what-if), added at the end (the board reads again on any change):
 *   PINNED / UNPINNED     slots were pinned where they are, or unpinned
 *   SCHEDULED_FORWARD     late work orders were scheduled forward from today on the lanes' free time
 *   BACKLOG_RESCHEDULED   bars left in the past were moved into the first free time (and what they pushed)
 *   WHAT_IF_APPLIED       a planner's private what-if moves were applied to the working plan
 *
 * B-W2b-329 (PLN-149), added at the end:
 *   UNDONE                a change of the board's log was undone (a bar taken off, moved back, put back, unpinned or pinned)
 */
export const SCHEDULE_CHANGES = ['PLACED', 'MOVED', 'REMOVED', 'PLACED_BY_DUE_DATE', 'ALLOCATED', /* B-W2b-312 */ 'PINNED', 'UNPINNED', 'SCHEDULED_FORWARD', 'BACKLOG_RESCHEDULED', 'WHAT_IF_APPLIED', /* B-W2b-329 */ 'UNDONE'] as const
export type ScheduleChange = (typeof SCHEDULE_CHANGES)[number]
