import type { ExportStatus } from '../exports'

/**
 * Background job progress (B-W2b-11; PLT-184 "Background job progress"; design shell.lists pop:export-job "Exporting
 * 18,400 rows" with JobProgress, planning.mrp "Planning… 38 of 61 order lines"). An export knows how many rows its view
 * holds BEFORE it writes the first one: the worker counts them first (the source's own count, else by reading the list
 * once without writing anything) and keeps the total on the job (ExportJob.rowCount, "how many in all once known"),
 * then writes `rowsDone` as it goes. The screen draws a bar with "38 of 61" from the two numbers.
 *
 * The list may change while the job runs: a row added after the count makes `rowsDone` pass the total; the total then
 * follows the rows written (the database refuses rowsDone above rowCount), and the finished job keeps the exact count of
 * the file. A count that passes the most rows a file may hold refuses the export at once, before anything is written.
 */

export interface JobNumbers {
  readonly status: ExportStatus
  readonly rowsDone: number
  readonly rowCount: number | null
}

export interface JobProgress {
  /** True when the total is known (a bar with "n of m"), false while it is counted (a moving bar with "n so far"). */
  readonly determinate: boolean
  readonly done: number
  readonly total: number | null
  /** 0…1 when determinate, else null. A finished job is 1. */
  readonly fraction: number | null
}

/** The progress a screen shows for a job. */
export function jobProgress(job: JobNumbers): JobProgress {
  if (job.status === 'DONE' || job.status === 'EXPIRED') {
    const total = job.rowCount ?? job.rowsDone
    return { determinate: true, done: total, total, fraction: 1 }
  }
  if (job.rowCount === null) return { determinate: false, done: job.rowsDone, total: null, fraction: null }
  const total = Math.max(job.rowCount, job.rowsDone)
  return { determinate: true, done: job.rowsDone, total, fraction: total === 0 ? 1 : Math.min(1, job.rowsDone / total) }
}

/** The total to keep beside `rowsDone`: the count, raised to the rows written when the list grew meanwhile. */
export function totalAfter(rowCount: number | null, rowsDone: number): number | null {
  if (rowCount === null) return null
  return Math.max(rowCount, rowsDone)
}
