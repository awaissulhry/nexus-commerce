/**
 * Editing speed (2026-10-13) — the product sheet's Shared save answers before its family's readiness is rebuilt.
 *
 * Measured on the private stack (a 21-product family, 46 readiness destinations): a 1-cell Shared save took 2.4–3.5 s,
 * and ~95% of it was the family's readiness rebuild inside the save's transaction (46 studio sheet reads and ~12 MB of
 * `ReadinessIndex` rows rewritten). The sheet keeps one save per row in flight, so every edit queued behind it.
 *
 * For a sheet save (`ProductBulkContext.readinessAfterResponse`) that rebuilds a WHOLE family:
 *   1. inside the save's transaction, the family's readiness rows are marked pending (`markReadinessPending`), so the
 *      mark commits with the values and rolls back with them — the durable record;
 *   2. after the commit, the rebuild is started HERE, in this process, after the response is sent;
 *   3. a crash before or during the rebuild loses nothing: the marks stay, and the readiness-pending drain (every
 *      minute) rebuilds the family. The rebuild is idempotent: it replaces the family's derived rows, and a family no
 *      longer pending is a no-op (`rebuildImportedFamily`).
 * The page reads readiness right after a save (`useReadinessRefresh`); `getProductReadiness` waits here for a rebuild
 * of that family that is still running in this process, so it answers with the rebuilt rows.
 *
 * One run per family at a time: a save that lands while its family is being rebuilt asks for one more run when this one
 * ends (a burst of edits costs two rebuilds, not one each). That follow-up run starts after the save committed, so it
 * reads it whatever the running one read; it rebuilds the whole family (`followUp`), never "only if still pending".
 */
import { workspaceContext, withWorkspace } from '../../lib/workspace-context.js'
import { logger } from '../../utils/logger.js'

interface FamilyRun {
  /** Resolves when no run of this family is left in this process (never rejects). */
  settled: Promise<void>
  /** Another save of this family committed while the run was in progress: run once more. */
  again: boolean
}

const runs = new Map<string, FamilyRun>()

/** Lets the save's response leave first; a save landing in this window joins the same run. */
const AFTER_RESPONSE_DELAY_MS = 100
/** How long a readiness read waits for a running rebuild before it answers with the rows stored now (still pending). */
const READINESS_WAIT_MS = 20_000

/**
 * Rebuild `rootId`'s family after the current response. Called from an after-commit effect, so the values and the
 * pending marks are committed. Never throws: a failed rebuild leaves the marks for the drain. `rebuild(followUp)`:
 * `false` for the first run, `true` for the run a save asked for while the family was being rebuilt.
 */
export function rebuildAfterResponse(rootId: string, rebuild: (followUp: boolean) => Promise<unknown>): void {
  const running = runs.get(rootId)
  if (running) { running.again = true; return }
  const workspace = workspaceContext()
  const inWorkspace = <T>(work: () => Promise<T>) => workspace ? withWorkspace(workspace, work) : work()
  const run: FamilyRun = { again: false, settled: Promise.resolve() }
  run.settled = (async () => {
    try {
      await new Promise(resolve => setTimeout(resolve, AFTER_RESPONSE_DELAY_MS))
      for (let followUp = false; ; followUp = true) {
        run.again = false
        try {
          await inWorkspace(() => rebuild(followUp))
        } catch (error) {
          logger.warn('[readiness] rebuild after the save failed; the readiness-pending drain will rebuild the family', {
            rootId, error: error instanceof Error ? error.message : String(error),
          })
        }
        if (!run.again) break
      }
    } finally {
      runs.delete(rootId)
    }
  })()
  runs.set(rootId, run)
}

/** Wait (bounded) for this process's rebuild of `rootId`'s family, when one is scheduled or running. */
export async function familyReadinessSettled(rootId: string, timeoutMs = READINESS_WAIT_MS): Promise<void> {
  const run = runs.get(rootId)
  if (!run) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([run.settled, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) })])
  clearTimeout(timer)
}

/** Families with a rebuild scheduled or running in this process (tests and diagnostics). */
export function familiesRebuildingAfterResponse(): string[] {
  return [...runs.keys()]
}
