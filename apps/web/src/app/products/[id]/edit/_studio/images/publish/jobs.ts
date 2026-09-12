/**
 * PES.7 — reading the image-publish job log honestly. Pure, tested.
 *
 * 🔴 **A job's `status` field cannot be trusted on its own, and neither can its receipt.**
 *
 * Measured across the FULL set of 78 jobs on GALE-JACKET (not a sample), the status column is
 * close to inverted:
 *
 * | rows | `status` | `completedAt` | per-SKU receipt |
 * |------|----------|---------------|-----------------|
 * | 37 Amazon | `IN_PROGRESS` | **set** (written in bursts by a sweep) | **present**, 666 lines |
 * | 6 Amazon  | `DONE`        | **null**      | **absent** |
 * | 22 eBay   | `DONE`        | set           | n/a |
 * | 13 eBay   | `FATAL`       | set           | n/a |
 *
 * The rows that claim to be running are the ones that finished; the rows that claim to be finished
 * never recorded finishing. Rendering `status` verbatim would show 47% of this product's history as
 * permanently in flight, for work that ended three months ago.
 *
 * ⚠ **But "no rejections" is Amazon's silence, not Amazon's approval.** The receipt is built as
 * `accepted: errors.length === 0`, and the service deliberately treats an *absent* processing
 * report as zero issues (its comment: "A DONE feed often returns an empty/absent processing report
 * when every message was accepted. Do NOT bail on a null report"). An all-accepted receipt is
 * therefore consistent with both "Amazon accepted every SKU" and "no report ever came back", and
 * the field that separates them — `resultSummary.processingReport` — is not exposed by the API.
 *
 * So this module reports three different things and never collapses them:
 *   • a rejection is a fact           → say it failed, and why
 *   • a receipt with no rejection     → say it ended and nothing was rejected, not that it worked
 *   • no receipt and no status        → say the outcome is not recorded, and do not guess
 *
 * The positive confirmation an operator actually wants lives elsewhere and is already on screen:
 * the listing rows' own `publishStatus` in the matrix. The job log is a record of attempts.
 */

/** One line of Amazon's processing report, as the API narrows it (`resultSummary.perSku`). */
export interface PerSkuLine {
  sku: string
  asin: string | null
  accepted: boolean
  errors: Array<{ code: string; message: string }>
}

export interface PublishJob {
  id: string
  channel: string
  marketplace: string | null
  status: string
  submittedAt: string
  completedAt: string | null
  errorMessage: string | null
  vendorEntityId?: string | null
  /** Amazon only, and only once the feed reached DONE. */
  perSku?: PerSkuLine[]
}

export type JobState =
  | 'done'
  | 'failed'
  /** Amazon returned a receipt and it names rejected SKUs. A fact, not an inference. */
  | 'rejected'
  /** Genuinely still running: no completion recorded, and recent enough to believe. */
  | 'running'
  /** A receipt exists and names no rejection — it ended; success is not thereby proven. */
  | 'endedNoRejections'
  /** A completion time with no receipt and no terminal status. It stopped; nothing else is known. */
  | 'endedUnrecorded'
  /** Claims to be running, no completion, and far too old to still be true. */
  | 'stalled'

/** Past this, a job claiming to run with no completion is not a job anyone is waiting for. */
const STALLED_AFTER_HOURS = 24

export interface Receipt {
  lines: number
  rejected: number
  /** Distinct rejection reasons, most frequent first. */
  reasons: Array<{ message: string; count: number }>
}

/** Amazon's per-SKU report, folded. `null` when the job carries none. */
export function readReceipt(job: PublishJob): Receipt | null {
  const perSku = job.perSku
  if (!perSku || perSku.length === 0) return null

  const counts = new Map<string, number>()
  let rejected = 0
  for (const line of perSku) {
    if (line.accepted) continue
    rejected++
    for (const e of line.errors ?? []) {
      const message = e.message?.trim() || e.code || 'Rejected without a reason'
      counts.set(message, (counts.get(message) ?? 0) + 1)
    }
  }
  return {
    lines: perSku.length,
    rejected,
    reasons: [...counts.entries()]
      .map(([message, count]) => ({ message, count }))
      .sort((a, b) => b.count - a.count),
  }
}

export interface JobReading {
  state: JobState
  /** The sentence shown to the operator. Never the raw enum. */
  label: string
  /** Present only when the record needs explaining, so a reader knows why the label differs. */
  note?: string
  receipt: Receipt | null
}

export function readJob(job: PublishJob, now: Date = new Date()): JobReading {
  const status = (job.status ?? '').toUpperCase()
  const receipt = readReceipt(job)

  // A named rejection outranks every status field: it is the one thing here that is directly
  // evidenced rather than inferred from an absence.
  if (receipt && receipt.rejected > 0) {
    return {
      state: 'rejected',
      label: `${receipt.rejected} of ${receipt.lines} rejected`,
      note: receipt.reasons[0]?.message,
      receipt,
    }
  }

  if (status === 'FATAL' || status === 'ERROR' || status === 'FAILED') {
    return { state: 'failed', label: 'Failed', note: job.errorMessage ?? undefined, receipt }
  }

  if (status === 'DONE' || status === 'SUCCESS') {
    return {
      state: 'done',
      label: 'Completed',
      /*
       * The 6 rows in this shape have no completion time and no report — but five of them do carry
       * a message saying why ("No variants with ASINs + images found"), i.e. the feed completed
       * because there was nothing to send. That sentence is the useful one, so it wins over the
       * generic remark about the missing report.
       */
      note: job.errorMessage
        ?? (receipt ? undefined : 'Recorded as completed, but no per-SKU report was stored for this feed.'),
      receipt,
    }
  }

  if (receipt) {
    return {
      state: 'endedNoRejections',
      // Short, because the row's own receipt column already spells the counts out; a pill that
      // repeats the cell beside it is noise, and a long pill reads as a sentence in a badge.
      label: 'Ended',
      note: 'Amazon returned a report naming no rejection, and this job’s status was never advanced. '
        + 'A report that names nothing is also what an empty report looks like, so this is evidence '
        + 'it finished rather than proof it published.',
      receipt,
    }
  }

  if (job.completedAt) {
    // It stopped. Say that, and not that it worked.
    return {
      state: 'endedUnrecorded',
      // Distinct from the row above at a glance: same ending, but nothing came back with it.
      label: 'Ended, no report',
      note: 'This job recorded a finish time but its status was never updated and it carries no report, so whether it succeeded is not recorded.',
      receipt,
    }
  }

  const ageHours = (now.getTime() - new Date(job.submittedAt).getTime()) / 3_600_000
  if (ageHours > STALLED_AFTER_HOURS) {
    return {
      state: 'stalled',
      label: 'No result',
      note: `Submitted ${Math.round(ageHours / 24)} days ago and never reported back. It is not still running.`,
      receipt,
    }
  }
  return { state: 'running', label: 'In progress', receipt }
}

export interface JobSummary {
  total: number
  byState: Record<JobState, number>
  /** Jobs whose outcome is genuinely not recorded anywhere. Not the same as "status looks odd". */
  unknown: number
  /** Jobs whose status field contradicts the rest of their own record. */
  contradictory: number
  /** SKU lines across every receipt, and how many of them Amazon named as rejected. */
  skuLines: number
  skuRejected: number
  /** Distinct failure reasons — from job errors and from receipts alike, most frequent first. */
  failures: Array<{ message: string; count: number }>
}

export function summariseJobs(jobs: readonly PublishJob[], now: Date = new Date()): JobSummary {
  const byState: Record<JobState, number> = {
    done: 0, failed: 0, rejected: 0, running: 0, endedNoRejections: 0, endedUnrecorded: 0, stalled: 0,
  }
  const failures = new Map<string, number>()
  let skuLines = 0
  let skuRejected = 0
  let contradictory = 0

  const add = (message: string, n = 1) => failures.set(message, (failures.get(message) ?? 0) + n)

  for (const j of jobs) {
    const r = readJob(j, now)
    byState[r.state]++
    if (r.receipt) {
      skuLines += r.receipt.lines
      skuRejected += r.receipt.rejected
      for (const reason of r.receipt.reasons) add(reason.message, reason.count)
    }
    if (r.state === 'failed' && j.errorMessage) add(j.errorMessage)
    // "IN_PROGRESS with a finish time" and "DONE with none" are both the record disagreeing
    // with itself; an operator should be told how much of this log is in that state.
    if (r.state === 'endedNoRejections' || r.state === 'endedUnrecorded') contradictory++
    else if (r.state === 'done' && !j.completedAt) contradictory++
  }

  return {
    total: jobs.length,
    byState,
    unknown: byState.endedUnrecorded + byState.stalled,
    contradictory,
    skuLines,
    skuRejected,
    failures: [...failures.entries()]
      .map(([message, count]) => ({ message, count }))
      .sort((a, b) => b.count - a.count),
  }
}
