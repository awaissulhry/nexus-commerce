import { legalGateFor, type GateReader } from './gate'

/**
 * Who did a piece of work, as an office read tells it (B-W2b-F3; plan GATE-LABOUR; Statuto dei Lavoratori art. 4 c.1): THE one
 * rule, used by every office read of a scan, a cut, a tick or a floor move. With the site's PERFORMANCE legal gate not open
 * the read serves neither the worker's name nor their id: the record says a person is on it (`worker: null`, `workerHidden:
 * true`, the shape of B-W2b-45's labour record), never who. With the gate open the read answers as it did, "only where the site
 * records workers" included: a row that names nobody stays null and is not hidden.
 *
 * Office scope only: the floor role reads no gate, and the floor's own screens are not this rule's (`legalGateReader`).
 */

export interface PersonRef {
  readonly id: string
  readonly name: string
}

export interface WorkerGate {
  /** The site's PERFORMANCE gate is in force now. */
  readonly open: boolean
  /** The worker ids a read may look a name up for: none while the gate is not open. */
  lookup(workerIds: readonly (string | null | undefined)[]): string[]
  /** A worker's id as an answer may carry it: null while the gate is not open. */
  id(workerId: string | null | undefined): string | null
  /** The worker as `{ id, name }`: null when the row names nobody or the gate is not open. */
  person(workerId: string | null | undefined, names: ReadonlyMap<string, string>): PersonRef | null
  /** The worker's name alone (the reads that answer a bare name). */
  name(workerId: string | null | undefined, names: ReadonlyMap<string, string>): string | null
  /** `workerHidden`: the row names a person and the gate keeps them back. */
  hidden(workerId: string | null | undefined): boolean
}

/** The rule itself, for a gate already read. */
export function workerGate(open: boolean): WorkerGate {
  return {
    open,
    lookup: (workerIds) => (open ? workerIds.filter((id): id is string => typeof id === 'string') : []),
    id: (workerId) => (open ? (workerId ?? null) : null),
    person: (workerId, names) => (open && workerId ? { id: workerId, name: names.get(workerId) ?? '' } : null),
    name: (workerId, names) => (open && workerId ? (names.get(workerId) ?? null) : null),
    hidden: (workerId) => !open && typeof workerId === 'string',
  }
}

/** The rule at a site: its PERFORMANCE gate as it stands (B-W2b-27's legalGateFor, never a local read of the gate). */
export async function workerGateFor(db: GateReader, siteId: string): Promise<WorkerGate> {
  return workerGate((await legalGateFor(db, siteId, 'PERFORMANCE')).open)
}
