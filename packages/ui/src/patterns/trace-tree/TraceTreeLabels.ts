/**
 * `TraceTree`'s words (B-W2b-09). English by default; a host passes the words it translates.
 */
export interface TraceTreeLabels {
  /** A node the records link only coarsely (per work order or size): it MAY hold the traced item. */
  possible: string
  /** After a level's count: "3 may hold it". */
  possibleCount: (count: number) => string
  /** The levels' list name. */
  levels: string
  /** A tick box's name: "Include Lot L-0042 and everything under it". */
  tick: (name: string) => string
  /** How many nodes are ticked: "12 selected". */
  selected: (count: number) => string
  /** The keys, in the one information icon under the tree (never above it). */
  keys: string
  /** Nothing to show. */
  empty: string
}

export const TRACE_TREE_LABELS: TraceTreeLabels = {
  possible: 'may hold it',
  possibleCount: (count) => `${count} may hold it`,
  levels: 'Levels',
  tick: (name) => `Include ${name} and everything under it`,
  selected: (count) => `${count} selected`,
  keys: 'Keys: ↑ ↓ move · → open or go in · ← close or go out · Home / End first or last · Enter opens the record · Space ticks',
  empty: 'Nothing to show',
}
