/**
 * The one way this API builds a custom BullMQ job id.
 *
 * BullMQ 5 (Job.validateOptions) refuses a custom id that is a bare integer ("Custom Id cannot be integers") or that
 * holds a ":" — unless it splits into exactly three parts, a shape it keeps only for old repeatable jobs and plans to
 * refuse too ("TODO: replace this check in next breaking check with include(':')"). A refused id makes every `add`
 * throw, so the job never runs and the work waits for a drain cron: on 2026-10-07 every queued ad write ("ads-sync:<row>")
 * went out late that way, sent by the drain instead of its own job.
 *
 * The parts are joined with "-", and a ":" inside a part becomes "-" too. The same parts always give the same id (the
 * id is how BullMQ drops a duplicate job), and the business prefix WorkspaceQueue adds ("w_<business>_") keeps it valid.
 */
export function safeJobId(first: string | number, ...rest: Array<string | number>): string {
  const id = [first, ...rest].map((part) => String(part).replace(/:/g, '-')).join('-')
  return /^\d+$/.test(id) ? `job-${id}` : id
}

/** A queued ad write's job: one per OutboundSyncQueue row, so a second enqueue of the row is dropped by BullMQ. */
export const adsSyncJobId = (queueRowId: string): string => safeJobId('ads-sync', queueRowId)
