/**
 * Listing readiness rebuild §3 (docs/listings/READINESS-REBUILD-2026-10-23.md) — the live event of the Listing readiness
 * page (`readiness.updated`, `{ rootProductId }`).
 *
 * Two callers in readiness-index.service.ts, so every path is covered without a call of its own:
 *   · the one materializer, `reconcileFamilyReadiness` — the rebuild inline in a save, after a sheet save's response,
 *     the queue worker, the minute drain, the nightly reconcile and an import's rebuild all end there;
 *   · a pending mark that wrote rows (`markReadinessPending`), so an open page can say "Checking…" before the rebuild.
 *
 * It never announces a write that is not there: inside a transaction it waits for COMMIT — a rollback, a restarted
 * attempt or a savepoint that rolled back drops it — and outside one it runs at once. Every family named in one
 * transaction is announced ONCE, however many rebuilds or marks of it that transaction ran.
 *
 * A refresh hint on the ephemeral lane (listing-events.service.ts): never awaited, never thrown — a dropped one costs an
 * open page its next re-read, never a save.
 */
import { afterDatabaseCommitBatch } from '../../lib/database-context.js'
import { logger } from '../../utils/logger.js'
import { publishListingEvent } from '../listing-events.service.js'

/** The after-commit key: one effect per transaction, holding every family it named. */
const COMMIT_KEY = 'readiness.updated'

const warn = (error: unknown, detail: Record<string, unknown> = {}) =>
  logger.warn('readiness: change not announced', { ...detail, error: error instanceof Error ? error.message : String(error) })

export function announceReadinessUpdated(rootIds: readonly string[]): void {
  try {
    const ids = [...new Set(rootIds.filter((id) => typeof id === 'string' && id.length > 0))]
    if (ids.length === 0) return
    void afterDatabaseCommitBatch(COMMIT_KEY, ids, async (committed) => {
      for (const rootProductId of committed) {
        try {
          publishListingEvent({ type: 'readiness.updated', rootProductId, ts: Date.now() })
        } catch (error) {
          warn(error, { rootProductId })
        }
      }
    }).catch((error) => warn(error))
  } catch (error) {
    warn(error)
  }
}
