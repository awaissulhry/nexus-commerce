import type { TaskSource, TimedTaskSource } from '../source-kit'
import holds from './holds'
import pickLists from './pick-lists'
import receipts from './receipts'
import { countSchedules } from './count-schedules'

/**
 * The sources of warehouse tasks (B-W2b-292; SCM-274), one file each in this folder (a merge point: each step adds its line).
 * Event sources follow their records' events (the worker's handler, ../handlers.ts); timed sources run on the scheduler's
 * cron. Each makes, changes, does or cancels the tasks its record asks (../source-kit.ts).
 */
export const TASK_SOURCES: readonly TaskSource[] = Object.freeze([
  // B-W2b-292: put-aways from a posted receipt, a released lot and a released hold in quarantine.
  receipts,
  // B-W2b-292: the quarantine move a hold asks (follow-up WT1:01).
  holds,
  // B-W2b-292: a pick list made for a work order.
  pickLists,
])

export const TIMED_TASK_SOURCES: readonly TimedTaskSource[] = Object.freeze([
  // B-W2b-292: a count schedule that is due.
  countSchedules,
])
