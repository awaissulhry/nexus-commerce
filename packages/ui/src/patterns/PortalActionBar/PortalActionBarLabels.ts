/**
 * `PortalActionBar`'s words (B-W2b-155). English by default; a host passes the words it translates. The action's own words
 * and its held reason are the page's.
 */
export interface PortalActionBarLabels {
  /** The bar's name for a screen reader (a region). */
  region: string
  /** The action runs: held with these words. */
  busy: string
}

export const PORTAL_ACTION_BAR_LABELS: PortalActionBarLabels = {
  region: 'Actions',
  busy: 'Working…',
}
