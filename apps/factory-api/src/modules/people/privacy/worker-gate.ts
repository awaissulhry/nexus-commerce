import type { CommandTx } from '../../../core/command'
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
  /** An author column (`createdById`, `postedById`, an audit actor) names an office user or a worker: a worker's id follows the rule, an office user's stays. */
  author(authorId: string | null | undefined, isWorker: boolean): { readonly id: string | null; readonly hidden: boolean }
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
    author: (authorId, isWorker) => ({ id: isWorker && !open ? null : (authorId ?? null), hidden: isWorker && !open && typeof authorId === 'string' }),
  }
}

/** The rule at a site: its PERFORMANCE gate as it stands (B-W2b-27's legalGateFor, never a local read of the gate). */
export async function workerGateFor(db: GateReader, siteId: string): Promise<WorkerGate> {
  return workerGate((await legalGateFor(db, siteId, 'PERFORMANCE')).open)
}

export interface WorkerGates {
  /** The rule at a site. A site that was not read, or no site, is not open. */
  at(siteId: string | null | undefined): WorkerGate
}

/** The rule at every site of a list (B-W2b-F4): each site's gate is read once, whatever the number of rows, never once per row. */
export async function workerGatesFor(db: GateReader, siteIds: readonly (string | null | undefined)[]): Promise<WorkerGates> {
  const open = new Set<string>()
  for (const siteId of new Set(siteIds.filter((id): id is string => typeof id === 'string'))) {
    if ((await workerGateFor(db, siteId)).open) open.add(siteId)
  }
  return { at: (siteId) => workerGate(typeof siteId === 'string' && open.has(siteId)) }
}

/** Which of these ids are floor workers: a column with no device beside it (a goods receipt's author, a value of an audit row) says it no other way. */
export async function workersAmong(db: Pick<CommandTx, 'worker'>, ids: Iterable<string | null | undefined>): Promise<ReadonlySet<string>> {
  const wanted = [...new Set([...ids].filter((id): id is string => typeof id === 'string'))]
  if (wanted.length === 0) return new Set()
  return new Set((await db.worker.findMany({ where: { id: { in: wanted } }, select: { id: true } })).map((row) => row.id))
}
