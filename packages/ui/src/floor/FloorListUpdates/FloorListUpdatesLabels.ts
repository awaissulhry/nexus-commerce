/**
 * `FloorListUpdates`' words (B-W2b-28). English by default; a host passes the words it translates.
 */
export interface FloorListUpdatesLabels {
  /** The button's words before Show: "List changed" (count unknown) or "List changed: 3 updates". */
  changed: (count: number) => string
  /** The button's action word. */
  show: string
  /** Said once, politely, when the list first changes. */
  announce: string
}

export const FLOOR_LIST_UPDATES_LABELS: FloorListUpdatesLabels = {
  changed: (count) => (count <= 0 ? 'List changed' : count === 1 ? 'List changed: 1 update' : `List changed: ${count} updates`),
  show: 'Show',
  announce: 'The list changed. Press Show to see it.',
}
