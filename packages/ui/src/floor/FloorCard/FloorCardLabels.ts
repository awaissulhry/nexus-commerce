/**
 * `FloorCard`'s words (B-W2b-28). English by default; a host passes the words it translates.
 */
export interface FloorCardLabels {
  /** A card drawn from the tablet's cache: "Saved on this tablet · as of 10:42". */
  cachedAt: (time: string) => string
  /** The facts' name for a screen reader. */
  facts: string
  /** The flags' name for a screen reader. */
  flags: string
  /** Before the status word for a screen reader ("Status: Ready"). */
  status: string
}

export const FLOOR_CARD_LABELS: FloorCardLabels = {
  cachedAt: (time) => `Saved on this tablet · as of ${time}`,
  facts: 'Details',
  flags: 'Flags',
  status: 'Status',
}
