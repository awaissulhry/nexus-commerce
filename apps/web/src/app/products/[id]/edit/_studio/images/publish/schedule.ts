/**
 * PES.7 — scheduled image publishes, read honestly. Pure, tested.
 *
 * 🔴 **A schedule can be created on a deployment where nothing will ever fire it.**
 *
 * The cron that fires these rows (`scheduled-image-publish.job.ts`) is gated on
 * `NEXUS_ENABLE_SCHEDULED_IMAGE_PUBLISH=1` and is **off on production** — measured at the endpoint,
 * which now reports `executionEnabled` for exactly this reason. The CRUD route does not care: a
 * POST stores the row and returns `PENDING` either way. So an operator can pick a time, get a
 * confirmation, and have nothing whatsoever happen at that time, with the row still reading
 * "Pending" a week later.
 *
 * That is the worst failure this surface can have, so the state is never inferred from the rows —
 * an empty list looks identical whether the queue is idle or dead. The server is asked, and the
 * answer is shown before anything else.
 */

export interface ScheduleRow {
  id: string
  channel: string
  marketplace: string | null
  scheduledFor: string
  status: string
  firedAt: string | null
  cancelledAt: string | null
  fireError: string | null
}

export type ScheduleState = 'pending' | 'fired' | 'failed' | 'cancelled' | 'unknown'

export interface ScheduleReading {
  state: ScheduleState
  label: string
  /** Why this row reads the way it does, when that needs saying. */
  note?: string
  /** True when this row is waiting for a cron that is not running. */
  stranded: boolean
}

export function readSchedule(
  row: ScheduleRow,
  executionEnabled: boolean,
  now: Date = new Date(),
): ScheduleReading {
  const status = (row.status ?? '').toUpperCase()

  if (status === 'CANCELLED') return { state: 'cancelled', label: 'Cancelled', stranded: false }
  if (status === 'FAILED') {
    return { state: 'failed', label: 'Failed', note: row.fireError ?? undefined, stranded: false }
  }
  if (status === 'FIRED') return { state: 'fired', label: 'Published', stranded: false }

  if (status === 'PENDING') {
    const due = new Date(row.scheduledFor).getTime() <= now.getTime()
    if (!executionEnabled) {
      // The important case, and the one an operator cannot possibly deduce from the row.
      return {
        state: 'pending',
        label: due ? 'Never ran' : 'Will not run',
        note: 'Scheduled publishing is switched off on this deployment, so nothing will fire this row.',
        stranded: true,
      }
    }
    if (due) {
      return {
        state: 'pending',
        label: 'Overdue',
        note: 'This time has passed and the row has not been picked up yet.',
        stranded: false,
      }
    }
    return { state: 'pending', label: 'Scheduled', stranded: false }
  }

  // An unrecognised status is reported as unrecognised rather than folded into a familiar one.
  return { state: 'unknown', label: row.status || 'Unknown', stranded: false }
}

export interface ScheduleSummary {
  total: number
  pending: number
  /** Pending rows that no cron will ever fire. */
  stranded: number
  /** Pending rows whose time has already passed. */
  overdue: number
}

export function summariseSchedules(
  rows: readonly ScheduleRow[],
  executionEnabled: boolean,
  now: Date = new Date(),
): ScheduleSummary {
  let pending = 0
  let stranded = 0
  let overdue = 0
  for (const r of rows) {
    const s = readSchedule(r, executionEnabled, now)
    if (s.state !== 'pending') continue
    pending++
    if (s.stranded) stranded++
    if (new Date(r.scheduledFor).getTime() <= now.getTime()) overdue++
  }
  return { total: rows.length, pending, stranded, overdue }
}

/**
 * The sentence shown above the list.
 *
 * 🔴 Deliberately says the same thing when the list is EMPTY. "No schedules yet" on a dead queue
 * invites the operator to create one, which is precisely the trap — an empty list and a broken
 * queue look identical, so the state has to be stated rather than left to be inferred.
 */
export function executionNotice(executionEnabled: boolean, pending: number): string | null {
  if (executionEnabled) return null
  return pending > 0
    ? `Scheduled publishing is switched off on this deployment. ${pending} scheduled `
      + `publish${pending === 1 ? '' : 'es'} ${pending === 1 ? 'is' : 'are'} stored here and `
      + 'none of them will run. Publish from the panel above instead.'
    : 'Scheduled publishing is switched off on this deployment — a time set here would be stored '
      + 'and never fired. Publish from the panel above instead.'
}
