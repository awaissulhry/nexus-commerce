/**
 * Ads Core (E1) — the async report-task pipeline contract.
 *
 * Generalizes the proven Amazon shape (AmazonAdsReportJob: create → poll →
 * download → parse → ingest) as a typed contract that the eBay pipeline
 * (E2: EbayAdsReportTask against createReportTask/getReportTask/reportHref)
 * implements. The Amazon pipeline itself is NOT refactored onto this in E1
 * (E0 audit: highest regression risk, zero payoff until a second
 * implementation exists) — this module carries the state machine + fairness
 * helpers both sides agree on, unit-tested once.
 *
 * Contract highlights (from the battle-tested Amazon pipeline + E0 verified
 * eBay behavior):
 *  - ensureTask() is IDEMPOTENT on the task's natural key while a task is
 *    open (PENDING/IN_PROGRESS) — re-scheduling never duplicates work.
 *  - Poll fairness: oldest-polled-first, never-polled first of all.
 *  - Ingest uses ABSOLUTE values upserted on natural fact keys → rerun-safe;
 *    every fact row is stamped with the task id + reportedAt for freshness.
 *  - Trailing re-pull (eBay: 72h "Reconciliation Period") is scheduler
 *    behavior, not state-machine behavior: it creates NEW tasks for the
 *    trailing window; it never re-opens terminal ones.
 */

export const REPORT_TASK_STATES = [
  'PENDING',      // created locally and/or accepted by the channel
  'IN_PROGRESS',  // channel is generating
  'SUCCESS',      // generated; download URL available
  'FAILED',       // channel failed it, or download/parse failed
  'EXPIRED',      // download window lapsed before ingest
  'INGESTED',     // facts upserted — the only "done and counted" state
] as const

export type ReportTaskState = (typeof REPORT_TASK_STATES)[number]

const TRANSITIONS: Record<ReportTaskState, readonly ReportTaskState[]> = {
  PENDING: ['IN_PROGRESS', 'SUCCESS', 'FAILED', 'EXPIRED'],
  IN_PROGRESS: ['SUCCESS', 'FAILED', 'EXPIRED'],
  SUCCESS: ['INGESTED', 'FAILED', 'EXPIRED'], // FAILED here = download/parse failure
  FAILED: [],   // terminal — retries are NEW tasks via ensureTask (idempotency)
  EXPIRED: [],  // terminal
  INGESTED: [], // terminal
}

export function canAdvanceReportTask(from: ReportTaskState, to: ReportTaskState): boolean {
  if (from === to) return false
  return (TRANSITIONS[from] ?? []).includes(to)
}

export function isReportTaskTerminal(s: ReportTaskState): boolean {
  return TRANSITIONS[s]?.length === 0
}

export function isReportTaskOpen(s: ReportTaskState): boolean {
  return s === 'PENDING' || s === 'IN_PROGRESS'
}

/**
 * Fair poll order: never-polled tasks first (oldest-created first), then by
 * oldest lastPolledAt — so a stuck task can't starve the queue. Pure; does
 * not mutate the input.
 */
export function pollOrder<T extends { lastPolledAt: Date | null; createdAt: Date }>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => {
    if (a.lastPolledAt === null && b.lastPolledAt === null) {
      return a.createdAt.getTime() - b.createdAt.getTime()
    }
    if (a.lastPolledAt === null) return -1
    if (b.lastPolledAt === null) return 1
    return a.lastPolledAt.getTime() - b.lastPolledAt.getTime()
  })
}

/**
 * What a channel report pipeline implements. TSpec identifies a task's
 * natural key (channel, report type, funding model, marketplace(s), date
 * window); TRow is one parsed fact row.
 */
export interface ReportTaskDriver<TSpec, TRow> {
  /** Create-or-return-open: never a duplicate open task for the same spec. */
  ensureTask(spec: TSpec): Promise<{ taskId: string; created: boolean }>
  /** One poll step; returns the (possibly advanced) state. */
  pollOne(taskId: string): Promise<ReportTaskState>
  /** Download + parse a SUCCESS task into fact rows (pure of side effects). */
  downloadAndParse(taskId: string): Promise<TRow[]>
  /** Idempotently upsert rows (absolute values on natural keys); stamp freshness. */
  ingest(taskId: string, rows: TRow[]): Promise<{ upserted: number }>
}
