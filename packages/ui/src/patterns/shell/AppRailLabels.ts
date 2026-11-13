/**
 * `AppRail`'s words (B-W2b-F41): the rail's landmark name, the counts, the chevrons and the channel rows' words.
 * English by default; a word with a row's name or a number in it is a function.
 */
export interface AppRailLabels {
  /** The rail's `<nav>` name: "Application navigation". */
  navigation: string
  /** A row's name when it carries a count: "Products, 4 pending". */
  withCount: (label: string, count: number) => string
  /** The count badge's own name: "4 pending". */
  count: (count: number) => string
  /** An external row's name: "Help (opens in a new tab)". */
  newTab: (name: string) => string
  /** A parent row's chevron while its rows are hidden: "Expand Listings". */
  expand: (label: string) => string
  /** A parent row's chevron while its rows are shown: "Collapse Listings". */
  collapse: (label: string) => string
  /** A channel row's chevron while its markets are hidden: "Expand Amazon markets". */
  expandMarkets: (label: string) => string
  /** A channel row's chevron while its markets are shown: "Collapse Amazon markets". */
  collapseMarkets: (label: string) => string
  /** The row that opens every market of a channel: "See all 12 markets". */
  seeAllMarkets: (count: number) => string
  /** A disconnected channel's trailing word: "Connect". */
  connect: string
}

export const APP_RAIL_LABELS: AppRailLabels = {
  navigation: 'Application navigation',
  withCount: (label, count) => `${label}, ${count} pending`,
  count: (count) => `${count} pending`,
  newTab: (name) => `${name} (opens in a new tab)`,
  expand: (label) => `Expand ${label}`,
  collapse: (label) => `Collapse ${label}`,
  expandMarkets: (label) => `Expand ${label} markets`,
  collapseMarkets: (label) => `Collapse ${label} markets`,
  seeAllMarkets: (count) => `See all ${count} markets`,
  connect: 'Connect',
}
