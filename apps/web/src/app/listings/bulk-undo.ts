/**
 * The listings bulk bar's Undo — pure, so it is tested by value (2026-10-13).
 *
 * 🔴 The Undo of a bulk "Unfollow master" ran "Follow master" on EVERY selected listing: one that had failed, and one
 * that was already unfollowed before the action, were handed back to the master too — its own price and quantity
 * wiped and the master's sent to the channel. The API now records what the action changed (its job's answer lists
 * those listings, `changed`), and its Undo (`action: 'undo'` with the job's id) puts back only those, each follow flag
 * to what it was.
 */

/**
 * The bulk actions that offer an Undo. "Follow master" offers none: it clears each listing's own price and queues the
 * master's, which an unfollow cannot bring back.
 */
const UNDOABLE_BULK_ACTIONS = new Set(['unfollow-master'])

const FINISHED = new Set(['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED'])

/** The listings a finished bulk action changed, which its Undo puts back; null when no Undo is offered. */
export function bulkUndoTargets(action: string, job: { status?: unknown; changed?: unknown } | null): string[] | null {
  if (!job || !UNDOABLE_BULK_ACTIONS.has(action) || typeof job.status !== 'string' || !FINISHED.has(job.status)) return null
  const changed = Array.isArray(job.changed) ? job.changed.filter((id): id is string => typeof id === 'string') : []
  return changed.length ? changed : null
}

/** The request body of the Undo: the job it puts back, and the listings that job changed. */
export function bulkUndoBody(jobId: string, listingIds: string[]): { action: 'undo'; listingIds: string[]; payload: { jobId: string } } {
  return { action: 'undo', listingIds, payload: { jobId } }
}
