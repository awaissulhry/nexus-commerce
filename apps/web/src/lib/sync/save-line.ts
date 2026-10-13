/**
 * One save line for a page — the Matrix's pattern (#592), for pages that are not the Matrix.
 *
 * - Writes go ONE AT A TIME, in the order they were asked: each starts once the one before it has settled, so it is
 *   sent at the version that write left. A write that fails never stops the line.
 * - Every read is ticketed when it STARTS: a read that started before the one already on screen is older, and never
 *   paints over it. A page whose screen runs ahead of the server (an optimistic order, a typed count) can also keep
 *   reads off the screen while a write is waiting or in flight; it reads again once its last write has settled.
 * - `ownVersions` re-bases a write on this page's own writes: the version a write's answer gave is the one the next
 *   write of that row is sent at, until a newer read arrives. The page never refuses itself; a move by anyone else
 *   is still a conflict.
 */

export type ReadOutcome<T> =
  | { kind: 'fresh'; value: T; ticket: number }
  /** A read that started later has already painted, or a write is waiting or in flight: drop this answer. */
  | { kind: 'stale' }
  /** The newest read failed: the page says so. */
  | { kind: 'failed'; error: unknown }

export interface SaveLine {
  /** Queue a write; it starts once every write before it has settled. Resolves or rejects as the write does. */
  write<T>(task: () => Promise<T>): Promise<T>
  /** Writes waiting or in flight. */
  readonly pending: number
  /** The newest ticket handed out (0 = none): a read with a higher ticket started after this moment. */
  readonly issued: number
  /**
   * A read through the line. `quietWhileWriting`: an answer that lands while a write is waiting or in flight is
   * dropped too — the page reads again after its last write.
   */
  read<T>(fetchIt: () => Promise<T>, opts?: { quietWhileWriting?: boolean }): Promise<ReadOutcome<T>>
}

export function saveLine(): SaveLine {
  let tail: Promise<unknown> = Promise.resolve()
  let pending = 0
  let issued = 0
  let shown = 0
  return {
    write<T>(task: () => Promise<T>): Promise<T> {
      pending += 1
      const run = tail.then(task, task).finally(() => { pending -= 1 })
      tail = run.catch(() => undefined)
      return run
    },
    get pending() { return pending },
    get issued() { return issued },
    async read<T>(fetchIt: () => Promise<T>, opts: { quietWhileWriting?: boolean } = {}): Promise<ReadOutcome<T>> {
      const ticket = ++issued
      const quiet = () => opts.quietWhileWriting === true && pending > 0
      try {
        const value = await fetchIt()
        if (ticket < shown || quiet()) return { kind: 'stale' }
        shown = ticket
        return { kind: 'fresh', value, ticket }
      } catch (error) {
        // Only the newest read speaks for the page; an older one's failure is answered by the read after it.
        if (ticket !== issued || quiet()) return { kind: 'stale' }
        return { kind: 'failed', error }
      }
    },
  }
}

export interface OwnVersions {
  /** The version this page's own write left (from the write's answer). */
  record(key: string, version: number): void
  /** The version to send: the newer of the read's and this page's own last write's. */
  at(key: string, readVersion: number | null | undefined): number | undefined
}

export function ownVersions(): OwnVersions {
  const own = new Map<string, number>()
  return {
    record(key, version) {
      if (!Number.isFinite(version)) return
      own.set(key, Math.max(own.get(key) ?? -Infinity, version))
    },
    at(key, readVersion) {
      const mine = own.get(key)
      const read = typeof readVersion === 'number' && Number.isFinite(readVersion) ? readVersion : undefined
      if (mine === undefined) return read
      // A version only grows: a read at least as new as this page's own write already shows it (and anyone else's).
      return read !== undefined && read > mine ? read : mine
    },
  }
}
